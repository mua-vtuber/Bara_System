import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetupEngine } from "./engine.ts";
import { detectOpenAiCompatible } from "./probes.ts";

describe("runSetupEngine dry-run", () => {
  test("Ollama selected without installation consent never completes or silently skips required models", async () => {
    const root = mkdtempSync(join(tmpdir(), "bara-no-consent-"));
    const app = join(root, "apps/memory");
    mkdirSync(join(app, "scripts"), { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ scripts: { "build:dashboard": "exit 0" } }));
    for (const name of ["fetch-kiwi-model.ts", "prefetch-core-models.ts"]) writeFileSync(join(app, "scripts", name), "process.exit(0);");
    try {
      await expect(runSetupEngine({ mode: "local", repoRoot: root, yes: false, ai: { useAi: true, localProvider: "ollama" } })).rejects.toThrow("--local --ollama --yes");
      const state = JSON.parse(readFileSync(join(app, "data/setup-state.json"), "utf8"));
      expect(state.status).toBe("failed");
      expect(state.completedAt).toBeNull();
      expect(state.failedStep).toBe("provider-consent");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("successful local preparation returns a private link but events never print the token", () => {
    const root = mkdtempSync(join(tmpdir(), "bara-success-setup-"));
    const app = join(root, "apps", "memory");
    mkdirSync(join(app, "scripts"), { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ scripts: { "build:dashboard": "exit 0" } }));
    for (const name of ["fetch-kiwi-model.ts", "prefetch-core-models.ts"]) writeFileSync(join(app, "scripts", name), "process.exit(0);");
    const fixture = join(root, "run.ts");
    writeFileSync(fixture, `import { runSetupEngine } from ${JSON.stringify(join(import.meta.dir, "engine.ts"))};\nconst result = await runSetupEngine({ mode: "local", repoRoot: ${JSON.stringify(root)}, jsonEvents: true, ai: { useAi: false, localProvider: "none" } });\nawait Bun.write(${JSON.stringify(join(root, "result.json"))}, JSON.stringify(result));`);
    try {
      const result = Bun.spawnSync([process.execPath, fixture], { stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      const output = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
      const token = new URLSearchParams(new URL(output.dashboardUrl).hash.slice(1)).get("bara-token");
      expect(token).toBeTruthy();
      expect(result.stdout.toString()).not.toContain(token!);
      expect(result.stderr.toString()).not.toContain(token!);
      expect(JSON.parse(readFileSync(join(app, "data/setup-state.json"), "utf8")).status).toBe("complete");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  // WP-B2-06R — the engine must announce, via a setup.llm jsonEvents event,
  // whether this run kept the configured llm slot or changed it. First install
  // has nothing to keep (always "changed"); a retry with no explicit AI choice
  // (bare --yes shape: `ai` carries no `explicit` field) must announce "kept".
  test("setup.llm event announces changed on first install and kept on a retry with no explicit AI choice", async () => {
    const root = mkdtempSync(join(tmpdir(), "bara-setup-llm-announce-"));
    const app = join(root, "apps", "memory");
    mkdirSync(join(app, "scripts"), { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ scripts: { "build:dashboard": "exit 0" } }));
    for (const name of ["fetch-kiwi-model.ts", "prefetch-core-models.ts"]) writeFileSync(join(app, "scripts", name), "process.exit(0);");
    const firstRun = join(root, "first.ts");
    const secondRun = join(root, "second.ts");
    // No `explicit` field on either ai selection below — matches the bare
    // --yes/no-flag shape that must never silently override a configured slot.
    // lmstudio carries no install-consent gate (unlike ollama), so this run
    // isolates the llmOutcome behavior under test from that unrelated gate.
    writeFileSync(firstRun, `import { runSetupEngine } from ${JSON.stringify(join(import.meta.dir, "engine.ts"))};\nconst result = await runSetupEngine({ mode: "local", repoRoot: ${JSON.stringify(root)}, jsonEvents: true, ai: { useAi: true, localProvider: "lmstudio", extractorModel: "first-text", visionModel: "first-image" } });\nawait Bun.write(${JSON.stringify(join(root, "first-result.json"))}, JSON.stringify(result));`);
    try {
      const first = Bun.spawnSync([process.execPath, firstRun], { stdout: "pipe", stderr: "pipe" });
      if (first.exitCode !== 0) throw new Error(first.stderr.toString());
      const firstStdout = first.stdout.toString();
      const firstLlmLine = firstStdout.split("\n").map(line => { try { return JSON.parse(line); } catch { return null; } }).find(event => event?.type === "setup.llm");
      expect(firstLlmLine).toBeDefined();
      expect(firstLlmLine.llmOutcome).toBe("changed");
      const firstResult = JSON.parse(readFileSync(join(root, "first-result.json"), "utf8"));
      expect(firstResult.llmOutcome).toBe("changed");

      writeFileSync(secondRun, `import { runSetupEngine } from ${JSON.stringify(join(import.meta.dir, "engine.ts"))};\nconst result = await runSetupEngine({ mode: "local", repoRoot: ${JSON.stringify(root)}, jsonEvents: true, ai: { useAi: true, localProvider: "lmstudio" } });\nawait Bun.write(${JSON.stringify(join(root, "second-result.json"))}, JSON.stringify(result));`);
      const second = Bun.spawnSync([process.execPath, secondRun], { stdout: "pipe", stderr: "pipe" });
      if (second.exitCode !== 0) throw new Error(second.stderr.toString());
      const secondStdout = second.stdout.toString();
      const secondLlmLine = secondStdout.split("\n").map(line => { try { return JSON.parse(line); } catch { return null; } }).find(event => event?.type === "setup.llm");
      expect(secondLlmLine).toBeDefined();
      expect(secondLlmLine.llmOutcome).toBe("kept");
      const secondResult = JSON.parse(readFileSync(join(root, "second-result.json"), "utf8"));
      expect(secondResult.llmOutcome).toBe("kept");
      // The retry must still carry the first run's model choice forward untouched.
      expect(secondResult.paths.settingsPath).toBe(firstResult.paths.settingsPath);
      const settings = JSON.parse(readFileSync(secondResult.paths.settingsPath, "utf8"));
      expect(settings.llm.extractor.openaiModel).toBe("first-text");
      expect(settings.llm.vision.openaiModel).toBe("first-image");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("local setup does not enable server systemd services", async () => {
    const root = mkdtempSync(join(tmpdir(), "bara-local-setup-"));
    try {
      const result = await runSetupEngine({ mode: "local", repoRoot: root, dryRun: true, ai: { useAi: false, localProvider: "none" } });
      expect(result.commands.some(command => command.command.includes("systemctl"))).toBe(false);
      expect(result.sshTunnelCommand).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("failed preparation leaves settings but never a completed setup marker", async () => {
    const root = mkdtempSync(join(tmpdir(), "bara-failed-setup-"));
    const app = join(root, "apps", "memory");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ scripts: { "build:dashboard": "exit 7" } }));
    const fixture = join(root, "fail.ts");
    writeFileSync(fixture, `import { runSetupEngine } from ${JSON.stringify(join(import.meta.dir, "engine.ts"))};\ntry { await runSetupEngine({ mode: "local", repoRoot: ${JSON.stringify(root)}, ai: { useAi: false, localProvider: "none" } }); } catch (error) { await Bun.write(${JSON.stringify(join(root, "failure.json"))}, JSON.stringify({ message: String(error) })); }`);
    try {
      const child = Bun.spawnSync([process.execPath, fixture], { stdout: "pipe", stderr: "pipe" });
      expect(child.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(join(root, "failure.json"), "utf8")).message).toContain("dashboard-build");
      expect(existsSync(join(app, "data", "memory-settings.json"))).toBe(true);
      const state = JSON.parse(readFileSync(join(app, "data", "setup-state.json"), "utf8"));
      expect(state.status).toBe("failed");
      expect(state.completedAt).toBeNull();
      expect(state.failedStep).toBe("dashboard-build");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("A1 서버 dry-run 은 core systemd enable 계획에 bara-bot 을 넣지 않는다", async () => {
    const root = mkdtempSync(join(tmpdir(), "bara-setup-engine-"));
    try {
      const result = await runSetupEngine({
        mode: "server-a1",
        repoRoot: root,
        dryRun: true,
        ai: { useAi: false, localProvider: "none" },
      });
      const systemd = result.commands.find((c) => c.label === "systemd-enable-core");
      expect(systemd).toBeDefined();
      expect(systemd!.command).toContain("bara-memory");
      expect(systemd!.command).toContain("bara-deploy.timer");
      expect(systemd!.command).toContain("bara-backup.timer");
      expect(systemd!.command).toContain("bara-monitor.timer");
      expect(systemd!.command).not.toContain("bara-bot");
      const restart = result.commands.find(
        (c) => c.label === "systemd-restart-memory",
      );
      const health = result.commands.find((c) => c.label === "health-check-memory");
      expect(restart?.command).toEqual(["sudo", "systemctl", "restart", "bara-memory"]);
      expect(health?.command.join(" ")).toContain("http://127.0.0.1:3001/health");
      const fetchKiwi = result.commands.find((c) => c.label === "fetch-kiwi-model");
      const prefetch = result.commands.find((c) => c.label === "prefetch-core-models");
      expect(fetchKiwi?.env?.BARA_KIWI_MODEL_DIR).toContain(
        join("apps", "memory", "assets", "kiwi-model"),
      );
      expect(prefetch?.env?.BARA_HF_CACHE_DIR).toContain(
        join("apps", "memory", "assets", "hf-cache"),
      );
      expect(result.sshTunnelCommand).toContain("ssh -L 3001:127.0.0.1:3001");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("LM Studio 미탐지 시 endpoint 를 지명한 경고와 실행 안내를 함께 남긴다", async () => {
    const root = mkdtempSync(join(tmpdir(), "bara-setup-engine-"));
    try {
      // 엔진과 같은 default endpoint(127.0.0.1:1234/v1)를 실제로 probe 해
      // 이 머신의 LM Studio 가동 여부를 확인한다 — mock 없이 두 갈래 모두 검증.
      const probe = await detectOpenAiCompatible();
      const result = await runSetupEngine({
        mode: "desktop-windows",
        repoRoot: root,
        dryRun: true,
        ai: {
          useAi: true,
          localProvider: "lmstudio",
          extractorModel: "local-text",
          visionModel: "local-vlm",
        },
      });
      if (probe.ok) {
        expect(result.warnings).toEqual([]);
      } else {
        const missing = result.warnings.find((w) =>
          w.includes("감지되지 않았습니다"),
        );
        expect(missing).toBeDefined();
        expect(missing).toContain("http://127.0.0.1:1234/v1");
        const guidance = result.warnings.find((w) =>
          w.includes("https://lmstudio.ai/download"),
        );
        expect(guidance).toBeDefined();
        expect(guidance).toContain("포트 1234");
        expect(guidance).toContain("다시 실행");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
