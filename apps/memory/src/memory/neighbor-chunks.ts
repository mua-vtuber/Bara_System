/**
 * 인접 청크 묶기 조립 (Phase 14b T2 / 14.5).
 *
 * 검색 결과로 한 청크(중심)만 나오면 앞뒤 맥락이 끊기므로, 같은 문서의 인접
 * 청크를 함께 묶어 보여준다. 이 모듈은 그 *순수 후처리 조립* 만 담당한다 —
 * 한 결과 청크 + 그 인접 청크 배열을 받아, 중심을 기준으로 앞·뒤를 번갈아
 * 더하되 누적 토큰이 maxContextTokens(default 2000)를 넘기 직전에 멈춘다.
 *
 * 순수 함수 — DB·임베딩·store 의존 0. 인접 청크 조회(store.getNeighborChunks)
 * 와 문서 제목·전체 청크 수 채움은 Task 3 의 search 라우트가 한다. 이 모듈은
 * 청크 자료(parentId·centerIndex)만 documentRef 에 담는다.
 *
 * token 추정: 기존 token-counter.ts 의 estimateTokens 재사용(CJK-aware BPE
 * 근사). 새 토큰 추정기를 만들지 않는다.
 */

import { estimateTokens } from "./token-counter.ts";
import type { DocumentChunkMetadata } from "./document-chunk-metadata.ts";

/** maxContextTokens 디폴트(spec 7.1). settings.chunking.maxContextTokens 와 동일 값. */
export const DEFAULT_MAX_CONTEXT_TOKENS = 2000;

/** 한 인접 청크 — store.getNeighborChunks 반환 형태(Task 1). */
export interface NeighborChunk extends DocumentChunkMetadata {
  id: number;
  chunkIndex: number;
  content: string;
}

/**
 * 중심(결과) 청크 입력. parentId·chunkIndex 가 없으면 document_chunk 가 아닌
 * 일반 메모리 노드 — 묶기 대상이 아니다(빈 결과 + documentRef null 로 회신).
 */
export interface CenterChunk {
  content: string;
  parentId: string | null;
  chunkIndex: number | null;
}

/** assembleNeighborContext 입력 묶음. */
export interface AssembleArgs {
  center: CenterChunk;
  neighbors: NeighborChunk[];
  /** 누적 토큰 상한. 생략 시 DEFAULT_MAX_CONTEXT_TOKENS(2000). */
  maxContextTokens?: number;
}

/** 묶기 결과 — 채택된 인접 청크 + 문서 참조. */
export interface NeighborContext {
  neighbors: NeighborChunk[];
  /** 청크 자료(parentId·centerIndex). 일반 노드 입력이면 null. */
  documentRef: { parentId: string; centerIndex: number } | null;
}

/**
 * 중심 청크 + 인접 청크 배열을 받아 토큰 한도 안에서 묶는다.
 *
 * 번갈아 greedy 규칙:
 *  1. 인접 청크를 중심과의 거리(|chunkIndex - centerIndex|)별로, 같은 거리면
 *     앞(작은 chunkIndex)을 뒤보다 먼저 보게 정렬한다.
 *  2. 그 순서로 하나씩 누적 토큰에 더하되, 더했을 때 maxContextTokens 를
 *     *넘기면* 그 청크는 채택하지 않고 멈춘다(greedy stop — 더 멀리 있는
 *     청크도 같이 멈춤. 가까운 맥락 우선이라 그게 자연스럽다).
 *  3. 채택된 청크를 최종적으로 chunkIndex 오름차순으로 정렬해 회신한다
 *     (표시 순서는 문서 순서대로).
 *
 * 일반 노드 입력(parentId 또는 chunkIndex 없음) → 빈 neighbors + documentRef
 * null(정직한 빈 상태). maxContextTokens 0 이하 → 빈 neighbors(절제 극단도
 * 정직 — documentRef 는 유효 청크면 채운다).
 */
export function assembleNeighborContext(args: AssembleArgs): NeighborContext {
  const { center, neighbors } = args;
  const maxContextTokens = args.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;

  // 일반 메모리 노드 — document_chunk 가 아니면 묶기 대상이 아니다.
  if (center.parentId === null || center.chunkIndex === null) {
    return { neighbors: [], documentRef: null };
  }

  const documentRef = {
    parentId: center.parentId,
    centerIndex: center.chunkIndex,
  };

  // 한도가 0 이하면 인접을 하나도 묶지 않는다(documentRef 는 유효 청크라 채움).
  if (maxContextTokens <= 0 || neighbors.length === 0) {
    return { neighbors: [], documentRef };
  }

  const centerIndex = center.chunkIndex;

  // 번갈아 순서로 정렬 — (가까운 거리 먼저, 같은 거리면 앞쪽 먼저).
  const ordered = [...neighbors].sort((a, b) => {
    const da = Math.abs(a.chunkIndex - centerIndex);
    const db = Math.abs(b.chunkIndex - centerIndex);
    if (da !== db) return da - db;
    // 같은 거리(앞/뒤 한 쌍) — 앞(작은 chunkIndex)을 먼저.
    return a.chunkIndex - b.chunkIndex;
  });

  // 거리 가까운 청크부터 누적 토큰에 더하다 한도 넘기 직전 멈춘다.
  const picked: NeighborChunk[] = [];
  let usedTokens = 0;
  for (const chunk of ordered) {
    const chunkTokens = estimateTokens(chunk.content);
    if (usedTokens + chunkTokens > maxContextTokens) {
      break;
    }
    usedTokens += chunkTokens;
    picked.push(chunk);
  }

  // 표시 순서는 문서 순서대로(chunkIndex 오름차순).
  picked.sort((a, b) => a.chunkIndex - b.chunkIndex);

  return { neighbors: picked, documentRef };
}
