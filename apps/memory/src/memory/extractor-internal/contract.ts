/**
 * contract.ts — extractor 외부 계약 타입·metadata 빌드(extractor.ts 에서 분리·G5-a).
 *
 * extractor.ts 가 1213줄로 800줄 하드 상한을 넘겨 책임 경계로 하위 모듈에 코드를 옮겼다
 * (동작 0 변화 — 코드 이동만·선례 store.ts → store-internal 분해). 이 모듈은 호출자
 * (봇·서버·scheduler)와 주고받는 입출력 계약과, 추출 자식 노드 metadata 를 만드는 순수
 * 함수를 모은다:
 *   - ExtractInput·ExtractedItem·ExtractionStoreResult·ExtractorOptions — 외부 타입 4개.
 *   - ExtractionLineage·ExtractionPlacement — 추출 자식이 붙는 곳(계보 또는 직접 출처, WP-B1-20T).
 *   - buildChildMetadata — 호출자 metadata + extractor 고유 키 머지(protectUntil 포함).
 *   - normalizeExtractedPersonCandidates — LLM 사람 후보 이름 정리(공백·중복 제거).
 */

import type { MemoryType } from "../types.ts";
import type { LlmProvider } from "../../llm/provider-registry.ts";
import type { Provenance } from "../provenance-vocabulary.ts";
import type { NodeProvenance, NodeSourceRef } from "../node-sources/source-ref.ts";
import { extractProtectUntil } from "../protect-until.ts";
import type { ExtractionContext } from "../extraction-context.ts";
import { inheritSharedMemoryForDerived, readSharedMemory } from "../shared-memory-contract.ts";
import { withoutExtractionRecord } from "../../db/store-internal/extraction-state-sql.ts";

// ── 외부 타입 ────────────────────────────────────────────────────────────

export interface ExtractInput {
  /** 추출 대상 텍스트 (디스코드 메시지 / 메모 / 대화 transcript). */
  text: string;
  /** 작성자 식별자. 빈 문자열이면 conflict check 스킵. */
  author?: string;
  /** 출처 플랫폼 ("discord", "manual" 등). 메타데이터에만 사용. */
  platform?: string;
  /**
   * 다중 프로젝트 스코프. undefined/빈 문자열/공백은 NULL 로 정규화하고,
   * 문자열은 trim 해서 추출 자식·dedup·conflict 스코프에 동일하게 쓴다.
   */
  projectId?: string | null;
  /**
   * 호출자가 모든 추출 자식 노드에 그대로 묻혀가길 원하는 추가 메타데이터.
   * 예: 디스코드 봇은 `{ messageId, channelId, guildId, source }`를 전달해
   * 메시지가 나중에 삭제되면 store.deleteBySource로 자식들까지 함께
   * 청소할 수 있게 한다. extractor 자체가 채우는 키(`source: "llm_extract"`,
   * `llm`, `platform`)는 이 패스스루 위에 덮어쓴다.
   */
  metadata?: Record<string, unknown>;
  /**
   * LLM 호출 갈래. 'off' = LLM 호출 skip (빈 items 반환 + LLM 부수효과 0),
   * 공급자 값(공급자 표의 다섯 값) = LLM 호출 정상 진행. 미지정 시 옛 동작 유지
   * (caller 가 이미 settings 기반 provider 로 LLM client 를 build 한 상태) —
   * Phase 5.6 W1 acceptance "옛 호출자 영향 0".
   */
  provider?: "off" | LlmProvider;
  /**
   * Phase 5.6 W5 (2026-05-20) — true 면 extractAndStore 진입부에서 hashtag wiring
   * 단계 자체를 skip. 백필 cron 흐름이 정합 사용처 — 옛 raw 노드는 봇 captureRaw
   * 시점에 이미 hashtag wiring 거쳤으니, 백필 시점에 또 부르면 같은 본문 노드 +
   * 같은 tagged_with edge 가 매 사이클 누적된다 (A1 DB 22~24 회 중복 bug 정황).
   * 기본 false — 봇 즉시 추출 흐름 + 옛 호출자 영향 0.
   */
  skipHashtagWiring?: boolean;
  /**
   * 원문·분석 본문·해시태그/직접 입력 확정 메타를 담는 내부 envelope.
   * REST API 계약에는 노출하지 않고, 입력 통로가 시스템적으로 채워 LLM 안내와
   * metadata 적용 잠금에 함께 쓴다.
   */
  context?: ExtractionContext;
}

/** LLM이 뽑아낸 단일 항목. store 저장 전 단계. */
export interface ExtractedItem {
  content: string;
  memoryType: MemoryType;
  importance: number;
  subject?: string;
  predicate?: string;
  object?: string;
  /**
   * Phase 7 명시 메타 (Task 3) — atomic 별로 문장에 *명시된* 장소·사람·시간 표현.
   * per-atomic: "병원 갔다가 약국 들렀다" 처럼 한 메시지가 여러 장소로 갈리면
   * 각 atomic 에 따로 붙는다. 문장에 명시 안 됐으면 비운다(지어내지 않음 —
   * graceful, 정직한 빈 값). 메타를 실제 개념 노드·event_at 칸에 적용하는 wiring
   * 은 후속 Task 4.
   */
  /** 문장에 명시된 장소 (예: "강남역", "한빛약국"). 없으면 undefined. */
  place?: string;
  /** 문장에 명시된 사람 이름들 (예: ["민수", "지영"]). 없으면 undefined. */
  person?: string[];
  /**
   * 원문 시간 표현 토막 (예: "어제", "금요일", "지난주 화요일"). ISO 환산은
   * 후속 Task 4 가 event-date.ts 의 extractEventDate 로 수행 — 이 칸은 *원문
   * 토막* 만 담는다(환산 안 함). 없으면 undefined.
   */
  eventDateText?: string;
}

export interface ExtractionStoreResult {
  /** 새로 만들어진 노드 ID들. */
  storedNodeIds: number[];
  /** dedup으로 mention만 올린 기존 노드 ID들. */
  bumpedNodeIds: number[];
  /**
   * 추출 원문 자신의 주장이라 자식을 만들지 않은 항목의 원문 id(WP-B1-20T 설계 3.6.1 자기 주장 규칙) —
   * 항목의 본문 해시가 원문과 같거나 유사 흡수 대상이 원문 자신이었다. 충돌 검사는 이 원문을 새 주장으로
   * 보고 돌렸다. 같은 원문은 한 번만 담는다. 계보(lineage) 없이 저장하면 늘 빈 배열이다.
   */
  selfClaimNodeIds: number[];
  /** LLM이 후보로 뽑았지만 importance 하한 미달로 버린 갯수. */
  filteredOutCount: number;
  /** 생성된 supersedes 엣지 수 (conflict 검출). */
  conflictsDetected: number;
  /** 디버깅용 LLM 원본 응답 (긴 경우 잘림). */
  llmRawResponse: string;
  /** LLM 추출 항목 (필터링 후). 봇이 사용자에게 요약할 때 사용. */
  items: ExtractedItem[];
}

/**
 * 추출 시도의 지문 조건 칸 — 실패 기록의 지문에 들어간다.
 * 이 값이 바뀌면(모델 교체·출력 한도 변경) 멈춘 줄이 풀려 다시 시도된다.
 */
export interface ExtractionAttemptIdentity {
  readonly llmName: string;
  readonly maxOutputTokens: number;
}

export interface ExtractorOptions {
  /** LLM 호출 temperature. 추출은 낮게 (기본 0.2). */
  temperature?: number;
  /** AbortSignal 전달용. */
  signal?: AbortSignal;
  /**
   * Phase 7 Task 4 — 등록 기준점(노드 생성 시각). 두 곳에 쓰인다:
   *  (1) LLM 추출 호출 시 "오늘 날짜" 단서로 주입 — 애매 표현 환산 기준.
   *  (2) extractAndStore 가 추출 메타(이벤트 날짜)를 ISO 로 환산할 때 기준.
   * 미주입이면 호출 시점의 new Date() — 운영 default. 테스트는 결정성 위해 주입.
   */
  now?: Date;
}

/**
 * 추출 자식의 계보(WP-B1-20T 설계 5.9·6.2). 새 자식은 parentId 로 가는 계보 엣지(relation, edgeProvenance)를
 * 저장과 같은 트랜잭션에서 받고, 기존 노드에 흡수되면 그 노드 → parentId 엣지가 더해진다(설계 3.6).
 * extractionOriginId 는 이번 추출의 원문이다 — 자식은 이 노드에 흡수되지 않고, 원문과 같은 주장은 자기
 * 주장 규칙(설계 3.6.1)으로 처리한다.
 */
export interface ExtractionLineage {
  parentId: number;
  relation: "merged_into" | "parent_of";
  edgeProvenance: Provenance;
  extractionOriginId: number;
}

/**
 * 추출 자식이 붙는 곳 — 계보(lineage)와 직접 출처(childSource) 중 정확히 하나. 부모 없는 추출(from-text 를
 * preserveRaw 없이 부른 경우)만 childSource 를 쓴다: 자식마다 입력 출처 행이 남아 메시지 삭제가 자식을
 * 직접 지운다(설계 5.10). 둘 다 없으면 자식이 출처도 부모도 없이 생기므로 저장하지 않는다(설계 6.2, 14).
 */
export type ExtractionPlacement =
  | { lineage: ExtractionLineage; childSource?: undefined }
  | { childSource: NodeSourceRef; lineage?: undefined };

/** 저장된 원문에서 뽑은 자식의 계보 — 즉시 추출·백필·수동 정리·from-text 원문 보존이 같은 값을 쓴다. */
export function originExtractionLineage(originId: number): ExtractionLineage {
  return { parentId: originId, relation: "merged_into", edgeProvenance: "system", extractionOriginId: originId };
}

/**
 * 추출 자식 저장·흡수 한 번의 출처. placement 가 계보면 derived(부모·원문 포함), 직접 출처면 source.
 * 둘 다 있거나 둘 다 없으면 무엇이 잘못됐는지 밝혀 멈춘다 — 타입을 우회한 호출도 여기서 막힌다.
 */
export function extractedChildProvenance(
  placement: { lineage?: ExtractionLineage; childSource?: NodeSourceRef },
): NodeProvenance {
  const { lineage, childSource } = placement;
  if (lineage !== undefined && childSource !== undefined) {
    throw new Error(
      "storeExtraction: lineage 와 childSource 를 함께 받았습니다 — 추출 자식은 계보 부모나 직접 출처 중 하나로만 붙습니다",
    );
  }
  if (lineage !== undefined) {
    return {
      kind: "derived",
      parentId: lineage.parentId,
      relation: lineage.relation,
      edgeProvenance: lineage.edgeProvenance,
      extractionOriginId: lineage.extractionOriginId,
    };
  }
  if (childSource !== undefined) return { kind: "source", source: childSource };
  throw new Error(
    "storeExtraction: lineage 도 childSource 도 없습니다 — 추출 자식이 출처도 계보 부모도 없이 생기지 않도록 " +
      "둘 중 하나를 넘겨야 합니다(WP-B1-20T 설계 6.2)",
  );
}

// ── 순수 함수 (metadata 빌드) ─────────────────────────────────────────────

/**
 * 추출 자식 노드 metadata 빌드. 순수 함수 — extractor 흐름과 별개로
 * 단위 검증 가능.
 *
 * 머지 우선순위: 호출자 metadata < extractor 고유 키
 * (source / llm / platform / protectUntil).
 * 즉 호출자가 source="spoofed" 박아도 extractor가 "llm_extract"로 덮어씀.
 *
 * protectUntil: item.content에 미래 시간 표현이 있으면 ISO 날짜 자동 추가.
 * 없으면 키 자체를 박지 않는다 (evolver에서 조건 없이 보호하지 않도록).
 *
 * sharedMemory: 부모 상태(수명·출처 사건)를 이어받아 revision 0·ai_inference 로 둔다.
 * 부모의 evidenceRefs 는 옮기지 않는다 — 추출 자식의 근거는 계보(merged_into·
 * extractedTo)로 연결된 부모뿐이고, 부모의 근거는 부모를 거쳐서만 전달된다.
 *
 * 부모의 출처(누가 저장했는가)는 metadata 가 아니라 서버 전용 표(memory_node_sources)에 있어
 * 자식에 옮겨질 일이 없다(WP-B1-20T) — 자식은 계보로만 부모에 붙는다.
 *
 * 부모의 추출 기록(extracted·extractedTo)도 옮기지 않는다 — 부모의 상태이고, 자식에
 * 남으면 가시성·무효화가 그 목록을 이 자식이 만든 파생 기억으로 읽는다. 백필은 편집으로
 * 추출 대기가 된 원문(extracted = 0)이나 자식이 모두 무효화된 원문의 metadata 를 넘긴다.
 */
export function buildChildMetadata(
  item: { content: string; memoryType: string; importance: number },
  input: { author?: string; platform?: string; metadata?: Record<string, unknown> },
  llmName: string,
): Record<string, unknown> {
  const protectUntil = extractProtectUntil(item.content);
  return {
    ...withoutExtractionRecord(input.metadata ?? {}),
    source: "llm_extract",
    ...(input.metadata?.sharedMemory !== undefined ? {
      sharedMemory: inheritSharedMemoryForDerived(readSharedMemory(input.metadata), {
        revision: 0, assertionKind: "ai_inference",
      }),
    } : {}),
    llm: llmName,
    ...(input.platform ? { platform: input.platform } : {}),
    ...(protectUntil ? { protectUntil } : {}),
  };
}

/**
 * LLM 이 낸 사람 후보 이름을 노드 metadata 에 남길 안전한 배열로 정리한다.
 * 이 값은 사람 row 생성 권한이 아니라, 후속 데이터 정리 AI 가 기존 personId 연결을
 * 검토할 때 쓰는 후보 텍스트다. 공백·중복만 제거하고 의미 판단은 하지 않는다.
 */
export function normalizeExtractedPersonCandidates(
  person: readonly unknown[] | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of person ?? []) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
