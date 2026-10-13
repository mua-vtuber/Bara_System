/**
 * memory/compute-intent.test.ts — detectComputeIntent 순수 함수 단위 검증 (단계5 T1).
 *
 * fixture 입력 → 출력만 본다(순수 함수·LLM 0·mock 0). 검증 항목:
 *   (a) 집계 종류 4종(count/list/timeline/log) 각각 정확 분류
 *   (b) 수치 집계어("얼마"·"합계"·"총액") 는 null(단계5 제외·Q1=C·찾기 경로)
 *   (c) 여러 종류 매치 시 우선순위 log > timeline > count > list
 *   (d) 날짜어만 있는 query → timeline(eventDateRange 합류)
 *   (e) 집계 의도 없는 평범한 query → null(찾기 경로)
 */
import { describe, expect, test } from "bun:test";
import { detectComputeIntent } from "./compute-intent.ts";

// 날짜어 판정 기준(결정성). 2026-06-23 화요일.
const NOW = new Date("2026-06-23T10:00:00");

describe("detectComputeIntent — 집계 종류 분류", () => {
  test("(a) count — '몇 번'·'몇 개'·'횟수'·'개수'", () => {
    expect(detectComputeIntent("커피 몇 번 마셨지", NOW)?.kind).toBe("count");
    expect(detectComputeIntent("운동 몇 개 했어", NOW)?.kind).toBe("count");
    expect(detectComputeIntent("방문 횟수", NOW)?.kind).toBe("count");
    expect(detectComputeIntent("개수 알려줘", NOW)?.kind).toBe("count");
  });

  test("(a) list — '목록'·'리스트'·'나열'·'뭐 샀'·'뭐 먹'(날짜어 없을 때)", () => {
    expect(detectComputeIntent("산 거 목록", NOW)?.kind).toBe("list");
    expect(detectComputeIntent("전부 리스트로", NOW)?.kind).toBe("list");
    expect(detectComputeIntent("다 나열해줘", NOW)?.kind).toBe("list");
    expect(detectComputeIntent("거기서 뭐 샀더라", NOW)?.kind).toBe("list");
    expect(detectComputeIntent("점심에 뭐 먹었지", NOW)?.kind).toBe("list");
  });

  test("(a) list 어휘 + 날짜어 동반 → timeline 우선(plan D1 명문 = 날짜어 timeline 위쪽)", () => {
    // "어제 뭐 샀더라" 는 list('뭐 샀') + timeline(날짜어 '어제') 둘 다 매치 →
    // 우선순위(timeline > list)로 timeline. 날짜어가 붙으면 시간순 의도가 더 구체적.
    expect(detectComputeIntent("어제 뭐 샀더라", NOW)?.kind).toBe("timeline");
  });

  test("(a) timeline — '언제'·'며칠' 시점 어휘", () => {
    expect(detectComputeIntent("그 일 언제였지", NOW)?.kind).toBe("timeline");
    expect(detectComputeIntent("며칠에 갔더라", NOW)?.kind).toBe("timeline");
  });

  test("(a) log — '진행상황'·'어디까지'·'현황'", () => {
    expect(detectComputeIntent("프로젝트 진행상황", NOW)?.kind).toBe("log");
    expect(detectComputeIntent("어디까지 했지", NOW)?.kind).toBe("log");
    expect(detectComputeIntent("작업 현황 보여줘", NOW)?.kind).toBe("log");
  });
});

describe("detectComputeIntent — 수치 집계어 제외(Q1=C·단계5 SUM 없음)", () => {
  test("(b) '얼마'·'합계'·'총액' 류는 분류 안 함 → null(찾기 경로)", () => {
    expect(detectComputeIntent("이번달 가계부 얼마 썼지", NOW)).toBeNull();
    expect(detectComputeIntent("합계 알려줘", NOW)).toBeNull();
    expect(detectComputeIntent("총액이 얼마야", NOW)).toBeNull();
    expect(detectComputeIntent("총 지출", NOW)).toBeNull();
  });
});

describe("detectComputeIntent — 우선순위", () => {
  test("(c) log > timeline ('진행상황 언제' → log)", () => {
    const r = detectComputeIntent("진행상황 언제 끝나", NOW);
    expect(r?.kind).toBe("log");
    expect(r?.matched).toContain("log");
    expect(r?.matched).toContain("timeline");
  });

  test("(c) timeline > count ('언제 몇 번' → timeline)", () => {
    const r = detectComputeIntent("언제 몇 번 갔지", NOW);
    expect(r?.kind).toBe("timeline");
  });

  test("(c) count > list ('몇 개 목록' → count)", () => {
    const r = detectComputeIntent("산 거 몇 개 목록", NOW);
    expect(r?.kind).toBe("count");
  });

  test("(c) log > list ('진행상황 목록' → log)", () => {
    expect(detectComputeIntent("진행상황 목록", NOW)?.kind).toBe("log");
  });
});

describe("detectComputeIntent — 날짜어 합류·미감지", () => {
  test("(d) 날짜어만 있는 query → timeline (eventDateRange 합류)", () => {
    // "5월" 닫힌 달 표현 + "뭐"(집계 어휘 아님) — 날짜어가 timeline 신호.
    const r = detectComputeIntent("5월에 있었던 일", NOW);
    expect(r?.kind).toBe("timeline");
    expect(r?.matched).toContain("timeline");
  });

  test("(d) now 미주입 시 날짜어 신호 건너뜀(어휘만으로 판정)", () => {
    // now 없으면 "5월"은 timeline 신호로 안 잡혀 어휘 매치 0 → null.
    expect(detectComputeIntent("5월에 있었던 일")).toBeNull();
  });

  test("(e) 집계 의도 없는 평범한 query → null(찾기 경로)", () => {
    expect(detectComputeIntent("고양이가 귀엽다", NOW)).toBeNull();
    expect(detectComputeIntent("주술회전 재밌어", NOW)).toBeNull();
    expect(detectComputeIntent("비슷한 글 찾아줘", NOW)).toBeNull();
  });
});

describe("detectComputeIntent — 순수성(query 토큰 불변·결정적)", () => {
  test("같은 query 두 번 호출 = 같은 결과(결정적)", () => {
    const q = "프로젝트 진행상황 어디까지";
    const a = detectComputeIntent(q, NOW);
    const b = detectComputeIntent(q, NOW);
    expect(a).toEqual(b);
  });
});
