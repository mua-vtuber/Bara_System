/**
 * mcp/usage-guide — get_usage_guide 안내 문안 조립(2026-10-21 spec 12.2, B-T3). 순수 함수라 DB·모델이 필요 없다.
 */
import { describe, expect, test } from "bun:test";
import { SHARED_MEMORY_ASSERTION_KINDS } from "../memory/shared-memory-contract.ts";
import { PROFILE_FACETS } from "../server-internal/profile.ts";
import { HASHTAG_WARNING_CODES } from "../memory/hashtag-chain-check.ts";
import { HASHTAG_WARNING_GUIDE } from "../memory/hashtag-chain-messages.ts";
import { loadReservedKeys, requireSingleReservedKey } from "../memory/parsers/hashtag-reserved-keys.ts";
import { TOOL_ANNOTATIONS } from "./annotations.ts";
import { buildUsageGuideText, NODE_FIELD_COLUMN_DESCRIPTIONS, reservedKeyDescription } from "./usage-guide.ts";

const words = (text: string) => text.split(/\s+/).filter((t) => /[A-Za-z0-9]/.test(t)).length;
const writeGuide = buildUsageGuideText("mcp-standard");
const readGuide = buildUsageGuideText("read-only");

describe("길이·양식", () => {
  test("1,200 단어 미만(쓰기 가능·읽기 전용 둘 다)", () => {
    expect(`write=${words(writeGuide)} < 1200: ${words(writeGuide) < 1200}`).toBe(`write=${words(writeGuide)} < 1200: true`);
    expect(words(readGuide) < 1200).toBe(true);
  });

  test("이모지 없음, 채우지 않은 자리 표시({…}) 없음", () => {
    for (const text of [writeGuide, readGuide]) {
      expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
      expect(/\{[A-Z_]+\}/.test(text)).toBe(false);
    }
  });

  test("쓰기 가능 scope 들은 같은 문안이다", () => {
    expect(buildUsageGuideText("full")).toBe(writeGuide);
    expect(buildUsageGuideText(undefined)).toBe(writeGuide);
  });
});

describe("단일 출처 값이 끼워 넣어진다", () => {
  test("assertionKind·facet 값 전부", () => {
    for (const kind of SHARED_MEMORY_ASSERTION_KINDS) expect(`${kind}: ${writeGuide.includes(kind)}`).toBe(`${kind}: true`);
    expect(writeGuide).toContain(`facet (${PROFILE_FACETS.join(", ")})`);
  });

  test("경고 코드 전부와 그 설명", () => {
    for (const code of HASHTAG_WARNING_CODES) {
      expect(writeGuide).toContain(`- ${code}: ${HASHTAG_WARNING_GUIDE[code]}`);
    }
  });

  test("프로젝트 키와 그 밖의 예약 키 이름 전부", () => {
    const keys = loadReservedKeys();
    const projectKey = requireSingleReservedKey(keys, "entity_project");
    expect(writeGuide).toContain(`#${projectKey}:... is the reserved project key`);
    // 서버 지침에서 옮겨 온 사슬 예시(2026-10-22) — 프로젝트 키 이름이 예약 키 묶음에서 끼워진다.
    expect(writeGuide).toContain(`- Examples: #${projectKey}:<category>, #<category>:<project name>, <body>`);
    for (const [name, def] of Object.entries(keys)) {
      if (def.kind === "entity_project") continue;
      expect(`${name}: ${writeGuide.includes(name)}`).toBe(`${name}: true`);
      expect(writeGuide).toContain(reservedKeyDescription(name, def));
    }
  });

  test("다른 예약 키 묶음을 넣으면 그 이름이 실린다", () => {
    const custom = loadReservedKeys({ 작업: { kind: "entity_project" } });
    delete custom["프로젝트"];
    expect(buildUsageGuideText("mcp-standard", custom)).toContain("#작업:... is the reserved project key");
    const two = loadReservedKeys({ project: { kind: "entity_project" } });
    expect(() => buildUsageGuideText("mcp-standard", two)).toThrow("entity_project");
  });
});

describe("읽기 전용 조립", () => {
  test("사슬 읽기와 범위 두 절만 싣는다", () => {
    expect(readGuide).toContain("1. CLASSIFICATION CHAIN");
    expect(readGuide).toContain("2. PROJECT SCOPE");
    for (const heading of ["WHICH SAVE TOOL", "LESSONS", "EVIDENCE FIELDS", "HASHTAG WARNINGS", "RESOLVING A DISPUTE"]) {
      expect(`${heading}: ${readGuide.includes(heading)}`).toBe(`${heading}: false`);
      expect(`${heading}: ${writeGuide.includes(heading)}`).toBe(`${heading}: true`);
    }
  });

  test("쓰기 도구 이름·저장 안내가 없다", () => {
    const writeTools = Object.entries(TOOL_ANNOTATIONS).filter(([, a]) => !a.readOnlyHint).map(([name]) => name);
    for (const name of writeTools) expect(`${name}: ${readGuide.includes(name)}`).toBe(`${name}: false`);
    expect(readGuide.includes("first save")).toBe(false);
    expect(writeGuide).toContain("update_memory keeps existing hashtags");
  });
});

describe("개정 2 문안(spec 20.6·20.7)", () => {
  test("근거 기억 규칙이 실제 검사(같은 프로젝트 또는 프로젝트 없음)와 같은 말을 한다", () => {
    expect(writeGuide).toContain(
      "Evidence must be in the same project as the new memory or have no project; a project's id, name and older memories stored under its plain name count as the same project.",
    );
  });

  test("M1: 첫 사슬만 글에 붙고, 뒤 사슬도 프로젝트 행은 만들 수 있다", () => {
    for (const text of [writeGuide, readGuide]) {
      expect(text).toContain("Only the first project chain is attached to the memory; later project chains can still create project entries.");
    }
  });

  test("m1: 태그만 남은 글은 응답으로 확인하게 말한다(쓰기 가능만)", () => {
    expect(writeGuide).toContain('store_memory then answers with type "entity_patch"; the save_* tools answer with an error.');
  });

  test("m7: 날짜 예약 키는 시작·끝 칸마다 설명이 갈린다", () => {
    for (const description of Object.values(NODE_FIELD_COLUMN_DESCRIPTIONS)) expect(writeGuide).toContain(description);
    expect(writeGuide).toContain(`일정종료 (${NODE_FIELD_COLUMN_DESCRIPTIONS.event_until})`);
    const broken = loadReservedKeys({ 마감: { kind: "node_field" } });
    expect(() => buildUsageGuideText("mcp-standard", broken)).toThrow("마감");
  });

  test("m3: 읽기 전용 안내에는 쓰는 법 조언이 없다", () => {
    const WRITE_ADVICE = [
      "Use letters, digits and underscore", "avoid hyphens", "close every tag with a comma",
      "Reuse names", "Prefer an existing name", "Put a comma before the body",
    ];
    for (const phrase of WRITE_ADVICE) {
      expect(`${phrase}: ${readGuide.includes(phrase)}`).toBe(`${phrase}: false`);
      expect(`${phrase}: ${writeGuide.includes(phrase)}`).toBe(`${phrase}: true`);
    }
  });
});
