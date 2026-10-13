import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELEASE_LAYOUT, RELEASE_NODE_SHIM_DIR, dependencyInstallScript } from "./remote-probe.ts";

const RELEASE = "/home/bara/.local/share/bara-pet-server/releases/0123456789abcdef";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// 2026-10-11: the 0.1.5 update on A1 failed with exit 127. A postinstall script called `node`, the host has none, and
// Bun reused a /tmp/bun-node-<revision> shim whose link pointed at a pruned release. The install must bring its own.
test("the release's own node link comes first on PATH before bun install runs", () => {
  const script = dependencyInstallScript(RELEASE);
  const shim = `${RELEASE}/${RELEASE_NODE_SHIM_DIR}`;
  const bun = `${RELEASE}/${RELEASE_LAYOUT.bun}`;
  expect(script).toBe(
    `cd '${RELEASE}' && 'mkdir' '-p' '${shim}' && 'ln' '-sfn' '${bun}' '${shim}/node' && ` +
    `PATH='${shim}':"$PATH" '${bun}' 'install' '--frozen-lockfile' '--production'`,
  );
});

test("a path with a quote stays one shell word everywhere", () => {
  const script = dependencyInstallScript("/srv/o'brien/releases/abc");
  expect(script).toContain(`'/srv/o'\\''brien/releases/abc/${RELEASE_NODE_SHIM_DIR}':"$PATH"`);
  expect(script).not.toContain("o'brien");
});

// Runs the real script with the real Bun: a trusted dependency's postinstall records which `node` it got, and that
// must be the release's own link, not a host node or Bun's /tmp shim. Needs a POSIX shell and symlinks.
test.skipIf(process.platform === "win32")("on a POSIX host the postinstall's node is the release's own Bun", () => {
  const release = mkdtempSync(join(tmpdir(), "bara-dep-install-"));
  dirs.push(release);
  copyFileSync(process.execPath, join(release, RELEASE_LAYOUT.bun));
  Bun.spawnSync(["chmod", "700", join(release, RELEASE_LAYOUT.bun)]);
  mkdirSync(join(release, "dep"));
  writeFileSync(join(release, "dep/package.json"), JSON.stringify({
    name: "dep", version: "1.0.0", scripts: { postinstall: "command -v node > \"$INIT_CWD/node-used\" && node -e \"process.exit(0)\"" },
  }));
  writeFileSync(join(release, "package.json"), JSON.stringify({
    name: "release", private: true, dependencies: { dep: "file:./dep" }, trustedDependencies: ["dep"],
  }));
  const lock = Bun.spawnSync([join(release, RELEASE_LAYOUT.bun), "install", "--lockfile-only"], { cwd: release });
  expect(lock.exitCode).toBe(0);
  const run = Bun.spawnSync(["bash", "-c", dependencyInstallScript(release)], { env: { ...process.env, PATH: "/usr/bin:/bin" } });
  expect({ exit: run.exitCode, stderr: run.stderr.toString() }).toEqual({ exit: 0, stderr: expect.any(String) });
  expect(readFileSync(join(release, "node-used"), "utf8").trim()).toBe(join(release, RELEASE_NODE_SHIM_DIR, "node"));
});
