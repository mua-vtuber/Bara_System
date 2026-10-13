import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { notifyMemoSaved } from "./memo-saved-cleanup.ts";

test("only a newly saved memory is queued", () => {
  const got: number[] = [];
  const deps = { cleanupRuns: { onMemoSaved: (id: number) => got.push(id) } } as never;
  notifyMemoSaved(deps, { kind: "memory", originNodeId: 5, cacheHit: false });
  notifyMemoSaved(deps, { kind: "memory", originNodeId: 6, cacheHit: true });
  notifyMemoSaved(deps, { kind: "entity_patch", originNodeId: null, cacheHit: false });
  notifyMemoSaved({ cleanupRuns: undefined } as never, { kind: "memory", originNodeId: 7, cacheHit: false });
  expect(got).toEqual([5]);
});

test("every text save path notifies after saving", () => {
  const root = join(import.meta.dir, "..");
  for (const file of [
    "server-internal/routes/ingest-text-flow.ts", "server-internal/routes/memories-append.ts",
    "server-internal/routes/memories-crud.ts", "mcp/tools-capture.ts", "mcp/tools-memory.ts",
  ]) {
    expect(readFileSync(join(root, file), "utf8")).toContain("notifyMemoSaved(");
  }
});
