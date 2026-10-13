/**
 * server-internal/save-input-plain.ts — plain 갈래(원본 + 조건부 청크) 저장
 * (P3 G5-a 분해 — 옛 save-input.ts 에서 이동, 내용 무변경).
 *
 * saveOriginThenChunks 는 긴 글 / extractor 미가용 / mode≠immediate 입력의 공통
 * 갈래이자, immediate·일정 발생 갈래의 fallback 이다. 제목 도출(deriveTitle)과
 * 원본 metadata 합성(buildOriginMetadata)은 갈래 공용 헬퍼라 여기 둔다. 편집 뒤
 * 재청크(rechunkEditedOrigin)도 저장과 같은 긴 글 판정·청크 규칙을 쓴다 — 그 규칙의 단일
 * 출처는 memory/origin-chunks.ts 다(백필도 쓰므로 도메인 계층에 둔다).
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import type { NodeSourceRef } from "../memory/node-sources/source-ref.ts";
import {
  chunkNodeArgs,
  chunkProvenance,
  exceedsChunkTokenCap,
  writeOriginChunksAtomic,
} from "../memory/origin-chunks.ts";
import { autoLinkMentions } from "../memory/auto-mention.ts";
import { linkAuthorPerson } from "../memory/person-link.ts";
import { extractProtectUntil } from "../memory/protect-until.ts";
import { wireHashtagConceptsSafe } from "../memory/hashtag-wiring.ts";
import { wireEntityPlacementSafe } from "../memory/entity-placement-wiring.ts";
import { wireHashtagEntitiesSafe } from "../memory/hashtag-entity-wiring.ts";
import { AUTO_CAPTURE_SOURCE_TYPE, isCurrentMemory } from "../memory/shared-memory-contract.ts";
import {
  extractRegexCandidates,
  linkRegexAtomicsSafe,
} from "./save-input-regex.ts";
import type {
  SaveTextChunkingSettings,
  SaveTextInputArgs,
  SaveTextInputResult,
} from "./save-input-types.ts";

// 긴 글 판정은 memory/origin-chunks.ts 가 단일 출처다. saveTextInput 파사드가 이 경로로 가져간다.
export { exceedsChunkTokenCap };

/**
 * 이 입력이 실제로 들어온 플랫폼(DA-2). args.source(body.platform)만 보면, 즉시 추출
 * 준비(prepareImmediateExtraction)가 만드는 입력처럼 클라이언트가 준 원래 출처가
 * extraMetadata.platform·extraMetadata.source 에만 있고 args.source 는 비어 있는
 * 경우를 놓친다. args.source 가 이미 비어 있지 않으면(예: 호출처가 채운 다른 값이라도)
 * 그 값이 그대로 먼저 채택되고 extraMetadata 는 보지 않는다 — args.source 를 최우선
 * 후보로 삼아, 그 값이 비어 있을 때만 extraMetadata.platform → extraMetadata.source
 * 순서로 넘어가 첫 비어 있지 않은 값을 고른다.
 */
export function resolveInputPlatform(args: SaveTextInputArgs): string | undefined {
  const candidates = [
    args.source,
    args.extraMetadata?.platform,
    args.extraMetadata?.source,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return undefined;
}

/**
 * 글 첫 줄 앞 50글자를 표시용 제목으로 뽑는다. 빈 줄은 건너뛴다.
 * content 자체는 원본 노드에 잘리지 않고 그대로 저장된다 — 제목은 표시용일 뿐.
 */
export function deriveTitle(content: string): string {
  const firstLine = content
    .split("\n")
    .find((l) => l.trim().length > 0)
    ?.trim();
  return firstLine ? firstLine.slice(0, 50) : "(제목 없음)";
}

/**
 * 원본 노드 metadata 빌드 — extraMetadata 먼저 펼치고 고정 칸(title/tags/protectUntil)을
 * 뒤에 둬 고정 칸이 우선하게 한다. plain·immediate 두 갈래가 같은 칸 구성을 쓰도록 공유.
 *
 * SA-0 — 공유 기억 신뢰 상태(args.sharedMemory, saveSharedMemoryInput 만 채움)도
 * extraMetadata 뒤에 둔다. 클라이언트 칸과 서버 신뢰 칸이 한 칸을 나눠 쓰지 않게 해,
 * 원본 metadata 의 sharedMemory 는 서버가 만든 값만 될 수 있다.
 *
 * Task 6 — protectUntil(원문에서 보호 기한 추출, memories.ts:201/441 선례) 도 여기서
 * 합류시킨다. 원문에 "2026년 12월" 같은 보호 기한이 있으면 metadata.protectUntil 로
 * 보존해 trash-manager 가 그 시점까지 자동 삭제하지 않게 한다. /memories·/ingest 글
 * 둘 다 같은 규칙을 받는다(D1).
 */
export function buildOriginMetadata(
  args: SaveTextInputArgs,
  title: string,
): Record<string, unknown> {
  const protectUntil = extractProtectUntil(args.content);
  return {
    ...(args.extraMetadata ?? {}),
    ...(args.sharedMemory !== undefined ? { sharedMemory: args.sharedMemory } : {}),
    title,
    ...(args.hashtags && args.hashtags.length > 0
      ? { tags: args.hashtags }
      : {}),
    ...(protectUntil ? { protectUntil } : {}),
  };
}

/**
 * plain 갈래 — 원본 먼저 저장 + 조건부 청크 + attribution/mentions. 긴 글 / extractor
 * 미가용 / mode≠immediate 가 모두 이 갈래. immediate 추출은 안 한다(긴 글 청크는
 * backfill 스케줄러가 처리). Task 3 골격 그대로.
 *
 * inputSource — 원문의 직접 저장 출처(WP-B1-20T). 원문이 새로 저장되든 같은 본문 노드에
 * 흡수되든 그 노드에 이 출처 행이 남는다. 청크·regex 원자는 원문의 파생(계보)이다.
 */
export async function saveOriginThenChunks(
  store: SqliteMemoryStore,
  args: SaveTextInputArgs,
  title: string,
  isLong: boolean,
  inputSource: NodeSourceRef,
  originEmbedding?: Float32Array,
): Promise<SaveTextInputResult> {
  // ── 1) 원본 노드 (안 잘림) ────────────────────────────────────────────────
  // source_type='auto_capture' — Task 4 가 자식으로 숨기는 목록
  // ('document_chunk'/'llm_extract'/'image_caption')에 들지 않게 한다(대표 노출).
  //
  // originEmbedding — 유사-중복 관문(T16)이 이미 계산한 이 글의 임베딩. 주입하면
  // addNodeIdempotent 가 embed 를 다시 부르지 않는다(단일 임베딩 불변식 — 글 1건
  // 저장당 embed 정확히 1회). 관문이 안 돌았으면 undefined 라 store 가 평소대로
  // 자기가 계산한다.
  const { id: originNodeId, reused } = await store.addNodeIdempotent({
    content: args.content,
    sourceType: AUTO_CAPTURE_SOURCE_TYPE,
    author: args.author,
    platform: args.source,
    memoryType: args.memoryType,
    importance: args.importance,
    project_id: args.projectId,
    metadata: buildOriginMetadata(args, title),
    embedding: originEmbedding,
    provenance: { kind: "source", source: inputSource },
  });

  // P0-A 입력 멱등성 — 같은 정규화 내용이 이미 있으면 origin 이 재사용된다. 청크·
  // mentions·author·hashtag·엔티티·regex atomic wiring 은 첫 저장 때 이미 됐으므로
  // 전부 skip 하고 재사용 origin 을 그대로 반환한다(spec §5.2 — 재사용 경로 wiring
  // skip). 긴 글이면 첫 저장 때 청크도 만들어졌으므로 재생성하지 않는다. 언급·출처 기록은
  // addNodeIdempotent 안에서 이미 됐다. cacheHit=true 로 라우트에 재사용을 알린다.
  if (reused) {
    return {
      kind: "memory",
      originNodeId,
      chunkNodeIds: [],
      nodeIds: [originNodeId],
      title,
      extracted: [],
      bumped: [],
      immediateExtractionRan: false,
      entities: [],
      warnings: [],
      cacheHit: true,
    };
  }

  // ── 2) 길이 조건부 청크 ────────────────────────────────────────────────────
  const chunkNodeIds = isLong
    ? await saveChunks(store, args, originNodeId)
    : [];

  // ── 3) attribution + 개념 mentions (POST /memories·/ingest 선례 정합) ───────
  await autoLinkMentions(store, { id: originNodeId, content: args.content });
  await linkAuthorPerson(store, {
    nodeId: originNodeId,
    author: args.author,
    platform: resolveInputPlatform(args),
    metadata: { user_id: args.userId ?? "", source: args.source },
  });

  // ── 3.5) 태그 개념 노드 wiring (입력 시점 1회 — spec §4.2 T2) ───────────────
  // mode·길이 무관 모든 입력이 origin 노드 하나에 태그를 연결한다. 청크는 비대상 —
  // 태그는 원본 글의 속성이라 origin 1노드에만 붙는다(청크당 중복 0). backfill 운영도
  // 이 입력 시점 wiring 으로 태그 개념 노드를 받는다(추출 사이클과 무관).
  await wireHashtagConceptsSafe(
    store,
    originNodeId,
    args.content,
    args.trigger,
    "saveTextInput",
  );

  await wireHashtagEntitiesSafe(
    store,
    originNodeId,
    args.content,
    args.trigger,
    "saveTextInput",
    new Date(),
  );

  // ── 3.6) 개념 엔티티 타입 배치 wiring (3단계 Task 5) ─────────────────────────
  // 위 개념 wiring 직후 같은 origin·content 로 신규 8 타입 배치를 돈다(판정 → 위계 →
  // 행 게이트 → 칸/라벨/identity). 호출 순서: 개념 wiring → 타입 배치. LLM 단은 null
  // (default OFF — 글 입력이 분류 LLM 호출만큼 느려지지 않게·settings 로 켤 구조만 남김).
  // Safe 래퍼라 배치 실패가 입력 저장을 통째 깨지 않는다(origin 은 이미 저장됨).
  await wireEntityPlacementSafe(
    store,
    originNodeId,
    args.content,
    args.trigger,
    "saveTextInput",
    null,
  );

  // ── 4) regex Level 0 atomic 저장 + 원본 연결 (Task 6 / D1) ──────────────────
  // regex 비활성·미가용·후보 0 이면 즉시 [] — 원본 흐름 그대로. 긴 글·짧은 글 둘 다
  // regex atomic 을 받는다(원문 전체에서 추출 — 청크와 무관, memories.ts 선례 정합).
  const regexAtomicIds = await linkRegexAtomicsSafe(
    store,
    originNodeId,
    extractRegexCandidates(args),
    args.memoryType,
    args.projectId ?? null,
  );

  return {
    kind: "memory",
    originNodeId,
    chunkNodeIds,
    nodeIds: [originNodeId, ...chunkNodeIds],
    title,
    // regex atomic 도 immediate LLM atomic 과 같이 extracted 로 노출한다 — 둘 다
    // 원본에 merged_into 된 추출 산출 노드라 nodeIds(저장 토대)와 분리한 계약 정합.
    extracted: regexAtomicIds,
    bumped: [],
    // plain 갈래 = immediate LLM 추출 미가동(긴 글 / backfill / 미가용 / 실패 fallback).
    immediateExtractionRan: false,
    entities: [],
    warnings: [],
    cacheHit: false,
  };
}

/**
 * 긴 글의 검색용 청크를 원본 자식 노드로 저장한다. 청크는 원문의 파생(chunkProvenance)이라
 * parent_of 계보 엣지는 저장소 흡수 규칙이 청크 INSERT 와 함께 쓴다(WP-B1-20T). 호출처가
 * isLong 판정 후에만 부른다. chunkDocument 는 문단 기준 분해라 청크가 여러 개 나온다.
 *
 * 청크는 원본의 공유 기억 상태(수명·출처 사건)를 이어받되 evidenceRefs 는 받지 않는다.
 * evidenceRefs 는 원본 작성자가 원본에 선언한 근거라, 청크의 근거는 parent_of 계보뿐이다.
 * 이어받는 출처는 서버 신뢰 칸(args.sharedMemory)뿐이다(SA-0) — 클라이언트 metadata 는
 * 청크 상태를 정하지 못한다.
 */
async function saveChunks(
  store: SqliteMemoryStore,
  args: SaveTextInputArgs,
  originNodeId: number,
): Promise<number[]> {
  const provenance = chunkProvenance(originNodeId);
  const chunkNodeIds: number[] = [];
  for (const chunkArgs of chunkNodeArgs(args, originNodeId)) {
    chunkNodeIds.push(await store.addNode({ ...chunkArgs, provenance }));
  }
  return chunkNodeIds;
}

/** 편집 뒤 재청크 결과 — 무엇을 했는지 호출자·테스트가 읽는다. */
export type RechunkOutcome =
  /** auto_capture 원문이 아니거나 현재 기억이 아니다 — 바꾸지 않았다. */
  | "not_origin"
  /** active 청크가 현재 본문을 나타낸다(태그만 바뀐 편집 등) — 바꾸지 않았다. */
  | "chunks_current"
  /** 청크를 만든 적이 없고 추출 대기도 아니다 — 바꾸지 않았다. */
  | "no_chunks"
  /** 긴 본문 — 새 청크를 만들었다. 청크가 추출 단위다. */
  | "rechunked"
  /** 짧은 본문 — 원문이 추출 대기라 백필이 원문을 직접 추출한다. */
  | "direct_candidate";

export interface RechunkEditedOriginResult {
  outcome: RechunkOutcome;
  /** 이번에 만든 청크 노드 id. */
  chunkNodeIds: number[];
}

/**
 * 편집 뒤 원문의 청크를 현재 본문에 맞춘다(SL-2). 편집 라우트와 MCP update_memory 가 쓰기
 * 잠금 안에서 rewireEditedNodeContent 를 거쳐 부른다.
 *
 *   - 주장이 바뀐 편집(추출 대기 0 — 편집 트랜잭션이 기록): 옛 청크는 편집 무효화가 이미
 *     철회했다. 긴 본문이면 새 청크를 만들고 대기 표시를 거둔다. 짧은 본문이면 원문이 그대로
 *     직접 추출 후보다.
 *   - 대기 표시가 없는데 active 청크 없이 계보 무효화된 청크만 남은 원문: 철회 뒤 같은 본문으로
 *     되살렸거나, 이 수정 이전의 편집이 청크를 거둔 글이다. 긴 본문이면 다시 나누고, 짧은
 *     본문이면 추출 대기로 표시해 직접 후보로 되돌린다.
 *   - 그 밖(active 청크가 있거나 청크를 만든 적이 없는 글)은 바꾸지 않는다. 사용자가 직접
 *     철회한 청크(계보 무효화 표시 없음)는 다시 만들지 않는다.
 *
 * 새 청크 상태는 원문의 현재 신뢰 상태에서 파생한다(evidenceRefs 없음, 새 노드라 revision 0).
 */
export async function rechunkEditedOrigin(
  store: SqliteMemoryStore,
  nodeId: number,
  chunking: SaveTextChunkingSettings | undefined,
): Promise<RechunkEditedOriginResult> {
  const origin = await store.getNode(nodeId);
  const state = store.nodeRepo.getOriginChunkState(nodeId);
  if (!origin || !state) {
    throw new Error(`rechunkEditedOrigin: memory ${nodeId} not found after edit`);
  }
  if (origin.sourceType !== AUTO_CAPTURE_SOURCE_TYPE || !isCurrentMemory(origin.metadata)) {
    return { outcome: "not_origin", chunkNodeIds: [] };
  }
  const long = exceedsChunkTokenCap(origin.content, chunking);
  if (state.pending) {
    if (!long) return { outcome: "direct_candidate", chunkNodeIds: [] };
    // 이 수정 전 재청크는 청크 쓰기와 대기 표시 거두기를 따로 커밋했다. active 청크가 이미 있으면
    // 그 재청크가 대기 표시를 거두기 전에 멈춘 것이다.
    if (state.activeChunk) {
      store.nodeRepo.clearExtractionPending(nodeId);
      return { outcome: "chunks_current", chunkNodeIds: [] };
    }
    const chunkNodeIds = await writeOriginChunksAtomic(store, origin, chunking, { clearPending: true });
    return { outcome: "rechunked", chunkNodeIds };
  }
  if (state.activeChunk) return { outcome: "chunks_current", chunkNodeIds: [] };
  if (!state.invalidatedChunk) return { outcome: "no_chunks", chunkNodeIds: [] };
  if (!long) {
    store.nodeRepo.markExtractionPending(nodeId);
    return { outcome: "direct_candidate", chunkNodeIds: [] };
  }
  const chunkNodeIds = await writeOriginChunksAtomic(store, origin, chunking, { clearPending: false });
  return { outcome: "rechunked", chunkNodeIds };
}
