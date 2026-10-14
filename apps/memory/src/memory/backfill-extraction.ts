/**
 * backfill-extraction.ts — 백필 후보 한 건의 추출을 "잠금 밖 준비"와 "잠금 안 저장"으로 나눈다
 * (WP-B1-07, SL-7).
 *
 * 옛 흐름은 후보 하나의 읽기 → LLM → 쓰기를 통째로 쓰기 잠금 안에서 해, LLM 이 응답하는 동안
 * (최대 수십 초) MCP 저장·수정과 REST 편집이 모두 기다렸다. 잠금은 쓰기 순서를 위한 것이라
 * 이제 LLM 호출은 잠금 밖에서 하고, 저장 직전에 잠금 안에서 후보가 준비 때와 같은지 다시
 * 확인한다.
 *
 *   준비(잠금 밖)  후보 재조회 → 현재성·가시성 확인 → 태그를 뺀 본문 → 추출 context →
 *                  extractor.prepareExtraction(LLM 호출·파싱, DB 쓰기 없음).
 *   저장(잠금 안)  후보를 다시 읽어 본문·sharedMemory.revision 이 준비 때와 같고, 현재 기억이며,
 *                  기본 조회에 보이고, isBackfillCandidateEligible 이 참인지 확인 →
 *                  storeExtraction(계보 부모·추출 원문 = 후보) + markNodeExtracted. 자식 → 후보
 *                  merged_into 엣지는 저장소가 자식 저장과 같은 트랜잭션에서 쓰고, 후보와 같은 주장은
 *                  자기 주장 규칙으로 후보에서 충돌 검사만 한다(WP-B1-20T 설계 5.9·3.6.1).
 *
 * 확인이 하나라도 어긋나면 LLM 결과를 버리고 이유를 돌려준다(호출자가 로그에 남긴다). 추출 완료
 * 표시를 하지 않으므로, 편집으로 다시 추출을 기다리는 원문은 다음 주기에 새 본문으로 후보가 된다.
 * 본문 비교는 저장 본문 문자열 그대로 한다 — content_hash(NFC + trim 해시)가 같은 것보다 엄격하다.
 *
 * 청크가 필요한 긴 원문(WP-B1-31): 저장 때와 같은 긴 글 판정(exceedsChunkTokenCap)에 걸리는
 * auto_capture 원문이 후보가 되면 LLM 을 부르지 않는다. 청크가 추출 단위라 원문 전체를 추출하면
 * 청크 단위 추출 원칙이 깨지고, 추출 완료 표시 뒤에는 청크가 다시 만들어지지 않는다. 그래서 잠금
 * 안에서 같은 재확인을 거친 뒤 재청크(writeOriginChunksAtomic)만 한다. 새 청크는 다음 주기 후보다.
 * 재청크가 실패하면 아무것도 쓰지 않고 사유를 붙여 throw 한다 — 원문은 추출 완료로 표시되지 않아
 * 재시도 간격 뒤 다시 시도된다(상한에 닿으면 멈춤. 편집 뒤 재청크 실패, WP-B1-06 이전에 청크만 거둔 원문 모두 여기서 복구).
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import { BackfillRechunkError } from "./backfill-attempts/classify.ts";
import {
  originExtractionLineage,
  type ExtractInput,
  type MemoryExtractor,
  type PreparedExtraction,
} from "./extractor.ts";
import type { ExtractionContext } from "./extraction-context.ts";
import { buildExtractionContext } from "./extraction-context.ts";
import { AUTO_CAPTURE_SOURCE_TYPE, isCurrentMemory, readSharedMemory } from "./shared-memory-contract.ts";
import { withMemoryMutationLock } from "./shared-memory-mutation-lock.ts";
import {
  getMemoryVisibilitySnapshot,
  type MemoryVisibilitySnapshot,
} from "./shared-memory-read.ts";
import {
  exceedsChunkTokenCap,
  writeOriginChunksAtomic,
  type ChunkingSettings,
} from "./origin-chunks.ts";
import { parseTags } from "./tag-extractor.ts";
import type { MemoryNode } from "./types.ts";

/**
 * 청크를 갖는 원문 종류 — 저장 때 긴 글이면 청크를 붙이는 종류(save-input-plain.ts)와 같다.
 * WP-B1-08R (Minor 5) — 단일 출처는 shared-memory-contract.ts 의 AUTO_CAPTURE_SOURCE_TYPE.
 */
const CHUNKED_ORIGIN_SOURCE_TYPE = AUTO_CAPTURE_SOURCE_TYPE;

interface PreparedBackfillBase {
  readonly nodeId: number;
  /** 준비 때 읽은 저장 본문(태그 포함). 잠금 안에서 그대로인지 확인한다. */
  readonly content: string;
  /** 준비 때 읽은 sharedMemory.revision. */
  readonly revision: number;
}

/** LLM 추출 결과를 저장할 후보. */
export interface PreparedBackfillExtract extends PreparedBackfillBase {
  readonly kind: "extract";
  /** LLM 준비 결과. 태그만 있는 원문(본문이 비었다)은 LLM 을 부르지 않아 null 이다. */
  readonly extraction: PreparedBackfillExtraction | null;
}

/** 청크가 필요한 긴 원문 — LLM 을 부르지 않았고, 잠금 안에서 재청크한다. */
export interface PreparedBackfillRechunk extends PreparedBackfillBase {
  readonly kind: "rechunk";
  /** 긴 글 판정에 쓴 청크 설정 — 재청크도 같은 값으로 나눈다. */
  readonly chunking: ChunkingSettings | undefined;
}

/** 잠금 밖에서 준비한 백필 후보 한 건. */
export type PreparedBackfill = PreparedBackfillExtract | PreparedBackfillRechunk;

/** LLM 에 넘긴 입력과 그 응답. */
export interface PreparedBackfillExtraction {
  /** LLM 에 넘긴 본문 — 태그를 뺀 본문. */
  readonly llmInputText: string;
  readonly context: ExtractionContext;
  readonly prepared: PreparedExtraction;
}

/** 잠금 안 저장의 결과. discarded 면 아무것도 쓰지 않았다. */
export type BackfillCommitOutcome =
  | { kind: "stored"; storedNodeIds: number[]; bumpedNodeIds: number[] }
  /** 긴 원문을 새 청크로 나눴다. 원문은 추출하지 않았고, 새 청크가 다음 주기 후보다. */
  | { kind: "rechunked"; chunkNodeIds: number[] }
  | { kind: "discarded"; reason: string };

/**
 * 후보 한 건을 잠금 밖에서 준비한다. 후보가 지금 현재 기억이 아니거나 기본 조회에 보이지
 * 않으면 null — 추출하지 않는다(옛 흐름의 조용한 건너뛰기와 같다. LLM 을 부르지 않았으니
 * 버릴 결과가 없다). LLM 실패는 그대로 throw 한다.
 *
 * chunking 은 저장 경로와 같은 청크 설정(settings.chunking)이다. 이 기준으로 긴 auto_capture
 * 원문은 LLM 을 부르지 않고 재청크 준비만 돌려준다.
 */
export async function prepareBackfillCandidate(
  extractor: MemoryExtractor,
  store: SqliteMemoryStore,
  nodeId: number,
  chunking: ChunkingSettings | undefined,
): Promise<PreparedBackfill | null> {
  const node = await store.getNode(nodeId);
  if (!node || !isCurrentMemory(node.metadata)) return null;
  if (!getMemoryVisibilitySnapshot(store).isAllowed(node.id)) return null;
  const revision = readSharedMemory(node.metadata).revision;
  if (node.sourceType === CHUNKED_ORIGIN_SOURCE_TYPE && exceedsChunkTokenCap(node.content, chunking)) {
    return { kind: "rechunk", nodeId, content: node.content, revision, chunking };
  }
  // 2026-06-02 Q1 — backfill 경로 태그 전처리. skipHashtagWiring=true 라 extractor 가 태그를
  // 제거하지 않으므로 LLM 입력 텍스트만 parseTags 로 정제한다(그래프 wiring 은 계속 건너뛴다 —
  // 누적 bug 차단 유지). 원본 노드(candidate.content)는 태그 포함 그대로 보존된다.
  // cleanContent 가 빈 문자열(태그만 입력)이면 LLM 에 원문을 되살려 보내지 않고 0건 추출
  // 완료로 마킹한다(태그 조각화 차단).
  const llmInputText = parseTags(node.content).cleanContent;
  if (llmInputText.trim().length === 0) {
    return { kind: "extract", nodeId, content: node.content, revision, extraction: null };
  }
  const context = await buildExtractionContext(store, node.content, llmInputText);
  const prepared = await extractor.prepareExtraction(
    backfillExtractInput(node, llmInputText, context),
  );
  return {
    kind: "extract", nodeId, content: node.content, revision,
    extraction: { llmInputText, context, prepared },
  };
}

/**
 * 준비 결과를 쓰기 잠금 안에서 저장한다. 후보가 준비 때와 달라졌으면 아무것도 쓰지 않고
 * discarded 와 이유를 돌려준다. onCommitted 는 저장·재청크가 끝난 직후 같은 잠금 안에서 부른다 — 백필 스케줄러가
 * 실패 기록 줄을 지우는 자리다(2026-10-14 spec 4.5 — 성공 저장과 같은 잠금 안). 버림(discarded)에는 부르지 않는다.
 */
export async function commitBackfillCandidate(
  extractor: MemoryExtractor,
  store: SqliteMemoryStore,
  prepared: PreparedBackfill,
  onCommitted?: () => void,
): Promise<BackfillCommitOutcome> {
  return withMemoryMutationLock(store, async () => {
    const node = await store.getNode(prepared.nodeId);
    if (node === null) return { kind: "discarded", reason: DISCARD_REASON.deleted };
    // 잠금 안에서 잡은 스냅샷을 추출 저장의 충돌 검사에도 넘긴다 — 추출 한 건당 가시성 1회(SL-8).
    const snapshot = getMemoryVisibilitySnapshot(store);
    const reason = staleReason(store, node, prepared, snapshot);
    if (reason !== null) return { kind: "discarded", reason };
    if (prepared.kind === "rechunk") {
      const rechunked = await rechunkLongOrigin(store, node, prepared.chunking);
      onCommitted?.();
      return rechunked;
    }

    const extraction = prepared.extraction;
    if (extraction === null) {
      await store.markNodeExtracted(node.id, []);
      onCommitted?.();
      return { kind: "stored", storedNodeIds: [], bumpedNodeIds: [] };
    }
    const result = await extractor.storeExtraction(
      extraction.prepared,
      // raw 후보 metadata 를 자식에게 그대로 묻혀준다 — messageId 추적 체인이 끊기지 않게.
      // 잠금 안에서 다시 읽은 metadata 를 쓴다.
      backfillExtractInput(node, extraction.llmInputText, extraction.context),
      // 자식은 후보의 파생이다 — 계보 엣지는 저장소가 쓰고, 후보는 흡수 대상이 아니다(설계 5.9).
      { visibility: snapshot, lineage: originExtractionLineage(node.id) },
    );
    // 입력 통로 통합 Task 5 (P1) — 추출 완료를 metadata 플래그로 기록한다. 청크(document_chunk)는
    // parent_of 엣지를 갖고 추출 atomic 은 merged_into 엣지를 받으므로 완료 판정을 엣지 relation
    // 으로 하면 두 relation 을 혼동한다. 추출 결과 0건이어도 "처리 시도 완료" 표시 → 무한 재처리
    // 차단. getBackfillCandidates 의 미추출 조건과 짝.
    await store.markNodeExtracted(node.id, result.storedNodeIds);
    onCommitted?.();
    return {
      kind: "stored",
      storedNodeIds: result.storedNodeIds,
      bumpedNodeIds: result.bumpedNodeIds,
    };
  });
}

/**
 * 잠금 안 재확인을 통과한 긴 원문을 재청크한다. 후보 조건상 active 청크가 없다. 추출 대기 표시가
 * 있으면 새 청크와 같은 트랜잭션에서 거둔다. 실패하면 아무것도 쓰지 않았으므로 사유를 붙여 throw
 * 한다 — 호출자가 노드 id 와 함께 로그에 남기고, 원문은 다음 주기에 다시 후보가 된다.
 */
async function rechunkLongOrigin(
  store: SqliteMemoryStore,
  node: MemoryNode,
  chunking: ChunkingSettings | undefined,
): Promise<BackfillCommitOutcome> {
  const state = store.nodeRepo.getOriginChunkState(node.id);
  if (state === null) throw new Error(`긴 원문 재청크 실패: 원문 ${node.id} 의 청크 상태를 읽지 못했다`);
  try {
    const chunkNodeIds = await writeOriginChunksAtomic(store, node, chunking, { clearPending: state.pending });
    return { kind: "rechunked", chunkNodeIds };
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    // 2026-10-14 spec 4.3 — 백필이 cause 를 풀어 분류하도록 이름 붙은 오류로 감싼다.
    throw new BackfillRechunkError(
      `긴 원문 재청크 실패(${cause}) — 원문 전체를 추출하지 않았고 추출 완료로 표시하지 않았다, 재시도 간격 뒤 다시 시도(상한에 닿으면 멈춤)`,
      { cause: e },
    );
  }
}

const DISCARD_REASON = {
  deleted: "원문이 삭제되었다",
  contentChanged: "준비 뒤 원문 본문이 바뀌었다",
  notVisible: "원문이 기본 조회에서 보이지 않는다(근거나 계보가 무효가 되었다)",
  notEligible: "원문이 백필 후보 조건을 벗어났다(이미 추출되었거나 청크가 추출 단위가 되었다)",
} as const;

function staleReason(
  store: SqliteMemoryStore,
  node: MemoryNode,
  prepared: PreparedBackfill,
  snapshot: MemoryVisibilitySnapshot,
): string | null {
  if (node.content !== prepared.content) return DISCARD_REASON.contentChanged;
  const state = readSharedMemory(node.metadata);
  if (state.revision !== prepared.revision) {
    return `준비 뒤 sharedMemory.revision 이 바뀌었다(${prepared.revision} → ${state.revision})`;
  }
  if (!isCurrentMemory(node.metadata)) return `원문이 현재 기억이 아니다(status=${state.status})`;
  if (!snapshot.isAllowed(node.id)) return DISCARD_REASON.notVisible;
  if (!store.nodeRepo.isBackfillCandidateEligible(node.id)) return DISCARD_REASON.notEligible;
  return null;
}

/** 백필 추출 입력 — 준비와 저장이 같은 모양을 쓴다. */
function backfillExtractInput(
  node: MemoryNode,
  llmInputText: string,
  context: ExtractionContext,
): ExtractInput {
  return {
    text: llmInputText,
    author: node.author,
    platform: node.platform,
    metadata: node.metadata,
    projectId: node.projectId,
    // Phase 5.6 W5 (2026-05-20) — 옛 raw 는 봇 captureRaw 시점에 이미 hashtag wiring 을
    // 거쳤다. 백필이 또 부르면 본문 노드 + tag edge 가 매 사이클 누적된다(A1 DB 22~24 회 bug).
    skipHashtagWiring: true,
    context,
  };
}
