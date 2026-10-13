import { expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import { buildServiceBundle } from "../scripts/build-service.ts";

/** Text that exists only inside `package.json` (script commands, dependency lists, the package name's
 * manifest keys). The service has no reason to carry any of it, so its presence in the bundle means
 * the whole manifest was inlined instead of the one value the service reads. */
const MANIFEST_ONLY_TEXT = ["devDependencies", "@tauri-apps/cli", "tauri build", "build:service", "check:native-exe"];

async function bundleText(): Promise<string> {
  const result = await buildServiceBundle();
  expect(result.outputs).toHaveLength(1);
  return result.outputs[0]!.text();
}

test("the service bundle carries the package version and none of the rest of package.json", async () => {
  const text = await bundleText();
  expect(text.includes(JSON.stringify(pkg.version))).toBe(true);
  // Compared as a list so a failure names the leaked text instead of printing the whole bundle.
  expect(MANIFEST_ONLY_TEXT.filter(manifestText => text.includes(manifestText))).toEqual([]);
}, 30_000);
