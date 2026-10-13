/**
 * search-repo-filters — 검색 후보 축소·필터 자유 함수(search-repository 3분할 / C1).
 *
 * SearchRepository 의 "필터·축소" 책임을 db 를 첫 인자로 받는 자유 함수로 떼어냈다.
 * retriever 가 채널 hits 를 모은 뒤 RRF 합산 *전* 후보 pool 을 줄이는 통과 Set 필터
 * (polarity·분류 값·글-칸·장소·pending_review·시간 범위·memory_type)와, 장소 소프트
 * 가산 점수·장소 leaf 이름 목록·시간 범위 출발 집합이 모인다. RRF 동등 합산 코어
 * (rrf.ts)는 한 글자도 안 건드린다 — 입력 후보만 줄이는 결정적 SQL 연산이다.
 *
 * 동작 보존(behavior-preserving): 함수 본체·SQL·NULL 처리·정규화 규칙은 옛 클래스
 * 메서드와 byte 동일하다(this.db → db·this.likeContains → likeContains 치환만).
 * SearchRepository 의 같은 이름 메서드가 이 함수들에 위임한다(외부 호출 표면 보존).
 */

import type { Database } from "bun:sqlite";
import type { MemoryType, Polarity } from "../../memory/types.ts";

// ── polarity 한정 query 필터 (D7 / spec 5.5 / 1.1c T3) ────────────────────

/**
 * 후보 node_id 목록에서 polarity 가 일치하는 것만 남긴 Set 을 반환한다.
 *
 * NULL 처리 규칙(plan Mock Policy / 회귀 함정 4): knowledge_nodes.polarity 가
 * NULL 인 노드는 *제외* 한다. polarity 필터를 *지정한* 호출자는 라벨된 자산만
 * 원하므로, NULL 제외는 데이터 누락 마스킹이 아니라 의도된 필터 의미다. body
 * 에 polarity 칸이 *없을* 때(필터 미적용)는 retriever 가 이 함수를 아예
 * 호출하지 않는다 — 두 경우(미지정 vs NULL)를 호출 여부로 구분한다.
 *
 * graceful: 후보 중 일치 노드가 0개면 빈 Set(에러 아님 / "그 polarity 라벨
 * 자산 없음" = 정직한 빈 상태). 운영 DB 는 현재 write 경로 0건이라 전 노드
 * polarity = NULL — polarity 필터가 거의 전부를 제외하는 것은 (a) 결정(자동
 * 채움 Phase 6 cleanup-AI)의 알려진 귀결이다. 빈 결과를 fallback 으로 채우지 않는다.
 *
 * 결정적 연산 — LLM 호출 0. 단일 SQL 조회(IN + polarity = ?).
 */
export function filterNodeIdsByPolarity(
  db: Database,
  nodeIds: readonly number[],
  polarity: Polarity,
): Set<number> {
  if (nodeIds.length === 0) return new Set();
  const placeholders = nodeIds.map(() => "?").join(",");
  // polarity = ? 는 SQLite 에서 polarity NULL 행을 자동 제외한다(NULL = ? 는
  // 항상 false). 그래서 라벨 없는 노드는 결과에 안 들어온다 — NULL 제외 규칙 충족.
  const rows = db
    // dynamic SQL: placeholder count varies, keep prepare()
    .prepare(
      `SELECT id FROM knowledge_nodes
         WHERE id IN (${placeholders}) AND polarity = ?`,
    )
    .all(...nodeIds, polarity) as Array<{ id: number }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * polarity 가 일치하는 글 node_id 를 후보 없이 전 노드에서 직접 선별한 Set
 * (T4 통과 집합 적응형 공급). filterNodeIdsByPolarity 의 전역 변형 짝 — 비교
 * 조건·NULL 제외 규칙은 글자 그대로 같고 `id IN (후보)` 절만 없다.
 *
 * NULL 처리는 후보형과 동일하다: `polarity = ?` 가 NULL 행을 자동 제외하므로
 * 라벨 없는 글은 안 잡힌다(라벨된 자산만 — 의도된 필터 의미). 운영 DB 는 현재
 * 전 노드 polarity = NULL 이라 이 조회가 거의 빈 Set 을 내는데, 그것이 곧 이
 * 필터를 지정한 검색의 정직한 답이다(빈 결과를 fallback 으로 안 채운다).
 *
 * graceful: 일치 0건이면 빈 Set(에러 아님). 결정적 연산 — LLM 호출 0.
 */
export function selectNodeIdsByPolarity(
  db: Database,
  polarity: Polarity,
): Set<number> {
  const rows = db
    .query("SELECT id FROM knowledge_nodes WHERE polarity = ?")
    .all(polarity) as Array<{ id: number }>;
  return new Set(rows.map((r) => r.id));
}

// ── 학술 분류 필터 (spec 5.7 / 1.1c T4) ───────────────────────────────────

/**
 * 분류 *값 문자열* → concept_nodes.name UNIQUE 조회 → 그 concept 에 연결된
 * 자산 node_id 를 role 무관(classification·tag·mention 전부)으로 회수한 Set.
 *
 * role 무관 매칭(spec 3.5.5 line 333): `#만화` 태그(role='tag')와 `review:만화`
 * 분류(role='classification')가 같은 `만화` concept 노드를 가리키므로, 두 통로로
 * 들어간 자산이 한 query 로 둘 다 잡힌다. name UNIQUE 자동 통합 — 별 traversal
 * 없이 같은 이름 = 같은 노드.
 *
 * 입력 값은 findOrCreateConcept 가 저장 시점에 lowercase 정규화한 name 과
 * 맞추려 toLowerCase().trim() 한다(concept-repository.ts L117/L169 정합).
 *
 * graceful: 값에 매칭되는 concept 가 0개면 빈 Set(에러 아님 / "그 분류로 라벨된
 * 자산 없음" = 정직한 빈 상태 / spec 5.7 Mock Policy). 빈 결과를 fallback 으로
 * 채우지 않는다. concept_nodes / node_concept_edges 테이블이 *없는* schema 누락
 * 상태면 prepare/all 단계 SQLite 가 던지는 구체 에러를 가리지 않는다.
 *
 * 결정적 연산 — LLM 호출 0. 단일 JOIN 조회(name 매칭 → node_id).
 */
export function getNodeIdsByConceptName(db: Database, value: string): Set<number> {
  const name = value.trim().toLowerCase();
  if (!name) return new Set();
  // concept_nodes.name UNIQUE → 그 concept 의 모든 node_concept_edges(role 무관).
  // 같은 이름 = 같은 노드라 분류·태그 통로 자산이 한 매칭으로 통합된다.
  const rows = db
    .query(
      `SELECT e.node_id AS node_id
         FROM concept_nodes c
         JOIN node_concept_edges e ON e.concept_id = c.concept_id
         WHERE c.name = ?`,
    )
    .all(name) as Array<{ node_id: number }>;
  return new Set(rows.map((r) => r.node_id));
}

// ── 글-칸 매칭 (활용 단계6 T4 / 검색 종류·칸 거름망 캡슐) ──────────────────

/**
 * metadata_json.fields.<키> === <값> 인 글 node_id Set 을 반환한다(T4 fieldFilters).
 * 키·값 trim 후 정확 일치. 빈 키·빈 값·매칭 0건이면 빈 Set(정직한 빈 상태).
 */
export function getNodeIdsByMetadataField(
  db: Database,
  key: string,
  value: string,
): Set<number> {
  const k = key.trim();
  const v = value.trim();
  const out = new Set<number>();
  if (!k || !v) return out;
  // 거친 LIKE 프리필터 — fields 안에 키와 값 토큰이 둘 다 등장하는 글로 줄인다
  // (정확성은 아래 JSON.parse 검증에 있다 / 다른 키·값 조합이 substring 합치는
  // 갈래는 parse 단계가 거른다). JSON.stringify 로 키·값을 JSON 인코딩해 따옴표
  // 양식을 metadata_json 직렬화와 맞춘다(예: "항목":"우유"). slice(1,-1)은 바깥
  // 따옴표를 떼 내부 인코딩 문자열만 LIKE 토큰으로 쓴다.
  const keyPattern = `%${JSON.stringify(k).slice(1, -1)}%`;
  const valPattern = `%${JSON.stringify(v).slice(1, -1)}%`;
  const rows = db
    .query(
      `SELECT id, metadata_json FROM knowledge_nodes
         WHERE metadata_json LIKE ? AND metadata_json LIKE ?`,
    )
    .all(keyPattern, valPattern) as Array<{
    id: number;
    metadata_json: string | null;
  }>;
  for (const r of rows) {
    let meta: Record<string, unknown>;
    try {
      const parsed = JSON.parse(r.metadata_json ?? "{}") as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      meta = parsed as Record<string, unknown>;
    } catch {
      continue; // 깨진 metadata_json 은 매칭 아님(정직 — 가짜 매칭 안 만듦).
    }
    const fields = meta.fields;
    if (
      fields &&
      typeof fields === "object" &&
      !Array.isArray(fields) &&
      (fields as Record<string, unknown>)[k] === v
    ) {
      out.add(r.id);
    }
  }
  return out;
}

// ── 장소 소프트 검색 점수 (활용 단계4 T1 / search-field-filter D2) ──────────

/**
 * LIKE '%값%' 부분일치 패턴을 만든다. 값 안의 LIKE 메타문자(% _ \)를 ESCAPE '\'
 * 로 리터럴화해, 사용자가 친 '%' 가 와일드카드로 새지 않게 한다(정확성·가드).
 */
function likeContains(needle: string): string {
  const escaped = needle.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

/**
 * 장소 leaf 개념 이름 부분일치(+ place 두 경로 OR)로 매칭된 글 node_id 마다
 * 0..1 소프트 가산 점수를 담은 Map 을 반환한다(D2). 정확 일치=1.0, 부분 일치는
 * 매칭 길이 비율(< 1.0). 빈 값·매칭 0건이면 빈 Map(정직한 빈 상태).
 */
export function searchPlaceNodeScores(
  db: Database,
  value: string,
): Map<number, number> {
  const needle = value.trim().toLowerCase();
  const result = new Map<number, number>();
  if (!needle) return result;
  // 장소 leaf 개념 두 경로 OR + 부분일치 → 그 leaf 를 classification 으로 매단 글
  // node_id 와 leaf 이름(점수 계산용)을 회수한다. UNION 으로 두 경로 중복 노드를
  // 한 행으로 합친다(같은 leaf 면 같은 node_id·name 이라 점수 동일).
  const rows = db
    // dynamic SQL: 없음 — LIKE 패턴은 ? 바인딩(SQL injection 가드).
    .query(
      `SELECT nce.node_id AS node_id, c.name AS name
           FROM concept_nodes c
           JOIN node_concept_edges nce
             ON nce.concept_id = c.concept_id AND nce.role = 'classification'
           JOIN hierarchy_edges he
             ON he.target_id = c.concept_id AND he.relation = 'parent_of'
           JOIN concept_nodes ckey
             ON ckey.concept_id = he.source_id
            AND ckey.is_classification_key = 1
            AND ckey.name = '장소'
          WHERE c.name LIKE ? ESCAPE '\\'
         UNION
         SELECT nce.node_id AS node_id, c.name AS name
           FROM concept_nodes c
           JOIN node_concept_edges nce
             ON nce.concept_id = c.concept_id AND nce.role = 'classification'
           JOIN entity_concept_edges pce
             ON pce.concept_id = c.concept_id AND pce.role = 'identity'
           JOIN entities pe
             ON pe.entity_id = pce.entity_id AND pe.type_name = 'place'
          WHERE c.name LIKE ? ESCAPE '\\'`,
    )
    .all(likeContains(needle), likeContains(needle)) as Array<{
    node_id: number;
    name: string;
  }>;
  for (const r of rows) {
    const leafLen = r.name.length;
    if (leafLen === 0) continue; // 빈 leaf 이름은 0 나눗셈 방지(정상 데이터엔 없음).
    // 점수 = 검색 값 길이 / leaf 이름 길이(부분문자열이라 0..1). 정확 일치 = 1.0.
    const score = Math.min(1, needle.length / leafLen);
    const prev = result.get(r.node_id);
    if (prev === undefined || score > prev) result.set(r.node_id, score);
  }
  return result;
}

/**
 * 저장된 장소 leaf 개념 이름 목록을 DISTINCT 로 반환한다(활용 단계4 T4 / D3).
 *
 * searchPlaceNodeScores(위)의 *목록 짝* — 그 함수가 한 값으로 매칭 글을 찾는다면,
 * 여기는 자연어 신호 추출(resolvePlaceSignal)이 query 안에서 장소 이름을 찾도록
 * *저장된 장소 이름 전부* 를 회신한다. 같은 장소 판정(has_place 두 경로 OR)을 써서
 * 직접 입력(entity_concept_edges role='identity' + entities type_name='place')·추론
 * (concept 위계) 장소를 모두 포함한다(단계4 T4 통합 엣지 이전·옛 place_concept_edges
 * 폐기) — place 엔티티 행만 보는 단순 목록이 추론 장소를 놓치는 한계를 닫는다(D3 leaf 통로).
 *
 * 회신 이름은 concept_nodes.name(저장 시점 toLowerCase 정규화값)이다. 호출자가
 * query 부분일치에 쓰므로 정렬은 *이름 길이 내림차순*(긴 이름 우선 — 구체적 우선)으로
 * 줘 호출자가 가장 긴 매칭을 먼저 만나게 한다(D3 "가장 긴 이름 우선" 보조).
 *
 * 장소 0건이면 빈 배열(정직한 빈 상태 — 에러 아님). 결정적 연산 — LLM 0. 단일 SQL
 * (두 경로 UNION). 검색마다 1회 호출이라 값싸다(장소 수가 코퍼스 글 수보다 훨씬 작음).
 */
export function listPlaceLeafNames(db: Database): string[] {
  const rows = db
    .query(
      `SELECT DISTINCT name FROM (
           SELECT c.name AS name
             FROM concept_nodes c
             JOIN hierarchy_edges he
               ON he.target_id = c.concept_id AND he.relation = 'parent_of'
             JOIN concept_nodes ckey
               ON ckey.concept_id = he.source_id
              AND ckey.is_classification_key = 1
              AND ckey.name = '장소'
           UNION
           SELECT c.name AS name
             FROM concept_nodes c
             JOIN entity_concept_edges pce
               ON pce.concept_id = c.concept_id AND pce.role = 'identity'
             JOIN entities pe
               ON pe.entity_id = pce.entity_id AND pe.type_name = 'place'
         )
         ORDER BY length(name) DESC, name ASC`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

// ── pending_review 검색 비노출 필터 (6a T9.5 / 사용자 결정 #5) ─────────────

/**
 * 후보 node_id 목록에서 pending_review 가 *아닌* 노드만 남긴 Set 을 반환한다.
 *
 * `pending_review=true` 인 노드만 제외한다. metadata 에 칸이 없거나(일반 노드·
 * auto_store regex atomic), `false` 이거나, metadata 가 비어 추출값이 NULL 인
 * 노드는 모두 통과한다(`IS NULL OR != true` 정신).
 *
 * JSON boolean 추출 실측(buildRegexMetadata 의 `pending_review: true` →
 * JSON.stringify → boolean true → metadata_json TEXT): SQLite 의
 * `metadata_json->>'$.pending_review'` 는 JSON boolean true 를 *정수 1* 로
 * 추출한다(문자열 'true' 가 아니다 — `->` 가 'true', `->>` 가 1/0). 그래서
 * 제외 조건은 추출값이 정수 1(=JSON true)인 행이다. false 는 0, 없음·빈
 * metadata 는 NULL 로 추출되어 자연 통과한다.
 *
 * 회귀 0 경로(plan 핵심 acceptance): pending_review 노드가 0건인 DB(6a 전 운영
 * 상태 — write 경로가 이 칸을 안 만들었음)에서는 IN 목록의 모든 행이 NULL/0 으로
 * 추출되어 전 후보가 통과한다 → 후보 pool 이 한 노드도 줄지 않고 기존 검색
 * 결과·점수가 완전히 동일하다.
 *
 * 결정적 연산 — LLM 호출 0. 단일 SQL 조회(IN + metadata_json->> 비교).
 */
export function filterOutPendingReview(
  db: Database,
  nodeIds: readonly number[],
): Set<number> {
  if (nodeIds.length === 0) return new Set();
  const placeholders = nodeIds.map(() => "?").join(",");
  // 추출값이 NULL(없음·빈 metadata)이거나 정수 1(JSON true)이 *아닌* 행만 남긴다.
  // SQLite 의 ->> 는 JSON true 를 정수 1 로, false 를 0 으로 추출한다.
  const rows = db
    // dynamic SQL: placeholder count varies, keep prepare()
    .prepare(
      `SELECT id FROM knowledge_nodes
         WHERE id IN (${placeholders})
           AND (metadata_json->>'$.pending_review' IS NULL
                OR metadata_json->>'$.pending_review' != 1)`,
    )
    .all(...nodeIds) as Array<{ id: number }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * pending_review 가 *아닌* 글 node_id 를 후보 없이 전 노드에서 직접 선별한 Set
 * (T4 벡터 채널 필터 pushdown). filterOutPendingReview 의 *전역 변형* 짝 — 판정
 * 규칙(추출값이 NULL 이거나 정수 1 이 아닌 행만 통과)은 글자 그대로 같고, 차이는
 * `id IN (후보)` 절이 없다는 것뿐이다.
 *
 * 왜 전역 변형이 필요한가: pushdown 은 순서가 뒤집힌다. 사후 필터는 "채널이 뽑은
 * 후보를 줄이는" 일이라 후보 목록을 받지만, pushdown 은 채널을 돌리기 *전* 에
 * 통과 집합을 알아야 그것을 KNN 에 밀어 넣을 수 있다 — 그래서 후보 없이 조건만으로
 * 전 노드를 훑는 짝이 필요하다.
 *
 * 비용(실측 2026-08-03 / WSL·bun 1.3.6·knowledge_nodes 5000행): 0.505 ms/query.
 * metadata_json->> 추출식이라 색인을 못 타고 SCAN 이지만, 이 조회가 없애는 KNN
 * 비용(현행 4.389 → pushdown 2.314 ms)이 그보다 커서 전체는 오히려 빨라진다.
 *
 * graceful: 통과 0건이면 빈 Set(에러 아님 — 정직한 빈 상태). 결정적·LLM 0.
 */
export function selectNodeIdsNotPendingReview(db: Database): Set<number> {
  const rows = db
    .query(
      `SELECT id FROM knowledge_nodes
         WHERE metadata_json->>'$.pending_review' IS NULL
            OR metadata_json->>'$.pending_review' != 1`,
    )
    .all() as Array<{ id: number }>;
  return new Set(rows.map((r) => r.id));
}

// ── 검색 시간 범위 hard filter (Phase 7 갈래 1 / Task 5) ──────────────────

/** 저장 구간 시작 칼럼 — 사건 시작 우선, 미상이면 등록 시각. */
const RANGE_START_COLUMN = "COALESCE(event_at, created_at)";

/** 저장 구간 끝 칼럼 — 종료 우선, 없으면 시작(순간), 그것도 없으면 등록 시각. */
const RANGE_END_COLUMN = "COALESCE(event_until, event_at, created_at)";

/**
 * 후보 node_id 목록에서 저장 구간 [시작, 끝] 이 검색 구간 [since, until]
 * 닫힌 구간(양 끝 포함)과 겹치는 노드만 남긴 Set 을 반환한다.
 *
 * since·until 은 ISO 날짜(YYYY-MM-DD, eventDateRange 산출). 저장 시작·끝은
 * 시각 포함(YYYY-MM-DDT<HH>:<MM>)일 수 있고 created_at 은 시각까지 담는다.
 * 검색 범위가 날짜 단위라 양쪽을 date() 로 날짜만 절삭해 비교한다(시각은
 * 표시·정렬용으로만 살린다).
 *
 * 겹침 판정(닫힌 구간):
 *   date(시작) < date(until, '+1 day')   AND   date(끝) >= date(since)
 * until 의 '+1 day' 는 until 당일을 포함하기 위한 상한 보정이다.
 *
 * 순간 일정(event_until NULL): 끝=시작 → [시작,시작] 한 점. 한 점 검색을 쓰던
 * 때와 결과가 같다(회귀 0). 구간 일정만 시작·끝 사이 중간 날짜 검색에 걸린다.
 *
 * NULL 처리: event_at·event_until·created_at 이 모두 비면 COALESCE 가 NULL 이라
 * 비교 false → 자연 제외. 운영상 created_at 은 NOT NULL 이라 정상 노드는 항상
 * 비교 대상이 된다.
 *
 * graceful: 후보 중 범위 일치 0개면 빈 Set(에러 아님 — 정직한 빈 상태).
 * 결정적 연산 — LLM 호출 0. 단일 SQL 조회(IN + 구간 겹침 비교).
 */
export function filterNodeIdsByDateRange(
  db: Database,
  nodeIds: readonly number[],
  since: string,
  until: string,
): Set<number> {
  if (nodeIds.length === 0) return new Set();
  const placeholders = nodeIds.map(() => "?").join(",");
  const startCol = RANGE_START_COLUMN;
  const endCol = RANGE_END_COLUMN;
  const rows = db
    // dynamic SQL: placeholder count varies, keep prepare()
    .prepare(
      `SELECT id FROM knowledge_nodes
         WHERE id IN (${placeholders})
           AND date(${startCol}) < date(?, '+1 day')
           AND date(${endCol}) >= date(?)`,
    )
    .all(...nodeIds, until, since) as Array<{ id: number }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * 저장 구간 [시작, 끝] 이 검색 구간 [since, until] 닫힌 구간과 겹치는 글
 * node_id 를 *후보 없이 전 노드에서 직접* 선별해 Set 으로 반환한다(활용 단계5
 * T2 / compute-path D3). filterNodeIdsByDateRange 의 *출발 집합* 짝 — 그
 * 함수가 후보 Set 을 받아 *축소* 한다면, 여기는 칸이 날짜 하나뿐일 때
 * 후보 자체를 만든다(계산 경로 D3 "기간·장소·프로젝트 중 첫 칸이 출발 집합").
 *
 * 같은 겹침 판정·같은 RANGE 칼럼을 쓰므로 filterNodeIdsByDateRange 와 결과가
 * 일관된다 — 차이는 IN(후보) 절이 없다는 것뿐이다. 집계 폭주 가드로 limit 을
 * 받는다(가장 최근 글부터). limit 0 이하면 빈 Set.
 *
 * graceful: 범위 일치 0개면 빈 Set(에러 아님 — 정직한 빈 상태). 결정적·LLM 0.
 * knowledge_nodes 테이블 누락은 SQLite 구체 에러를 전파(빈 Set 위장 안 함).
 */
export function selectNodeIdsByDateRange(
  db: Database,
  since: string,
  until: string,
  limit: number,
): Set<number> {
  if (limit <= 0) return new Set();
  const startCol = RANGE_START_COLUMN;
  const endCol = RANGE_END_COLUMN;
  const rows = db
    .query(
      `SELECT id FROM knowledge_nodes
         WHERE date(${startCol}) < date(?, '+1 day')
           AND date(${endCol}) >= date(?)
         ORDER BY ${startCol} DESC, id DESC
         LIMIT ?`,
    )
    .all(until, since, limit) as Array<{ id: number }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * 저장 구간이 [since, until] 닫힌 구간과 겹치는 글 node_id 를 후보 없이 전 노드에서
 * *상한 없이* 선별한 Set(T4 벡터 채널 필터 pushdown). filterNodeIdsByDateRange 의
 * 전역 변형 짝 — 겹침 판정·RANGE 칼럼은 글자 그대로 같고 `id IN (후보)` 절만 없다.
 *
 * 옆에 있는 selectNodeIdsByDateRange 와 다른 점은 **limit 이 없다** 는 것 하나다.
 * 그쪽은 계산 경로(compute-path D3)의 *출발 집합* 이라 "가장 최근 글부터 N개"로
 * 잘라도 의미가 성립하지만, pushdown 통과 집합은 자르면 안 된다 — 잘린 id 는 KNN
 * 후보에서 통째로 사라져 "필터는 통과하는데 검색에 안 잡히는" 조용한 누락이 된다.
 * 그래서 두 함수를 합치지 않고 나란히 둔다(상한의 의미가 서로 반대다).
 *
 * 비용(실측 2026-08-03 / 5000행): 0.992 ms/query. date() 함수 비교라 색인을 못 타고
 * SCAN 이다 — 세 전역 조회 중 가장 비싸지만 절약하는 KNN 비용 안쪽이다.
 *
 * graceful: 겹침 0건이면 빈 Set(에러 아님 — 정직한 빈 상태). 결정적·LLM 0.
 */
export function selectAllNodeIdsByDateRange(
  db: Database,
  since: string,
  until: string,
): Set<number> {
  const startCol = RANGE_START_COLUMN;
  const endCol = RANGE_END_COLUMN;
  const rows = db
    .query(
      `SELECT id FROM knowledge_nodes
         WHERE date(${startCol}) < date(?, '+1 day')
           AND date(${endCol}) >= date(?)`,
    )
    .all(until, since) as Array<{ id: number }>;
  return new Set(rows.map((r) => r.id));
}

// ── memory_type 한정 query 필터 (1.2 / 1.1c filter 가족 정합) ──────────────

/**
 * 후보 node_id 목록에서 memory_type 이 일치하는 것만 남긴 Set 을 반환한다.
 *
 * filterNodeIdsByPolarity 의 정확한 짝 — 비교 칼럼만 memory_type 이다.
 * knowledge_nodes.memory_type 은 NOT NULL DEFAULT 'fact' 라 항상 값이 있으므로
 * (polarity 의 NULL 제외 같은 미묘함 없음), 단순히 일치 노드만 통과한다.
 *
 * graceful: 후보 중 일치 노드가 0개면 빈 Set(에러 아님 / "그 종류 자산 없음"
 * = 정직한 빈 상태). 빈 결과를 fallback 으로 채우지 않는다.
 *
 * 결정적 연산 — LLM 호출 0. 단일 SQL 조회(IN + memory_type = ?).
 */
export function filterNodeIdsByMemoryType(
  db: Database,
  nodeIds: readonly number[],
  memoryType: MemoryType,
): Set<number> {
  if (nodeIds.length === 0) return new Set();
  const placeholders = nodeIds.map(() => "?").join(",");
  const rows = db
    // dynamic SQL: placeholder count varies, keep prepare()
    .prepare(
      `SELECT id FROM knowledge_nodes WHERE id IN (${placeholders}) AND memory_type = ?`,
    )
    .all(...nodeIds, memoryType) as Array<{ id: number }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * memory_type 이 일치하는 글 node_id 를 후보 없이 전 노드에서 직접 선별한 Set
 * (T4 벡터 채널 필터 pushdown). filterNodeIdsByMemoryType 의 전역 변형 짝 —
 * 비교 조건은 글자 그대로 같고 `id IN (후보)` 절만 없다.
 *
 * 비용(실측 2026-08-03 / 5000행): 0.084 ms/query. 세 전역 조회 중 유일하게 색인을
 * 탄다 — EXPLAIN QUERY PLAN 이 `SEARCH knowledge_nodes USING COVERING INDEX
 * idx_kn_memory_type (memory_type=?)` 로, 본체 행을 안 읽고 색인만으로 답한다.
 *
 * graceful: 일치 0건이면 빈 Set(에러 아님 / "그 종류 자산 없음" = 정직한 빈 상태).
 * 결정적 연산 — LLM 호출 0.
 */
export function selectNodeIdsByMemoryType(
  db: Database,
  memoryType: MemoryType,
): Set<number> {
  const rows = db
    .query("SELECT id FROM knowledge_nodes WHERE memory_type = ?")
    .all(memoryType) as Array<{ id: number }>;
  return new Set(rows.map((r) => r.id));
}
