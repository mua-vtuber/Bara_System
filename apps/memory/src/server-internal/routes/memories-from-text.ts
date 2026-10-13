/**
 * routes/memories-from-text.ts — POST /memories/from-text (LLM 추출 후 다중 저장).
 *
 * routes/memories.ts 를 책임 경계로 분할하며 옮겨 온 모듈이다(P3 G5-a —
 * docs/decisions/2026-07-03-structure-cleanup-spec.md).
 *
 * **외부 어댑터 직접 추출 호출 통로** (Phase 5.7.2 정합).
 * 이 라우트는 mode 설정 *무관* — 항상 즉시 추출 가동. 어댑터가 메모리
 * settings.llm.extractor.mode 우회 의도 시 활용한다. preserveRaw 필드는
 * 의미 보존 — 어댑터가 raw 노드 저장 여부 결정한다.
 *
 * 옛 봇 어댑터는 5.7.2 직전까지 이 통로 호출 (autoExtract=true fallback).
 * 5.7.2 정착 후 봇 어댑터 = POST /memories 한 통로만 호출 (메모리 자율 결정).
 * 외부 어댑터 (텔레그램 / 슬랙 / 카톡 등) 가 mode 우회 의도 시 이 라우트
 * 직접 호출 가능.
 *
 * 저장 순서(WP-B1-20T 설계 5.10): LLM 준비를 먼저(잠금 밖, DB 쓰기 없음) 하고, 쓰기는 한 번의 쓰기
 * 잠금 구간에서 한다. preserveRaw 면 원문을 먼저 저장하고 자식을 그 원문의 계보로 저장한다(원문과 같은
 * 주장은 자기 주장 규칙 — 자식 없이 원문에서 충돌 검사). preserveRaw 가 없으면 부모가 없으므로 자식마다
 * 이 입력의 출처 행을 남긴다 — 메시지를 지우면 자식이 직접 지워진다.
 */

import type { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { isPositiveString, err } from "../http-helpers.ts";
import type { SqliteMemoryStore } from "../../db/store.ts";
import {
  EXTRACTED_KEY,
  EXTRACTED_TO_KEY,
  EXTRACTION_DONE,
} from "../../db/store-internal/extraction-state-sql.ts";
import { autoLinkMentions } from "../../memory/auto-mention.ts";
import { linkAuthorPerson } from "../../memory/person-link.ts";
import { extractProtectUntil } from "../../memory/protect-until.ts";
import { parseTags } from "../../memory/tag-extractor.ts";
import { buildExtractionContext } from "../../memory/extraction-context.ts";
import { wireHashtagConceptsSafe } from "../../memory/hashtag-wiring.ts";
import { wireEntityPlacementSafe } from "../../memory/entity-placement-wiring.ts";
import { normalizeProjectId } from "../../memory/project-scope.ts";
import { AUTO_CAPTURE_SOURCE_TYPE } from "../../memory/shared-memory-contract.ts";
import { withMemoryMutationLock, withMemoryWriteActivity } from "../../memory/shared-memory-mutation-lock.ts";
import { describeInputSource, type NodeSourceRef } from "../../memory/node-sources/source-ref.ts";
import {
  originExtractionLineage,
  type ExtractInput,
  type ExtractionStoreResult,
  type MemoryExtractor,
  type PreparedExtraction,
} from "../../memory/extractor.ts";
import type { AutoCleanupTriggerHandle } from "../../memory/auto-cleanup-trigger.ts";
import { applyWriteGuard } from "../write-guard/write-guard.ts";
import { secretRejectionResponse } from "../write-guard/write-guard-http.ts";
import { parseClientMetadata, resolveRestAttribution, sourceKeyDelimiterResponse } from "./memories-shared.ts";

/** 원문 보존 노드의 중요도 — 분해 자식보다 약간 낮게(검색 노이즈 방지). */
const RAW_IMPORTANCE = 0.4;
/** 원문 보존 노드의 신뢰도 — 사용자가 직접 친 어휘라 최고 신뢰. */
const RAW_CONFIDENCE = 1.0;
/** wiring 로그에 남는 호출 통로 이름. */
const FROM_TEXT_CALLER = "from-text";

/** LLM 준비 결과 — 태그만 있는 입력(추출할 본문 없음)은 null. */
interface PreparedFromText {
  readonly input: ExtractInput;
  readonly prepared: PreparedExtraction;
}

/** 쓰기 잠금 안 저장에 필요한 입력. */
interface FromTextWrite {
  text: string;
  author: string;
  platform: string;
  metadata: Record<string, unknown>;
  projectId: string | null;
  preserveRaw: boolean;
  /** 이 입력의 직접 저장 출처 — 원문(preserveRaw)이나 부모 없는 자식(preserveRaw 없음)이 받는다. */
  inputSource: NodeSourceRef;
  trigger: AutoCleanupTriggerHandle | undefined;
}

/** 추출할 본문이 없는 입력(태그만)의 저장 결과 — LLM 도 자식 저장도 없었다. */
function noExtraction(): ExtractionStoreResult {
  return {
    storedNodeIds: [],
    bumpedNodeIds: [],
    selfClaimNodeIds: [],
    filteredOutCount: 0,
    conflictsDetected: 0,
    llmRawResponse: "",
    items: [],
  };
}

/**
 * 쓰기 잠금 안 저장(설계 5.10). preserveRaw 면 원문 R 을 먼저 저장(입력 출처, 추출 완료 표시와 빈
 * extractedTo) → storeExtraction(계보 부모·추출 원문 = R) → R 의 extractedTo → R 의 mentions·작성자·
 * 해시태그·엔티티 wiring. preserveRaw 가 없으면 storeExtraction 에 입력 출처(childSource)를 넘긴다.
 *
 * R 이 같은 본문의 기존 기억에 흡수되면(reused) 그 기억이 이 입력의 출처 행을 받고 자식의 계보 부모가
 * 된다. 그 기억의 추출 기록(extractedTo)은 첫 추출의 것이라 덮지 않는다.
 */
async function writeFromText(
  store: SqliteMemoryStore,
  extractor: MemoryExtractor,
  write: FromTextWrite,
  extraction: PreparedFromText | null,
): Promise<{ result: ExtractionStoreResult; rawNodeId: number | null }> {
  if (!write.preserveRaw) {
    const result = extraction === null
      ? noExtraction()
      : await extractor.storeExtraction(extraction.prepared, extraction.input, { childSource: write.inputSource });
    return { result, rawNodeId: null };
  }

  // 원문 보존 모드 — 추출이 압축하거나 paraphrase 를 망쳐도 사용자가 입력한 어휘 그대로 남는다.
  const rawProtectUntil = extractProtectUntil(write.text);
  const raw = await store.addNodeIdempotent({
    content: write.text,
    sourceType: AUTO_CAPTURE_SOURCE_TYPE,
    importance: RAW_IMPORTANCE,
    confidence: RAW_CONFIDENCE,
    platform: write.platform,
    author: write.author,
    project_id: write.projectId,
    metadata: {
      ...write.metadata,
      preservedRaw: true,
      [EXTRACTED_KEY]: EXTRACTION_DONE,
      [EXTRACTED_TO_KEY]: [],
      ...(rawProtectUntil ? { protectUntil: rawProtectUntil } : {}),
    },
    // WP-B1-20T — 원문은 이 입력의 직접 저장이다(messageId 가 있으면 메시지 출처).
    provenance: { kind: "source", source: write.inputSource },
  });
  const result = extraction === null
    ? noExtraction()
    : await extractor.storeExtraction(
      extraction.prepared,
      extraction.input,
      { lineage: originExtractionLineage(raw.id) },
    );
  if (!raw.reused && result.storedNodeIds.length > 0) {
    await store.markNodeExtracted(raw.id, result.storedNodeIds);
  }

  // 원문도 개념 자동 mentions (자식 노드는 extractor 안에서 처리됨).
  await autoLinkMentions(store, { id: raw.id, content: write.text });
  // 작성자 사람 개념 mentions (spec 4.6) — extractor 자식은 안에서 처리.
  await linkAuthorPerson(store, {
    nodeId: raw.id,
    author: write.author,
    platform: write.platform,
    metadata: { ...write.metadata, preservedRaw: true },
  });
  // 태그 개념 노드 wiring (origin 시점 1회 — 메인 결정 2). 추출 경로는 skipHashtagWiring=true 라
  // wiring 을 안 하므로 정확히 1회다(중복 0). preserveRaw=false 면 origin 노드가 없어 wiring 대상이
  // 없다 — 태그는 원본 글 속성이라 자식 노드에 억지로 붙이지 않는다.
  await wireHashtagConceptsSafe(store, raw.id, write.text, write.trigger, FROM_TEXT_CALLER);
  // 개념 엔티티 타입 배치 wiring(3단계 Task 5) — 개념 wiring 직후 같은 origin·text 로 신규 8 타입
  // 배치. LLM 단 null(default OFF). Safe 래퍼라 격리된다.
  await wireEntityPlacementSafe(store, raw.id, write.text, write.trigger, FROM_TEXT_CALLER, null);
  return { result, rawNodeId: raw.id };
}

export function registerMemoriesFromTextRoutes(app: Hono, deps: MemoryApiDeps): void {
  const { store } = deps; // 부팅 시점 고정 의존만 구조분해

  app.post("/memories/from-text", (c) => withMemoryWriteActivity(store, async () => {
    let body: {
      text?: unknown;
      author?: unknown;
      platform?: unknown;
      metadata?: unknown;
      projectId?: unknown;
      project?: unknown;
      preserveRaw?: unknown;
      debug?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    if (!isPositiveString(body.text)) {
      return err(c, 400, "text must be a non-empty string");
    }

    // SA-0 — 추출기 입력 metadata(추출 자식마다 복사된다)와 preserveRaw 원본 metadata 가
    // 같은 값을 쓰므로 이 한 번의 검사가 둘 다 보호한다. 서버 관리 칸은 400, 제한 토큰의
    // 작성자는 adapterId(다른 author·metadata.user_id 는 403). 추출(LLM) 비용보다 앞선다.
    const metadata = parseClientMetadata(c, body.metadata);
    if (metadata instanceof Response) return metadata;
    const attribution = resolveRestAttribution(c, { author: body.author, metadata });
    if (attribution instanceof Response) return attribution;
    const { author } = attribution;
    const platform = typeof body.platform === "string" ? body.platform : "";
    // 출처 키 구분자(설계 17.18 설계 7) — POST /memories 와 같은 400. 추출기 가용 판정·LLM 준비보다 앞선다.
    const keyProblem = sourceKeyDelimiterResponse(c, { source: platform, author, metadata });
    if (keyProblem) return keyProblem;
    const preserveRaw = body.preserveRaw === true;
    const debugRaw = body.debug === true;
    const projectId = normalizeProjectId(body.projectId ?? body.project);

    // T15(결정 D-C + T12 인계) — 이 라우트는 saveTextInput 을 거치지 않는 우회
    // 저장 통로다. 관문을 직접 통과시켜 비밀값을 거부하고 울타리 태그를 씻는다
    // (통로별 재구현 금지 — write-guard.ts 한 함수 공유). 관문 산출 text 를 이후
    // 추출·저장·wiring 전부가 쓰도록 body.text 대신 이 값을 아래에서 참조한다.
    let text: string;
    try {
      text = applyWriteGuard(body.text, deps.getSettings?.().writeGuard);
    } catch (e) {
      const rejected = secretRejectionResponse(c, e);
      if (rejected) return rejected;
      throw e;
    }

    // extractor 가용 판정은 관문 **뒤**다(T15). 비밀값이 들어왔다는 사실은 LLM 설정
    // 여부와 무관하므로, 추출기가 없다는 이유로 503 을 먼저 돌려주면 같은 입력이
    // 설정에 따라 다른 이유로 거절돼 클라이언트가 "키를 지워야 한다"는 진짜 원인을
    // 못 본다. 둘 다 저장 0 이지만 회신하는 이유가 정확해야 한다.
    // deps.extractor 는 동적 lookup (구조분해 금지) — 준비와 저장이 같은 인스턴스를 쓰도록 한 번 읽는다.
    const extractor = deps.extractor;
    if (!extractor) {
      return err(
        c,
        503,
        "extractor not configured — set LLM_PROVIDER and required credentials",
      );
    }

    try {
      // (1) 준비 — LLM 호출·파싱(잠금 밖, DB 쓰기 없음). 태그 wiring 은 추출 경로에서 끄고
      // (skipHashtagWiring=true) 원문 저장 뒤에 1회 한다(save-input immediate 갈래와 동형).
      // skipHashtagWiring=true 면 원문을 그대로 LLM 에 넘기므로, 태그가 atomic 조각이 되지 않게
      // parseTags 의 cleanContent 만 LLM 에 넘긴다. cleanContent 가 비면 LLM 을 부르지 않고 빈 추출
      // 결과로 닫아 태그 자체가 atomic 조각이 되는 일을 막는다.
      const cleaned = parseTags(text).cleanContent;
      let extraction: PreparedFromText | null = null;
      if (cleaned.trim().length > 0) {
        const input: ExtractInput = {
          text: cleaned,
          author,
          platform,
          metadata,
          skipHashtagWiring: true,
          projectId,
          context: await buildExtractionContext(store, text, cleaned),
        };
        extraction = { input, prepared: await extractor.prepareExtraction(input) };
      }

      // (2) 쓰기 — 한 번의 쓰기 잠금 구간(원문 먼저, 설계 5.10). deps.autoCleanupTrigger 동적 lookup.
      const { result, rawNodeId } = await withMemoryMutationLock(store, () => writeFromText(store, extractor, {
        text, author, platform, metadata, projectId, preserveRaw,
        inputSource: describeInputSource({ source: platform, author, metadata }),
        trigger: deps.autoCleanupTrigger,
      }, extraction));

      return c.json(
        {
          extractor: { provider: extractor.llmName },
          stored: result.storedNodeIds,
          bumped: result.bumpedNodeIds,
          filteredOut: result.filteredOutCount,
          conflicts: result.conflictsDetected,
          items: result.items,
          raw: rawNodeId !== null ? { id: rawNodeId } : null,
          // 디버깅: debug=true 시 LLM 원본 응답(처음 4KB) 노출 — 모델이
          // 무엇을 뱉었는지 봇/슬래시에서 바로 확인 가능. 평소엔 생략.
          llmRawResponse: debugRaw ? result.llmRawResponse : undefined,
        },
        201,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err(c, 500, `extraction failed: ${message}`);
    }
  }));
}
