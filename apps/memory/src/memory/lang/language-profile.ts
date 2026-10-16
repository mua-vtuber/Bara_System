/**
 * lang/language-profile.ts — 언어 프로파일 타입 정의 (P3 G5-c).
 *
 * compute-intent / search-cues / short-text-gate / event-date 4개 모듈의
 * 언어 의존 데이터(정규식 패턴 문자열·플래그·어휘 매핑)를 lang/<code>.yaml
 * 로 외부화한 프로파일의 컴파일 완료 형태다 — 패턴 문자열이 아니라 로더
 * (profile-loader.ts)가 new RegExp 로 컴파일한 RegExp 를 담는다(소비 모듈
 * 재컴파일 0). 판정·파싱 로직은 각 모듈 TS 에 남는다.
 *
 * 새 언어 추가 = 같은 칸 구성의 lang/<code>.yaml 한 장 추가(예: en.yaml).
 */

/** 정규식 + 오프셋 한 쌍 — 상대 날짜 토큰("어제" = -1)류. */
export interface OffsetPatternEntry {
  /** 토큰 매칭 정규식(컴파일 완료). */
  regex: RegExp;
  /** 매치 시 적용할 오프셋(일·주·달 단위는 소비 모듈이 정한다). */
  offset: number;
}

/**
 * 정규식 + 매치 문자열별 오프셋 — 한 패턴이 여러 토큰을 겸할 때("작년|재작년").
 * 옛 코드의 resolver 함수("매치가 재작년이면 -2, 아니면 -1")를 데이터로 편 것.
 * 정규식 대안(alternation) 각 갈래가 그대로 매치 문자열이 되므로, 갈래마다
 * offsets 매핑에 항목이 있어야 한다(없으면 소비 모듈이 loud throw).
 */
export interface MatchOffsetPatternEntry {
  /** 토큰 매칭 정규식(컴파일 완료). */
  regex: RegExp;
  /** 매치 문자열 → 오프셋. 패턴의 모든 대안 갈래를 담아야 한다. */
  offsetByMatch: Readonly<Record<string, number>>;
}

/** compute-intent.ts — 집계 의도 감지 어휘(plan D1). */
export interface ComputeIntentProfile {
  /** 누적 로그 의도("진행상황"·"어디까지"·"현황"). */
  logIntent: RegExp;
  /** 시간순 의도("언제"·"며칠" + "뭐 했"류). */
  timelineIntent: RegExp;
  /** 개수 의도("몇 번"·"몇 개"·"횟수"·"개수"). */
  countIntent: RegExp;
  /** 목록 의도("목록"·"리스트"·"나열" + "뭐 샀"류). */
  listIntent: RegExp;
  /** 수치 합계 제외 신호("얼마"·"합계"·"총액") — 매치 시 즉시 null 컷. */
  numericIntent: RegExp;
}

/** search-cues.ts — 검색 cue builtin 어휘(spec 5.3.1 / 5.3.2). */
export interface SearchCuesProfile {
  /** 관계 cue("왜·이유·의도·변경·결정·바꿨·바꾼·어떻게"). */
  relationCue: RegExp;
  /** 주제 cue("전체·모두·전부·모든"). */
  topicCue: RegExp;
}

/** short-text-gate.ts — 짧은글 추출 스킵 판정 신호(spec §4.2). */
export interface ShortTextGateProfile {
  /** 절 접속어미 패턴 목록 — 있으면 절이 여럿이라 쪼갤 가치 있음. */
  clauseConnectors: readonly RegExp[];
  /** '-고' 연결어미(g 플래그) — 소비 측이 lastIndex 를 리셋하며 재사용한다. */
  goConnector: RegExp;
  /** 인용 어미('-다고/라고/냐고/자고') — '-고' 매치에서 제외할 토큰. */
  reportedSpeechGo: RegExp;
  /** 문장 종결부호(g 플래그) — String.match 로 개수를 센다. */
  terminatorPunctuation: RegExp;
  /** 종결부호 없는 한국어 종결 어말('-다'/'-음'/'-함' 어말) 보조 신호. */
  sentenceFinal: RegExp;
  /** 나열/복수 사실 신호 패턴 목록(개행·나열 부호·접속 부사·병렬 조사). */
  multiFactSignals: readonly RegExp[];
}

/** event-date.ts — 시간 표현 토큰(옛 KO_TOKENS 테이블의 프로파일 형태). */
export interface EventDateProfile {
  /** 굴러가는(열린) 창 표현("지난 7일") — 닫힌 날짜가 아니라 null 컷. */
  rollingWindow: RegExp;
  /** 절대 날짜 "YYYY년 M월 D일". 캡처 1=년·2=월·3=일. */
  absYmd: RegExp;
  /** 연도 있는 숫자 날짜 "YYYY/M/D"·"YYYY.M.D"(빗금·점 혼용 불가). 캡처 1=년·2=월·3=일. */
  absYmdNumeric: RegExp;
  /** 절대 날짜 "M월 D일"(연도 없음). 캡처 1=월·2=일. */
  absMd: RegExp;
  /** 절대 날짜 "M/D" 슬래시 표기. 캡처 1=월·2=일. */
  absMdSlash: RegExp;
  /** 절대 달 "(YYYY년)? M월"(일 없음 — span 전용). 캡처 1=년(선택)·2=월. */
  absYm: RegExp;
  /** 상대 일 토큰("어제" -1 등) → 일 오프셋. */
  dayOffsets: readonly OffsetPatternEntry[];
  /** "N일 전". 캡처 1=숫자. */
  daysAgo: RegExp;
  /** "N일 후/뒤". 캡처 1=숫자. */
  daysLater: RegExp;
  /** 주 토큰("지난주" -1 등) → 주 오프셋. */
  weekOffsets: readonly OffsetPatternEntry[];
  /** 요일 글자 → getDay 값(0=일..6=토). weekday 패턴 캡처 2와 짝. */
  weekdayGetday: Readonly<Record<string, number>>;
  /** 요일 표현. 캡처 1=한정어(선택)·2=요일 글자. */
  weekday: RegExp;
  /**
   * 요일 한정어(공백 제거 후) → 주 오프셋("지난주" -1 등). 여기 없는 한정어
   * ("지난"/"저번" — 주 글자 없음)는 가장 최근 과거 그 요일로 떨어진다.
   */
  weekdayQualifierOffsets: Readonly<Record<string, number>>;
  /** 달 토큰("지난달" -1 등) → 달 오프셋. */
  monthOffsets: readonly OffsetPatternEntry[];
  /** 달 토큰 바로 뒤의 "N일"(달 토큰 매치 끝부터 맞춤 — ^ 고정). 캡처 1=일. */
  monthDay: RegExp;
  /** 해 토큰 → 매치 문자열별 해 오프셋("재작년" -2 / "작년" -1). */
  yearOffsets: readonly MatchOffsetPatternEntry[];
  /** 시각 "오전/오후 H시 (M분)". 캡처 1=오전·오후(선택)·2=시·3=분(선택). */
  hourMinute: RegExp;
  /** 콜론 시각 "HH:MM". 캡처 1=시·2=분. */
  colonTime: RegExp;
  /** hourMinute 캡처 1과 비교할 오전 어휘(12시 → 00 보정 신호). */
  meridiemAm: string;
  /** hourMinute 캡처 1과 비교할 오후 어휘(+12시간 보정 신호). */
  meridiemPm: string;
}

/** entity-register/judge.ts 데이터 — 호칭 끝말 목록(spec 4.2). */
export interface EntityRegisterProfile {
  /** 이름 끝에 붙으면 호칭으로 볼 만한 말(spec 4.2). 로더가 길이 내림차순으로 정렬한다. */
  honorificSuffixes: readonly string[];
  /** 받침 있는 이름 뒤에만 붙는 끝말("이"). honorificSuffixes 의 부분집합이어야 한다. */
  finalConsonantSuffixes: readonly string[];
}

/** 언어 프로파일 한 장 — lang/<code>.yaml 의 컴파일 완료 형태. */
export interface LanguageProfile {
  /** 언어 코드(yaml lang 칸 — 예: "ko"). */
  code: string;
  /** compute-intent.ts 데이터. */
  computeIntent: ComputeIntentProfile;
  /** search-cues.ts 데이터. */
  searchCues: SearchCuesProfile;
  /** short-text-gate.ts 데이터. */
  shortTextGate: ShortTextGateProfile;
  /** event-date.ts 데이터. */
  eventDate: EventDateProfile;
  /** 항목·일정 자동 등록 판정(entity-register/judge.ts) 데이터. */
  entityRegister: EntityRegisterProfile;
}
