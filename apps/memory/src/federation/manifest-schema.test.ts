import { describe, test, expect } from "bun:test";
import {
  ID_PATTERN,
  SUPPORTED_MANIFEST_VERSION,
  isAllowedEndpoint,
  isValidActionReturns,
} from "./manifest-schema";
import { validateManifest } from "./manifest-validator";

/** 본 spec section 4.1 과 정합인 매니페스트 stub. */
function validManifest() {
  return {
    id: "bot-discord",
    name: "디스코드 봇",
    version: "0.1.0",
    manifestVersion: 1,
    endpoint: "http://127.0.0.1:3100",
    health: "/health",
    settings: {
      schemaPath: "/settings/schema",
      getPath: "/settings",
      putPath: "/settings",
    },
    actions: [
      {
        id: "verify-token",
        label: "토큰 검증",
        method: "POST" as const,
        path: "/actions/verify-token",
        returns: "toast" as const,
      },
    ],
    icon: "/icon.svg",
    description: "디스코드 본인 DM 입력 어댑터",
    tags: ["adapter", "input"],
  };
}

describe("ID_PATTERN", () => {
  test("소문자 시작 + 소문자/숫자/하이픈 = 통과", () => {
    expect(ID_PATTERN.test("bot-discord")).toBe(true);
    expect(ID_PATTERN.test("memory")).toBe(true);
    expect(ID_PATTERN.test("a")).toBe(true);
    expect(ID_PATTERN.test("bot-1")).toBe(true);
  });

  test("대문자 / 숫자 시작 / 특수문자 = 차단", () => {
    expect(ID_PATTERN.test("Bot")).toBe(false);
    expect(ID_PATTERN.test("1bot")).toBe(false);
    expect(ID_PATTERN.test("bot_discord")).toBe(false);
    expect(ID_PATTERN.test("bot.discord")).toBe(false);
    expect(ID_PATTERN.test("")).toBe(false);
    expect(ID_PATTERN.test("-bot")).toBe(false);
  });
});

describe("isAllowedEndpoint", () => {
  test("127.0.0.1 + 포트 = 허용", () => {
    expect(isAllowedEndpoint("http://127.0.0.1:3100")).toBe(true);
    expect(isAllowedEndpoint("http://127.0.0.1:8080")).toBe(true);
  });

  test("localhost + 포트 = 허용", () => {
    expect(isAllowedEndpoint("http://localhost:3100")).toBe(true);
  });

  test("외부 호스트 = 차단", () => {
    expect(isAllowedEndpoint("http://192.168.1.10:3100")).toBe(false);
    expect(isAllowedEndpoint("http://example.com:3100")).toBe(false);
    expect(isAllowedEndpoint("http://0.0.0.0:3100")).toBe(false);
  });

  test("https / 포트 누락 / 잘못된 URL = 차단", () => {
    expect(isAllowedEndpoint("https://127.0.0.1:3100")).toBe(false);
    expect(isAllowedEndpoint("http://127.0.0.1")).toBe(false);
    expect(isAllowedEndpoint("not-a-url")).toBe(false);
    expect(isAllowedEndpoint("")).toBe(false);
  });
});

describe("isValidActionReturns", () => {
  test("'toast' / 'enum' / 'redirect' = 통과", () => {
    expect(isValidActionReturns("toast")).toBe(true);
    expect(isValidActionReturns("enum")).toBe(true);
    expect(isValidActionReturns("redirect")).toBe(true);
  });

  test("그 외 값 = 차단", () => {
    expect(isValidActionReturns("modal")).toBe(false);
    expect(isValidActionReturns("")).toBe(false);
    expect(isValidActionReturns(null)).toBe(false);
    expect(isValidActionReturns(123)).toBe(false);
  });
});

describe("validateManifest — 통과 케이스", () => {
  test("정합 매니페스트 = ok: true + AppManifest 로 narrowing", () => {
    const result = validateManifest(validManifest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("bot-discord");
      expect(result.manifest.manifestVersion).toBe(1);
      expect(result.manifest.actions?.length).toBe(1);
    }
  });

  test("actions 생략 = 통과 (선택 필드)", () => {
    const m = validManifest();
    delete (m as Partial<typeof m>).actions;
    const result = validateManifest(m);
    expect(result.ok).toBe(true);
  });

  test("선택 필드 (icon / description / tags) 모두 생략 = 통과", () => {
    const m = validManifest();
    delete (m as Partial<typeof m>).icon;
    delete (m as Partial<typeof m>).description;
    delete (m as Partial<typeof m>).tags;
    const result = validateManifest(m);
    expect(result.ok).toBe(true);
  });
});

describe("validateManifest — 실패 케이스", () => {
  test("필수 필드 누락 = 실패 + errors 항목에 각 누락 필드 명시", () => {
    const result = validateManifest({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path);
      expect(paths).toContain("id");
      expect(paths).toContain("name");
      expect(paths).toContain("version");
      expect(paths).toContain("manifestVersion");
      expect(paths).toContain("endpoint");
      expect(paths).toContain("health");
      expect(paths).toContain("settings");
    }
  });

  test("id 정규식 미일치 = 실패", () => {
    const m = validManifest();
    m.id = "Bot_Discord";
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "id")).toBe(true);
    }
  });

  test("endpoint 외부 호스트 = 실패", () => {
    const m = validManifest();
    m.endpoint = "http://192.168.1.10:3100";
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "endpoint")).toBe(true);
    }
  });

  test("manifestVersion > 본 모듈 지원 = 실패", () => {
    const m = validManifest();
    m.manifestVersion = SUPPORTED_MANIFEST_VERSION + 1;
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.path === "manifestVersion");
      expect(err).toBeDefined();
      expect(err?.message).toContain("초과");
    }
  });

  test("manifestVersion < 1 = 실패", () => {
    const m = validManifest();
    m.manifestVersion = 0;
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
  });

  test("settings.* 경로가 '/' 시작 아님 = 실패", () => {
    const m = validManifest();
    m.settings.schemaPath = "settings/schema";
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.path === "settings.schemaPath"),
      ).toBe(true);
    }
  });

  test("action 필드 누락 = 실패 + 경로 명시", () => {
    const m = validManifest();
    m.actions = [
      {
        id: "verify-token",
        label: "토큰 검증",
        method: "POST",
        path: "/actions/verify-token",
        // returns 필드 누락
      } as never,
    ];
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.path === "actions[0].returns"),
      ).toBe(true);
    }
  });

  test("action id 중복 = 실패", () => {
    const m = validManifest();
    m.actions = [
      {
        id: "dup",
        label: "A",
        method: "GET" as never,
        path: "/a",
        returns: "toast" as const,
      },
      {
        id: "dup",
        label: "B",
        method: "GET" as never,
        path: "/b",
        returns: "toast" as const,
      },
    ];
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) => e.path === "actions[1].id" && e.message.includes("중복"),
        ),
      ).toBe(true);
    }
  });

  test("객체 아님 (null / array / primitive) = 실패", () => {
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest("string").ok).toBe(false);
    expect(validateManifest(123).ok).toBe(false);
    expect(validateManifest([]).ok).toBe(false);
  });
});
