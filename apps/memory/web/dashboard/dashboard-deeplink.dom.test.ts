import { expect, test } from "bun:test";
import { join } from "node:path";

test("memoryId link opens the exact memory after fragment authentication", () => {
  // The dashboard entry is a singleton module. Run this UI bootstrap in its
  // own process so the usability suite can independently import and boot it.
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "dashboard-deeplink.fixture.ts")],
    { stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  expect(JSON.parse(child.stdout.toString())).toEqual({ selected: true, queryRetained: true, tokenConsumed: true });
});
