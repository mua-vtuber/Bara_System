/**
 * memory/origin-chunks.ts — 원문(auto_capture)의 긴 글 판정과 청크 노드 모양·원자 재청크.
 *
 * 저장(server-internal/save-input-plain.ts saveChunks), 편집 뒤 재청크(rechunkEditedOrigin),
 * 백필의 긴 원문 재청크(memory/backfill-extraction.ts)가 이 한 기준을 쓴다. 도메인 계층
 * (memory/)이 server-internal/ 을 import 하지 않도록(계층 규율 G5-b) 여기 둔다 — server-internal
 * 이 이 모듈을 가져다 쓴다.
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import type { AddNodeArgs } from "../db/store-internal/args-types.ts";
import { chunkDocument, DEFAULT_TOKEN_CAP } from "./chunker.ts";
import { contentHash } from "./content-hash.ts";
import type { NodeProvenance } from "./node-sources/source-ref.ts";
import { toNfc } from "./nfc.ts";
import {
  inheritSharedMemoryForDerived,
  readSharedMemory,
  type SharedMemoryState,
} from "./shared-memory-contract.ts";
import { estimateTokens } from "./token-counter.ts";
import type { MemoryNode } from "./types.ts";

/** 청크 분해 설정 — settings.chunking 슬롯에서 동적으로 읽어 넘긴다. */
export interface ChunkingSettings {
  /** 청크 token 한도. 미지정 시 chunkDocument default(DEFAULT_TOKEN_CAP). */
  tokenCap?: number;
  /** 짧은 청크 병합 하한(token). 미지정 시 chunkDocument default(64). */
  minChunkTokens?: number;
}

/** 청크를 만드는 원문 칸 — 저장 입력(SaveTextInputArgs)과 원문 행에서 같은 모양으로 만든다. */
export interface OriginChunkSource {
  content: string;
  /** 입력 플랫폼·출처 — 청크 노드 platform 칸. */
  source: string;
  author?: string;
  projectId?: string | null;
  chunking?: ChunkingSettings;
  /** 원문의 서버 신뢰 상태. 청크는 evidenceRefs 를 뺀 상태를 이어받는다(SA-0). */
  sharedMemory?: SharedMemoryState;
}

/**
 * 긴 글 판정(D3) — 토큰 추정치가 청크 한도를 넘으면 원본에 검색·추출용 청크를 붙인다.
 * 한도 미지정 시 chunkDocument 와 같은 DEFAULT_TOKEN_CAP 을 쓴다(판정과 분해가 같은 한도).
 */
export function exceedsChunkTokenCap(
  content: string,
  chunking: ChunkingSettings | undefined,
): boolean {
  return estimateTokens(content) > (chunking?.tokenCap ?? DEFAULT_TOKEN_CAP);
}

/** 청크 노드 인자 — 저장(saveChunks)과 재청크(writeOriginChunksAtomic)가 같은 모양을 쓴다. */
export function chunkNodeArgs(args: OriginChunkSource, originNodeId: number): AddNodeArgs[] {
  const chunks = chunkDocument(args.content, {
    strategy: "paragraph",
    tokenCap: args.chunking?.tokenCap,
    minChunkTokens: args.chunking?.minChunkTokens,
  });
  const chunkSharedMemory = args.sharedMemory !== undefined
    ? inheritSharedMemoryForDerived(args.sharedMemory)
    : undefined;
  return chunks.map((chunk) => ({
    content: chunk.text,
    sourceType: "document_chunk",
    author: args.author,
    platform: args.source,
    project_id: args.projectId,
    metadata: {
      ...(chunkSharedMemory !== undefined ? { sharedMemory: chunkSharedMemory } : {}),
      parentNodeId: originNodeId,
      chunkIndex: chunk.index,
    },
  }));
}

/**
 * 청크의 출처 — 원문의 파생(parent_of, system). 청크 → 원문 계보 엣지는 저장소 흡수 규칙
 * (node-absorption.ts)이 청크 INSERT 와 같은 트랜잭션에서 쓴다(WP-B1-20T).
 */
export function chunkProvenance(originNodeId: number): NodeProvenance {
  return { kind: "derived", parentId: originNodeId, relation: "parent_of", edgeProvenance: "system" };
}

/**
 * 원문의 현재 본문을 새 청크로 나눠 한 트랜잭션으로 쓴다(WP-B1-31). 편집 뒤 재청크와 백필의
 * 긴 원문 재청크가 쓴다. 호출자는 쓰기 잠금을 쥐고 부른다.
 *
 * 청크 N개를 하나씩 커밋하면 중간 실패(임베딩 오류, 다른 연결이 DB 쓰기 잠금을 쥐어 난
 * SQLITE_BUSY)가 앞 청크만 남긴다. 그러면 원문에 살아 있는 청크가 생겨 백필 후보에서 빠지고
 * 나머지 본문은 영영 청크가 되지 않는다. 그래서 임베딩을 먼저 한 번에 계산하고(쓰기 없음),
 * 청크 노드·parent_of 엣지·대기 표시 거두기를 한 트랜잭션에서 쓴다. 실패하면 아무것도 쓰지
 * 않은 채 throw 한다 — 원문은 추출 대기(또는 청크 복구 대기) 그대로라 다음 백필이 다시 시도한다.
 * 문서 그래프 원자 쓰기(DocumentGraphRepository)와 같은 두 단계다.
 */
export async function writeOriginChunksAtomic(
  store: SqliteMemoryStore,
  origin: MemoryNode,
  chunking: ChunkingSettings | undefined,
  options: { clearPending: boolean },
): Promise<number[]> {
  const argsList = chunkNodeArgs(chunkSourceFromOrigin(origin, chunking), origin.id);
  if (argsList.length === 0) {
    throw new Error(`원문 ${origin.id}: 본문을 나눈 청크가 0개다`);
  }
  const contents = argsList.map((args) => toNfc(args.content));
  const vectors = await store.embedder.embedBatch(contents);
  if (vectors.length !== contents.length) {
    throw new Error(`원문 ${origin.id}: 청크 임베딩 수가 다르다(${vectors.length}/${contents.length})`);
  }
  for (const vector of vectors) {
    if (vector.length !== store.embedder.dimension) {
      throw new Error(
        `원문 ${origin.id}: 청크 임베딩 차원이 다르다(${vector.length}, 기대 ${store.embedder.dimension})`,
      );
    }
  }
  const provenance = chunkProvenance(origin.id);
  const chunkNodeIds = store.getRawDb().transaction((): number[] => {
    const ids = argsList.map((args, index) => {
      const content = contents[index]!;
      return store.nodeRepo.insertNodeWithVecSync(
        { ...args, provenance },
        content,
        contentHash(content),
        vectors[index]!,
      );
    });
    if (options.clearPending) store.nodeRepo.clearExtractionPending(origin.id);
    return ids;
  })();
  // commit 뒤 새 노드 1개당 1회 — addNode 경로와 같은 신호 횟수다.
  for (const _id of chunkNodeIds) store.nodeRepo.emitRawMemoryAdded();
  return chunkNodeIds;
}

/** 재청크 입력 — 원문 행에서 저장 때와 같은 칸을 만든다. 신뢰 상태는 원문의 현재 상태다. */
function chunkSourceFromOrigin(
  origin: MemoryNode,
  chunking: ChunkingSettings | undefined,
): OriginChunkSource {
  // 현재 원문(active)의 상태라 철회·대체 표시는 없다. 새 청크가 그런 칸을 이어받지 않게 뺀다.
  const { invalidatedBy: _invalidatedBy, supersededBy: _supersededBy, ...current } =
    readSharedMemory(origin.metadata);
  return {
    content: origin.content,
    source: origin.platform,
    author: origin.author,
    projectId: origin.projectId,
    chunking,
    sharedMemory: { ...current, revision: 0 },
  };
}
