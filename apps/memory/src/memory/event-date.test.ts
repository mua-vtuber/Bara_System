/**
 * event-date.test.ts — 한국어 시간 표현 → 사건 ISO 날짜 변환 검증.
 *
 * 기준점(now)을 고정해 결정적으로 검사한다. data fixture 방식(순수 함수
 * 입출력) — mock 객체 없음. now 는 항상 인자로 주입한다.
 *
 * 기준 NOW = 2026-05-27 수요일 14:00 (로컬). month 는 0-indexed 라 4 = 5월.
 */
import { describe, test, expect } from "bun:test";
import { extractEventDate, eventDateRange, extractEventDateTime } from "./event-date.ts";

const NOW = new Date(2026, 4, 27, 14, 0, 0);

describe("extractEventDate — 절대 날짜 표현", () => {
  const cases: Array<[string, string]> = [
    ["2026년 5월 25일에 갔다", "2026-05-25"],
    ["2026-05-25 약속", "2026-05-25"],
    ["5월 25일 약속", "2026-05-25"],
    ["5/25 미팅", "2026-05-25"],
  ];
  test.each(cases)("%s → %s", (text, expected) => {
    expect(extractEventDate(text, NOW)).toBe(expected);
  });
});

describe("extractEventDate — 상대 일 단위", () => {
  const cases: Array<[string, string]> = [
    ["오늘 병원", "2026-05-27"],
    ["어제 산책", "2026-05-26"],
    ["그저께 일", "2026-05-25"],
    ["내일 회의", "2026-05-28"],
    ["모레 발표", "2026-05-29"],
    ["3일 전 메모", "2026-05-24"],
    ["5일 후 마감", "2026-06-01"],
  ];
  test.each(cases)("%s → %s", (text, expected) => {
    expect(extractEventDate(text, NOW)).toBe(expected);
  });
});

describe("extractEventDate — 달력 경계 주 단위(월요일 시작)", () => {
  const cases: Array<[string, string]> = [
    ["이번주 회식", "2026-05-25"],
    ["지난주 영화", "2026-05-18"],
    ["다음주 여행", "2026-06-01"],
  ];
  test.each(cases)("%s → %s", (text, expected) => {
    expect(extractEventDate(text, NOW)).toBe(expected);
  });

  // 회귀 방어: startOfWeek 의 (getDay - weekStart + 7) % 7 에서 가장 깨지기
  // 쉬운 일요일(getDay=0)·월요일(경계 자기 자신) 기준점을 따로 고정한다.
  test("일요일(2026-05-31) 기준 — 주 경계 보존", () => {
    const sunday = new Date(2026, 4, 31, 9, 0, 0);
    expect(extractEventDate("이번주 회식", sunday)).toBe("2026-05-25");
    expect(extractEventDate("지난주 영화", sunday)).toBe("2026-05-18");
    expect(extractEventDate("다음주 여행", sunday)).toBe("2026-06-01");
  });

  test("월요일(2026-05-25, 경계 자기 자신) 기준 — 주 경계 보존", () => {
    const monday = new Date(2026, 4, 25, 9, 0, 0);
    expect(extractEventDate("이번주 회식", monday)).toBe("2026-05-25");
    expect(extractEventDate("지난주 영화", monday)).toBe("2026-05-18");
  });
});

describe("extractEventDate — 달력 경계 달 단위(1일 시작)", () => {
  const cases: Array<[string, string]> = [
    ["이번달 목표", "2026-05-01"],
    ["지난달 결산", "2026-04-01"],
    ["다음달 계획", "2026-06-01"],
  ];
  test.each(cases)("%s → %s", (text, expected) => {
    expect(extractEventDate(text, NOW)).toBe(expected);
  });
});

describe("extractEventDate — 달력 경계 해 단위(1월 1일 시작)", () => {
  const cases: Array<[string, string]> = [
    ["올해 다짐", "2026-01-01"],
    ["작년 기록", "2025-01-01"],
    ["내년 계획", "2027-01-01"],
  ];
  test.each(cases)("%s → %s", (text, expected) => {
    expect(extractEventDate(text, NOW)).toBe(expected);
  });
});

describe("extractEventDate — null(매칭 없음 / 굴러가는 창)", () => {
  test("평범한 메모는 시간 표현이 없어 null", () => {
    expect(extractEventDate("그냥 평범한 메모", NOW)).toBeNull();
  });

  test("'지난 7일' 은 열린(굴러가는) 창이라 닫힌 날짜 아님 → null", () => {
    expect(extractEventDate("지난 7일 동안", NOW)).toBeNull();
  });
});

describe("extractEventDate — 요일 표현(now=2026-06-05 금요일 고정)", () => {
  // 기준 now = 2026-06-05 금요일(getDay=5). 결정성 위해 한 요일로 고정한다.
  const FRI = new Date(2026, 5, 5, 14, 0, 0);

  test("한정어 없는 '수요일' → 가장 최근 과거 수요일(2026-06-03)", () => {
    expect(extractEventDate("수요일에 회의", FRI)).toBe("2026-06-03");
  });

  test("now 가 그 요일이면 '금요일' → 오늘(2026-06-05, offset 0)", () => {
    expect(extractEventDate("금요일에 갔다", FRI)).toBe("2026-06-05");
  });

  test("'지난주 월요일' → 지난주 그 요일(2026-05-25)", () => {
    expect(extractEventDate("지난주 월요일 점심", FRI)).toBe("2026-05-25");
  });

  test("'이번주 화요일' → 이번주 그 요일(2026-06-02)", () => {
    expect(extractEventDate("이번주 화요일 약속", FRI)).toBe("2026-06-02");
  });

  test("'다음주 금요일' → 다음주 그 요일(2026-06-12, 미래)", () => {
    expect(extractEventDate("다음주 금요일 발표", FRI)).toBe("2026-06-12");
  });

  test("일요일(getDay 0) 경계 — 가장 최근 일요일(2026-05-31)", () => {
    expect(extractEventDate("일요일에 쉬었다", FRI)).toBe("2026-05-31");
  });

  test("월요일(주 시작, WEEK_START) 경계 — 가장 최근 월요일(2026-06-01)", () => {
    expect(extractEventDate("월요일에 시작했다", FRI)).toBe("2026-06-01");
  });

  test("'다음주 금요일' 은 matchWeek('다음주') 가 아니라 금요일로 잡힌다(순서 가드)", () => {
    // matchWeek 가 먼저 잡으면 '다음주' = 그 주 월요일(2026-06-08)이 돼 어긋난다.
    // matchWeekday 가 matchWeek 보다 앞이라 금요일(2026-06-12)이 정답.
    const wrongIfWeekFirst = "2026-06-08";
    const got = extractEventDate("다음주 금요일 발표", FRI);
    expect(got).toBe("2026-06-12");
    expect(got).not.toBe(wrongIfWeekFirst);
  });

  test("'5월' 의 '월' 은 요일로 오매칭되지 않는다('요일' 글자 필수)", () => {
    // 요일 매처는 "월요일" 처럼 "요일" 글자를 요구하므로 "5월"(달)은 안 먹는다.
    // extractEventDate 는 일 없는 달 표현을 안 다루므로 정답은 null —
    // 요일로 잘못 잡혀 엉뚱한 날짜가 나오지 않음을 확인한다.
    expect(extractEventDate("5월에 본 영화", FRI)).toBeNull();
  });
});

describe("eventDateRange — 요일 점(하루) 표현(now=2026-06-05 금요일)", () => {
  const FRI = new Date(2026, 5, 5, 14, 0, 0);

  test("'금요일' 검색 → 그 하루({2026-06-05, 같은 날})", () => {
    expect(eventDateRange("금요일에 만난 사람", FRI)).toEqual({
      since: "2026-06-05",
      until: "2026-06-05",
    });
  });

  test("'다음주 금요일' 검색 → 그 하루(2026-06-12), 주 span 아님", () => {
    expect(eventDateRange("다음주 금요일 일정", FRI)).toEqual({
      since: "2026-06-12",
      until: "2026-06-12",
    });
  });
});

describe("extractEventDate — 연말 경계", () => {
  test("12월 등록 시 '다음달' 은 내년 1월 1일", () => {
    const decNow = new Date(2026, 11, 10);
    expect(extractEventDate("다음달 약속", decNow)).toBe("2027-01-01");
  });
});

describe("extractEventDate — 우선순위(가장 구체적인 표현)", () => {
  test("절대 표현이 상대 주 표현보다 우선", () => {
    // 두 표현이 한 문장에 있으면 절대(5월 25일)가 이긴다.
    expect(extractEventDate("이번주 중 5월 25일에 미팅", NOW)).toBe("2026-05-25");
  });

  test("상대 일 표현이 주 표현보다 우선", () => {
    expect(extractEventDate("다음주에 내일 점검", NOW)).toBe("2026-05-28");
  });
});

// ── eventDateRange (검색 시간 범위 / Task 5) ────────────────────────────────
//
// 점(point) 표현은 since=until 한 날, 기간(span) 표현은 시작~끝.
// 굴러가는 창·매칭 없음은 null. now 는 2026-05-27 수요일 고정.

describe("eventDateRange — 점(하루) 표현은 since=until", () => {
  const cases: Array<[string, string]> = [
    ["5월 25일 약속", "2026-05-25"],
    ["2026-05-25 약속", "2026-05-25"],
    ["2026년 5월 25일에 갔다", "2026-05-25"],
    ["5/25 미팅", "2026-05-25"],
    ["오늘 병원", "2026-05-27"],
    ["어제 산책", "2026-05-26"],
    ["3일 전 메모", "2026-05-24"],
  ];
  test.each(cases)("%s → 하루 {%s, 같은 날}", (text, day) => {
    expect(eventDateRange(text, NOW)).toEqual({ since: day, until: day });
  });
});

describe("eventDateRange — 주 span(월요일~일요일)", () => {
  test("지난주 영화 → {2026-05-18, 2026-05-24}", () => {
    expect(eventDateRange("지난주 영화", NOW)).toEqual({
      since: "2026-05-18",
      until: "2026-05-24",
    });
  });

  test("이번주 회식 → {2026-05-25, 2026-05-31}", () => {
    expect(eventDateRange("이번주 회식", NOW)).toEqual({
      since: "2026-05-25",
      until: "2026-05-31",
    });
  });

  test("다음주 여행 → {2026-06-01, 2026-06-07}", () => {
    expect(eventDateRange("다음주 여행", NOW)).toEqual({
      since: "2026-06-01",
      until: "2026-06-07",
    });
  });
});

describe("eventDateRange — 달 span(1일~말일)", () => {
  test("절대 달 '5월' → {2026-05-01, 2026-05-31}", () => {
    expect(eventDateRange("5월에 본 영화", NOW)).toEqual({
      since: "2026-05-01",
      until: "2026-05-31",
    });
  });

  test("절대 달 '2026년 5월' → {2026-05-01, 2026-05-31}", () => {
    expect(eventDateRange("2026년 5월 기록", NOW)).toEqual({
      since: "2026-05-01",
      until: "2026-05-31",
    });
  });

  test("'2월' → 말일 28일(2026 평년)로 경계 보정", () => {
    expect(eventDateRange("2월 메모", NOW)).toEqual({
      since: "2026-02-01",
      until: "2026-02-28",
    });
  });

  test("상대 달 '지난달' → {2026-04-01, 2026-04-30}", () => {
    expect(eventDateRange("지난달 결산", NOW)).toEqual({
      since: "2026-04-01",
      until: "2026-04-30",
    });
  });

  test("'5월 25일'(일 포함)은 달 span 이 아니라 그 하루 점", () => {
    // ABS_YM_KO 의 lookahead 가 일 포함 표현을 점 매처에 넘긴다.
    expect(eventDateRange("5월 25일 약속", NOW)).toEqual({
      since: "2026-05-25",
      until: "2026-05-25",
    });
  });
});

describe("eventDateRange — 해 span(1월1일~12월31일)", () => {
  test("작년 기록 → {2025-01-01, 2025-12-31}", () => {
    expect(eventDateRange("작년 기록", NOW)).toEqual({
      since: "2025-01-01",
      until: "2025-12-31",
    });
  });

  test("올해 다짐 → {2026-01-01, 2026-12-31}", () => {
    expect(eventDateRange("올해 다짐", NOW)).toEqual({
      since: "2026-01-01",
      until: "2026-12-31",
    });
  });
});

describe("eventDateRange — null(매칭 없음 / 굴러가는 창)", () => {
  test("시간 표현 없는 검색어 → null", () => {
    expect(eventDateRange("노란후드 검색", NOW)).toBeNull();
  });

  test("'지난 7일'(굴러가는 창)은 닫힌 구간 아님 → null", () => {
    expect(eventDateRange("지난 7일", NOW)).toBeNull();
  });
});

describe("eventDateRange — 우선순위(점이 span 보다 우선)", () => {
  test("'이번주 중 5월 25일' → 점(하루)", () => {
    expect(eventDateRange("이번주 중 5월 25일에 미팅", NOW)).toEqual({
      since: "2026-05-25",
      until: "2026-05-25",
    });
  });
});

// ── extractEventDateTime (날짜 + 시각 / 활용 단계2 ①) ────────────────────────
//
// 날짜에 더해 "같은 날 안의 시각"을 살린다. 날짜+시각이면 "YYYY-MM-DDT<HH>:<MM>",
// 시각 없으면 extractEventDate 와 같은 날짜만, 날짜 없이 시각만이면 오늘 그 시각.
// 초·timezone 미부착·로컬. now 는 2026-05-27 수요일 고정(위 NOW 재사용).

describe("extractEventDateTime — 날짜 + 시각", () => {
  const cases: Array<[string, string]> = [
    ["2026-05-25 14:00 약속", "2026-05-25T14:00"],
    ["2026-05-25T14:00 약속", "2026-05-25T14:00"],
    ["2026-05-25 약속", "2026-05-25"],
    ["5월 25일 14시 약속", "2026-05-25T14:00"],
    ["5월 25일 오후 2시 미팅", "2026-05-25T14:00"],
    ["5월 25일 오전 9시 회의", "2026-05-25T09:00"],
    ["5월 25일 2시 30분 통화", "2026-05-25T02:30"],
    ["5월 25일 오후 2시 30분 통화", "2026-05-25T14:30"],
    ["5월 25일 14:00 출발", "2026-05-25T14:00"],
    ["2026년 5월 25일 오전 9시", "2026-05-25T09:00"],
    ["5월 25일 오후 12시 점심", "2026-05-25T12:00"],
    ["5월 25일 오전 12시 자정", "2026-05-25T00:00"],
  ];
  test.each(cases)("%s → %s", (text, expected) => {
    expect(extractEventDateTime(text, NOW)).toBe(expected);
  });

  test("시각 없으면 날짜만 — extractEventDate 와 동일 결과", () => {
    expect(extractEventDateTime("5월 25일 약속", NOW)).toBe("2026-05-25");
    // "어제" 기대값은 기준 NOW(2026-05-27)에 맞춰 2026-05-26. extractEventDate
    // 재호출로 기준 독립으로 적어 회귀 없이 통과한다.
    expect(extractEventDateTime("어제 산책", NOW)).toBe(extractEventDate("어제 산책", NOW));
  });

  test("날짜 없이 시각만 → 오늘 날짜로 채운다(거부 아님)", () => {
    // 오늘 = NOW 의 날짜(2026-05-27).
    const today = extractEventDate("오늘", NOW) ?? "";
    expect(extractEventDateTime("14시 약속", NOW)).toBe(`${today}T14:00`);
    expect(extractEventDateTime("오후 2시 미팅", NOW)).toBe(`${today}T14:00`);
  });

  test("날짜·시각 둘 다 없으면 null(정직)", () => {
    expect(extractEventDateTime("그냥 메모", NOW)).toBeNull();
  });

  test("애매한 시각 토막은 시각 없이 날짜만 — 거짓 시각 미생성", () => {
    expect(extractEventDateTime("5월 25일 25시 메모", NOW)).toBe("2026-05-25");
  });

  test("날짜의 슬래시(5/25)를 시각으로 오인하지 않는다 — 시각 없이 그 하루", () => {
    // COLON_TIME 은 콜론(:)만 잡고 슬래시(/)는 안 잡는다. KO_HOUR_MINUTE 은
    // "시" 글자가 필수라 "25일"의 25 도 시각으로 새지 않는다.
    expect(extractEventDateTime("5/25 미팅", NOW)).toBe("2026-05-25");
  });
});

describe("extractEventDate — 회귀 가드(시각 추가가 날짜-only 거동 안 깸)", () => {
  test("시각이 섞인 입력도 extractEventDate 는 날짜만 반환(시그니처·반환 불변)", () => {
    expect(extractEventDate("5월 25일 14시 약속", NOW)).toBe("2026-05-25");
    expect(extractEventDate("14시 약속", NOW)).toBeNull();
  });
});
