/**
 * query-embedding-cache — 질의 임베딩 LRU 메모이즈 캐시 (감사 High: bge-m3.ts embed
 * 무메모이즈 → retrieve() 가 같은 질의 텍스트에도 매번 모델 재실행, 실측 37~60ms).
 *
 * 배치 결정 — *검색층* 질의 캐시(임베더 내장 아님):
 *   - 임베더(Bgem3Embedder.embed) 안에 넣으면 모든 호출자가 혜택을 보지만, ingest
 *     경로의 글 텍스트는 사실상 전부 유일해 LRU 를 밀어내기만 한다(churn). 반복이
 *     실제로 일어나는 곳은 *질의* 경로뿐이라, HybridRetriever 가 자기 인스턴스
 *     캐시로 baseQuery(project vocab 확장 *후* 텍스트)만 메모이즈한다.
 *   - 키 = 확장 후 텍스트 정확 일치. project vocab 이 바뀌면 확장 결과 텍스트가
 *     달라져 키도 달라진다 — vocab 변경에 따른 stale 적중이 구조적으로 불가능.
 *   - SearchCache(post-RRF 결과 캐시)는 키에 db_revision 이 들어가 글 하나만 추가돼도
 *     전부 무효화되지만, 질의→벡터 변환은 DB 상태와 무관한 순수 계산이라 이 캐시는
 *     db_revision 을 안 본다(무효화 불필요 — 같은 텍스트 = 항상 같은 벡터).
 *
 * 모델 교체 안전: 이 캐시는 HybridRetriever 의 인스턴스 필드로만 생성되고, retriever
 * 의 embedder 필드는 private readonly 라 살아있는 인스턴스에서 교체될 수 없다. 모델
 * 교체 = 새 embedder + 새 retriever 생성(운영은 settings 변경 + 재시작)이므로 다른
 * 차원의 stale 벡터가 나올 경로가 없다(EmbeddingDimMismatchError loud-fail 정책 유지).
 *
 * 별칭 오염 차단: get/set 모두 복사본으로 주고받는다. 호출자가 회신 벡터를 변형해도
 * 캐시 원본이 오염되지 않고, set 후 원본 배열을 변형해도 캐시가 안 바뀐다. 1024
 * float 복사는 마이크로초 수준 — 모델 재실행(37~60ms) 대비 무시 가능한 비용.
 *
 * 동시성: 같은 텍스트 두 검색이 겹쳐 둘 다 miss 면 embed 가 2회 돌 수 있다(현행
 * 무캐시 동작과 동일한 최악치). embed 는 결정적이라 어느 쪽이 set 하든 값이 같아
 * 정확성 문제는 없다 — in-flight promise 공유는 이 단일 사용자 서버에선 과설계라 뺐다.
 */

import type { Embedder } from "../embedding/types.ts";

/**
 * 캐시 항목 수 상한. 메모리 상한 계산: bge-m3 벡터 = 1024 float32 × 4B = 4KB/항목
 * → 128 항목 × 4KB = 최대 약 512KB(+ 키 문자열 소량) — 상주 비용 무시 가능.
 */
export const QUERY_EMBEDDING_CACHE_CAPACITY = 128;

export interface QueryEmbeddingCacheStats {
  hits: number;
  misses: number;
  size: number;
}

/**
 * 문자열 키 → Float32Array LRU 캐시. Map 의 삽입 순서를 최근 사용 순서로 유지한다
 * (get 적중 시 삭제 후 재삽입으로 승격, 용량 초과 시 가장 앞 = 가장 오래 안 쓰인
 * 항목 제거). hits/misses 카운터는 "두 번째 호출이 모델을 재실행하지 않았다"를
 * 테스트가 mock 없이 단언하는 통로다.
 */
export class QueryEmbeddingCache {
  private readonly entries = new Map<string, Float32Array>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly capacity: number = QUERY_EMBEDDING_CACHE_CAPACITY,
  ) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(
        `QueryEmbeddingCache capacity must be a positive integer, got ${capacity}`,
      );
    }
  }

  /** 적중 시 최근 사용으로 승격 후 복사본 회신. 미적중은 undefined + miss 집계. */
  get(text: string): Float32Array | undefined {
    const found = this.entries.get(text);
    if (found === undefined) {
      this.misses += 1;
      return undefined;
    }
    this.entries.delete(text);
    this.entries.set(text, found);
    this.hits += 1;
    return new Float32Array(found);
  }

  /** 복사본을 저장한다. 용량 초과 시 가장 오래 안 쓰인 항목 1개를 제거한다. */
  set(text: string, vec: Float32Array): void {
    // 같은 키 재저장은 승격을 겸한다 — 삭제 후 재삽입으로 최신 위치에 놓는다.
    this.entries.delete(text);
    this.entries.set(text, new Float32Array(vec));
    if (this.entries.size > this.capacity) {
      // set 은 한 번에 최대 1개만 늘리므로 1개 제거로 충분하다. size > capacity ≥ 1
      // 이면 첫 키가 반드시 존재한다 — undefined 분기는 타입 좁히기용일 뿐이다.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  stats(): QueryEmbeddingCacheStats {
    return { hits: this.hits, misses: this.misses, size: this.entries.size };
  }
}

/**
 * 캐시 경유 임베딩 — 적중이면 모델을 안 부르고 캐시 벡터(복사본)를, 미적중이면
 * embedder.embed 실행 후 결과를 캐시에 넣고 회신한다. embed 실패는 그대로 전파되고
 * 캐시에 아무것도 남기지 않는다(실패를 빈 값으로 눙치지 않음).
 */
export async function embedQueryCached(
  cache: QueryEmbeddingCache,
  embedder: Embedder,
  text: string,
): Promise<Float32Array> {
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  const vec = await embedder.embed(text);
  cache.set(text, vec);
  return vec;
}
