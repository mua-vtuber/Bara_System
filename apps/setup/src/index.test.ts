import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { isInstallationConsent, SERVER_MODE_REMOVED_MESSAGE } from "./index.ts";

describe("setup CLI --help", () => {
  test("only explicit affirmative install consent authorizes installation", () => {
    for (const answer of ["", "n", "no", "1", "maybe"]) expect(isInstallationConsent(answer)).toBe(false);
    for (const answer of ["y", "YES", " Yes "]) expect(isInstallationConsent(answer)).toBe(true);
  });
  test("launcher cwd still resolves the real repository and local mode has no systemd", () => {
    const proc = Bun.spawnSync([process.execPath, "src/index.ts", "--local", "--dry-run", "--no-ai", "--json-events"], {
      cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const events = proc.stdout.toString().trim().split("\n").map(line => JSON.parse(line));
    const dry = events.find(event => event.type === "setup.dryRun");
    expect(dry.commands.find((command: { label: string }) => command.label === "dashboard-build").cwd)
      .toBe(resolve(import.meta.dir, "../../memory"));
    expect(JSON.stringify(dry.commands)).not.toContain("systemctl");
    expect(proc.stdout.toString()).not.toContain("bara-token=");
  });
  test("--server 는 다른 모드로 넘어가지 않고 대신 쓸 경로를 알리며 멈춘다", () => {
    const proc = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "index.ts"), "--server", "--dry-run", "--no-ai", "--json-events"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.exitCode).toBe(1);
    expect(proc.stdout.toString()).toBe("");
    expect(proc.stderr.toString().trim()).toBe(SERVER_MODE_REMOVED_MESSAGE);
    expect(SERVER_MODE_REMOVED_MESSAGE).toContain("내 외부 서버");
    expect(SERVER_MODE_REMOVED_MESSAGE).toContain("bun run deploy:a1");
  });
  test("help 문구는 실재하는 플래그만 안내한다 (--repair 제거)", () => {
    const proc = Bun.spawnSync(
      ["bun", join(import.meta.dir, "index.ts"), "--help"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.exitCode).toBe(0);
    const stdout = proc.stdout.toString();
    expect(stdout).toContain("flags: --yes, --dry-run, --json-events");
    expect(stdout).not.toContain("--repair");
    expect(stdout).not.toContain("--server");
  });
});
