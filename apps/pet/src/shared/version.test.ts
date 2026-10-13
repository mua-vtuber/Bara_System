import { expect, test } from "bun:test";
import pkg from "../../package.json" with { type: "json" };
import { PET_VERSION } from "./version.ts";

// WP-P2-12: PET_VERSION is package.json's version read via a JSON import, so this always holds by
// construction. The test exists as a regression guard: if PET_VERSION is ever changed to a separately
// maintained literal, this fails instead of the two values silently drifting apart (PV-6, CC-9).
test("PET_VERSION always equals package.json's version", () => {
  expect(PET_VERSION).toBe(pkg.version);
});
