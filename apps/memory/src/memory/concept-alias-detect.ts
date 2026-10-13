/**
 * concept-alias-detect.ts — D2 개념 별칭 후보 판정 (Phase 6b T8, spec 8.3).
 *
 * concept_vec(distance_metric=cosine) ANN 으로 뽑은 후보 행을 입력받아,
 * cosine 임계값(모델별 EMBEDDING_ALIAS_THRESHOLDS)으로 별칭 후보를 가려내는
 * 판정 함수들. 판정 자체는 DB·임베딩 의존이 없어 데이터 fixture 로 검증
 * 가능하다(인터페이스 구현체 mock 안 만듦).
 *
 * 같은 이름은 name UNIQUE 라 자동 합류(findOrCreateConcept)되므로 검출 대상이
 * 아니다 — 이름이 다르면서 의미가 같은 후보만 가린다(사용자 결정 1).
 */

import {
  aliasThresholdOf,
  DEFAULT_EMBEDDER_MODEL,
} from "../embedding/factory.ts";

/**
 * 별칭 후보 임계값. cosine ≥ 이 값이면 같은 의미의 다른 표현으로 보고
 * concept_alias_suggestions 에 후보로 적재한다(spec 8.3 / 사용자 결정 1).
 *
 * 값은 모델별 단일 출처 EMBEDDING_ALIAS_THRESHOLDS(factory.ts)에서 현 운영
 * default 모델로 결정된다 — bge-m3 = 0.68 (2026-07-10 실측, 결정 근거는 맵
 * 주석). 옛 직접 기재값 0.95 는 제거된 Granite(384-dim) 보정값이라 bge-m3
 * 운영에서 검출이 정지 상태였다.
 */
export const CONCEPT_ALIAS_THRESHOLD = aliasThresholdOf(DEFAULT_EMBEDDER_MODEL);

/**
 * concept_vec(distance_metric=cosine) 의 distance 를 cosine 유사도로 변환한다.
 * sqlite-vec cosine distance = 1 − cosine_similarity 이므로 cosine = 1 − distance.
 */
export function cosineFromDistance(distance: number): number {
  return 1 - distance;
}

/**
 * cosine 이 임계값 이상이면 별칭 후보(true). 경계값(=threshold)은 포함한다(≥).
 */
export function isAliasCandidate(
  cosine: number,
  threshold: number = CONCEPT_ALIAS_THRESHOLD,
): boolean {
  return cosine >= threshold;
}

/** concept_vec KNN 한 행 — concept_rowid + concept_id + name + distance. */
export interface AnnConceptRow {
  conceptRowid: number;
  conceptId: string;
  name: string;
  distance: number;
}

/** 별칭 후보 한 건 — concept_id + 변환된 cosine. */
export interface AliasCandidate {
  conceptId: string;
  conceptRowid: number;
  name: string;
  cosine: number;
}

export interface FilterAliasOptions {
  /** 기준(새) 개념의 rowid — 자기 자신은 후보에서 뺀다. */
  selfRowid: number;
  /** 기준(새) 개념의 이름 — 같은 이름(자동 합류 대상)은 후보에서 뺀다. */
  selfName: string;
  threshold?: number;
  limit?: number;
}

/** 이름 비교용 정규화 — concept_nodes.name 관례(lowercase + trim)에 맞춘다. */
function normalizeName(name: string): string {
  return name.toLowerCase().trim();
}

/**
 * ANN 후보 행 → 별칭 후보 목록. self(rowid 동일) 제외 + 같은 이름(정규화 후
 * 동일) 제외 + cosine 임계값 미달 제외. cosine 내림차순 정렬 후 limit 적용.
 */
export function filterAliasCandidates(
  rows: readonly AnnConceptRow[],
  options: FilterAliasOptions,
): AliasCandidate[] {
  const threshold = options.threshold ?? CONCEPT_ALIAS_THRESHOLD;
  const selfName = normalizeName(options.selfName);

  const candidates = rows
    .filter((r) => r.conceptRowid !== options.selfRowid)
    .filter((r) => normalizeName(r.name) !== selfName)
    .map((r) => ({
      conceptId: r.conceptId,
      conceptRowid: r.conceptRowid,
      name: r.name,
      cosine: cosineFromDistance(r.distance),
    }))
    .filter((c) => isAliasCandidate(c.cosine, threshold))
    .sort((a, b) => b.cosine - a.cosine);

  if (options.limit !== undefined && options.limit >= 0) {
    return candidates.slice(0, options.limit);
  }
  return candidates;
}
