/**
 * 한국어 builtin 정규식 양식 — Phase 6 spec 단락 2 (양식 갈래 5 + 기술 옵션).
 *
 * 이 상수는 가짜 데이터가 아니라 regex L0 추출기의 실제 default 동작이다.
 * 사용자가 yaml / 대시보드로 추가하지 않아도 이 양식이 항상 가동한다
 * (graceful degradation Level 0). yaml(regex-patterns.yaml) 은 같은 내용을
 * 사용자 갱신 진입점으로 보유하고, DB 사용자 양식은 후속 task 가 합산한다.
 *
 * 정규식 문자열은 옛 Python 자산
 * (backend/app/services/memory/regex_extractor.py) 과 기존
 * apps/memory/src/memory/regex-extractor.ts 의 검증된 한국어 양식 + spec 단락 2
 * 의 신규 양식을 정합시킨 값이다. 정규식 문자열은 spec 권위 값 그대로 유지한다.
 *
 * `pattern`(원본 문자열) 과 `regex`(컴파일된 RegExp) 를 같이 보유한다.
 * RegExp 는 case-insensitive(i) 한정 — 영어 양식(T13)과 일관성을 둔다.
 *
 * exampleInput 은 fixture 검증용 실제 입력 예시다. spec 의 일부 example_input
 * 은 그 양식 정규식과 정합하지 않아(예: "하기로" 양식에 "끄기로 했어" 예시),
 * 정규식 문자열은 그대로 두고 매치되는 자연 입력으로 exampleInput 을 정합시켰다.
 */

import type { RegexPatternDef } from "./types.ts";

/** 양식 정의 한 줄을 RegExp 컴파일과 함께 형성하는 helper. */
function def(
  d: Omit<RegexPatternDef, "regex" | "lang" | "enabled"> &
    Partial<Pick<RegexPatternDef, "lang" | "enabled">>,
): RegexPatternDef {
  return {
    ...d,
    regex: new RegExp(d.pattern, "i"),
    lang: d.lang ?? "ko",
    enabled: d.enabled ?? true,
  };
}

/**
 * 한국어 builtin 양식 목록 (38개).
 * 결정 10 / 선호 7 / 제약 5 / 상태 4 / 사실 7 / 기술 5.
 */
export const BUILTIN_PATTERNS: readonly RegexPatternDef[] = [
  // ── 결정 양식 (decision, +3) — spec 2.1.1 ─────────────────────────
  def({
    id: "decision_ko_001",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s*하기로\\s*(?:했|함|하였|정했)",
    score: 3,
    category: "decision",
    polarity: "positive",
    description: "X 하기로 했다 / 하기로 정했다 / 하기로 함",
    exampleInput: "매일 정리하기로 했어",
    exampleExtracted: "매일 정리",
  }),
  def({
    id: "decision_ko_002",
    // 키워드 `결정` 앞에 공백을 필수(\s+)로 둔다 — 옛 `\s*[으로]?\s*`(전부 optional)는
    // `미결정했어`의 `결정`에 공백 없이 붙어 `정족수 미` 같은 어절 중간 절단 조각을
    // 만들 수 있었다. 공백 필수로 합성어 내부 매치를 막고, 조사(으로/를)는 greedy 캡처가
    // 흡수해 옛 추출값(`Bun 런타임으로`)을 그대로 보존한다. score/category/polarity/id 불변.
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s+결정(?:했|함|하였)",
    score: 3,
    category: "decision",
    polarity: "positive",
    description: "X (으)로 결정했다 / 결정함",
    exampleInput: "Bun 런타임으로 결정했어",
    exampleExtracted: "Bun 런타임으로",
  }),
  def({
    id: "decision_ko_003",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s*[을를]\\s*선택(?:했|함|하였)",
    score: 3,
    category: "decision",
    polarity: "positive",
    description: "X 을 선택했다 / 선택함",
    exampleInput: "bge-m3 모델을 선택했어",
    exampleExtracted: "bge-m3 모델",
  }),
  def({
    id: "decision_ko_004",
    // 키워드 `정했`(2글자)는 `결정했`·`확정했` 같은 합성어 내부에 들어 있어, 옛
    // `\s*[으로]?\s*`(전부 optional)로는 `Bun 런타임으로 결정했어`의 `정했`에 붙어
    // 잘린 조각 `Bun 런타임으로 결` 을 만들었다(qa 발견 결함). 키워드 앞 공백을
    // 필수(\s+)로 두면 합성어(공백 없음)는 안 잡히고, 정상(`정리로 정했` — 공백 있음)은
    // 그대로 잡힌다. 조사는 greedy 캡처가 흡수해 옛 추출값(`주 1회 정리로`) 보존.
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s+정했",
    score: 3,
    category: "decision",
    polarity: "positive",
    description: "X (으)로 정했다",
    exampleInput: "주 1회 정리로 정했어",
    exampleExtracted: "주 1회 정리로",
  }),
  def({
    id: "decision_ko_005",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s*[을를]\\s*쓰기로",
    score: 3,
    category: "decision",
    polarity: "positive",
    description: "X 을 쓰기로",
    exampleInput: "SQLite를 쓰기로 했어",
    exampleExtracted: "SQLite",
  }),
  def({
    id: "decision_ko_006",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s*[을를]\\s*채택(?:했|함|하였)",
    score: 3,
    category: "decision",
    polarity: "positive",
    description: "X 을 채택했다 / 채택함",
    exampleInput: "RRF 합산 방식을 채택했어",
    exampleExtracted: "RRF 합산 방식",
  }),
  def({
    id: "decision_ko_007",
    pattern: "앞으로\\s+([^,]{2,40})",
    score: 3,
    category: "decision",
    polarity: "positive",
    description: "앞으로 X (선언적 결정)",
    exampleInput: "앞으로 디스코드 봇은 수동 입력만 받기",
    exampleExtracted: "디스코드 봇은 수동 입력만 받기",
  }),
  def({
    id: "decision_ko_008",
    // 양식 정밀화 spec §4.3(b) — false positive 게이트. `유지` 뒤에 결정 맥락 어미
    // (유지하기로 / 유지 확정 / 유지 결정 / 유지하자 / 유지할 것)를 동반해야 매치한다.
    // "기억과 호감도를 유지한다"(현재 시제 서술 = 게임 설정 묘사)는 결정 어미가 없어
    // 매치하지 않는다(입력1 false positive 차단). 어절 시작 경계·쉼표 제외는 T3 정합.
    pattern:
      "(?:^|[\\s,])([^,]{2,40}?)\\s+유지(?:하기로|\\s*확정|\\s*결정|하자|할\\s*것)",
    score: 3,
    category: "decision",
    polarity: "positive",
    description: "X 유지하기로 / 유지 확정 (현 결정 보존)",
    exampleInput: "MENTION_BOOST 0.05 유지하기로",
    exampleExtracted: "MENTION_BOOST 0.05",
  }),
  def({
    id: "decision_ko_009",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s+확정",
    score: 3,
    category: "decision",
    polarity: "positive",
    description: "X 확정",
    exampleInput: "Phase 5.7.2 정착 확정",
    exampleExtracted: "Phase 5.7.2 정착",
  }),
  def({
    id: "decision_ko_010",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s+동결",
    score: 3,
    category: "decision",
    polarity: "positive",
    description: "X 동결 (변경 차단 결정)",
    exampleInput: "갈래 A 메모리 자율 결정 동결",
    exampleExtracted: "갈래 A 메모리 자율 결정",
  }),

  // ── 선호 양식 (preference, +2) — spec 2.2.1 ───────────────────────
  def({
    id: "preference_ko_001",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s*[가이]\\s+좋[아다]",
    score: 2,
    category: "preference",
    polarity: "positive",
    description: "X 가 좋아 / 좋다",
    exampleInput: "수채화 톤이 좋아",
    exampleExtracted: "수채화 톤",
  }),
  def({
    id: "preference_ko_002",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s+선호",
    score: 2,
    category: "preference",
    polarity: "positive",
    description: "X 선호",
    exampleInput: "Bun 런타임 선호",
    exampleExtracted: "Bun 런타임",
  }),
  def({
    id: "preference_ko_003",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s+마음에\\s+들[어다]",
    score: 2,
    category: "preference",
    polarity: "positive",
    description: "X 마음에 들어 / 든다",
    exampleInput: "이 색감이 마음에 들어",
    exampleExtracted: "이 색감이",
  }),
  def({
    id: "preference_ko_004",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s*[을를이가]\\s+싫[다어]",
    score: 2,
    category: "preference",
    polarity: "negative",
    description: "X 싫다 / 싫어",
    exampleInput: "한자 표기가 싫어",
    exampleExtracted: "한자 표기",
  }),
  def({
    id: "preference_ko_005",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s*[을를이가]\\s+(?:좋아|즐겨)",
    score: 2,
    category: "preference",
    polarity: "positive",
    description: "X 을 좋아함 / 즐겨함",
    exampleInput: "게임 시나리오를 즐겨",
    exampleExtracted: "게임 시나리오",
  }),
  def({
    id: "preference_ko_006",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s*[이가은는]\\s+(?:최고|최애|짱)",
    score: 2,
    category: "preference",
    polarity: "positive",
    description: "X 이 최고 / 최애",
    exampleInput: "흰머리 토끼귀가 최애",
    exampleExtracted: "흰머리 토끼귀",
  }),
  def({
    id: "preference_ko_007",
    // 양식 정밀화 spec §5(T5) — 캡처 끝을 조사([은는이가])·문장 끝·쉼표 경계로 닫는다.
    // non-greedy + 쉼표 제외([^,])로 오른쪽 절단·과도 매치를 막는다(옛 Python `(?:\.|$)`
    // 앵커 정신). "내가 좋아하는 색감, 그리고 ..." 처럼 쉼표 뒤 절을 한 덩어리로 끌고
    // 가지 않는다.
    pattern: "(?:제|내)가?\\s+좋아하는\\s+([^,]{2,40}?)(?:[은는이가]|$)",
    score: 2,
    category: "preference",
    polarity: "positive",
    description: "내가 좋아하는 X",
    exampleInput: "내가 좋아하는 색감",
    exampleExtracted: "색감",
  }),

  // ── 제약 양식 (constraint, +2) — spec 2.3.1 ───────────────────────
  def({
    id: "constraint_ko_001",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s+해야\\s+(?:한다|함)",
    score: 2,
    category: "constraint",
    polarity: "positive",
    description: "X 해야 한다",
    exampleInput: "커밋 전에 타입 검사를 해야 한다",
    exampleExtracted: "커밋 전에 타입 검사를",
  }),
  def({
    id: "constraint_ko_002",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s+안\\s+된다",
    score: 2,
    category: "constraint",
    polarity: "negative",
    description: "X 안 된다",
    exampleInput: "옛 코드 수정 안 된다",
    exampleExtracted: "옛 코드 수정",
  }),
  def({
    id: "constraint_ko_003",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s+금지",
    score: 2,
    category: "constraint",
    polarity: "negative",
    description: "X 금지",
    exampleInput: "Mock 객체 사용 금지",
    exampleExtracted: "Mock 객체 사용",
  }),
  def({
    id: "constraint_ko_004",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s+필수",
    score: 2,
    category: "constraint",
    polarity: "positive",
    description: "X 필수",
    exampleInput: "타입 검증 필수",
    exampleExtracted: "타입 검증",
  }),
  def({
    id: "constraint_ko_005",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s+불가",
    score: 2,
    category: "constraint",
    polarity: "negative",
    description: "X 불가",
    exampleInput: "Python 새 코드 추가 불가",
    exampleExtracted: "Python 새 코드 추가",
  }),

  // ── 상태 양식 (status, +1) — spec 2.4 ─────────────────────────────
  def({
    id: "status_ko_001",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s+진행중",
    score: 1,
    category: "status",
    polarity: "neutral",
    description: "X 진행중",
    exampleInput: "Phase 6 spec 작성 진행중",
    exampleExtracted: "Phase 6 spec 작성",
  }),
  def({
    id: "status_ko_002",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s+작업중",
    score: 1,
    category: "status",
    polarity: "neutral",
    description: "X 작업중",
    exampleInput: "타입 정의 작업중",
    exampleExtracted: "타입 정의",
  }),
  def({
    id: "status_ko_003",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s+(?:검토|검증)중",
    score: 1,
    category: "status",
    polarity: "neutral",
    description: "X 검토중 / 검증중",
    exampleInput: "양식 fixture 검증중",
    exampleExtracted: "양식 fixture",
  }),
  def({
    id: "status_ko_004",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s+대기중",
    score: 1,
    category: "status",
    polarity: "neutral",
    description: "X 대기중",
    exampleInput: "qa 검증 대기중",
    exampleExtracted: "qa 검증",
  }),

  // ── 사실 양식 (fact, +1~2) — spec 2.5.1 ───────────────────────────
  def({
    id: "fact_ko_001",
    // m[1](주어 X)을 어절 시작 경계·쉼표 제외·non-greedy 로 좁힌다(T3·T5 정합). m[2](Y)도
    // 쉼표 제외로 닫아 끝 절 경계를 넘지 않는다. 추출 내용은 m[1] 한정(주어).
    pattern:
      "(?:^|[\\s,])([^,]{2,40}?)\\s*[은는]\\s+([^,]{2,40})(?:이다|입니다|이에요|예요|이야|야)(?:\\.|$)",
    score: 2,
    category: "fact",
    polarity: "neutral",
    description: "X 은 Y 이다 / Y 야",
    // 첫 캡처 그룹(m[1])이 추출 내용 — 주어 X 만 뽑힌다 (Y 는 m[2]).
    exampleInput: "bara_system은 메모리 모듈이야",
    exampleExtracted: "bara_system",
  }),
  def({
    id: "fact_ko_002",
    pattern: "(?:^|[\\s,])([^,]{2,40}?)\\s+이름은\\s+([^,]{2,40})",
    score: 2,
    category: "fact",
    polarity: "neutral",
    description: "X 이름은 Y",
    exampleInput: "이 캐릭터 이름은 흰머리 토끼귀",
    exampleExtracted: "이 캐릭터",
  }),
  def({
    id: "fact_ko_003",
    pattern: "(?:저|나|제)는?\\s+([^,]{2,40}?)(?:이에요|입니다|이다|예요|거든요)",
    score: 1,
    category: "fact",
    polarity: "neutral",
    description: "저는 / 나는 X 이에요",
    exampleInput: "저는 개발자예요",
    exampleExtracted: "개발자",
  }),
  def({
    id: "fact_ko_004",
    pattern: "(?:저|나|제)는?\\s+([^,]{2,40}?)에\\s+(?:살[아고]|거주)",
    score: 2,
    category: "fact",
    polarity: "neutral",
    description: "X 에 거주",
    exampleInput: "저는 서울에 거주",
    exampleExtracted: "서울",
  }),
  def({
    id: "fact_ko_005",
    pattern: "(?:저|나|제)는?\\s+([^,]{2,40}?)\\s+(?:출신|태생)",
    score: 1,
    category: "fact",
    polarity: "neutral",
    description: "X 출신",
    exampleInput: "저는 부산 출신",
    exampleExtracted: "부산",
  }),
  def({
    id: "fact_ko_006",
    pattern: "(?:저|나|제)\\s+직업은?\\s+([^,]{2,40}?)(?:이에요|입니다|이다|예요)",
    score: 2,
    category: "fact",
    polarity: "neutral",
    description: "직업은 X",
    exampleInput: "제 직업은 프로그래머예요",
    exampleExtracted: "프로그래머",
  }),
  def({
    id: "fact_ko_007",
    pattern: "(?:저|나|제)는?\\s+([^,]{2,40}?)살(?:이에요|입니다|이야)",
    score: 1,
    category: "fact",
    polarity: "neutral",
    description: "X 살 (나이)",
    exampleInput: "저는 서른여섯살이야",
    exampleExtracted: "서른여섯",
  }),

  // ── 기술 양식 (technical, +2) — spec 2.6, default ON (사용자 결정 #1) ──
  def({
    id: "technical_ko_001",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s*[을를]\\s+사용(?:하고|해|합니다|중)",
    score: 2,
    category: "technical",
    polarity: "positive",
    description: "X 을 사용함",
    exampleInput: "Bun 런타임을 사용중",
    exampleExtracted: "Bun 런타임",
  }),
  def({
    id: "technical_ko_002",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s*[으로]?\\s+개발(?:하고|해|합니다|중)",
    score: 2,
    category: "technical",
    polarity: "positive",
    description: "X (으)로 개발함",
    exampleInput: "TypeScript로 개발중",
    exampleExtracted: "TypeScript로",
  }),
  def({
    id: "technical_ko_003",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s+스택[을를으로]?\\s+(?:쓰|사용|씀)",
    score: 2,
    category: "technical",
    polarity: "positive",
    description: "X 스택 사용",
    exampleInput: "Hono 스택 사용",
    exampleExtracted: "Hono",
  }),
  def({
    id: "technical_ko_004",
    pattern: "(?:^|[\\s,])([^,]{2,40}?)\\s+(?:프레임워크|라이브러리)[을를]?\\s+(?:쓰|사용|씀)",
    score: 2,
    category: "technical",
    polarity: "positive",
    description: "X 프레임워크 / 라이브러리 사용",
    exampleInput: "discord.js 라이브러리 사용",
    exampleExtracted: "discord.js",
  }),
  def({
    id: "technical_ko_005",
    pattern: "(?:^|[\\s,])([^,]{2,40})\\s*[을를]\\s+배우(?:고|는\\s+중)",
    score: 1,
    category: "technical",
    polarity: "positive",
    description: "X 을 배우는 중",
    exampleInput: "Rust를 배우는 중",
    exampleExtracted: "Rust",
  }),
];
