/**
 * memory/compute-candidates.ts — 칸 → 후보 node_id 교집합 조회 (활용 단계5 T2 / plan D3).
 *
 * 계산 경로가 받은 칸(종류·기간·장소·프로젝트)을 AND 교집합으로 좁혀 집계 대상
 * node_id Set 을 만든다. 단계4 가 깐 SQL 조회 통로를 그대로 재사용한다 — 신규 칸
 * 추출 0, 집계만 그 위에 얹는다(D2). 모든 조회는 store facade 를 거친다(직접 SQL 0).
 *
 * 칸별 통로(D2):
 *   - 종류   = store.getNodeIdsByConceptName(분류값) → Set (role 무관 매칭)
 *   - 날짜   = store.filterNodeIdsByDateRange(후보, since, until) → 후보 축소 /
 *             칸이 날짜뿐이면 store.selectNodeIdsByDateRange(since, until, limit) → 출발
 *   - 장소   = store.searchPlaceNodeScores(값).keys() → Set (소프트 점수 무시·키만)
 *   - 프로젝트 = store.getNodesByProjectId(projectId, limit) → number[]
 *
 * 출발 집합(D3): 종류 칸이 있으면 종류 매칭이 출발, 없으면 장소·프로젝트·날짜 중
 * 첫 칸이 출발(전 노드 풀스캔 회피). 그 뒤 나머지 칸으로 교집합 축소한다.
 * 칸이 하나도 없으면 빈 Set + needsCondition 신호 — 전 노드 SUM 같은 폭주를 막고
 * "조건이 필요하다"를 정직하게 알린다(가짜 0 아님 / Mock Policy).
 */
import type { SqliteMemoryStore } from "../db/store.ts";

/**
 * 집계 후보를 좁히는 칸. 전부 선택 — 주어진 칸만 교집합에 참여한다.
 * 빈 칸(undefined·빈 문자열)은 미적용(전 후보 통과 — 그 축으로는 안 좁힘).
 */
export interface ComputeFields {
  /** 종류(분류값) — concept_nodes.name 매칭. 예: '가계부'·'일정'. */
  conceptValue?: string;
  /** 기간 시작(ISO YYYY-MM-DD). since·until 둘 다 있어야 날짜 칸이 산다. */
  since?: string;
  /** 기간 끝(ISO YYYY-MM-DD). */
  until?: string;
  /** 장소(장소 leaf 이름·부분일치). 예: '강남'. */
  place?: string;
  /** 프로젝트 id(knowledge_nodes.project_id). */
  projectId?: string;
}

/** 후보 조회 결과 — 교집합 node_id Set + 칸 0개 신호. */
export interface ComputeCandidates {
  /** 집계 대상 후보 node_id 집합(AND 교집합). 칸 0개·매칭 0건이면 빈 Set. */
  candidates: Set<number>;
  /**
   * 칸이 하나도 주어지지 않았는가. true 면 candidates 는 빈 Set 이고, 호출자는
   * "조건 필요"를 정직하게 회신해야 한다(전 노드 폭주 차단 — 가짜 빈 결과 아님).
   */
  needsCondition: boolean;
}

/**
 * 집계 폭주 가드 상한. 날짜·프로젝트 단독 칸이 출발 집합일 때 끌어오는 후보 수의
 * 천장이다(전 노드 풀스캔 방지). 코어 코퍼스가 이 천장을 넘으면 가장 최근 글부터
 * 본다(selectNodeIdsByDateRange·getNodesByProjectId 가 최근 우선/LIMIT). 리터럴
 * 직접 기재를 피해 상수로 외부화한다(search-tuning 외부화 정신).
 */
export const COMPUTE_CANDIDATE_LIMIT = 5000;

/** since·until 이 둘 다 1자 이상 문자열일 때만 닫힌 날짜 칸으로 인정. */
function hasDateField(fields: ComputeFields): fields is ComputeFields & {
  since: string;
  until: string;
} {
  return (
    typeof fields.since === "string" &&
    fields.since.length > 0 &&
    typeof fields.until === "string" &&
    fields.until.length > 0
  );
}

/** 두 Set 의 교집합(작은 쪽을 순회). */
function intersect(a: Set<number>, b: Set<number>): Set<number> {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const out = new Set<number>();
  for (const id of small) if (large.has(id)) out.add(id);
  return out;
}

/**
 * 칸을 AND 교집합으로 좁혀 집계 후보 node_id Set 을 만든다(D3). 결정적·LLM 0.
 *
 * 절차:
 *   1. 종류·장소·프로젝트 칸이 있으면 각각 매칭 Set 을 만든다.
 *   2. 날짜 칸이 있으면, 다른 칸의 후보가 *있을 때* 그 후보를 날짜로 축소
 *      (filterNodeIdsByDateRange), 날짜가 *유일한* 칸이면 날짜로 출발 집합을
 *      만든다(selectNodeIdsByDateRange).
 *   3. 여러 Set 은 교집합으로 합친다(작은 쪽 순회).
 *   4. 칸이 하나도 없으면 빈 Set + needsCondition=true(폭주 차단·정직).
 *
 * @param store  조회 통로(facade). 모든 SQL 은 이 store 를 거친다.
 * @param fields 후보를 좁히는 칸(주어진 칸만 교집합 참여).
 * @param limit  단독 칸(날짜·프로젝트)의 후보 천장(기본 COMPUTE_CANDIDATE_LIMIT).
 */
export function resolveComputeCandidates(
  store: SqliteMemoryStore,
  fields: ComputeFields,
  limit: number = COMPUTE_CANDIDATE_LIMIT,
): ComputeCandidates {
  // 날짜를 제외한 "축소 가능" 칸 Set 들을 모은다(종류·장소·프로젝트).
  const sets: Set<number>[] = [];

  const concept = fields.conceptValue?.trim();
  if (concept) {
    sets.push(store.getNodeIdsByConceptName(concept));
  }

  const place = fields.place?.trim();
  if (place) {
    // searchPlaceNodeScores 는 소프트 점수 Map — 후보 축소엔 키(매칭 node_id)만 쓴다.
    sets.push(new Set(store.searchPlaceNodeScores(place).keys()));
  }

  const projectId = fields.projectId?.trim();
  if (projectId) {
    sets.push(new Set(store.getNodesByProjectId(projectId, limit)));
  }

  // 날짜 외 칸이 하나라도 있으면 그것들의 교집합이 출발, 날짜는 축소.
  if (sets.length > 0) {
    let candidates = sets[0]!;
    for (let i = 1; i < sets.length; i++) {
      candidates = intersect(candidates, sets[i]!);
    }
    if (hasDateField(fields) && candidates.size > 0) {
      candidates = store.filterNodeIdsByDateRange(
        [...candidates],
        fields.since,
        fields.until,
      );
    }
    return { candidates, needsCondition: false };
  }

  // 날짜가 유일한 칸 → 날짜로 출발 집합을 직접 만든다(폭주 가드 limit).
  if (hasDateField(fields)) {
    const candidates = store.selectNodeIdsByDateRange(
      fields.since,
      fields.until,
      limit,
    );
    return { candidates, needsCondition: false };
  }

  // 칸이 하나도 없음 → 조건 필요(전 노드 폭주 차단·정직).
  return { candidates: new Set(), needsCondition: true };
}
