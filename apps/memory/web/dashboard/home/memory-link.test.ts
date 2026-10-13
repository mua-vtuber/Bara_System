import { expect, test } from "bun:test";
import { memoryIdFromSearch, pageFromLocation } from "./memory-link.ts";

test("memory deep links accept one positive id and ignore malformed values", () => {
  expect(memoryIdFromSearch("?memoryId=42")).toBe(42);
  for (const search of ["", "?memoryId=0", "?memoryId=-1", "?memoryId=1.5", "?memoryId=abc", "?memoryId=1&memoryId=2", "?memoryId=9007199254740992"]) {
    expect(memoryIdFromSearch(search)).toBeNull();
  }
});

test("review view query wins over an authentication fragment; legacy hashes still work", () => {
  expect(pageFromLocation("?view=proposals", "#bara-token=secret")).toBe("proposals");
  expect(pageFromLocation("?view=archive", "#bara-token=secret")).toBe("archive");
  expect(pageFromLocation("", "#proposals")).toBe("proposals");
  expect(pageFromLocation("?view=other", "#bara-token=secret")).toBe("main");
});
