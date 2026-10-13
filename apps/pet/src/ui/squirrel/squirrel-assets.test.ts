import { expect, test } from "bun:test";
import { join } from "node:path";
import { SQUIRREL_ATLAS_FILE, SQUIRREL_SKELETON_FILE } from "./asset-paths.ts";
import { isPageInsteadOf } from "./squirrel-assets.ts";

// How the loader tells a missing file from a broken one when the app answers a path it lacks with its own page
// (`index.html`, status 200) instead of 404 (design section 8, `ASSET_MISSING`).
const PAGE_IMAGE = "bara.png";
const SQUIRREL_FILES = [SQUIRREL_ATLAS_FILE, SQUIRREL_SKELETON_FILE, PAGE_IMAGE];

test("an actual HTML page returned for a squirrel file means the asset is missing", () => {
  for (const body of ["<!doctype html><html><body>app</body></html>", "\uFEFF \n<HTML lang='ko'><body>app</body></HTML>"]) {
    for (const file of SQUIRREL_FILES) expect(isPageInsteadOf(file, body)).toBe(true);
  }
});

test("real squirrel assets remain assets even when the host labels them as HTML", async () => {
  for (const file of SQUIRREL_FILES) {
    const response = new Response(Bun.file(join(import.meta.dir, "..", "assets", "squirrel", file)), { headers: { "content-type": "text/html" } });
    expect(isPageInsteadOf(file, await response.text())).toBe(false);
  }
  expect(isPageInsteadOf(SQUIRREL_ATLAS_FILE, "")).toBe(false);
  expect(isPageInsteadOf("index.html", "<!doctype html><html></html>")).toBe(false);
  expect(isPageInsteadOf("page.HTM", "<html></html>")).toBe(false);
});

test("the real app page is detected regardless of the response MIME type", async () => {
  // Tauri derives the fallback's MIME type from the requested path, not necessarily index.html.
  for (const type of ["text/html", "application/json", "application/octet-stream"]) {
    const response = new Response(Bun.file(join(import.meta.dir, "..", "..", "..", "index.html")), { headers: { "content-type": type } });
    const body = await response.text();
    for (const file of SQUIRREL_FILES) expect(isPageInsteadOf(file, body)).toBe(true);
  }
});
