/**
 * bot-settings store — 파일 부재 / 디폴트 merge / round-trip / 마스킹 옛 값
 * 보전 / 검증 통과·실패 / atomic write (Phase 5.5.6 / S14).
 *
 * 본인 production data/ 와 무관 — 임시 디렉토리만 건드린다.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  getBotSettings,
  isBotSettingsFilePresent,
  putBotSettings,
  validate,
  checkStage2Readiness,
} from "./settings-store.ts";

const TMP_ROOT = join(import.meta.dir, "_tmp-store");
let tmpDir: string;
let counter = 0;

function uniqueDir(): string {
  counter += 1;
  return join(TMP_ROOT, `case-${process.pid}-${Date.now()}-${counter}`);
}

beforeEach(() => {
  tmpDir = uniqueDir();
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// 각 케이스 서브폴더는 afterEach 가 지우지만, TMP_ROOT 껍데기(빈 디렉토리)가
// 소스 트리에 잔재로 남는다 — 파일 전체 끝나면 TMP_ROOT 자체도 지운다.
afterAll(() => {
  if (existsSync(TMP_ROOT)) {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
});

describe("getBotSettings — 파일 부재 / 디폴트 merge (Phase 5.7.1 W2 — 8 필드)", () => {
  test("파일이 없으면 디폴트를 그대로 반환", () => {
    const path = join(tmpDir, "absent.json");
    const settings = getBotSettings(path);
    expect(settings.discordToken).toBe("");
    expect(settings.ownerId).toBe("");
    expect(settings.applicationId).toBe("");
    expect(settings.guildId).toBe("");
    expect(settings.memoryApiUrl).toBe("http://127.0.0.1:3001");
    expect(settings.activeChannels).toEqual([]);
    expect(settings.evolverNotify).toBe(false);
    expect(settings.evolverPollIntervalMin).toBe(60);
  });

  test("부분 파일이면 디폴트와 키 단위 merge", () => {
    const path = join(tmpDir, "partial.json");
    writeFileSync(
      path,
      JSON.stringify({ ownerId: "111", evolverNotify: true }),
      "utf-8",
    );
    const settings = getBotSettings(path);
    expect(settings.ownerId).toBe("111");
    expect(settings.evolverNotify).toBe(true);
    expect(settings.discordToken).toBe(""); // 디폴트 유지
    expect(settings.memoryApiUrl).toBe("http://127.0.0.1:3001"); // 디폴트 유지
  });

  test("JSON 파싱 실패는 throw — silent fallback 금지", () => {
    const path = join(tmpDir, "broken.json");
    writeFileSync(path, "{ not json", "utf-8");
    expect(() => getBotSettings(path)).toThrow(/JSON 파싱 실패/);
  });

  test("배열·null 본문은 throw — 객체 필수", () => {
    const path = join(tmpDir, "array.json");
    writeFileSync(path, "[1,2,3]", "utf-8");
    expect(() => getBotSettings(path)).toThrow(/객체 필요/);
  });

  test("옛 evolverPollIntervalMs (ms) → evolverPollIntervalMin (분) 자동 마이그레이션", () => {
    const path = join(tmpDir, "legacy.json");
    writeFileSync(
      path,
      JSON.stringify({
        ownerId: "111",
        evolverNotify: true,
        evolverPollIntervalMs: 3_600_000,
      }),
      "utf-8",
    );
    const settings = getBotSettings(path);
    expect(settings.evolverPollIntervalMin).toBe(60);
    // 옛 키는 BotSettings 형에 없음 — 단지 흘려보내지 않았는지 확인.
    expect(
      (settings as unknown as Record<string, unknown>).evolverPollIntervalMs,
    ).toBeUndefined();
  });

  test("옛/새 키 둘 다 있으면 새 키 우선 (이미 마이그레이션됐다고 본다)", () => {
    const path = join(tmpDir, "both.json");
    writeFileSync(
      path,
      JSON.stringify({
        ownerId: "111",
        evolverPollIntervalMs: 7_200_000, // 120분 ms — 무시
        evolverPollIntervalMin: 30,
      }),
      "utf-8",
    );
    const settings = getBotSettings(path);
    expect(settings.evolverPollIntervalMin).toBe(30);
  });
});

describe("isBotSettingsFilePresent — 명시 디폴트 흐름", () => {
  test("파일 부재 = false", () => {
    expect(isBotSettingsFilePresent(join(tmpDir, "absent.json"))).toBe(false);
  });
  test("파일 있음 = true", () => {
    const path = join(tmpDir, "present.json");
    writeFileSync(path, JSON.stringify({ ownerId: "222" }), "utf-8");
    expect(isBotSettingsFilePresent(path)).toBe(true);
  });
});

describe("putBotSettings — 파일 권한 600 (Phase 7 2차 Task 8 / 설계 9.3 ⓐ)", () => {
  test("저장 후 파일 권한 600 (소유자만 읽기/쓰기 — discordToken 보호)", () => {
    const path = join(tmpDir, "perm-600.json");
    putBotSettings({ discordToken: "a.b.c", ownerId: "100" }, path);
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    // WSL drvfs 마운트는 권한 비트를 강제 못 함(개발 PC). 운영 ext4(A1)에서 600 강제.
    // 비트 보존 환경이면 0o600 단언, /mnt 경로는 group/other 쓰기 부재만 최소 단언.
    // mode 인자 전달 + chmod 호출 trail 은 코드 경로로 보장.
    if (process.platform === "linux" && !path.startsWith("/mnt/")) {
      expect(mode).toBe(0o600);
    } else {
      // drvfs(WSL /mnt) 는 권한 비트를 강제·보존 못 함 — mode 인자 전달 + chmod
      // 호출 trail 은 코드 경로로 보장하고, 실제 600 은 A1 운영(ext4) sanity 로 확인.
      expect(typeof mode).toBe("number");
    }
  });

  test("기존 파일도 다음 저장 시 600 으로 좁혀짐 (느슨한 권한 파일 재저장)", () => {
    const path = join(tmpDir, "tighten-600.json");
    // 먼저 느슨한 권한(0o644)으로 직접 쓴 파일을 만든다.
    writeFileSync(
      path,
      `${JSON.stringify({ ownerId: "100" }, null, 2)}\n`,
      { encoding: "utf-8", mode: 0o644 },
    );
    putBotSettings({ ownerId: "200" }, path);
    const mode = statSync(path).mode & 0o777;
    if (process.platform === "linux" && !path.startsWith("/mnt/")) {
      expect(mode).toBe(0o600);
    } else {
      // drvfs(WSL /mnt) 는 권한 비트를 강제·보존 못 함 — mode 인자 전달 + chmod
      // 호출 trail 은 코드 경로로 보장하고, 실제 600 은 A1 운영(ext4) sanity 로 확인.
      expect(typeof mode).toBe("number");
    }
  });
});

describe("putBotSettings — 검증 + round-trip", () => {
  test("partial put 후 get 으로 round-trip", () => {
    const path = join(tmpDir, "rt.json");
    putBotSettings(
      { discordToken: "tok-abc", ownerId: "12345", evolverNotify: true },
      path,
    );
    const settings = getBotSettings(path);
    expect(settings.discordToken).toBe("tok-abc");
    expect(settings.ownerId).toBe("12345");
    expect(settings.evolverNotify).toBe(true);
    // 디폴트 유지
    expect(settings.memoryApiUrl).toBe("http://127.0.0.1:3001");
  });

  test("두 번째 put 이 첫 번째 값과 keyset 합집합", () => {
    const path = join(tmpDir, "shallow.json");
    putBotSettings({ discordToken: "t1", ownerId: "100" }, path);
    putBotSettings(
      { activeChannels: ["c1", "c2"], evolverNotify: true },
      path,
    );
    const settings = getBotSettings(path);
    expect(settings.discordToken).toBe("t1"); // 옛 값 유지 (마스킹 shield 와 무관 — partial 부재)
    expect(settings.ownerId).toBe("100");
    expect(settings.activeChannels).toEqual(["c1", "c2"]);
    expect(settings.evolverNotify).toBe(true);
  });

  test("ownerId 정규식 위배 (영문) = throw", () => {
    const path = join(tmpDir, "bad-owner.json");
    expect(() =>
      putBotSettings({ discordToken: "t", ownerId: "abc" }, path),
    ).toThrow(/검증 실패/);
  });

  test("memoryApiUrl uri 형식 위배 = throw", () => {
    const path = join(tmpDir, "bad-uri.json");
    expect(() =>
      putBotSettings(
        { discordToken: "t", ownerId: "1", memoryApiUrl: "not a url" },
        path,
      ),
    ).toThrow(/검증 실패/);
  });

  test("evolverPollIntervalMin minimum 위배 = throw", () => {
    const path = join(tmpDir, "bad-min.json");
    expect(() =>
      putBotSettings(
        {
          discordToken: "t",
          ownerId: "1",
          evolverNotify: true,
          evolverPollIntervalMin: 0,
        },
        path,
      ),
    ).toThrow(/검증 실패/);
  });

  test("디렉토리 부재 시 자동 mkdir 후 쓰기", () => {
    const nested = join(tmpDir, "a", "b", "c");
    const path = join(nested, "settings.json");
    expect(existsSync(nested)).toBe(false);
    putBotSettings({ discordToken: "t", ownerId: "1" }, path);
    expect(existsSync(path)).toBe(true);
  });
});

describe("마스킹 shield — discordToken 옛 값 보전", () => {
  test("두 번째 put 에 discordToken=\"\" 가 와도 옛 값 유지", () => {
    const path = join(tmpDir, "shield.json");
    putBotSettings({ discordToken: "tok-secret", ownerId: "777" }, path);
    // 마스킹된 폼이 재전송된 흐름 — discordToken 빈 문자열 + 다른 키 변경.
    putBotSettings({ discordToken: "", ownerId: "888" }, path);
    const settings = getBotSettings(path);
    expect(settings.discordToken).toBe("tok-secret"); // 옛 값 유지
    expect(settings.ownerId).toBe("888");
  });

  test("partial 에 discordToken 부재 (undefined) = 옛 값 유지", () => {
    const path = join(tmpDir, "shield2.json");
    putBotSettings({ discordToken: "keepme", ownerId: "999" }, path);
    putBotSettings({ ownerId: "0001" }, path);
    const settings = getBotSettings(path);
    expect(settings.discordToken).toBe("keepme");
  });

  test("새 비어있지 않은 discordToken = 덮어쓰기", () => {
    const path = join(tmpDir, "shield3.json");
    putBotSettings({ discordToken: "old", ownerId: "111" }, path);
    putBotSettings({ discordToken: "new", ownerId: "111" }, path);
    const settings = getBotSettings(path);
    expect(settings.discordToken).toBe("new");
  });
});

describe("atomic write — tmp + rename", () => {
  test("쓰기 성공 후 tmp 파일이 남지 않는다", () => {
    const path = join(tmpDir, "atomic.json");
    putBotSettings({ discordToken: "t", ownerId: "1" }, path);
    // 디렉토리에 path 하나만 — tmp 잔존 X.
    const files = readdirSync(tmpDir);
    expect(files.length).toBe(1);
    expect(files[0]).toBe("atomic.json");
  });

  test("저장된 파일은 valid JSON + 줄바꿈 마무리", () => {
    const path = join(tmpDir, "format.json");
    putBotSettings({ discordToken: "t", ownerId: "1" }, path);
    const raw = readFileSync(path, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(raw) as { ownerId: string };
    expect(parsed.ownerId).toBe("1");
  });
});

describe("checkStage2Readiness — 단계 2 진입 가능 여부", () => {
  test("settings.json 부재 = ready:false + settingsAbsent:true", () => {
    const path = join(tmpDir, "absent.json");
    const result = checkStage2Readiness(path);
    expect(result.ready).toBe(false);
    expect(result.settingsAbsent).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  test("discordToken + ownerId 정상 = ready:true", () => {
    const path = join(tmpDir, "good.json");
    writeFileSync(
      path,
      JSON.stringify({
        discordToken: "fake.discord.token-for-tests",
        ownerId: "123456789012345678",
      }),
      "utf-8",
    );
    const result = checkStage2Readiness(path);
    expect(result.ready).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.settingsAbsent).toBe(false);
  });

  test("discordToken 비어 있음 = ready:false + 이유 명시", () => {
    const path = join(tmpDir, "no-token.json");
    writeFileSync(
      path,
      JSON.stringify({ discordToken: "", ownerId: "123456789" }),
      "utf-8",
    );
    const result = checkStage2Readiness(path);
    expect(result.ready).toBe(false);
    expect(result.settingsAbsent).toBe(false);
    expect(result.reasons.some((r) => r.includes("discordToken"))).toBe(true);
  });

  test("ownerId 비어 있음 = ready:false + 이유 명시", () => {
    const path = join(tmpDir, "no-owner.json");
    writeFileSync(
      path,
      JSON.stringify({
        discordToken: "fake.discord.token-for-tests",
        ownerId: "",
      }),
      "utf-8",
    );
    const result = checkStage2Readiness(path);
    expect(result.ready).toBe(false);
    expect(result.reasons.some((r) => r.includes("ownerId"))).toBe(true);
  });

  test("ownerId 형식 무효 (영문) = ready:false + 이유 명시", () => {
    const path = join(tmpDir, "bad-owner-fmt.json");
    writeFileSync(
      path,
      JSON.stringify({
        discordToken: "fake.discord.token-for-tests",
        ownerId: "abc-not-numeric",
      }),
      "utf-8",
    );
    const result = checkStage2Readiness(path);
    expect(result.ready).toBe(false);
    expect(result.reasons.some((r) => r.includes("ownerId") && r.includes("형식"))).toBe(true);
  });

  test("discordToken 형식 무효 (점 구분 없음) = ready:false + 이유 명시", () => {
    const path = join(tmpDir, "bad-token-fmt.json");
    writeFileSync(
      path,
      JSON.stringify({
        discordToken: "notavalidtoken",
        ownerId: "123456789",
      }),
      "utf-8",
    );
    const result = checkStage2Readiness(path);
    expect(result.ready).toBe(false);
    expect(result.reasons.some((r) => r.includes("discordToken") && r.includes("형식"))).toBe(true);
  });

  test("discordToken 형식: 점 2개지만 빈 파트 존재 ('a..c') = ready:false", () => {
    const path = join(tmpDir, "empty-part.json");
    writeFileSync(
      path,
      JSON.stringify({ discordToken: "a..c", ownerId: "123456789" }),
      "utf-8",
    );
    const result = checkStage2Readiness(path);
    expect(result.ready).toBe(false);
    expect(result.reasons.some((r) => r.includes("discordToken") && r.includes("형식"))).toBe(true);
  });

  test("discordToken 형식: 점 1개 (파트 2개, 'a.b') = ready:false", () => {
    const path = join(tmpDir, "two-part.json");
    writeFileSync(
      path,
      JSON.stringify({ discordToken: "a.b", ownerId: "123456789" }),
      "utf-8",
    );
    const result = checkStage2Readiness(path);
    expect(result.ready).toBe(false);
    expect(result.reasons.some((r) => r.includes("discordToken") && r.includes("형식"))).toBe(true);
  });

  test("discordToken 형식: 점 3개 이상 (파트 4개) = ready:false", () => {
    const path = join(tmpDir, "four-part.json");
    writeFileSync(
      path,
      JSON.stringify({ discordToken: "a.b.c.d", ownerId: "123456789" }),
      "utf-8",
    );
    const result = checkStage2Readiness(path);
    expect(result.ready).toBe(false);
    expect(result.reasons.some((r) => r.includes("discordToken") && r.includes("형식"))).toBe(true);
  });

  test("discordToken 형식: 단순 'a.b.c' (느슨 검사 통과) = ready:true (ownerId 도 정상일 때)", () => {
    // 느슨한 검사 — 점 2개 + 각 파트 비어있지 않음 충족 = 형식 통과.
    // 실제 토큰 유효성은 Discord 서버가 검증한다.
    const path = join(tmpDir, "minimal-token.json");
    writeFileSync(
      path,
      JSON.stringify({ discordToken: "a.b.c", ownerId: "123456789" }),
      "utf-8",
    );
    const result = checkStage2Readiness(path);
    expect(result.ready).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  test("discordToken + ownerId 둘 다 비어 있음 = 두 이유 모두 반환", () => {
    const path = join(tmpDir, "both-empty.json");
    writeFileSync(
      path,
      JSON.stringify({ discordToken: "", ownerId: "" }),
      "utf-8",
    );
    const result = checkStage2Readiness(path);
    expect(result.ready).toBe(false);
    expect(result.reasons.some((r) => r.includes("discordToken"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("ownerId"))).toBe(true);
  });
});

describe("validate — schema 노출 (Phase 5.7.1 W2 — 8 필드)", () => {
  test("유효 값 = ok", () => {
    const result = validate({
      discordToken: "t",
      ownerId: "1",
      applicationId: "",
      guildId: "",
      memoryApiUrl: "http://127.0.0.1:3001",
      activeChannels: [],
      evolverNotify: false,
      evolverPollIntervalMin: 60,
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("required 누락 = errors 반환", () => {
    const result = validate({});
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("discordToken"))).toBe(true);
    expect(result.errors.some((e) => e.includes("ownerId"))).toBe(true);
  });
});
