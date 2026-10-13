/**
 * 디스코드 봇 settings W3 마이그레이션 helper 단위 — Phase 5.7.1 W3 (2026-05-21).
 * spec section 4 매핑 정합 — 옛 4 칸 통째 삭제 + idempotency + 명시 로그.
 */

import { describe, expect, test } from "bun:test";

import { migrateLegacyBotKeys } from "./migrate-legacy-bot-keys.ts";

describe("migrateLegacyBotKeys — Phase 5.7.1 W3: 옛 4 칸 삭제", () => {
  test("autoExtract 단독 박힘 → 삭제 + 명시 로그", () => {
    const { migrated, warnings } = migrateLegacyBotKeys({
      autoExtract: true,
      discordToken: "x.y.z",
      ownerId: "123",
    });
    expect("autoExtract" in migrated).toBe(false);
    expect(migrated.discordToken).toBe("x.y.z");
    expect(migrated.ownerId).toBe("123");
    expect(
      warnings.some(
        (w) =>
          w.includes("Phase 5.7.1 W3") &&
          w.includes("autoExtract") &&
          w.includes("drop"),
      ),
    ).toBe(true);
  });

  test("activeMode 단독 박힘 → 삭제 + 명시 로그", () => {
    const { migrated, warnings } = migrateLegacyBotKeys({
      activeMode: false,
    });
    expect("activeMode" in migrated).toBe(false);
    expect(
      warnings.some(
        (w) =>
          w.includes("Phase 5.7.1 W3") &&
          w.includes("activeMode") &&
          w.includes("drop"),
      ),
    ).toBe(true);
  });

  test("ollamaUrl 단독 박힘 → 삭제 + 명시 로그", () => {
    const { migrated, warnings } = migrateLegacyBotKeys({
      ollamaUrl: "http://127.0.0.1:11434",
    });
    expect("ollamaUrl" in migrated).toBe(false);
    expect(
      warnings.some(
        (w) =>
          w.includes("Phase 5.7.1 W3") &&
          w.includes("ollamaUrl") &&
          w.includes("drop"),
      ),
    ).toBe(true);
  });

  test("ollamaModel 단독 박힘 → 삭제 + 명시 로그", () => {
    const { migrated, warnings } = migrateLegacyBotKeys({
      ollamaModel: "exaone3.5:32b",
    });
    expect("ollamaModel" in migrated).toBe(false);
    expect(
      warnings.some(
        (w) =>
          w.includes("Phase 5.7.1 W3") &&
          w.includes("ollamaModel") &&
          w.includes("drop"),
      ),
    ).toBe(true);
  });

  test("옛 봇 fixture 통합 — 4 칸 한 입력에 모두 박힘 → 삭제 + 잔존 8 칸 보존", () => {
    const { migrated, warnings } = migrateLegacyBotKeys({
      discordToken: "x.y.z",
      ownerId: "123456789",
      applicationId: "987654321",
      guildId: "111222333",
      memoryApiUrl: "http://127.0.0.1:3001",
      activeChannels: ["chan-a", "chan-b"],
      evolverNotify: false,
      evolverPollIntervalMin: 60,
      // 옛 4 칸 — 삭제 대상.
      autoExtract: true,
      activeMode: false,
      ollamaUrl: "http://127.0.0.1:11434",
      ollamaModel: "exaone3.5:7.8b",
    });
    // 4 칸 삭제 검증.
    expect("autoExtract" in migrated).toBe(false);
    expect("activeMode" in migrated).toBe(false);
    expect("ollamaUrl" in migrated).toBe(false);
    expect("ollamaModel" in migrated).toBe(false);
    // 잔존 8 칸 보존 검증.
    expect(migrated.discordToken).toBe("x.y.z");
    expect(migrated.ownerId).toBe("123456789");
    expect(migrated.applicationId).toBe("987654321");
    expect(migrated.guildId).toBe("111222333");
    expect(migrated.memoryApiUrl).toBe("http://127.0.0.1:3001");
    expect(migrated.activeChannels).toEqual(["chan-a", "chan-b"]);
    expect(migrated.evolverNotify).toBe(false);
    expect(migrated.evolverPollIntervalMin).toBe(60);
    // 4 변환 모두 로그 emit.
    const w3Logs = warnings.filter((w) => w.includes("Phase 5.7.1 W3"));
    expect(w3Logs.length).toBe(4);
  });

  test("idempotent — 두 번 가동 결과 동일 + 두 번째 warnings 빈 배열", () => {
    const input = {
      discordToken: "x.y.z",
      ownerId: "123",
      autoExtract: true,
      ollamaUrl: "http://127.0.0.1:11434",
    };
    const first = migrateLegacyBotKeys(input);
    const second = migrateLegacyBotKeys(first.migrated);
    expect(JSON.stringify(second.migrated)).toBe(JSON.stringify(first.migrated));
    expect(second.warnings).toEqual([]);
  });

  test("input mutate X (structuredClone 가드)", () => {
    const input = {
      autoExtract: true,
      ownerId: "456",
    };
    const inputBeforeJson = JSON.stringify(input);
    migrateLegacyBotKeys(input);
    expect(JSON.stringify(input)).toBe(inputBeforeJson);
  });

  test("옛 4 칸 부재 = 빈 warnings + 입력 그대로 반환", () => {
    const { migrated, warnings } = migrateLegacyBotKeys({
      discordToken: "x.y.z",
      ownerId: "123",
    });
    expect(migrated).toEqual({ discordToken: "x.y.z", ownerId: "123" });
    expect(warnings).toEqual([]);
  });

  test("빈 객체 = 빈 객체 출력 + 경고 0", () => {
    const { migrated, warnings } = migrateLegacyBotKeys({});
    expect(migrated).toEqual({});
    expect(warnings).toEqual([]);
  });

  test("silent fallback 금지 — 모든 변환 명시 로그 (4 칸 각각)", () => {
    const { warnings } = migrateLegacyBotKeys({
      autoExtract: true,
      activeMode: false,
      ollamaUrl: "http://127.0.0.1:11434",
      ollamaModel: "exaone3.5:7.8b",
    });
    expect(warnings.length).toBe(4);
    for (const key of ["autoExtract", "activeMode", "ollamaUrl", "ollamaModel"]) {
      expect(warnings.some((w) => w.includes(key))).toBe(true);
    }
  });
});
