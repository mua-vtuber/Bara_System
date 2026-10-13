/**
 * Bot verification boundary guard.
 *
 * The Discord bot imports the memory API client as a runtime dependency, but
 * its typecheck must not glob the entire memory app. Pulling
 * a broad memory source glob into this tsconfig makes bot verification fail
 * on memory tests/dashboard files, which hides actual adapter regressions.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("tsconfig — bot verification boundary", () => {
  test("include stays scoped to bot source files", () => {
    const path = join(import.meta.dir, "..", "tsconfig.json");
    const tsconfig = JSON.parse(readFileSync(path, "utf-8")) as {
      include?: string[];
    };

    expect(tsconfig.include).toEqual(["src/**/*"]);
  });

  test("package exposes a typecheck script for the bot adapter", () => {
    const path = join(import.meta.dir, "..", "package.json");
    const pkg = JSON.parse(readFileSync(path, "utf-8")) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.typecheck).toBe("bunx tsc --noEmit -p tsconfig.json");
  });
});
