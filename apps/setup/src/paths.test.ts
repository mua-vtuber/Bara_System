import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveSetupPaths } from "./paths.ts";

describe("resolveSetupPaths", () => {
  test("child Date.setHours uses configured timezone with explicit TZ taking precedence", () => {
    const root = mkdtempSync(join(tmpdir(), "bara-child-timezone-"));
    const memoryDir = join(root, "apps/memory");
    mkdirSync(memoryDir, { recursive: true });
    const settingsPath = join(root, "memory-settings.json");
    const cases = [
      { settings: {}, env: {}, zone: "Asia/Seoul", scheduled: "2026-09-23T19:00:00.000Z" },
      { settings: { time: { zone: "America/New_York" } }, env: {}, zone: "America/New_York", scheduled: "2026-09-24T08:00:00.000Z" },
      { settings: { time: { zone: "Asia/Seoul" } }, env: { TZ: "UTC" }, zone: "UTC", scheduled: "2026-09-24T04:00:00.000Z" },
    ];
    try {
      for (const mode of ["local", "desktop-windows"] as const) {
        for (const fixture of cases) {
          writeFileSync(settingsPath, JSON.stringify(fixture.settings));
          const paths = resolveSetupPaths({ mode, repoRoot: root, env: {
            LOCALAPPDATA: join(root, "appdata"), MEMORY_SETTINGS_PATH: settingsPath, ...fixture.env,
          } });
          const child = Bun.spawnSync([process.execPath, "-e", "const next=new Date('2026-09-24T12:00:00Z'); next.setHours(4,0,0,0); console.log(JSON.stringify({zone:process.env.TZ, scheduled:next.toISOString()}));"], {
            cwd: memoryDir, env: Object.assign({}, process.env, { TZ: "UTC" }, paths.env), stdout: "pipe", stderr: "pipe",
          });
          expect(child.exitCode).toBe(0);
          expect(JSON.parse(child.stdout.toString())).toEqual({ zone: fixture.zone, scheduled: fixture.scheduled });
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("final child environment preserves configured assets and adjacent secrets for local and desktop", () => {
    const root = mkdtempSync(join(tmpdir(), "bara-child-env-"));
    const memoryDir = join(root, "apps/memory");
    mkdirSync(join(root, "custom"), { recursive: true });
    mkdirSync(memoryDir, { recursive: true });
    try {
      for (const name of ["memory-settings.json", "profile.json"]) {
        const settingsPath = join(root, "custom", name);
        writeFileSync(settingsPath, JSON.stringify({ assets: { dir: "retained-assets" } }));
        for (const mode of ["local", "desktop-windows"] as const) {
          for (const explicit of [false, true]) {
            const paths = resolveSetupPaths({ mode, repoRoot: root, env: {
              LOCALAPPDATA: join(root, "appdata"), MEMORY_SETTINGS_PATH: settingsPath,
              ...(explicit ? { BARA_ASSET_DIR: "override-assets", BARA_SECRETS_PATH: "override-secrets.json" } : {}),
            } });
            const child = Bun.spawnSync([process.execPath, "-e", "console.log(JSON.stringify({assets:process.env.BARA_ASSET_DIR,secrets:process.env.BARA_SECRETS_PATH}))"], {
              cwd: memoryDir, env: { ...process.env, ...paths.env }, stdout: "pipe", stderr: "pipe",
            });
            expect(child.exitCode).toBe(0);
            const actual = JSON.parse(child.stdout.toString());
            expect(actual.assets).toBe(join(memoryDir, explicit ? "override-assets" : "retained-assets"));
            expect(actual.secrets).toBe(explicit ? join(memoryDir, "override-secrets.json") : join(root, "custom", name.includes("settings") ? "secrets.json" : "profile.json.secrets.json"));
          }
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("relative overrides resolve from memory server cwd, not the setup caller", () => {
    const root = resolve("fixture-repo");
    const paths = resolveSetupPaths({ mode: "local", repoRoot: root, env: {
      MEMORY_SETTINGS_PATH: "custom/settings.json", SSE_TOKEN_PATH: "private/tokens.json", BARA_ASSET_DIR: "custom/assets",
    } });
    expect(paths.settingsPath).toBe(join(root, "apps/memory/custom/settings.json"));
    expect(paths.setupStatePath).toBe(join(root, "apps/memory/custom/setup-state.json"));
    expect(paths.env.SSE_TOKEN_PATH).toBe(join(root, "apps/memory/private/tokens.json"));
    expect(paths.assetDir).toBe(join(root, "apps/memory/custom/assets"));
  });
  test("desktop-windows 는 LOCALAPPDATA 아래 Bara/memory 를 쓴다", () => {
    const paths = resolveSetupPaths({
      mode: "desktop-windows",
      repoRoot: "D:/repo/bara_system",
      env: { LOCALAPPDATA: "C:/Users/test/AppData/Local" },
    });
    expect(paths.dataDir.replaceAll("\\", "/")).toBe(
      "C:/Users/test/AppData/Local/Bara/memory/data",
    );
    expect(paths.dbPath.replaceAll("\\", "/")).toBe(
      "C:/Users/test/AppData/Local/Bara/memory/data/bara.sqlite",
    );
    expect(paths.settingsPath.replaceAll("\\", "/")).toBe(
      "C:/Users/test/AppData/Local/Bara/memory/memory-settings.json",
    );
    expect(paths.hfCacheDir.replaceAll("\\", "/")).toBe(
      "C:/Users/test/AppData/Local/Bara/memory/models/hf-cache",
    );
  });

  test("local 은 apps/memory/data/bara.sqlite 를 고정 DB로 쓴다", () => {
    const root = resolve("D:/repo/bara_system");
    const paths = resolveSetupPaths({
      mode: "local",
      repoRoot: root,
      env: {},
    });
    expect(paths.dbPath).toBe(join(root, "apps", "memory", "data", "bara.sqlite"));
    expect(paths.settingsPath).toBe(
      join(root, "apps", "memory", "data", "memory-settings.json"),
    );
  });

  test("env override 는 settings/secrets/assets/HF/Kiwi 경로에 우선한다", () => {
    const paths = resolveSetupPaths({
      mode: "local",
      repoRoot: "D:/repo/bara_system",
      env: {
        MEMORY_SETTINGS_PATH: "X:/settings.json",
        BARA_SECRETS_PATH: "X:/secrets.json",
        BARA_ASSET_DIR: "X:/assets",
        BARA_HF_CACHE_DIR: "X:/hf",
        BARA_KIWI_MODEL_DIR: "X:/kiwi",
      },
    });
    expect(paths.settingsPath.replaceAll("\\", "/")).toBe("X:/settings.json");
    expect(paths.secretsPath.replaceAll("\\", "/")).toBe("X:/secrets.json");
    expect(paths.assetDir.replaceAll("\\", "/")).toBe("X:/assets");
    expect(paths.hfCacheDir.replaceAll("\\", "/")).toBe("X:/hf");
    expect(paths.kiwiModelDir.replaceAll("\\", "/")).toBe("X:/kiwi");
  });
});

