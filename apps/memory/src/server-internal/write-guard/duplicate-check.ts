/**
 * write-guard/duplicate-check.ts — 저장 시 유사-중복(near-duplicate) 차단
 * (T16 / 결정 D-A + spec D).
 *
 * 정확히 같은 글은 이미 content_hash 흡수가 막는다(P0-A 입력 멱등성). 그런데
 * AI 클라이언트는 같은 사실을 매번 조금씩 다른 문장으로 다시 저장한다 — 토씨만
 * 바꾼 문장은 해시가 달라 흡수를 통과하고, DB 에 사실상 같은 기억이 여러 벌
 * 쌓인다. 이 관문은 그 틈을 임베딩 유사도로 막는다.
 *
 * 관문이 하는 판단은 하나다: 들어온 글이 기존 기억 중 하나와 임계 이상으로
 * 닮았으면 저장하지 않고 `DuplicateMemoryError` 를 던진다. 조용히 흡수하지
 * 않고 에러로 알리는 이유는, 호출자(AI)가 "이미 있으니 그 기억을 갱신할지 /
 * 그래도 새로 남길지(force)"를 판단할 수 있어야 하기 때문이다 — 조용한 흡수는
 * 저장했다고 착각하게 만든다.
 *
 * ── 단일 임베딩 불변식(구현 불변식 / 브리핑 규칙 2) ──────────────────────────
 * 저장 경로는 어차피 보존용으로 글을 임베딩한다. 이 검사는 **그 임베딩을 새로
 * 계산하지 않고 재사용한다** — 검사 때문에 임베딩 호출이 한 번 더 늘어나면
 * 모든 저장이 두 배로 비싸진다. 그래서 이 모듈이 임베딩을 *한 번* 계산해
 * (a) KNN 조회에 쓰고 (b) 통과 시 그 벡터를 호출자에게 돌려줘 저장 INSERT 에
 * 그대로 주입시킨다(addNodeIdempotent 의 `args.embedding` 통로). 글 1건 저장당
 * embed 호출은 정확히 1회다.
 *
 * 비용은 임베딩 재사용 + sqlite-vec top-1 조회 한 번뿐이다. LLM 은 어디에도
 * 쓰지 않는다(D-D 승인 비용).
 *
 * ── 프로젝트 경계(T16 수정 1회차) ────────────────────────────────────────────
 * 비교는 **같은 project_id 안에서만** 한다. 전역으로 견주면 두 가지가 깨진다:
 * (1) 같은 글을 두 번째 프로젝트에 남기는 것이 불가능해진다 — 정확-중복 흡수는
 * (content_hash, project_id) 스코프라 해시 프리체크를 정상 통과하는데, 그 뒤
 * 전역 KNN 이 다른 프로젝트의 같은 글을 유사도 1.0 으로 잡아 거부해 버린다.
 * (2) 회신 details 에 남의 프로젝트 노드 id 와 본문 발췌가 실려 나간다(기억
 * 경계 유출). project 는 노드 정체성의 1급 스코프이므로(D8) 흡수 키와 같은
 * 기준으로 가른다.
 */

import type { SqliteMemoryStore } from "../../db/store.ts";
import { toNfc } from "../../memory/nfc.ts";

/** 회신 excerpt 로 실을 기존 기억 본문의 최대 글자 수. */
const EXCERPT_MAX_CHARS = 120;

/**
 * KNN 조회 개수. top-1 만 본다 — 임계를 넘는 가장 닮은 기억 하나면 호출자가
 * "이미 있다"를 판단하기에 충분하고, 더 받아봐야 쓰지 않는다(D-D 최소 비용).
 */
const DUPLICATE_KNN_K = 1;

/**
 * 유사-중복이 검출돼 저장을 거부할 때 던지는 에러. 호출처(REST 라우트 / MCP
 * 도구)가 이 타입을 알아보고 각자의 표현으로 매핑한다 — SecretDetectedError
 * (T15)와 같은 양식이다.
 *
 * details 에는 호출자가 다음 행동(기존 기억 갱신 / force 재시도)을 고를 수 있는
 * 최소 재료만 담는다: 기존 기억 id·닮은 정도·본문 발췌·작성 시각.
 */
export class DuplicateMemoryError extends Error {
  readonly existingId: number;
  readonly similarity: number;
  readonly excerpt: string;
  readonly existingCreatedAt: string;

  constructor(args: {
    existingId: number;
    similarity: number;
    excerpt: string;
    existingCreatedAt: string;
  }) {
    super(
      `이미 거의 같은 기억이 있어 저장하지 않았습니다(기존 id=${args.existingId}, ` +
        `닮은 정도 ${args.similarity.toFixed(3)}). 기존 기억을 고치려면 그 id 로 수정하고, ` +
        "다른 기억으로 따로 남기려면 force 를 켜서 다시 보내 주세요.",
    );
    this.name = "DuplicateMemoryError";
    this.existingId = args.existingId;
    this.similarity = args.similarity;
    this.excerpt = args.excerpt;
    this.existingCreatedAt = args.existingCreatedAt;
  }

  /** REST·MCP 가 공유하는 { code, message, details } 응답 본문. */
  toPayload(): {
    code: "DUPLICATE";
    message: string;
    details: {
      existingId: number;
      similarity: number;
      excerpt: string;
      existingCreatedAt: string;
    };
  } {
    return {
      code: "DUPLICATE",
      message: this.message,
      details: {
        existingId: this.existingId,
        similarity: this.similarity,
        excerpt: this.excerpt,
        existingCreatedAt: this.existingCreatedAt,
      },
    };
  }
}

/** 유사-중복 검사 동작을 정하는 설정 — 호출처가 호출 시점 최신 snapshot 에서 읽어 넘긴다. */
export interface DuplicateCheckOptions {
  /**
   * 검사를 가동할지. 미지정이면 가동(fail-safe) — 설정을 아직 안 넘기는
   * 호출처에서 방어가 조용히 꺼지면 안 된다(writeGuard.secretRejection 과 같은 규칙).
   */
  enabled?: boolean;
  /**
   * 차단 임계 사용자 오버라이드. 음수(-1 sentinel) = 미지정이라 모델 연동
   * factory 값(storeDuplicateThresholdOf)을 쓴다. 0..1 로 명시하면 그 값이
   * 이긴다 — settings.search.baselineVectorCosine 과 같은 sentinel 규칙.
   */
  threshold?: number;
}

/** 검사를 통과했을 때의 산출 — 계산한 임베딩을 저장 경로가 재사용하도록 돌려준다. */
export interface DuplicateCheckResult {
  /**
   * 이 글의 임베딩. 호출자는 이것을 store 저장 인자의 `embedding` 으로 그대로
   * 넘겨 재계산을 막는다(단일 임베딩 불변식). 검사가 꺼져 있어 임베딩을 계산할
   * 이유가 없었으면 undefined — 그때는 저장 경로가 평소대로 자기가 계산한다.
   */
  embedding?: Float32Array;
}

/**
 * 유사-중복 관문 — 들어온 글이 기존 기억과 임계 이상 닮았으면 저장을 막는다.
 *
 * 통과하면 계산한 임베딩을 담아 돌려준다(저장 INSERT 가 재사용). 검사가 꺼져
 * 있으면 임베딩 계산조차 하지 않고 빈 결과를 돌려준다 — "검사는 하되 결과를
 * 무시"가 아니라 비용 자체가 0 이다(T15 관문 토글과 같은 계약).
 *
 * @throws {DuplicateMemoryError} 검사 가동 + 임계 이상 닮은 기존 기억 존재 시.
 */
export async function checkDuplicateBeforeStore(
  store: SqliteMemoryStore,
  content: string,
  threshold: number,
  projectId: string | null,
  options?: DuplicateCheckOptions,
  /**
   * 같은 본문으로 이 함수가 이미 계산한 임베딩(WP-B1-08 — 잠금 밖 준비에서 한 번 검사하고 잠금
   * 안에서 다시 검사할 때). 있으면 임베딩을 다시 계산하지 않고 KNN 조회만 다시 한다.
   */
  precomputedEmbedding?: Float32Array,
): Promise<DuplicateCheckResult> {
  // 미지정 = 가동(fail-safe). 명시적으로 false 를 넘긴 경우에만 건너뛴다.
  if (options?.enabled === false) return {};

  // 임베딩 1회 계산 — 아래 KNN 조회와 (통과 시) 저장 INSERT 가 이 한 벡터를 공유한다.
  // store.embedder 단일 출처를 그대로 쓴다(저장 경로가 쓰는 그 임베더와 같은 것이라야
  // 벡터를 저장에 재사용할 수 있다).
  //
  // **NFC 정규화 후 임베딩한다**(G3-a 정규화 경계 / T16 수정 1회차). 저장 본체
  // addNodeIdempotent 는 `toNfc(content)` 를 임베딩·해시·INSERT 세 곳에 쓴다 —
  // 여기서 원문 그대로 임베딩해 그 벡터를 저장에 재사용시키면, NFD 로 들어온
  // 입력에서 저장된 content(NFC)와 저장된 벡터(NFD)가 서로 다른 정규화 상태로
  // 갈린다. 눈에 안 보이게 어긋나므로 같은 문자열에서 나오도록 여기서 맞춘다.
  const embedding = precomputedEmbedding ?? await store.embedder.embed(toNfc(content));

  // **같은 프로젝트 안에서만** 견준다(T16 수정 1회차). 전역 KNN 이면 다른
  // 프로젝트의 기억이 후보로 잡혀, 같은 글을 두 번째 프로젝트에 남기는 것이
  // 막히고(정확-중복 흡수는 project 스코프라 해시 프리체크를 통과해 여기 온다)
  // 남의 프로젝트 노드 id·발췌가 회신에 실려 나간다(기억 경계 유출). 흡수 키가
  // (content_hash, project_id) 인 것과 같은 정신 — project 는 노드 정체성의
  // 1급 스코프다(D8).
  const hits = await store.searchByVectorInProject(
    embedding,
    DUPLICATE_KNN_K,
    projectId,
  );
  const top = hits[0];
  if (top === undefined) return { embedding };

  // vec_nodes 는 cosine distance 라 유사도 = 1 - distance (기준 스키마
  // distance_metric=cosine). 검색 채널이 쓰는 환산과 같은 식이다.
  const similarity = 1 - top.distance;
  if (similarity < threshold) return { embedding };

  // 임계를 넘었다 — 기존 기억의 본문·시각을 읽어 호출자가 판단할 재료를 싣는다.
  // 노드가 사라졌으면(경합) 막을 근거가 없으므로 정직하게 통과시킨다.
  const existing = await store.getNode(top.nodeId);
  if (!existing) return { embedding };

  throw new DuplicateMemoryError({
    existingId: top.nodeId,
    similarity,
    excerpt: truncateExcerpt(existing.content),
    existingCreatedAt: existing.createdAt,
  });
}

/**
 * 기존 기억 본문을 회신용 발췌로 자른다. 호출자가 "정말 같은 기억인가"를
 * 눈으로 판단할 만큼만 싣고 응답을 부풀리지 않는다. 잘렸으면 말줄임표를 붙여
 * 뒤에 더 있음을 표시한다(잘린 글을 전문으로 오해하지 않게).
 */
export function truncateExcerpt(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length <= EXCERPT_MAX_CHARS
    ? flat
    : `${flat.slice(0, EXCERPT_MAX_CHARS)}…`;
}

/**
 * 설정 sentinel 을 실제 임계로 푼다 — 음수(미지정)면 모델 연동 factory 값,
 * 0..1 로 명시됐으면 그 사용자값이 이긴다(baselineVectorCosine 과 같은 규칙).
 * 호출처가 factory 값을 이미 읽어 modelThreshold 로 넘긴다.
 */
export function resolveDuplicateThreshold(
  modelThreshold: number,
  override?: number,
): number {
  return override !== undefined && override >= 0 ? override : modelThreshold;
}
