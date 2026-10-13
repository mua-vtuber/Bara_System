/**
 * 디스코드 봇 settings-schema + app.manifest.json 단위 검증
 * (Phase 5.7.1 W2 정합 — 옛 12 칸 → 8 칸 정리).
 *
 * 세 가닥:
 *  1) app.manifest.json 이 메모리 코어 manifest-validator 통과
 *  2) settings-schema 구조 정합 (8 필드 + x-ui 약속 + dependentSchemas)
 *  3) actions 2개 정의 정합 (verify-token / list-channels) —
 *     list-ollama-models 액션은 Phase 5.7.1 W2 에서 폐기 (능동 모드 Phase 10
 *     미구현 잔존 코드 정리, ollama* 키 봇 schema 안 자리 0 정합).
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { validateManifest } from "../../memory/src/federation/manifest-validator";
import {
  BOT_DEFAULTS,
  BOT_FIELD_KEYS,
  BOT_PASSWORD_FIELDS,
  botSettingsSchema,
  getBotDefaults,
  maskBotSecrets,
  validateBotSettings,
  validateMemoryApiUrlScheme,
} from "./settings-schema";

const manifestPath = join(__dirname, "..", "app.manifest.json");
const manifestRaw = readFileSync(manifestPath, "utf-8");
const manifestJson = JSON.parse(manifestRaw) as unknown;

describe("app.manifest.json — 메모리 디스커버리 검증", () => {
  test("manifest-validator 검증 통과", () => {
    const result = validateManifest(manifestJson);
    if (!result.ok) {
      // 실패 시 어떤 항목인지 한 줄로 노출 (디버깅 편의)
      throw new Error(
        `manifest 검증 실패: ${result.errors
          .map((e) => `${e.path}=${e.message}`)
          .join(" | ")}`,
      );
    }
  });

  test("핵심 필드 = spec section 4 정합", () => {
    const m = manifestJson as Record<string, unknown>;
    expect(m.id).toBe("bot-discord");
    expect(m.manifestVersion).toBe(1);
    expect(m.endpoint).toBe("http://127.0.0.1:3100");
    expect(m.health).toBe("/health");
    const settings = m.settings as Record<string, string>;
    expect(settings.schemaPath).toBe("/settings/schema");
    expect(settings.getPath).toBe("/settings");
    expect(settings.putPath).toBe("/settings");
    expect(m.tags).toEqual(["adapter", "input", "reference"]);
  });

  test("actions = 2개 (verify-token / list-channels) — list-ollama-models 폐기", () => {
    const m = manifestJson as Record<string, unknown>;
    const actions = m.actions as Array<Record<string, unknown>>;
    expect(actions).toHaveLength(2);

    const byId = new Map(actions.map((a) => [a.id, a]));
    const verify = byId.get("verify-token");
    expect(verify?.method).toBe("POST");
    expect(verify?.returns).toBe("toast");
    expect(verify?.needsConfirm).toBe(false);

    const channels = byId.get("list-channels");
    expect(channels?.method).toBe("GET");
    expect(channels?.returns).toBe("enum");

    // Phase 5.7.1 W2 — list-ollama-models 액션 통째 폐기.
    expect(byId.get("list-ollama-models")).toBeUndefined();
  });
});

describe("settings-schema 구조 정합 (Phase 5.7.1 W2 + Phase 7 2차 + 일정 알림 — 12 필드)", () => {
  test("12 필드 — 옛 4 칸 삭제 + sseReconnectDelayMs + 일정 알림 3칸 추가", () => {
    const props = botSettingsSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(
      [
        "activeChannels",
        "applicationId",
        "discordToken",
        "evolverNotify",
        "evolverPollIntervalMin",
        "guildId",
        "memoryApiUrl",
        "ownerId",
        "scheduleReminderDateOnlyTime",
        "scheduleReminderPollIntervalMin",
        "scheduleRemindersEnabled",
        "sseReconnectDelayMs",
      ].sort(),
    );
    expect(BOT_FIELD_KEYS).toHaveLength(12);
  });

  test("sseReconnectDelayMs — Phase 7 2차 정리 제안 알림 재연결 칸 (default 3000)", () => {
    const props = botSettingsSchema.properties as Record<string, { default?: unknown }>;
    expect(props.sseReconnectDelayMs).toBeDefined();
    expect(props.sseReconnectDelayMs.default).toBe(3000);
  });

  test("일정 알림 3칸 — default off + 5분 poll + 날짜-only 09:00", () => {
    const props = botSettingsSchema.properties as Record<string, { default?: unknown }>;
    expect(props.scheduleRemindersEnabled.default).toBe(false);
    expect(props.scheduleReminderPollIntervalMin.default).toBe(5);
    expect(props.scheduleReminderDateOnlyTime.default).toBe("09:00");
    expect(BOT_DEFAULTS.scheduleRemindersEnabled).toBe(false);
    expect(BOT_DEFAULTS.scheduleReminderPollIntervalMin).toBe(5);
    expect(BOT_DEFAULTS.scheduleReminderDateOnlyTime).toBe("09:00");
  });

  test("옛 4 칸 (autoExtract / activeMode / ollamaUrl / ollamaModel) properties 박힌 자리 0", () => {
    const props = botSettingsSchema.properties as Record<string, unknown>;
    expect(props.autoExtract).toBeUndefined();
    expect(props.activeMode).toBeUndefined();
    expect(props.ollamaUrl).toBeUndefined();
    expect(props.ollamaModel).toBeUndefined();
  });

  test("BOT_FIELD_KEYS 박힌 자리 옛 4 칸 0", () => {
    const keys = BOT_FIELD_KEYS as readonly string[];
    expect(keys).not.toContain("autoExtract");
    expect(keys).not.toContain("activeMode");
    expect(keys).not.toContain("ollamaUrl");
    expect(keys).not.toContain("ollamaModel");
  });

  test("required = discordToken + ownerId", () => {
    const required = [...botSettingsSchema.required].sort();
    expect(required).toEqual(["discordToken", "ownerId"].sort() as typeof required);
  });

  test("discordToken = password 위젯 (마스킹 약속)", () => {
    const field = (botSettingsSchema.properties as Record<string, any>)
      .discordToken;
    expect(field["x-ui"]?.widget).toBe("password");
    expect(BOT_PASSWORD_FIELDS).toContain("discordToken");
  });

  test("ownerId = 숫자 정규식 패턴", () => {
    const field = (botSettingsSchema.properties as Record<string, any>).ownerId;
    expect(field.pattern).toBe("^\\d+$");
  });

  test("activeChannels = array + items dynamic-enum list-channels", () => {
    const field = (botSettingsSchema.properties as Record<string, any>)
      .activeChannels;
    expect(field.type).toBe("array");
    expect(field.items?.type).toBe("string");
    expect(field.items?.["x-ui"]?.widget).toBe("dynamic-enum");
    expect(field.items?.["x-ui"]?.actionId).toBe("list-channels");
    expect(field.items?.["x-ui"]?.labelField).toBe("name");
    expect(field.items?.["x-ui"]?.valueField).toBe("id");
  });

  test("evolverPollIntervalMin = minimum 1 (분)", () => {
    const field = (botSettingsSchema.properties as Record<string, any>)
      .evolverPollIntervalMin;
    expect(field.minimum).toBe(1);
  });

  test("evolverPollIntervalMin title = 정리 결과 알림 확인 주기 (분)", () => {
    const field = (botSettingsSchema.properties as Record<string, any>)
      .evolverPollIntervalMin;
    expect(field.title).toBe("정리 결과 알림 확인 주기 (분)");
  });

  test("evolverPollIntervalMin description = 폴링 흐름 정직 라벨 + Phase 7.4 종착점 명시", () => {
    const field = (botSettingsSchema.properties as Record<string, any>)
      .evolverPollIntervalMin;
    const desc: string = field.description;
    // 옛 4문장 → 1~2문장 압축 (spec section 2.2 정합).
    expect(desc).toContain("폴링");
    expect(desc).toContain("Phase 7.4");
    expect(desc).toContain("push");
    // 옛 4문장 잔존 단어 자리 0 (압축 검증).
    expect(desc).not.toContain("디폴트 60분");
    expect(desc).not.toContain("정리 사이클 자체는");
  });

  test("dependentSchemas = evolverNotify ↔ evolverPollIntervalMin", () => {
    const deps = (botSettingsSchema as any).dependentSchemas;
    expect(deps).toBeDefined();
    expect(deps.evolverNotify).toBeDefined();
    expect(deps.evolverNotify.then.required).toContain("evolverPollIntervalMin");
    expect(deps.scheduleRemindersEnabled.then.required).toContain(
      "scheduleReminderPollIntervalMin",
    );
    expect(deps.scheduleRemindersEnabled.then.required).toContain(
      "scheduleReminderDateOnlyTime",
    );
  });

  test("디폴트 값 = evolverNotify false + 폴링 60분 (1시간)", () => {
    expect(BOT_DEFAULTS.evolverNotify).toBe(false);
    expect(BOT_DEFAULTS.evolverPollIntervalMin).toBe(60);
  });

  test("BOT_DEFAULTS 박힌 자리 옛 4 칸 0", () => {
    const defaults = BOT_DEFAULTS as unknown as Record<string, unknown>;
    expect(defaults.autoExtract).toBeUndefined();
    expect(defaults.activeMode).toBeUndefined();
    expect(defaults.ollamaUrl).toBeUndefined();
    expect(defaults.ollamaModel).toBeUndefined();
  });
});

describe("validateBotSettings — 단위 검증", () => {
  test("디폴트 값 전체가 통과 (단, discordToken/ownerId 빈 문자 = required 통과)", () => {
    // required 는 키 존재만 본다 (디폴트 BOT_DEFAULTS 가 8 키 다 채움)
    const result = validateBotSettings(getBotDefaults());
    expect(result.ok).toBe(true);
  });

  test("ownerId 정규식 위반 = 실패", () => {
    const s = getBotDefaults();
    s.ownerId = "not-a-number";
    const result = validateBotSettings(s);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("ownerId"))).toBe(true);
  });

  test("memoryApiUrl uri 형식 위반 = 실패", () => {
    const s = getBotDefaults();
    s.memoryApiUrl = "not a url";
    const result = validateBotSettings(s);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("memoryApiUrl"))).toBe(true);
  });

  test("evolverPollIntervalMin minimum 위반 = 실패", () => {
    const s = getBotDefaults();
    s.evolverPollIntervalMin = 0;
    const result = validateBotSettings(s);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("evolverPollIntervalMin"))).toBe(
      true,
    );
  });

  test("evolverNotify=true 일 때 evolverPollIntervalMin 누락 = 실패", () => {
    const s = getBotDefaults();
    s.evolverNotify = true;
    // @ts-expect-error — 의도적 누락 테스트
    delete s.evolverPollIntervalMin;
    const result = validateBotSettings(s);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("evolverPollIntervalMin")),
    ).toBe(true);
  });

  test("scheduleReminderDateOnlyTime HH:MM 패턴 위반 = 실패", () => {
    const s = getBotDefaults();
    s.scheduleRemindersEnabled = true;
    s.scheduleReminderDateOnlyTime = "25:99";
    const result = validateBotSettings(s);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("scheduleReminderDateOnlyTime")),
    ).toBe(true);
  });

  test("activeChannels item 비-string = 실패", () => {
    const s = getBotDefaults();
    // @ts-expect-error — 의도적 타입 위반 테스트
    s.activeChannels = ["123", 456];
    const result = validateBotSettings(s);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("activeChannels"))).toBe(true);
  });

  test("옛 4 칸 (autoExtract / activeMode / ollamaUrl / ollamaModel) 입력 = silent 무시 + ok 유지", () => {
    // 옛 fixture (settings.json 잔존) 입력 시 schema 안 박힌 키는 validateField
    // 가 skip (fieldSchema 미존재 → continue). W3 migration helper 가 명시 삭제
    // 처리 약속. 본 단위 검증에서는 unknown 키가 ok 를 깨지 않는다는 약속만 검증.
    const s = {
      ...getBotDefaults(),
      autoExtract: true,
      activeMode: false,
      ollamaUrl: "http://127.0.0.1:11434",
      ollamaModel: "qwen3:8b",
    };
    const result = validateBotSettings(s);
    expect(result.ok).toBe(true);
    // 옛 키 관련 오류 박힌 자리 0.
    expect(result.errors.some((e) => e.includes("autoExtract"))).toBe(false);
    expect(result.errors.some((e) => e.includes("activeMode"))).toBe(false);
    expect(result.errors.some((e) => e.includes("ollamaUrl"))).toBe(false);
    expect(result.errors.some((e) => e.includes("ollamaModel"))).toBe(false);
  });
});

describe("신규 3 필드 — 디폴트 / 형식 검증 (Phase 5.7.1 W2 — autoExtract 단락 폐기)", () => {
  test("applicationId 디폴트 = 빈 문자열", () => {
    expect(BOT_DEFAULTS.applicationId).toBe("");
  });

  test("guildId 디폴트 = 빈 문자열", () => {
    expect(BOT_DEFAULTS.guildId).toBe("");
  });

  test("memoryApiUrl 디폴트 = http://127.0.0.1:3001", () => {
    expect(BOT_DEFAULTS.memoryApiUrl).toBe("http://127.0.0.1:3001");
  });

  test("applicationId 숫자 전용 패턴 — 비어 있으면 통과 (선택 필드)", () => {
    const s = getBotDefaults();
    s.applicationId = "";
    const result = validateBotSettings(s);
    expect(result.ok).toBe(true);
  });

  test("applicationId 숫자 전용 패턴 — 영문 포함 시 실패", () => {
    const s = getBotDefaults();
    s.applicationId = "abc123";
    const result = validateBotSettings(s);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("applicationId"))).toBe(true);
  });

  test("guildId 숫자 전용 패턴 — 비어 있으면 통과 (선택 필드)", () => {
    const s = getBotDefaults();
    s.guildId = "";
    const result = validateBotSettings(s);
    expect(result.ok).toBe(true);
  });

  test("guildId 숫자 전용 패턴 — 영문 포함 시 실패", () => {
    const s = getBotDefaults();
    s.guildId = "abc";
    const result = validateBotSettings(s);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("guildId"))).toBe(true);
  });

  test("memoryApiUrl uri 형식 검증 — loopback http 유효 URL 통과", () => {
    // D4 도입 후 비-loopback http 는 막히므로, "형식 유효 URL 통과" 케이스는
    // loopback 주소로 확인한다(비-loopback https 통과는 아래 D4 describe 에서 별도 검증).
    const s = getBotDefaults();
    s.memoryApiUrl = "http://127.0.0.1:3001";
    const result = validateBotSettings(s);
    expect(result.ok).toBe(true);
  });
});

describe("D4 — memoryApiUrl scheme 제약 (loopback http / 비-loopback https)", () => {
  describe("validateMemoryApiUrlScheme (순수 함수 fixture)", () => {
    test("loopback http 허용 — 127.0.0.1", () => {
      expect(validateMemoryApiUrlScheme("http://127.0.0.1:3001")).toBeNull();
    });

    test("loopback http 허용 — localhost", () => {
      expect(validateMemoryApiUrlScheme("http://localhost:3001")).toBeNull();
    });

    test("loopback http 허용 — [::1]", () => {
      expect(validateMemoryApiUrlScheme("http://[::1]:3001")).toBeNull();
    });

    test("loopback https 허용", () => {
      expect(validateMemoryApiUrlScheme("https://127.0.0.1:3001")).toBeNull();
    });

    test("비-loopback https 허용", () => {
      expect(
        validateMemoryApiUrlScheme("https://memory.example.com"),
      ).toBeNull();
    });

    test("비-loopback http 거부 — IP", () => {
      const err = validateMemoryApiUrlScheme("http://1.2.3.4:3001");
      expect(err).not.toBeNull();
      expect(err).toContain("https 만 허용");
    });

    test("비-loopback http 거부 — 도메인", () => {
      const err = validateMemoryApiUrlScheme("http://memory.example.com");
      expect(err).not.toBeNull();
      expect(err).toContain("https 만 허용");
    });

    test("http/https 아닌 scheme 거부 — ftp", () => {
      const err = validateMemoryApiUrlScheme("ftp://127.0.0.1/x");
      expect(err).not.toBeNull();
      expect(err).toContain("http 또는 https");
    });

    test("파싱 불가 URL 은 null (format:uri 가 잡으므로 중복 회피)", () => {
      expect(validateMemoryApiUrlScheme("not a url")).toBeNull();
    });
  });

  describe("validateBotSettings 통합 — memoryApiUrl 반영", () => {
    test("http://1.2.3.4:3001 → 실패 (비-loopback 평문)", () => {
      const s = getBotDefaults();
      s.memoryApiUrl = "http://1.2.3.4:3001";
      const result = validateBotSettings(s);
      expect(result.ok).toBe(false);
      expect(
        result.errors.some((e) => e.includes("memoryApiUrl")),
      ).toBe(true);
    });

    test("http://memory.example.com → 실패 (비-loopback 평문 도메인)", () => {
      const s = getBotDefaults();
      s.memoryApiUrl = "http://memory.example.com";
      const result = validateBotSettings(s);
      expect(result.ok).toBe(false);
      expect(
        result.errors.some((e) => e.includes("memoryApiUrl")),
      ).toBe(true);
    });

    test("https://memory.example.com → 통과", () => {
      const s = getBotDefaults();
      s.memoryApiUrl = "https://memory.example.com";
      const result = validateBotSettings(s);
      expect(result.ok).toBe(true);
    });

    test("http://127.0.0.1:3001 → 통과 (loopback 평문 허용)", () => {
      const s = getBotDefaults();
      s.memoryApiUrl = "http://127.0.0.1:3001";
      const result = validateBotSettings(s);
      expect(result.ok).toBe(true);
    });
  });
});

describe("maskBotSecrets — 패스워드 마스킹 약속", () => {
  test("discordToken 빈 문자 + $masked 메타 첨부", () => {
    const s = getBotDefaults();
    s.discordToken = "super-secret-token";
    const masked = maskBotSecrets(s);
    expect(masked.discordToken).toBe("");
    expect(masked.$masked).toContain("discordToken");
  });

  test("원본은 변경 X (immutable)", () => {
    const s = getBotDefaults();
    s.discordToken = "keep-me";
    maskBotSecrets(s);
    expect(s.discordToken).toBe("keep-me");
  });
});
