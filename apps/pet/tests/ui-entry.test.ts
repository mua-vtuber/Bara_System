import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BUNDLED_ENTRY_TAGS, DEV_ENTRY_SRC, DEV_ENTRY_TAG, rewriteUiEntry } from "../scripts/ui-entry.ts";

const indexHtml = await readFile(join(resolve(import.meta.dir, ".."), "index.html"), "utf8");

test("the real index.html holds the dev entry tag exactly once", () => {
  expect(indexHtml.split(DEV_ENTRY_TAG).length - 1).toBe(1);
});

test("the real index.html gets the bundled stylesheet and script in place of the dev tag", () => {
  const built = rewriteUiEntry(indexHtml);
  expect(built).toContain(BUNDLED_ENTRY_TAGS);
  expect(built).toContain('href="./assets/main.css"');
  expect(built).toContain('src="./assets/main.js"');
  expect(built).not.toContain(DEV_ENTRY_SRC);
  expect(built).toBe(indexHtml.replace(DEV_ENTRY_TAG, BUNDLED_ENTRY_TAGS));
});

test("a script tag with another attribute order is not silently left in place", () => {
  const reordered = indexHtml.replace(DEV_ENTRY_TAG, `<script src="${DEV_ENTRY_SRC}" type="module"></script>`);
  expect(() => rewriteUiEntry(reordered))
    .toThrow(`found 0 exact match(es) and 1 reference(s) to ${DEV_ENTRY_SRC}`);
});

test("a page without any entry tag fails", () => {
  const without = indexHtml.replace(DEV_ENTRY_TAG, "");
  expect(() => rewriteUiEntry(without)).toThrow("found 0 exact match(es) and 0 reference(s)");
});

test("a page with the entry tag twice fails", () => {
  const twice = indexHtml.replace(DEV_ENTRY_TAG, `${DEV_ENTRY_TAG}${DEV_ENTRY_TAG}`);
  expect(() => rewriteUiEntry(twice)).toThrow("found 2 exact match(es) and 2 reference(s)");
});

test("a dev path that remains elsewhere in the page fails after the tag is replaced", () => {
  const preload = indexHtml.replace("</head>", `<link rel="modulepreload" href="${DEV_ENTRY_SRC}" /></head>`);
  expect(preload).not.toBe(indexHtml);
  expect(() => rewriteUiEntry(preload)).toThrow(`still references ${DEV_ENTRY_SRC} 1 time(s)`);
});
