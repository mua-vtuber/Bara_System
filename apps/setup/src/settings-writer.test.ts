import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { embeddingDimensionOf } from "../../memory/src/embedding/factory.ts";
import { resolveSetupPaths, type SetupMode, type SetupPathEnv, type SetupPaths } from "./paths.ts";

/** Setup runs as a CLI process. End that real process before removing a Windows
 * WAL database: migrations leave prepared sqlite-vec statements alive until exit. */
function runWriter(root: string, mode: SetupMode, env: SetupPathEnv, selection: Record<string, unknown>) {
  const fixture = join(root, "prepare.ts");
  const output = join(root, "result.json");
  writeFileSync(fixture,
    `import { resolveSetupPaths } from ${JSON.stringify(join(import.meta.dir, "paths.ts"))};\n` +
    `import { writeSettingsAndMigrateDb } from ${JSON.stringify(join(import.meta.dir, "settings-writer.ts"))};\n` +
    `process.env.BARA_SECRETS_PATH = "before-setup-test";\n` +
    `const paths = resolveSetupPaths({ mode: ${JSON.stringify(mode)}, repoRoot: ${JSON.stringify(root)}, env: ${JSON.stringify(env)} });\n` +
    `const result = writeSettingsAndMigrateDb(paths, ${JSON.stringify(selection)});\n` +
    `await Bun.write(${JSON.stringify(output)}, JSON.stringify({ result, restoredSecretsPath: process.env.BARA_SECRETS_PATH }));\n`);
  // The writer migrates MEMORY_DB_PATH when it is set; an inherited value must never reach a real database.
  const { MEMORY_DB_PATH: _inheritedDbPath, ...childEnv } = process.env;
  const child = Bun.spawnSync([process.execPath, fixture], { env: childEnv, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return JSON.parse(readFileSync(output, "utf8")) as {
    result: ReturnType<typeof import("./settings-writer.ts")["writeSettingsAndMigrateDb"]>;
    restoredSecretsPath: string;
  };
}

/** Setup modes that launch.ts or Bara Launcher send back through setup when the completion marker is not current. */
const LAUNCHER_MODES = ["local", "desktop-windows"] as const;

/** LLM slot as the dashboard LLM settings leave it: LM Studio text/image models on the
 * user's port plus the Claude cleanup pass, whose key lives only in secrets.json. */
const CONFIGURED_LLM = {
  extractor: { enabled: true, provider: "openai_compatible", openaiBaseUrl: "http://127.0.0.1:4321/v1", openaiModel: "user-text-model" },
  cleanup: { enabled: true, provider: "anthropic", anthropicModel: "user-cleanup-model", intervalDays: 3 },
  vision: { enabled: true, provider: "openai_compatible", openaiBaseUrl: "http://127.0.0.1:4321/v1", openaiModel: "user-image-model" },
};
const CLEANUP_KEY_PATH = "llm.cleanup.anthropicApiKey";
const CLEANUP_KEY = "cleanup-key-fixture";

function writeConfiguredSettings(paths: SetupPaths): void {
  mkdirSync(dirname(paths.settingsPath), { recursive: true });
  mkdirSync(dirname(paths.secretsPath), { recursive: true });
  writeFileSync(paths.settingsPath, JSON.stringify({ db: { path: paths.dbPath }, llm: CONFIGURED_LLM }));
  writeFileSync(paths.secretsPath, JSON.stringify({ version: 1, secrets: { [CLEANUP_KEY_PATH]: CLEANUP_KEY } }));
}

describe("writeSettingsAndMigrateDb", () => {
  test("retry preserves configured database path, port and bind host", () => {
    const root = mkdtempSync(join(tmpdir(), "bara-setup-retry-"));
    const paths = resolveSetupPaths({ mode: "server-a1", repoRoot: root, env: {} });
    mkdirSync(paths.dataDir, { recursive: true });
    const dbPath = join(paths.dataDir, "existing.sqlite");
    writeFileSync(paths.settingsPath, JSON.stringify({ db: { path: dbPath, port: 4411, host: "::1" } }));
    try {
      const { result } = runWriter(root, "server-a1", {}, { useAi: false, localProvider: "none" });
      expect(result.settings.db.path).toBe(dbPath);
      expect(result.settings.db.port).toBe(4411);
      expect(result.settings.db.host).toBe("::1");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("temp data dir에 settings 를 쓰고 실제 SQLite migration 까지 완료한다", () => {
    const root = mkdtempSync(join(tmpdir(), "bara-setup-writer-"));
    try {
      const paths = resolveSetupPaths({ mode: "server-a1", repoRoot: root,
        env: { BARA_SECRETS_PATH: join(root, "private", "secrets.json") } });
      const { result, restoredSecretsPath } = runWriter(root, "server-a1",
        { BARA_SECRETS_PATH: join(root, "private", "secrets.json") },
        { useAi: true, localProvider: "lmstudio", extractorModel: "local-text", visionModel: "local-vlm" });
      expect(restoredSecretsPath).toBe("before-setup-test");
      expect(result.schemaVersion).toBeGreaterThan(0);
      expect(result.settings.db.path).toBe(paths.dbPath);
      expect(result.settings.assets.dir).toBe(paths.assetDir);
      expect(result.settings.llm.extractor.provider).toBe("openai_compatible");
      expect(result.settings.llm.extractor.openaiModel).toBe("local-text");
      expect(result.settings.llm.vision.openaiModel).toBe("local-vlm");
      expect(result.settings.db.embeddingModel).toBe("bge-m3");
      expect(embeddingDimensionOf(result.settings.db.embeddingModel)).toBe(1024);
      const db = new Database(paths.dbPath, { readonly: true });
      try {
        const vecSql = db.query("SELECT sql FROM sqlite_master WHERE name = 'vec_nodes'").get() as { sql: string } | null;
        expect(vecSql).not.toBeNull();
        expect(vecSql!.sql).toContain("float[1024]");
      } finally { db.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  /** All three setup modes, per WP-B2-06R: "server-a1을 포함한 모든 모드에서
   * 기존 설정 파일이 있으면 llm을 기본으로 보존한다". */
  const ALL_MODES = ["local", "desktop-windows", "server-a1"] as const;

  for (const mode of LAUNCHER_MODES) {
    test(`${mode} retry keeps the user's configured LLM slot when this run picked nothing explicitly`, () => {
      const root = mkdtempSync(join(tmpdir(), "bara-setup-llm-retry-"));
      const env = { LOCALAPPDATA: join(root, "local-app-data") };
      const paths = resolveSetupPaths({ mode, repoRoot: root, env });
      try {
        writeConfiguredSettings(paths);
        // No `explicit` field — matches bare --yes/--dry-run (accepts a default,
        // did not pick anything in this run).
        const { result } = runWriter(root, mode, env, { useAi: true, localProvider: "ollama" });
        expect(result.llmOutcome).toBe("kept");
        expect(result.settings.llm.extractor.provider).toBe("openai_compatible");
        expect(result.settings.llm.cleanup.enabled).toBe(true);
        expect(result.settings.llm.extractor).toMatchObject(CONFIGURED_LLM.extractor);
        expect(result.settings.llm.cleanup).toMatchObject({ ...CONFIGURED_LLM.cleanup, anthropicApiKey: CLEANUP_KEY });
        expect(result.settings.llm.vision).toMatchObject(CONFIGURED_LLM.vision);
        // The preserved key goes back to secrets.json only, never into the settings file.
        expect(readFileSync(paths.settingsPath, "utf8")).not.toContain(CLEANUP_KEY);
        expect(JSON.parse(readFileSync(paths.secretsPath, "utf8")).secrets[CLEANUP_KEY_PATH]).toBe(CLEANUP_KEY);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    test(`first ${mode} preparation writes the chosen AI selection`, () => {
      const root = mkdtempSync(join(tmpdir(), "bara-setup-first-llm-"));
      const env = { LOCALAPPDATA: join(root, "local-app-data") };
      try {
        const { result } = runWriter(root, mode, env,
          { useAi: true, localProvider: "ollama", extractorModel: "chosen-text", visionModel: "chosen-image", cleanupEnabled: true });
        // First install has no previous settings to keep, so this is always "changed".
        expect(result.llmOutcome).toBe("changed");
        expect(result.settings.llm.extractor).toMatchObject({ enabled: true, provider: "ollama", ollamaModel: "chosen-text" });
        expect(result.settings.llm.cleanup).toMatchObject({ enabled: true, provider: "ollama" });
        expect(result.settings.llm.vision).toMatchObject({ provider: "ollama", ollamaModel: "chosen-image" });
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  test("server-a1 retry also keeps the operator's configured LLM slot when this run picked nothing explicitly", () => {
    // WP-B2-06R extends WP-B2-06's preservation to server-a1 too — the earlier
    // "server-a1 always applies its selection" exception is removed. Only an
    // *explicit* choice may now change the llm slot, in any mode.
    const root = mkdtempSync(join(tmpdir(), "bara-setup-a1-llm-"));
    const paths = resolveSetupPaths({ mode: "server-a1", repoRoot: root, env: {} });
    try {
      writeConfiguredSettings(paths);
      const { result } = runWriter(root, "server-a1", {},
        { useAi: true, localProvider: "ollama", extractorModel: "operator-text", visionModel: "operator-image", cleanupEnabled: false });
      expect(result.llmOutcome).toBe("kept");
      expect(result.settings.llm.extractor).toMatchObject(CONFIGURED_LLM.extractor);
      expect(result.settings.llm.cleanup).toMatchObject({ ...CONFIGURED_LLM.cleanup, anthropicApiKey: CLEANUP_KEY });
      expect(result.settings.llm.vision).toMatchObject(CONFIGURED_LLM.vision);
      expect(result.settings.db.path).toBe(paths.dbPath);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // WP-B2-06R matrix: 3 modes x (no explicit choice / explicit choice same as
  // current / explicit choice different from current). The "no explicit
  // choice" cell is already covered by the two test blocks above (LAUNCHER_MODES
  // + the server-a1 test just above); this block covers the two explicit cells
  // for all three modes, including server-a1.
  for (const mode of ALL_MODES) {
    test(`${mode} retry with an explicit choice that differs from the configured LLM slot changes only what that choice decides`, () => {
      const root = mkdtempSync(join(tmpdir(), "bara-setup-llm-explicit-diff-"));
      const env = mode === "desktop-windows" ? { LOCALAPPDATA: join(root, "local-app-data") } : {};
      const paths = resolveSetupPaths({ mode, repoRoot: root, env });
      try {
        writeConfiguredSettings(paths);
        const { result } = runWriter(root, mode, env, {
          useAi: true,
          localProvider: "ollama",
          extractorModel: "picked-text",
          visionModel: "picked-image",
          cleanupEnabled: false,
          explicit: true,
        });
        expect(result.llmOutcome).toBe("changed");
        expect(result.settings.llm.extractor).toMatchObject({ enabled: true, provider: "ollama", ollamaModel: "picked-text" });
        expect(result.settings.llm.cleanup).toMatchObject({ enabled: false, provider: "ollama" });
        expect(result.settings.llm.vision).toMatchObject({ enabled: false, provider: "ollama", ollamaModel: "picked-image" });
        // API keys never land in the settings JSON regardless of mode or explicitness.
        expect(readFileSync(paths.settingsPath, "utf8")).not.toContain(CLEANUP_KEY);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    test(`${mode} retry with an explicit choice that reproduces the configured LLM slot reports "kept" and leaves it untouched`, () => {
      const root = mkdtempSync(join(tmpdir(), "bara-setup-llm-explicit-same-"));
      const env = mode === "desktop-windows" ? { LOCALAPPDATA: join(root, "local-app-data") } : {};
      const paths = resolveSetupPaths({ mode, repoRoot: root, env });
      try {
        // Unlike CONFIGURED_LLM (dashboard-only shape: anthropic cleanup), this
        // fixture is exactly what a prior lmstudio setup selection would have
        // written via llmPartial() — the only shape an explicit re-selection
        // through setup can actually reproduce.
        mkdirSync(dirname(paths.settingsPath), { recursive: true });
        writeFileSync(paths.settingsPath, JSON.stringify({
          db: { path: paths.dbPath },
          llm: {
            extractor: { enabled: true, provider: "openai_compatible", openaiBaseUrl: "http://127.0.0.1:1234/v1", openaiModel: "same-text" },
            cleanup: { enabled: true, provider: "openai_compatible", openaiBaseUrl: "http://127.0.0.1:1234/v1", openaiModel: "" },
            vision: { enabled: false, provider: "openai_compatible", openaiBaseUrl: "http://127.0.0.1:1234/v1", openaiModel: "same-image" },
          },
        }));
        // Explicitly picking LM Studio with the exact same text/image models and
        // cleanup-on that the fixture already has must be reported as "kept"
        // (nothing actually differs), not "changed".
        const { result } = runWriter(root, mode, env, {
          useAi: true,
          localProvider: "lmstudio",
          extractorModel: "same-text",
          visionModel: "same-image",
          cleanupEnabled: true,
          explicit: true,
        });
        expect(result.llmOutcome).toBe("kept");
        expect(result.settings.llm.extractor).toMatchObject({ provider: "openai_compatible", openaiModel: "same-text" });
        expect(result.settings.llm.cleanup).toMatchObject({ enabled: true, provider: "openai_compatible" });
        expect(result.settings.llm.vision).toMatchObject({ provider: "openai_compatible", openaiModel: "same-image" });
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
});
