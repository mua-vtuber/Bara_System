/**
 * memory/compute-intent.ts — 집계 의도 값싼 규칙 감지 (활용 단계5 T1 / plan D1).
 *
 * query 에서 *집계 의도*("몇 번"·"목록"·"진행상황"·"언제")를 정규식으로 감지해
 * 어느 집계 종류(개수·목록·시간순·누적)인지 분류한다. LLM 호출 0 / 결정적 —
 * detectCues(search-cues.ts) 와 같은 값싼 규칙 양식이다. query 토큰을 추가·삭제
 * 하지 않고 query *전체* 를 정규식 검사만 한다(찾기 경로 0 diff 정신 그대로).
 *
 *   - 누적("진행상황"·"어디까지"·"현황")        → 'log'
 *   - 시간순("언제"·"며칠" + 날짜어 + "뭐 했"류) → 'timeline'
 *   - 개수("몇 번"·"몇 개"·"횟수"·"개수")        → 'count'
 *   - 목록("목록"·"뭐 샀"·"뭐 먹"·"뭐 했"·"리스트"·"나열") → 'list'
 *   - 매치 없음                                   → null(집계 의도 없음 → 찾기 경로)
 *
 * **수치 합계(SUM/평균)는 단계5 제외(Q1=C 사용자 확정).** "얼마"·"합계"·"총액"
 * 류 수치 집계어는 *분류하지 않고* null 을 회신해 찾기 경로로 보낸다 — 수치 칸은
 * 종류를 골라야 나오는 칸이라 단계6(종류별 동적 폼)·분류 단계 몫이고, SUM/평균은
 * 수치 칸 가진 종류에서만 의미가 있어 공용 코어에 넣으면 한 종류 전용 기능이 된다.
 *
 * 한 query 가 여러 종류에 매치하면 *구체적 의도* 우선순위로 하나를 택한다:
 * log > timeline > count > list. ("진행상황 목록" 은 누적 의도가 더 구체적).
 *
 * 집계어 어휘(정규식)는 lang/<code>.yaml 언어 프로파일 데이터다(P3 G5-c) —
 * 판정 로직은 여기 남고 패턴은 프로파일이 공급한다. 프로파일은 앱과 함께
 * 배포되는 필수 파일이라 없거나 어긋나면 로드가 loud fail 한다(항상 가동).
 */
import { eventDateRange } from "./event-date.ts";
import { getLanguageProfile } from "./lang/profile-loader.ts";

/**
 * 집계 종류. 단계5 범위 = 종류 무관 범용 집계 4종 + 단계6b 수치 2종.
 *   - list     = 매칭 글 전부 나열
 *   - count    = 매칭 글 개수
 *   - timeline = 사건 시간순 정렬
 *   - log      = 프로젝트/종류 누적 진행 시간순
 *   - sum      = 숫자형 칸 합계(단계6b 합류)
 *   - avg      = 숫자형 칸 평균(단계6b 합류·분모 A 글당 / 분모 B 기간 단위당)
 *
 * sum·avg 는 단계6b 에서 합류했다. 자연어 자동 인식(detectComputeIntent)은 여전히
 * Phase 9 몫이라 NUMERIC_INTENT_REGEX 가 query 의 "얼마"·"합계"를 null 로 컷한다 —
 * 명시 kind=sum/avg 는 detectComputeIntent 를 거치지 않고 라우트가 직접 받는다.
 */
export type ComputeKind = "list" | "count" | "timeline" | "log" | "sum" | "avg";

/** 집계 의도 감지 결과 — 어느 종류로 분류됐는지 + 디버그용 매치 종류 목록. */
export interface ComputeIntent {
  /** 최종 선택된 집계 종류(우선순위 적용 후 단일). */
  kind: ComputeKind;
  /** 정규식이 매치한 모든 종류(우선순위 적용 전·디버그·표시용). */
  matched: ComputeKind[];
}

/** 언어 프로파일의 집계 의도 단락 — 모듈 로드 시 1회 로드(로더 캐시 공유). */
const INTENT_VOCAB = getLanguageProfile().computeIntent;

/**
 * 누적 로그 의도 정규식(plan D1). 프로젝트·종류의 진행을 시간순으로 훑는 신호.
 * "진행상황 어디까지 됐지"·"현황" — 가장 구체적 의도라 우선순위 최상위.
 */
export const LOG_INTENT_REGEX = INTENT_VOCAB.logIntent;

/**
 * 시간순(타임라인) 의도 정규식(plan D1). "언제"·"며칠" 같은 시점 질문 + "뭐 했"류.
 * 날짜어(eventDateRange 매칭)도 timeline 신호로 합류한다(detectComputeIntent 안에서).
 */
export const TIMELINE_INTENT_REGEX = INTENT_VOCAB.timelineIntent;

/**
 * 개수(COUNT) 의도 정규식(plan D1). "몇 번"·"몇 개"·"횟수"·"개수" — 셈 신호.
 */
export const COUNT_INTENT_REGEX = INTENT_VOCAB.countIntent;

/**
 * 목록(list) 의도 정규식(plan D1). "목록"·"리스트"·"나열" + "뭐 샀"·"뭐 먹"류.
 * 가장 약한 신호라 우선순위 최하위(다른 종류가 같이 매치하면 그쪽을 택한다).
 */
export const LIST_INTENT_REGEX = INTENT_VOCAB.listIntent;

/**
 * 수치 합계(SUM/평균) 의도 정규식 — **단계5 제외 신호**(Q1=C 사용자 확정).
 * "얼마"·"합계"·"총액"·"총 N"·"몇 원" 같은 수치 집계어가 잡히면 detectComputeIntent
 * 가 *즉시 null* 을 회신해 찾기 경로로 보낸다. "이번달 가계부 얼마" 처럼 날짜어와
 * 같이 와도 수치 집계 의도가 우선이라(timeline 으로 오분류하면 안 됨) 제외 신호가
 * 다른 종류 판정보다 *앞* 에서 컷한다. 수치 칸은 단계6·분류 단계 몫 — 단계5 계산
 * 경로는 종류 무관 범용 집계(목록·개수·시간순·누적)만 담당한다.
 */
export const NUMERIC_INTENT_REGEX = INTENT_VOCAB.numericIntent;

/**
 * 우선순위 순서(구체적 의도 우선). detectComputeIntent 가 이 순서로 첫 매치를
 * 최종 kind 로 택한다. plan D1 = log > timeline > count > list.
 */
const KIND_PRIORITY: readonly ComputeKind[] = ["log", "timeline", "count", "list"];

/**
 * query 에서 집계 의도를 감지해 집계 종류를 분류한다. 순수 함수 — query 토큰을
 * 안 건드리고 query *전체* 를 정규식 검사만 한다(LLM 0·결정적).
 *
 * 분류 절차:
 *   1. 각 종류 정규식으로 query 를 검사해 매치한 종류를 모은다.
 *   2. timeline 은 날짜어(eventDateRange(query, now) 매칭)도 신호로 합류한다 —
 *      "5월에 뭐 했지" 의 "5월" 같은 닫힌 날짜 표현이 시간순 의도를 보강한다.
 *   3. 매치 0 이면 null(집계 의도 없음 → 찾기 경로).
 *   4. 매치가 있으면 우선순위(log > timeline > count > list)로 단일 kind 를 택한다.
 *
 * 수치 합계어("얼마"·"합계"·"총액")가 잡히면 다른 종류 판정보다 *앞* 에서 null 로
 * 컷한다(단계5 제외·Q1=C). "이번달 가계부 얼마" 처럼 날짜어가 같이 와도 timeline
 * 으로 오분류하지 않고 찾기 경로로 보낸다 — 수치 집계 의도가 종류 신호보다 우선.
 *
 * @param query 검색어 원본(변경하지 않는다).
 * @param now   날짜어 판정 기준 시각(eventDateRange 주입·테스트 결정성). 미지정 시
 *              날짜어 신호는 건너뛰고 어휘 정규식만으로 판정한다(graceful).
 */
export function detectComputeIntent(
  query: string,
  now?: Date,
): ComputeIntent | null {
  // 수치 합계 의도("얼마"·"합계"·"총액")는 단계5 제외(Q1=C) — 다른 종류 판정보다
  // 앞에서 컷해 "이번달 얼마"(날짜어 동반)도 timeline 오분류 없이 찾기 경로로 보낸다.
  if (NUMERIC_INTENT_REGEX.test(query)) return null;

  const matched: ComputeKind[] = [];

  if (LOG_INTENT_REGEX.test(query)) matched.push("log");

  // timeline = 시점 어휘 OR 날짜어(닫힌 표현). now 미주입 시 날짜어 판정은 건너뛴다.
  const hasDateSignal = now !== undefined && eventDateRange(query, now) !== null;
  if (TIMELINE_INTENT_REGEX.test(query) || hasDateSignal) matched.push("timeline");

  if (COUNT_INTENT_REGEX.test(query)) matched.push("count");
  if (LIST_INTENT_REGEX.test(query)) matched.push("list");

  if (matched.length === 0) return null;

  // 우선순위로 단일 kind 선택(구체적 의도 우선).
  const kind = KIND_PRIORITY.find((k) => matched.includes(k));
  // matched 가 비지 않았으므로 KIND_PRIORITY 안에서 반드시 하나는 잡힌다.
  if (kind === undefined) return null;

  return { kind, matched };
}
