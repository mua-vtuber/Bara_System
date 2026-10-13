/**
 * lang/profile-loader.test.ts — 언어 프로파일 로더 검증 (P3 G5-c).
 *
 * (1) ko.yaml(필수 배포 파일) 정상 로드 + 프로파일 값이 옛 코드 상수(정규식
 *     리터럴)와 패턴 문자열 동일함을 실증(byte 동일 근거 — 리터럴의 .source 와
 *     비교), (2) 필수 파일 없음/형식 어긋남 loud throw(어느 파일·어느 칸인지
 *     명시), (3) 플래그 칸 보존 컴파일(go_connector "g" 등), (4) default
 *     프로파일 캐시(1회 로드) 확인.
 *
 * 아래 정규식 리터럴들은 G5-c 외부화 직전 코드에 있던 값 그대로다 — yaml 이
 * 값을 바꾸면 이 테스트가 잡는다(데이터 fixture, mock 아님).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LANGUAGE_CODE,
  getLanguageProfile,
  languageProfilePath,
  loadLanguageProfile,
} from "./profile-loader.ts";

const KO_PATH = languageProfilePath("ko");

/** 형식 어긋남 케이스용 임시 yaml 파일 생성. */
const tmpRoot = mkdtempSync(join(tmpdir(), "lang-profile-test-"));
let seq = 0;
function writeTempYaml(content: string): string {
  const p = join(tmpRoot, `profile-${seq++}.yaml`);
  writeFileSync(p, content, "utf8");
  return p;
}

describe("loadLanguageProfile — 필수 파일 실패 정책(loud throw)", () => {
  test("필수 파일 없음 — 경로를 명시한 구체 에러", () => {
    const missing = languageProfilePath("zz-does-not-exist");
    expect(() => loadLanguageProfile(missing)).toThrow("필수 언어 프로파일 파일 없음");
    expect(() => loadLanguageProfile(missing)).toThrow(missing);
  });

  test("yaml 파싱 실패 — 구체 에러", () => {
    const p = writeTempYaml("{");
    expect(() => loadLanguageProfile(p)).toThrow(/lang-profile: yaml 파싱 실패/);
  });

  test("빈 파일 — 구체 에러(자연 degrade 아님)", () => {
    const p = writeTempYaml("");
    expect(() => loadLanguageProfile(p)).toThrow(/필수 언어 프로파일이 비어 있음/);
  });

  test("최상위가 매핑 아님 — 구체 에러", () => {
    const p = writeTempYaml("- a\n- b\n");
    expect(() => loadLanguageProfile(p)).toThrow(/최상위가 매핑이 아님/);
  });

  test("단락 누락 — 어느 단락인지 명시", () => {
    const p = writeTempYaml("lang: ko\n");
    expect(() => loadLanguageProfile(p)).toThrow(/'compute_intent' 단락 누락/);
  });

  test("칸 누락 — 어느 칸인지 명시", () => {
    const p = writeTempYaml('lang: ko\ncompute_intent:\n  timeline_intent: "언제"\n');
    expect(() => loadLanguageProfile(p)).toThrow(/'compute_intent\.log_intent' 칸 누락/);
  });

  test("정규식 컴파일 실패 — 칸·패턴 명시", () => {
    const p = writeTempYaml('lang: ko\ncompute_intent:\n  log_intent: "["\n');
    expect(() => loadLanguageProfile(p)).toThrow(/'compute_intent\.log_intent' 정규식 컴파일 실패 "\["/);
  });

  test("flags 칸이 문자열 아님 — 칸 명시", () => {
    const p = writeTempYaml(
      'lang: ko\ncompute_intent:\n  log_intent: { pattern: "현황", flags: 3 }\n',
    );
    expect(() => loadLanguageProfile(p)).toThrow(/'compute_intent\.log_intent\.flags' 칸이 문자열이 아님/);
  });

  test("깊은 칸 형식 어긋남 — day_offsets[0].offset 정수 아님", () => {
    // 실제 ko.yaml 을 바탕으로 day_offsets 첫 항목의 offset 만 문자열로 오염.
    const koRaw = readFileSync(KO_PATH, "utf8");
    const broken = koRaw.replace('offset: -2 }', 'offset: "x" }');
    expect(broken).not.toBe(koRaw); // 치환이 실제로 일어났는지 확인.
    const p = writeTempYaml(broken);
    expect(() => loadLanguageProfile(p)).toThrow(/'event_date\.day_offsets\[0\]\.offset' 칸이 정수가 아님/);
  });

  test("weekday_getday 범위 밖 값 — 칸·범위 명시", () => {
    const koRaw = readFileSync(KO_PATH, "utf8");
    const broken = koRaw.replace("토: 6", "토: 9");
    expect(broken).not.toBe(koRaw);
    const p = writeTempYaml(broken);
    expect(() => loadLanguageProfile(p)).toThrow(/'event_date\.weekday_getday\.토' 값 9 이 범위\(0\.\.6\) 밖/);
  });
});

describe("loadLanguageProfile — ko.yaml 정상 로드 + 플래그 보존", () => {
  const p = loadLanguageProfile(KO_PATH);

  test("lang 코드와 네 단락이 전부 로드된다", () => {
    expect(p.code).toBe("ko");
    expect(p.computeIntent.logIntent).toBeInstanceOf(RegExp);
    expect(p.searchCues.relationCue).toBeInstanceOf(RegExp);
    expect(p.shortTextGate.goConnector).toBeInstanceOf(RegExp);
    expect(p.eventDate.rollingWindow).toBeInstanceOf(RegExp);
  });

  test("플래그 칸 보존 컴파일 — g 플래그 2곳·나머지 플래그 없음", () => {
    expect(p.shortTextGate.goConnector.flags).toBe("g");
    expect(p.shortTextGate.terminatorPunctuation.flags).toBe("g");
    expect(p.computeIntent.logIntent.flags).toBe("");
    expect(p.searchCues.relationCue.flags).toBe("");
    expect(p.eventDate.rollingWindow.flags).toBe("");
  });
});

describe("ko 프로파일 값 = 옛 코드 상수 동일 실증(패턴 문자열 비교)", () => {
  // 기대값은 정규식 리터럴이 아니라 패턴 문자열 상수로 적는다 — bun transpiler
  // 가 정규식 리터럴 속 한글을 \uXXXX 로 이스케이프해 .source 텍스트가 달라지기
  // 때문(매칭 의미는 동일). 문자열 리터럴은 런타임 값이 한글 원문 그대로다.
  const p = loadLanguageProfile(KO_PATH);

  test("compute_intent — 집계 의도 정규식 5개", () => {
    expect(p.computeIntent.logIntent.source).toBe("진행상황|진행\\s*상황|어디까지|현황");
    expect(p.computeIntent.timelineIntent.source).toBe("언제|며칠|뭐\\s*했|뭐\\s*한");
    expect(p.computeIntent.countIntent.source).toBe("몇\\s*번|몇\\s*개|횟수|개수");
    expect(p.computeIntent.listIntent.source).toBe(
      "목록|리스트|나열|뭐\\s*샀|뭐\\s*먹|뭐\\s*사|뭐\\s*구매",
    );
    expect(p.computeIntent.numericIntent.source).toBe(
      "얼마|합계|총액|총\\s*지출|총\\s*수입|몇\\s*원|총\\s*금액",
    );
  });

  test("search_cues — 관계·주제 cue 정규식 2개", () => {
    expect(p.searchCues.relationCue.source).toBe("왜|이유|의도|변경|결정|바꿨|바꾼|어떻게");
    expect(p.searchCues.topicCue.source).toBe("전체|모두|전부|모든");
  });

  test("short_text_gate — 게이트 신호 12항목", () => {
    expect(p.shortTextGate.clauseConnectors.map((r) => r.source)).toEqual([
      "지만",
      "[아어여와워봐줘해돼]서\\s",
      "으?며",
      "는데",
    ]);
    expect(p.shortTextGate.goConnector.source).toBe("[가-힣]고\\s");
    expect(p.shortTextGate.reportedSpeechGo.source).toBe("^(다고|라고|냐고|자고)$");
    expect(p.shortTextGate.terminatorPunctuation.source).toBe("[.?!]");
    expect(p.shortTextGate.sentenceFinal.source).toBe("(다|음|함|까|네|군|지|죠|요)$");
    expect(p.shortTextGate.multiFactSignals.map((r) => r.source)).toEqual([
      "\\n",
      "[,，;；·•]",
      "\\s(그리고|또|또한|및)\\s",
      "[가-힣](랑|와|과|하고)\\s+[가-힣]",
    ]);
  });

  test("event_date — 날짜·시각 토큰 전량", () => {
    expect(p.eventDate.rollingWindow.source).toBe(
      "지난\\s*\\d+\\s*일|최근\\s*\\d+\\s*일|최근\\s*\\d+\\s*주|최근\\s*일주일|최근\\s*한\\s*주|지난\\s*\\d+\\s*개?월|최근\\s*\\d+\\s*개?월",
    );
    expect(p.eventDate.absYmd.source).toBe(
      "(\\d{4})\\s*년\\s*(\\d{1,2})\\s*월\\s*(\\d{1,2})\\s*일",
    );
    expect(p.eventDate.absMd.source).toBe("(\\d{1,2})\\s*월\\s*(\\d{1,2})\\s*일");
    expect(p.eventDate.absMdSlash.source).toBe(
      "(?<!\\d)(\\d{1,2})\\s*\\/\\s*(\\d{1,2})(?!\\d)",
    );
    expect(p.eventDate.absYm.source).toBe(
      "(?:(\\d{4})\\s*년\\s*)?(\\d{1,2})\\s*월(?!\\s*\\d{1,2}\\s*일)",
    );
    expect(p.eventDate.dayOffsets.map((e) => [e.regex.source, e.offset])).toEqual([
      ["그저께|그제", -2],
      ["어제", -1],
      ["오늘", 0],
      ["내일", 1],
      ["모레", 2],
    ]);
    expect(p.eventDate.daysAgo.source).toBe("(\\d+)\\s*일\\s*전");
    expect(p.eventDate.daysLater.source).toBe("(\\d+)\\s*일\\s*(?:후|뒤)");
    expect(p.eventDate.weekOffsets.map((e) => [e.regex.source, e.offset])).toEqual([
      ["지난\\s*주|저번\\s*주", -1],
      ["이번\\s*주|금주", 0],
      ["다음\\s*주|담주", 1],
    ]);
    expect(p.eventDate.weekdayGetday).toEqual({ 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 });
    expect(p.eventDate.weekday.source).toBe(
      "(지난\\s*주|저번\\s*주|이번\\s*주|금주|다음\\s*주|담주|지난|저번)?\\s*(월|화|수|목|금|토|일)요일",
    );
    // 옛 matchWeekday 의 리터럴 분기("지난주"/"저번주" -1 · "이번주"/"금주" 0 ·
    // "다음주"/"담주" +1)와 같은 매핑인지 실증.
    expect(p.eventDate.weekdayQualifierOffsets).toEqual({
      지난주: -1,
      저번주: -1,
      이번주: 0,
      금주: 0,
      다음주: 1,
      담주: 1,
    });
    expect(p.eventDate.monthOffsets.map((e) => [e.regex.source, e.offset])).toEqual([
      ["지난\\s*달|저번\\s*달|지난\\s*개?월", -1],
      ["이번\\s*달|금월|이번\\s*개?월", 0],
      ["다음\\s*달|담달|내달", 1],
    ]);
    // 옛 resolver("매치가 재작년이면 -2, 아니면 -1")와 같은 매핑인지 실증.
    expect(p.eventDate.yearOffsets.map((e) => [e.regex.source, e.offsetByMatch])).toEqual([
      ["작년|재작년", { 작년: -1, 재작년: -2 }],
      ["올해|금년", { 올해: 0, 금년: 0 }],
      ["내년", { 내년: 1 }],
    ]);
    expect(p.eventDate.hourMinute.source).toBe(
      "(오전|오후)?\\s*(\\d{1,2})\\s*시(?:\\s*(\\d{1,2})\\s*분)?",
    );
    expect(p.eventDate.colonTime.source).toBe("(?<!\\d)(\\d{1,2}):(\\d{2})(?!\\d)");
    expect(p.eventDate.meridiemAm).toBe("오전");
    expect(p.eventDate.meridiemPm).toBe("오후");
  });
});

describe("getLanguageProfile — default(ko) 캐시", () => {
  test("default 코드는 ko, 두 번 호출이 같은 객체(1회 로드)", () => {
    expect(DEFAULT_LANGUAGE_CODE).toBe("ko");
    const a = getLanguageProfile();
    const b = getLanguageProfile();
    expect(a).toBe(b);
    expect(a.code).toBe("ko");
  });
});

test("ko profile carries the honorific suffixes of spec 4.2, longest first", () => {
  const profile = loadLanguageProfile(languageProfilePath("ko"));
  expect([...profile.entityRegister.honorificSuffixes].sort()).toEqual(
    ["형", "오빠", "누나", "언니", "씨", "님", "쌤", "선배", "이"].sort(),
  );
  const lengths = profile.entityRegister.honorificSuffixes.map((s) => s.length);
  expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  expect(profile.entityRegister.finalConsonantSuffixes).toEqual(["이"]);
});

test("a final-consonant suffix outside the honorific list stops loudly", () => {
  const dir = mkdtempSync(join(tmpdir(), "bara-lang-"));
  const original = readFileSync(languageProfilePath("ko"), "utf8");
  const path = join(dir, "ko.yaml");
  writeFileSync(path, original.replace(/final_consonant_suffixes:.*$/m, 'final_consonant_suffixes: ["야"]'));
  expect(() => loadLanguageProfile(path)).toThrow("entity_register.final_consonant_suffixes");
  rmSync(dir, { recursive: true, force: true });
});

test("a profile without entity_register stops loudly with the section name", () => {
  const dir = mkdtempSync(join(tmpdir(), "bara-lang-"));
  const original = readFileSync(languageProfilePath("ko"), "utf8");
  const path = join(dir, "ko.yaml");
  writeFileSync(path, original.replace(/\n# ── 항목·일정 자동 등록[\s\S]*$/, "\n"));
  expect(() => loadLanguageProfile(path)).toThrow("entity_register");
  rmSync(dir, { recursive: true, force: true });
});

test("an empty suffix entry stops loudly with the field name", () => {
  const dir = mkdtempSync(join(tmpdir(), "bara-lang-"));
  const original = readFileSync(languageProfilePath("ko"), "utf8");
  const path = join(dir, "ko.yaml");
  writeFileSync(path, original.replace(/honorific_suffixes:.*$/m, 'honorific_suffixes: ["형", ""]'));
  expect(() => loadLanguageProfile(path)).toThrow("entity_register.honorific_suffixes");
  rmSync(dir, { recursive: true, force: true });
});
