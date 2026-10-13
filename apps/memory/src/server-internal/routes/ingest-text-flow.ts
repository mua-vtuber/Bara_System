/**
 * routes/ingest-text-flow.ts — POST /ingest 순수 타이핑 글 분기 (입력 통로 통합 spec §3 D1·D4).
 *
 * routes/ingest.ts 를 책임 경계로 분할하며 옮겨 온 모듈이다(P3 G5-a —
 * docs/decisions/2026-07-03-structure-cleanup-spec.md). content.type === "text" 이고
 * originalName 이 없을 때만 "사용자가 직접 친 글"이다. 이 글의 원본은 노드 content
 * 자체이므로 자산 파일(asset_files)·documents 행을 만들지 않고(고아 메타 회피 /
 * spec §3 P1), saveTextInput 으로 원본 한 노드 + 길이 조건부 청크를 저장한다.
 * 분기 선택(contentType/originalName 판정)은 ingest.ts 파사드가 진다.
 */

import type { Context } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { err } from "../http-helpers.ts";
import { EVENT_TYPES } from "../event-bus.ts";
import { saveTextInput } from "../save-input.ts";
import { notifyMemoSaved } from "../memo-saved-cleanup.ts";
import { readSharedMemory } from "../../memory/shared-memory-contract.ts";
import { sourceMessageMarkers } from "../../memory/node-sources/source-ref.ts";
import { secretRejectionResponse } from "../write-guard/write-guard-http.ts";
import {
  collectGlobFields,
  applyGlobFields,
} from "../../memory/glob-field-apply.ts";
import {
  explicitContentTypeName,
  displayKindName,
} from "../../memory/entity-type-classifier.ts";
import {
  ISO_DAY_REGEX,
  kindColumnKeys,
  type IngestParsedInput,
} from "./ingest-helpers.ts";

export async function handleTextIngest(
  c: Context,
  deps: MemoryApiDeps,
  store: MemoryApiDeps["store"],
  input: IngestParsedInput,
) {
  const { body, data, source, author, userId, hashtags, projectId, capture, sourceMessage } = input;
  // WP-B1-20U 설계 17.8 — 글 갈래(파일 이름 없는 글)는 메시지의 글 자체라 출처는 첨부 id 없는 글 행이다. 첨부 id 를
  // 받으면 조용히 버리게 되므로 저장 전에 400 으로 알린다.
  if (sourceMessage?.attachmentId !== undefined) {
    return err(c, 400, "sourceMessage.attachmentId is only valid for file or image inputs (content.originalName or an image mimeType)");
  }

  const settingsForText = deps.getSettings?.();
  try {
    const saveResult = await saveTextInput(store, {
      content: data,
      source,
      author,
      userId,
      extraMetadata: {
        user_id: userId,
        source,
        ...(capture ? { capture } : {}),
        // WP-B1-20U 설계 17.8 — 외부 메시지의 플랫폼과 표시 칸(messageId·channelId·guildId)을 저장 metadata 에 실어,
        // 저장 출처 판정(describeInputSource)이 그 메시지의 글 행을 남긴다. 메시지 삭제가 표시 칸을 거둔다.
        ...(sourceMessage ? { platform: sourceMessage.platform, ...sourceMessageMarkers(sourceMessage) } : {}),
      },
      hashtags,
      projectId,
      // chunking 슬롯 방어적 확인 — Task 2 관측(슬롯 부분 복원 누락)에 대비해
      // 슬롯이 없으면 undefined 를 넘겨 chunkDocument default(tokenCap 2000)로 둔다.
      chunking: settingsForText?.chunking
        ? {
            tokenCap: settingsForText.chunking.tokenCap,
            minChunkTokens: settingsForText.chunking.minChunkTokens,
          }
        : undefined,
      // Task 5 — 짧은 글 immediate 추출. extractor·settings 둘 다 동적 lookup
      // (구조분해 금지 — deps.extractor 는 createMemoryApi 가 나중에 채울 수 있다).
      // saveTextInput 안에서 wantsImmediate 판정(짧은 글 + enabled + mode='immediate')
      // 후에만 가동 — extractor 미가용·긴 글·backfill mode 면 원본 보존(graceful).
      extractor: deps.extractor,
      extractorSettings: settingsForText?.llm?.extractor,
      // Task 6 — regex Level 0 atomic. /memories 글과 같은 규칙으로 대시보드 글도
      // regex atomic 을 받는다(D1 통로 통합). 토글·regexL0 둘 다 동적 lookup.
      regexL0: deps.regexL0,
      regexEnabled: settingsForText?.extractor?.regex?.enabled === true,
      // 태그 wiring 입력 시점 이동(T2) — 태그 개념 노드 신규 작성 신호 통로.
      // deps.autoCleanupTrigger 동적 lookup(구조분해 금지). 미주입이면 no-op.
      trigger: deps.autoCleanupTrigger,
      // T15(결정 D-C) — 저장 관문 토글. 미주입이면 관문이 가동(fail-safe).
      writeGuard: settingsForText?.writeGuard,
    });
    if (saveResult.kind === "entity_patch") {
      deps.autoCleanupTrigger?.emit("external-sdk-write");
      deps.eventBus?.emit(EVENT_TYPES.GRAPH_CHANGED, { reason: "entity-patched" });
      return c.json(
        {
          ok: true,
          type: "entity_patch",
          id: null,
          nodeIds: [],
          originNodeId: null,
          chunkNodeIds: [],
          title: saveResult.title,
          entities: saveResult.entities,
          warnings: saveResult.warnings,
          extracted: [],
          bumped: [],
          pendingChunks: 0,
        },
        201,
      );
    }

    const originNodeId = saveResult.originNodeId;
    if (originNodeId === null) {
      return err(c, 500, "텍스트 입력 저장 실패: origin node id 누락");
    }
    notifyMemoSaved(deps, saveResult);
    // Exact-content reuse skips insert metadata. Apply an explicit correction to
    // the reused raw node, while an AI guess cannot replace a user's choice.
    if (saveResult.cacheHit && capture !== undefined) {
      const existing = await store.getNode(originNodeId);
      if (existing && !(capture && capture.source === "ai" &&
          (existing.metadata.capture as { source?: unknown } | undefined)?.source === "user") &&
          JSON.stringify(existing.metadata.capture ?? null) !== JSON.stringify(capture)) {
        await store.editNodeContent({ nodeId: originNodeId, content: existing.content,
          expectedRevision: readSharedMemory(existing.metadata).revision, capture,
          reason: "capture correction", editSource: source });
      }
    }

    // ── 종류 분류값(②④) + 글-칸 수렴 (본문 # 태그 인식 단일 출처) ──────────
    // 종류·칸을 본문 `#가계부:미용` `#금액:28000원` 에서 인식한다(폼은 S8 에서 종류
    // 드롭다운·날짜 필드를 없앴다). explicitContentTypeName 으로 typeName(영문)을 얻어
    // 두 용도로 쓴다:
    //   · 종류 분류값(②④) = koName(displayKindName) — kind 검색 캡슐이 이 이름을 매칭.
    //   · 칸 조회(kindColumnKeys) = 영문 typeName — getTypeColumns·columnLabelKeysOf 가
    //     영문 키로만 칸을 찾는다(메모리 stage6-dynamic-form). koName 으로 찾으면 칸 누락.
    //
    // (2026-07 평문 자동 분류 범위 축소·Task 2) classifyEntityTypeDeterministic 을 직접
    // 쓰면 콜론 태그가 없어도 2단 평문 단어 경계 매칭(source "seed")만으로 종류가 확정돼,
    // 본문 아무 단어가 분류 폴더 어휘(예 material 하위 "코드")와 겹치기만 해도 종류값
    // 노드가 잘못 생겼다("클로드 코드"의 "코드"가 자료로 오분류). explicitContentTypeName
    // 게이트(source==='explicit' 일 때만 typeName 인정)로 바꿔 콜론으로 명시했을 때만
    // 아래 종류 확정이 실행되게 한다. classifyEntityTypeDeterministic·matchBoundary 자체는
    // 무변경(엔티티 배치 등 다른 호출처가 seed 판정을 그대로 써야 함 — entity-type-classifier.ts
    // 참고).
    //
    // 2026-06-28 "종류" 허브 버그 수정(spec §4.2 후보 가) — 옛 코드는 종류를
    // addClassificationTag(node, "종류", koName) 로 매달았다. 그 한 호출이 ①"종류" 부모 키 +
    // ②koName 값 개념 + ③"종류"→값 위계선 + ④글→값 엣지를 만들어, ①③(허브)이 장소·사람·
    // 일정을 한 "종류" 노드로 빨아들였다(spec §2.4). 이제 ①③(허브)은 안 만들고 ②④(검색)만
    // 만드는 좁은 store 메서드 store.addNodeKindValue 로 바꾼다. 그러면 그래프 허브가 안
    // 생기고, kind 검색 캡슐(retriever.ts:467 → getNodeIdsByConceptName(koName))이 회수하는
    // ②값 개념 + ④글 엣지는 살아 본문만 적은 일정 글도 콜론 없이 회상된다(함정 2 차단).
    // 공용 addClassificationTagFlow(콜론 위계도 쓰는 헬퍼)는 미접촉(콜론 위계 회귀 0·함정 8).
    // wireEntityPlacement 가 entities 행을 만들 때 쓰는 분류기를 공유해 행·글 노드 종류가
    // 어긋나지 않는다. 본문에 종류 신호가 없으면 종류값·칸 0(정직한 빈 상태).
    const contentTypeName = explicitContentTypeName(data);
    if (contentTypeName !== null) {
      // ②④ — koName 값 개념 + 글→값 classification 엣지만 만든다(①③ 허브 0). 종류
      // 분류 실패가 입력 저장(이미 끝난 origin)을 깨면 안 된다 — origin id·사유와 함께
      // warn 후 계속(silent fallback 아님 — 칸은 별 호출이라 이어 시도).
      try {
        await store.addNodeKindValue(
          originNodeId,
          displayKindName(contentTypeName),
          "user_input",
          originNodeId,
        );
      } catch (e) {
        console.warn(
          `[POST /ingest text] 종류 분류값 저장 실패 — 원본 ${originNodeId} 보존: ${String(e)}`,
        );
      }
      // 글-칸 — 이 종류의 칸(getTypeColumns 새 종류 columns ∪ 코드 8 타입 columnLabels 키)
      // 안에 든 키만 글-칸으로 받는다. collectGlobFields 가 본문 `#금액:28000원` 을 직접 읽어
      // 칸으로 수렴하므로 폼 fields 없이도 채워진다(본문 단일 출처). 폼 fields(pre-S8)가 같은
      // 키면 폼 값이 이기되 같은 글-칸 한 번만 setGlobField(direct) 라 이중 0. kindColumnKeys
      // 가 미등록 kind 를 빈 집합으로 graceful 처리(throw 차단). 칸 조회는 영문 typeName.
      const allowed = kindColumnKeys(contentTypeName);
      const formFields =
        body.fields &&
        typeof body.fields === "object" &&
        !Array.isArray(body.fields)
          ? (body.fields as Record<string, string>)
          : undefined;
      const globFields = collectGlobFields(formFields, data, allowed);
      if (Object.keys(globFields).length > 0) {
        try {
          await applyGlobFields(store, originNodeId, globFields);
        } catch (e) {
          console.warn(
            `[POST /ingest text] 글-칸 저장 실패 — 원본 ${originNodeId} 보존: ${String(e)}`,
          );
        }
      }
    }
    // 일정 날짜 — 본문 `#날짜:6월 28일 ~ 6월 30일` 인식은 위 wireHashtagEntitiesSafe 가
    // 단일 출처로 처리한다(reserved key '날짜' → event_at·event_until, splitDateRange 로
    // `~` 분할·extractEventDateTime 으로 ISO·애매하면 미설정). 라우트는 본문 날짜를 다시 안
    // 푼다(이중 0). 폼 호환(pre-S8) — body.eventAt/Until(ISO date 필드)은 본문이 그 칸을
    // 아직 안 채웠을 때만 받는다(본문 우선·같은 칸 두 번 쓰기 0). canWriteField 는
    // direct≥direct 라 덮어쓰기를 허용하므로, 덮어쓰기 차단을 현재 칸이 빈지 읽어 가드한다.
    const afterBody = await store.getNode(originNodeId);
    if (
      afterBody?.eventAt == null &&
      typeof body.eventAt === "string" &&
      ISO_DAY_REGEX.test(body.eventAt)
    ) {
      await store.setEventAt(originNodeId, body.eventAt, "direct");
    }
    if (
      afterBody?.eventUntil == null &&
      typeof body.eventUntil === "string" &&
      ISO_DAY_REGEX.test(body.eventUntil)
    ) {
      await store.setEventUntil(
        originNodeId,
        body.eventUntil,
        "direct",
      );
    }
    deps.autoCleanupTrigger?.emit("external-sdk-write");
    // 그래프 라이브 연출 2a — 텍스트 입력이 진짜 저장된 끝에서 graph_changed 발행.
    // eventBus 미주입이면 no-op. 저장 성공 경로에서만(에러 응답은 여기 못 온다).
    deps.eventBus?.emit(EVENT_TYPES.GRAPH_CHANGED, { reason: "ingested" });
    return c.json(
      {
        ok: true,
        type: "text",
        nodeIds: saveResult.nodeIds,
        originNodeId,
        chunkNodeIds: saveResult.chunkNodeIds,
        title: saveResult.title,
        // Task 5 — immediate 추출 결과. 긴 글·미가용 시 빈 배열(정직한 0건).
        // pendingChunks = 추출 대기 청크 수(긴 글의 backfill 대상) — Task 7 표시 자료.
        extracted: saveResult.extracted,
        bumped: saveResult.bumped,
        pendingChunks: saveResult.chunkNodeIds.length,
        // P0-A 입력 멱등성 — 정확-중복 재사용 여부(같은 글 재입력 시 true, originNodeId
        // 는 기존 노드 id). 이미지 자산 갈래가 노출하는 cacheHit 선례 정합(spec §5.1).
        cacheHit: saveResult.cacheHit,
      },
      201,
    );
  } catch (e) {
    const rejected = secretRejectionResponse(c, e);
    if (rejected) {
      // saveTextInput applies the secret guard before any write. This explicit
      // marker lets a client distinguish a proven rejection from an ambiguous
      // error after dispatch (where auto-rePOST would risk a duplicate).
      rejected.headers.set("X-Ingest-Retryable", "true");
      return rejected;
    }
    const msg = e instanceof Error ? e.message : String(e);
    return err(c, 500, `글 저장 실패: ${msg}`);
  }
}
