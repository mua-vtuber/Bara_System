/**
 * candidate-query.ts — 깊은 패스 1단계 후보 검출 (Phase 7 cleanup-deep-pass / Task 2).
 *
 * 권위: docs/decisions/2026-06-05-phase7-cleanup-deep-pass-regex-strengthen-spec.md 단락 3
 *       docs/decisions/2026-06-05-phase7-cleanup-deep-pass-regex-strengthen-plan.md Task 2
 *
 * 무엇을 찾나: "정규식이 약한 자리". LLM 추출기는 그 raw 글에서 atomic 을 만들어
 * 냈는데(= 건질 의미가 있다고 LLM 이 판단), 현재 정규식 세트로 같은 글을 다시 돌리면
 * 0매치인 raw 원본을 줍는다. 그런 글이 바로 새 정규식 양식을 제안할 닻이다.
 *
 * 흐름 한 줄:
 *   SQL 1차(auto_capture raw + merged_into 자식이 llm_extract + 이미 regex_pattern_add
 *   제안 없음) 로 후보를 줄이고 → 주입된 RegexL0Extractor.extract 로 결정적으로 0매치인
 *   것만 최종 후보로 남긴다 → 각 후보에 그 raw 의 llm_extract 자식 내용(atomics)을 단다.
 *
 * 정규식 재실행을 SQL 이 아니라 코드에서 하는 이유: 정규식 세트는 yaml+builtin+사용자
 * DB 병합 캐시라 SQL 만으로는 흉내 낼 수 없다. SQL 은 값싼 1차 거름(자식 유무·제안
 * 유무)만 맡고, 비싼 정규식 판정은 실 추출기에 맡긴다.
 *
 * 선호(memory_type='preference') 배제(spec H 후반): 선호는 원문 보존 트랙(openhuman
 * memory_protocol.rs:81-90 선례)이라 이 후보 검출 대상이 아니다. 1차 SQL 이
 * memory_type != 'preference' 로 미리 거른다.
 *
 * 사용 이력 소비 정렬(spec 5-5): 이 raw 풀이 batchSize LIMIT 을 넘길 수 있는 stage 라
 * ORDER BY 표현식이 실제로 어느 후보가 이번 패스에 들어가는지를 가른다. "오래 안
 * 열어본 글일수록 먼저" + "자주 열어본 글일수록 뒤로 미룸" 을 한 식으로 합친다(openhuman
 * hotness ×2.0 on query hits / langgraph refresh_on_read 선례 — 계속 조회되는 기억은
 * 정의상 아직 유효하니 정리 후보 앞순위에서 뺀다). 자세한 식과 COALESCE 근거는
 * ACCESS_ORDER_EXPR 주석 참조.
 */

import type { Database } from "bun:sqlite";
import type { RegexL0Extractor } from "../regex-l0/extractor.ts";
import type { MemoryType } from "../types.ts";

/**
 * 선호 트랙 배제 값(spec H 후반 / openhuman memory_protocol.rs:81-90 선례) —
 * 선호는 원문 보존 트랙이라 정규식 강화 후보(=원문을 재작성·병합할 후보)의 대상이
 * 아니다. `MemoryType` 합집합에서 값을 가져와 리터럴 오기를 막는다.
 */
const EXCLUDED_MEMORY_TYPE: MemoryType = "preference";

/**
 * 사용 이력 소비 정렬 키(spec 5-5) — "오래 안 열어본 글일수록 먼저, 자주 열어본
 * 글일수록 뒤로 미룸" 을 한 숫자로 합친 ORDER BY 표현식.
 *
 *   strftime('%s', COALESCE(kn.last_accessed_at, kn.created_at)) + kn.access_count * 86400
 *
 * 읽는 법:
 *   - strftime('%s', ...) 로 last_accessed_at(KST datetime 문자열)을 unix epoch 초로
 *     바꾼다 — 오래 전일수록 값이 작다(ASC 정렬 시 먼저 옴).
 *   - kn.access_count * 86400(하루치 초) 을 더해 조회 횟수만큼 정렬 키를 미래로
 *     민다(damping) — 자주 열어본 글은 실제 last_accessed_at 이 아무리 오래됐어도
 *     access_count 가 쌓일수록 뒤로 밀려난다. 1회당 하루어치 가중은 "적당히 자주
 *     열어본 글"(수 회~수십 회) 이 "몇 달 방치된 글" 보다 항상 뒤로 가도록 잡은
 *     값이다(하드코딩 상수지만 damping 강도 자체가 이 spec 의 설계값 — 튜닝 필요
 *     시 이 상수 하나만 바꾸면 두 stage 모두 반영).
 *   - COALESCE(kn.last_accessed_at, kn.created_at) — knowledge_nodes.last_accessed_at
 *     은 스키마상 NOT NULL DEFAULT(생성 시 created_at 과 동일 값으로 채워짐 — 기준 스키마)
 *     라 오늘 시점 NULL 행은 생기지 않는다. 그래도 미래에 이 컬럼이 nullable 로
 *     바뀌거나 raw INSERT 가 컬럼을 생략하는 경로가 생겨도 "한 번도 안 열어본 글 =
 *     가장 오래된 취급" 이 조용히 깨지지 않도록 명시적으로 방어한다(정직 가드).
 *   - ORDER BY 마지막 tie-breaker 로 kn.id ASC 를 둬 같은 정렬 키 행도 결정적 순서를
 *     보장한다(기존 관례 정합).
 *
 * idx_kn_last_accessed(last_accessed_at) 인덱스가 COALESCE·strftime 식 자체는 못
 * 태우지만(표현식 인덱스 아님), WHERE 절의 다른 조건(source_type·memory_type 등)이
 * 먼저 행을 줄인 뒤 이 식으로 정렬하므로 batchSize 규모에서 비용은 무시할 만하다.
 */
const ACCESS_ORDER_EXPR =
  "strftime('%s', COALESCE(kn.last_accessed_at, kn.created_at)) + kn.access_count * 86400";

/**
 * regex_pattern_add 제안 kind 단일 출처. Task 3(사이클 글루가 제안 insert)·Task 6
 * (approve 분기)·이 모듈의 멱등 제외 SQL 이 모두 이 상수를 import 한다 — 문자열을
 * 여러 곳에 직접 기재하지 않는다(하드코딩 격리).
 */
export const REGEX_PATTERN_ADD_KIND = "regex_pattern_add";

/** 한 후보 raw — id·원문·추출기가 뽑은 atomic 내용(LLM 입력 닻). */
export interface MissedCandidate {
  /** raw 노드 id(knowledge_nodes.id). */
  id: number;
  /** raw 원문(정규식 0매치 확인을 거친 글). */
  content: string;
  /** 그 raw 에서 추출된 llm_extract 자식 내용 목록(Task 3 LLM 입력 닻). */
  atomics: string[];
}

interface RawRow {
  id: number;
  content: string;
}

/**
 * 추출기 atomic 이 달린 auto_capture raw 중, 현재 정규식 세트로 0매치인 것만 회신한다.
 * 이미 regex_pattern_add 제안이 있는 노드는 제외(status 무관 멱등 — 거절된 것 재제안
 * 차단). batchSize 로 한 패스 처리량을 제한한다.
 *
 * 정렬(spec 5-5): ACCESS_ORDER_EXPR ASC, kn.id ASC — 이 stage 는 auto_capture raw 전체
 * 모집단이 batchSize 를 쉽게 넘길 수 있어(일상 대화가 계속 쌓임) ordering 이 실제로
 * "이번 패스에 뭐가 들어가는가" 를 가른다. 오래 안 열어본 raw 부터 정규식 강화
 * 후보로 우선 처리한다 — 자주 열어보는 글은 이미 사용자가 검색 등으로 계속 마주치는
 * 글이라 정규식 보강 급함이 낮다고 본다(spec 5-5 기준).
 *
 * @param db        store.getRawDb() 핸들(실 SQLite).
 * @param extractor 실 RegexL0Extractor(0.1초 마감 / LLM·임베딩 호출 0). 정규식 0매치
 *                  판정을 결정적으로 한다.
 * @param batchSize 한 패스 후보 최대 수(설정값 — 하드코딩 0).
 */
export function findRegexMissedCandidates(
  db: Database,
  extractor: RegexL0Extractor,
  batchSize: number,
): MissedCandidate[] {
  // 1차 SQL: auto_capture raw + (llm_extract 자식이 merged_into 로 달림) + (regex_pattern_add
  // 제안 아직 없음). 엣지 방향은 scheduler.ts addEdge 정합 — child 가 source_id, raw 가
  // target_id, relation='merged_into'. 멱등 제외는 metadata-infer-cycle.ts queryCandidates
  // 의 JSON 추출 관용구(CAST(... ->> '$.sourceNodeId' AS INTEGER)) 와 정합.
  const rows = db
    .prepare(
      `SELECT kn.id AS id, kn.content AS content
       FROM knowledge_nodes kn
       WHERE kn.source_type = 'auto_capture'
         AND kn.memory_type != ?
         AND EXISTS(
           SELECT 1 FROM knowledge_edges e
           JOIN knowledge_nodes child ON child.id = e.source_id
           WHERE e.target_id = kn.id
             AND e.relation = 'merged_into'
             AND child.source_type = 'llm_extract'
         )
         AND NOT EXISTS(
           SELECT 1 FROM cleanup_proposals cp
           WHERE cp.kind = ?
             AND CAST(cp.payload_json ->> '$.sourceNodeId' AS INTEGER) = kn.id
         )
       ORDER BY ${ACCESS_ORDER_EXPR} ASC, kn.id ASC
       LIMIT ?`,
    )
    .all(EXCLUDED_MEMORY_TYPE, REGEX_PATTERN_ADD_KIND, batchSize) as RawRow[];

  const out: MissedCandidate[] = [];
  for (const r of rows) {
    // 비싼 판정 — 실 정규식 세트로 0매치인 글만 남긴다.
    //
    // 후보에서 뺄 기준 = 정규식이 이 글을 *조금이라도 잡으면*(ignore 레벨 매치 포함)
    // 제외한다. ignore 매치(점수 ≤2 라 저장 안 됨)는 정규식 양식 *모양*은 이미 있고
    // 점수만 낮은 글 — 그건 새 양식이 아니라 booster(점수 올리기)로 풀 일이고, booster
    // 자동 추가는 이 feature 범위 밖(보류, spec §0). 새 양식 제안은 *어떤 양식도
    // 안 걸리는* 글만 대상으로 한다(걸리는 글에 새 양식을 내면 Task 1 하네스의 중복
    // 게이트 — 현재 양식이 예문 매치 — 가 거절해 강한 모델 LLM 호출만 낭비한다).
    //
    // 그래서 candidates.length(ignore 포함)로 거른다 — decision 별로 가르지 않는다.
    if (extractor.extract(r.content).candidates.length > 0) continue;
    out.push({ id: r.id, content: r.content, atomics: readAtomics(db, r.id) });
  }
  return out;
}

/**
 * 한 raw 의 llm_extract 자식 내용 목록을 읽는다(merged_into child→raw). Task 3 가
 * 이 atomics 를 LLM 입력 닻으로 쓴다 — "추출기는 이만큼을 건졌는데 정규식은 0이니,
 * 이 글에서 어떤 양식을 새로 만들 수 있나" 판단의 근거.
 */
function readAtomics(db: Database, rawId: number): string[] {
  const rows = db
    .prepare(
      `SELECT child.content AS content
       FROM knowledge_edges e
       JOIN knowledge_nodes child ON child.id = e.source_id
       WHERE e.target_id = ?
         AND e.relation = 'merged_into'
         AND child.source_type = 'llm_extract'
       ORDER BY child.id ASC`,
    )
    .all(rawId) as { content: string }[];
  return rows.map((x) => x.content);
}
