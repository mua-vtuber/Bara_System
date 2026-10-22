/**
 * hashtag-chain-check — 저장 응답 해시태그 경고의 순수 판정(2026-10-21 spec 12.4, B-T5).
 * store 가 필요한 PROJECT_AMBIGUOUS 와 실제 저장 결과 대조는 hashtag-chain-check.int.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { analyzeHashtagChain, HASHTAG_TAG_EXCERPT_MAX, HASHTAG_WARNING_CODES, type HashtagWarning } from "./hashtag-chain-check.ts";
import { HASHTAG_WARNING_GUIDE, HASHTAG_WARNING_MESSAGES, type HashtagSavedAs } from "./hashtag-chain-messages.ts";
import { resolveChainLeafValue, traceChainLeaf } from "./entity-placement-loop-internal/chain-structure.ts";
import { loadReservedKeys, requireSingleReservedKey } from "./parsers/hashtag-reserved-keys.ts";
import { parseClassificationTags, scanClassificationKeys } from "./parsers/classification-tag.ts";
import { parseTags } from "./tag-extractor.ts";
import type { ProjectAttachmentPlan } from "./project-attachment-plan.ts";

const NO_PLAN: ProjectAttachmentPlan = { kind: "none" };
const AMBIGUOUS: ProjectAttachmentPlan = { kind: "not_attached", reason: "ambiguous", name: "bara_system" };

function warnings(content: string, savedAs: HashtagSavedAs = "memory"): HashtagWarning[] {
  return analyzeHashtagChain(content, { savedAs, projectPlan: NO_PLAN, overriddenArgument: null });
}

describe("평범한 메모는 절대 경고하지 않는다", () => {
  const plain = [
    "해시태그가 하나도 없는 평범한 메모",
    "C# 언어로 짠 도구를 고쳤다",
    "https://x.dev/page#intro-2 를 참고했다",
    "이슈 #42 해결",
    "#AI기록, 본문",
    "#프로젝트:코딩, #코딩:bara_system, 본문",
    "#소설:긴 제목, 감상문",
    "",
  ];
  for (const content of plain) {
    for (const savedAs of ["memory", "entity_patch"] as const) {
      test(`${JSON.stringify(content)} (${savedAs})`, () => {
        expect(warnings(content, savedAs)).toEqual([]);
      });
    }
  }
});

describe("BODY_ABSORBED", () => {
  test("쉼표가 빠져 본문이 값에 먹힌 글 — 글 기억으로 저장된 경우의 문구", () => {
    const [w, ...rest] = warnings("#일상:건강 오늘 운동함");
    expect(rest).toEqual([]);
    expect(w).toEqual({
      code: "BODY_ABSORBED",
      tag: "#일상:건강 오늘 운동함",
      readAs: 'key "일상", value "건강 오늘 운동함"',
      message: HASHTAG_WARNING_MESSAGES.BODY_ABSORBED({ savedAs: "memory", reservedKey: false, colon: true }),
    });
  });

  test("엔티티 전용 입력으로 처리된 경우의 문구 — 값에 공백이 있는 태그만 가리킨다", () => {
    const list = warnings("#프로젝트:코딩, #코딩:바라 배포 메모", "entity_patch");
    expect(list.map((w) => [w.code, w.tag])).toEqual([["BODY_ABSORBED", "#코딩:바라 배포 메모"]]);
    expect(list[0]!.message).toBe(HASHTAG_WARNING_MESSAGES.BODY_ABSORBED({ savedAs: "entity_patch", reservedKey: false, colon: true }));
  });

  test("태그 밖 본문이 있으면 긴 값이어도 경고하지 않는다", () => {
    expect(warnings("#소설:데뷔 못 하면 죽는 병 걸림, 다 읽었다")).toEqual([]);
  });
});

describe("HYPHEN_SPLIT", () => {
  test("콜론 태그 키의 하이픈 — 두 파서의 읽기를 그대로 보여 준다", () => {
    const content = "#bara-system:x, 본문";
    const list = warnings(content);
    expect(list.map((w) => w.code)).toEqual(["HYPHEN_SPLIT"]);
    expect(list[0]!.tag).toBe("#bara-system:x");
    expect(list[0]!.readAs).toBe('colon reader: key "bara-system"; plain reader: tag "bara", text "-system:x" left in body');
    // 경고가 말하는 읽기가 실제 파서의 읽기와 같다.
    expect(parseTags(content).tags).toEqual(["bara"]);
    expect(parseTags(content).cleanContent).toContain("-system:x");
    expect(parseClassificationTags(content)[0]!.rawCategory).toBe("bara-system");
    expect(list[0]!.message).toBe(HASHTAG_WARNING_MESSAGES.HYPHEN_SPLIT({ savedAs: "memory", reservedKey: false, colon: true }));
  });

  test("콜론 없는 태그의 하이픈", () => {
    const list = warnings("#bara-system 정리했다");
    expect(list.map((w) => [w.code, w.tag, w.readAs])).toEqual([
      ["HYPHEN_SPLIT", "#bara-system", 'plain tag "bara", text "-system" left in body'],
    ]);
  });

  test("태그 뜻이 없던 하이픈(이슈 번호·날짜)에는 평면 문구 — 태그가 아니었다면 # 를 빼라고 말한다", () => {
    for (const content of ["이슈 #42-1 해결", "#2026-10-21 회의"]) {
      const list = warnings(content);
      expect(list.map((w) => w.code)).toEqual(["HYPHEN_SPLIT"]);
      expect(list[0]!.message).toBe(HASHTAG_WARNING_MESSAGES.HYPHEN_SPLIT({ savedAs: "memory", reservedKey: false, colon: false }));
      expect(list[0]!.message).toContain("write the text without '#'");
    }
  });
});

describe("EMPTY_VALUE", () => {
  test("예약 키가 아닌 키의 빈 값은 버려진다", () => {
    const list = warnings("#일상:, 본문");
    expect(list.map((w) => [w.code, w.tag, w.readAs])).toEqual([["EMPTY_VALUE", "#일상:", 'key "일상", empty value']]);
    expect(list[0]!.message).toBe(HASHTAG_WARNING_MESSAGES.EMPTY_VALUE({ savedAs: "memory", reservedKey: false, colon: true }));
  });

  test("예약 키의 빈 값은 적용되지 않는다는 문구", () => {
    const list = warnings("#생일:, 본문");
    expect(list.map((w) => w.code)).toEqual(["EMPTY_VALUE"]);
    expect(list[0]!.message).toBe(HASHTAG_WARNING_MESSAGES.EMPTY_VALUE({ savedAs: "memory", reservedKey: true, colon: true }));
  });
});

describe("CHAIN_CYCLE", () => {
  test("한 순환은 한 번만 알린다", () => {
    const list = warnings("#가:나, #나:가, 본문");
    expect(list.map((w) => w.code)).toEqual(["CHAIN_CYCLE"]);
    expect(list[0]!.tag).toBe("#가:나");
  });

  test("traceChainLeaf 는 resolveChainLeafValue 와 같은 끝 값을 돌려준다", () => {
    const chain = "#프로젝트:코딩, #코딩:bara_system, 본문";
    expect(traceChainLeaf("코딩", chain)).toEqual({ leaf: "bara_system", cycle: false, keys: ["코딩", "bara_system"] });
    expect(resolveChainLeafValue("코딩", chain)).toBe("bara_system");
    const loop = "#가:나, #나:가";
    expect(traceChainLeaf("나", loop).cycle).toBe(true);
    expect(traceChainLeaf("나", loop).leaf).toBe(resolveChainLeafValue("나", loop));
    expect(traceChainLeaf("", loop)).toEqual({ leaf: "", cycle: false, keys: [] });
  });
});

describe("프로젝트 선언", () => {
  test("EXTRA_PROJECT_CHAIN — 첫 선언만 글에 붙는다", () => {
    const list = warnings("#프로젝트:바라, #프로젝트:펫, 본문");
    expect(list.map((w) => [w.code, w.tag, w.readAs])).toEqual([
      ["EXTRA_PROJECT_CHAIN", "#프로젝트:펫", 'used "바라"; ignored "펫"'],
    ]);
    expect(list[0]!.message).toContain("may still have created a project entry");
  });

  test("PROJECT_NOT_CREATED — 사슬이 분류 폴더에서 끝난다(저장 전 애매함 값과 무관)", () => {
    const list = analyzeHashtagChain("#프로젝트:코딩", { savedAs: "entity_patch", projectPlan: AMBIGUOUS, overriddenArgument: null });
    expect(list.map((w) => [w.code, w.readAs])).toEqual([["PROJECT_NOT_CREATED", 'project chain ends on "코딩"']]);
  });

  test("PROJECT_AMBIGUOUS — 프로젝트를 붙일 사슬이고 저장 전에 이름이 애매했을 때만", () => {
    const content = "#프로젝트:코딩, #코딩:bara_system, 본문";
    expect(analyzeHashtagChain(content, { savedAs: "memory", projectPlan: AMBIGUOUS, overriddenArgument: null }).map((w) => [w.code, w.tag]))
      .toEqual([["PROJECT_AMBIGUOUS", "#프로젝트:코딩"]]);
    expect(analyzeHashtagChain("평범한 메모", { savedAs: "memory", projectPlan: AMBIGUOUS, overriddenArgument: null })).toEqual([]);
  });

  test("PROJECT_ARGUMENT_OVERRIDDEN — 사슬이 붙을 때만, 덮인 인자와 사슬 프로젝트를 밝힌다", () => {
    const content = "#프로젝트:코딩, #코딩:bara_system, 본문";
    const attached: ProjectAttachmentPlan = { kind: "existing", projectId: "prj_x", name: "bara_system" };
    const list = analyzeHashtagChain(content, { savedAs: "memory", projectPlan: attached, overriddenArgument: "다른것" });
    expect(list.map((w) => [w.code, w.tag, w.readAs])).toEqual([
      ["PROJECT_ARGUMENT_OVERRIDDEN", "#프로젝트:코딩", 'project argument "다른것" replaced by chain project "bara_system"'],
    ]);
    expect(analyzeHashtagChain(content, { savedAs: "memory", projectPlan: attached, overriddenArgument: null })).toEqual([]);
  });
});

test("tag 칸은 길면 잘라 표시한다", () => {
  const list = warnings(`#일상:${"가 ".repeat(100)}`);
  expect(list[0]!.tag.length).toBe(HASHTAG_TAG_EXCERPT_MAX + "...".length);
  expect(list[0]!.tag.endsWith("...")).toBe(true);
});

test("scanClassificationKeys 는 빈 값 자리도 담고, parseClassificationTags 는 그것만 뺀다", () => {
  const content = "#일상:, #생일:3월5일";
  expect(scanClassificationKeys(content).map((m) => [m.rawCategory, m.value])).toEqual([["일상", ""], ["생일", "3월5일"]]);
  expect(parseClassificationTags(content).map((t) => t.rawCategory)).toEqual(["생일"]);
});

describe("requireSingleReservedKey", () => {
  test("기본 묶음의 프로젝트 키", () => {
    expect(requireSingleReservedKey(loadReservedKeys(), "entity_project")).toBe("프로젝트");
  });

  test("0개·2개 이상이면 이름을 대며 던진다", () => {
    const none = loadReservedKeys();
    delete none["프로젝트"];
    expect(() => requireSingleReservedKey(none, "entity_project")).toThrow("entity_project");
    const two = loadReservedKeys({ project: { kind: "entity_project" } });
    expect(() => requireSingleReservedKey(two, "entity_project")).toThrow("프로젝트, project");
  });
});

test("경고 코드 목록과 두 문구 묶음의 키가 정확히 같다", () => {
  const codes = [...HASHTAG_WARNING_CODES].sort();
  expect(Object.keys(HASHTAG_WARNING_MESSAGES).sort()).toEqual(codes);
  expect(Object.keys(HASHTAG_WARNING_GUIDE).sort()).toEqual(codes);
});
