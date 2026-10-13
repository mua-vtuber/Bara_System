/**
 * Static operation checks for the OCR companion launch/docs surface.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
const memoryRoot = join(repoRoot, "apps", "memory");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("document OCR companion ops docs/scripts", () => {
  test("start-ocr-companion.bat runs from repo root into apps/memory under WSL", () => {
    const bat = read(join(repoRoot, "start-ocr-companion.bat"));
    expect(bat).toContain('wsl --cd "%~dp0" bash -lc "cd apps/memory && bun run ocr:companion"');
    expect(bat).toContain("BARA_OCR_COMMAND_JSON");
    expect(bat).toContain("BARA_MEMORY_TOKEN");
    expect(bat).toContain("MEMORY_API_URL");
    expect(bat).toContain("BARA_MEMORY_URL");
  });

  test("README and .env.example env names match the CLI surface", () => {
    const cli = read(join(memoryRoot, "src", "tools", "document-ocr-companion.ts"));
    const envExample = read(join(memoryRoot, ".env.example"));
    const rootReadme = read(join(repoRoot, "README.md"));
    const memoryReadme = read(join(memoryRoot, "README.md"));
    const docs = `${envExample}\n${rootReadme}\n${memoryReadme}`;

    for (const name of [
      "BARA_MEMORY_URL",
      "MEMORY_API_URL",
      "BARA_MEMORY_TOKEN",
      "BARA_OCR_COMMAND_JSON",
      "BARA_OCR_WORKER_ID",
      "BARA_OCR_POLL_SECONDS",
      "BARA_OCR_LEASE_SECONDS",
      "BARA_OCR_TMP_DIR",
      "BARA_OCR_PROVIDER_NAME",
    ]) {
      expect(cli).toContain(name);
      expect(docs).toContain(name);
    }

    expect(rootReadme).toContain("start-ocr-companion.bat");
    expect(rootReadme).toContain("bun run ocr:companion --request-token");
    expect(rootReadme).toContain("bun run ocr:companion --pickup-token");
    expect(memoryReadme).toContain("bun run ocr:companion --request-token");
    expect(memoryReadme).toContain("bun run ocr:companion --pickup-token");
  });
});
