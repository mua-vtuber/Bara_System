import { expect, test } from "bun:test";
import { probeCli } from "../src/service/cli.ts";

const signedIn = !!Bun.which("codex") && Bun.spawnSync(["codex", "login", "status"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
test.skipIf(!signedIn)("an installed, logged-in Codex CLI passes the real readiness probe", async () => {
  const probe = await probeCli("codex", new AbortController().signal);
  expect(probe.available).toBe(true);
});
