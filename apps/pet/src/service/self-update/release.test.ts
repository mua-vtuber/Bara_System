import { expect, test } from "bun:test";
import { PRODUCT_RELEASE_SOURCE } from "../../shared/self-update.ts";
import { ServiceError } from "../errors.ts";
import { classifyRelease, parseRelease } from "./release.ts";

/** The public v0.1.8 release as `releases/latest` answered on 2026-10-14 (the fields `gh api` showed). */
const PUBLIC_0_1_8 = {
  tag_name: "v0.1.8", name: "Bara Pet 0.1.8", draft: false, prerelease: false,
  assets: [{
    name: "Bara.Pet_0.1.8_x64-setup.exe", size: 210310619,
    digest: "sha256:8e214a184a4852b5c20e91599f731f50b481cfbd6a109dde6f5b97ac3f8d7cab",
    browser_download_url: "https://github.com/mua-vtuber/Bara_System/releases/download/v0.1.8/Bara.Pet_0.1.8_x64-setup.exe",
  }],
};
const SHA = "c".repeat(64);
function release(overrides: Record<string, unknown> = {}, assets?: unknown[]) {
  const name = "Bara.Pet_0.1.9_x64-setup.exe";
  return { tag_name: "v0.1.9", ...overrides,
    assets: assets ?? [{ name, size: 1234, digest: `sha256:${SHA}`, browser_download_url: `${PRODUCT_RELEASE_SOURCE.downloadBaseUrl}v0.1.9/${name}` }] };
}
function codeOf(run: () => unknown): string {
  try { run(); } catch (error) { expect(error).toBeInstanceOf(ServiceError); return (error as ServiceError).code; }
  throw new Error("expected a ServiceError");
}

test("the real public v0.1.8 release parses, and only an older pet sees it as new", () => {
  const parsed = parseRelease(PUBLIC_0_1_8, PRODUCT_RELEASE_SOURCE);
  expect(parsed).toEqual({ version: "0.1.8", tag: "v0.1.8", assetName: "Bara.Pet_0.1.8_x64-setup.exe", size: 210310619,
    sha256: "8e214a184a4852b5c20e91599f731f50b481cfbd6a109dde6f5b97ac3f8d7cab", url: PUBLIC_0_1_8.assets[0]!.browser_download_url });
  expect(classifyRelease(parsed, "0.1.8")).toEqual({ kind: "current", latest: "0.1.8" });
  expect(classifyRelease(parsed, "0.1.9")).toEqual({ kind: "current", latest: "0.1.8" });
  expect(classifyRelease(parsed, "0.1.7")).toEqual({ kind: "available", release: parsed });
  expect(classifyRelease(parsed, "0.0.99")).toEqual({ kind: "available", release: parsed });
});

test("other release files are ignored; no installer or two installers is a release format error", () => {
  const installer = release().assets[0]!;
  expect(parseRelease(release({}, [installer, { name: "latest.json", size: 10, browser_download_url: "x" }]), PRODUCT_RELEASE_SOURCE).assetName)
    .toBe("Bara.Pet_0.1.9_x64-setup.exe");
  expect(codeOf(() => parseRelease(release({}, [{ name: "notes.txt", size: 1 }]), PRODUCT_RELEASE_SOURCE))).toBe("SELF_UPDATE_INSTALLER_MISSING");
  expect(codeOf(() => parseRelease(release({}, []), PRODUCT_RELEASE_SOURCE))).toBe("SELF_UPDATE_INSTALLER_MISSING");
  const second = { ...installer, name: "Other_0.1.9_x64-setup.exe" };
  let caught: ServiceError | null = null;
  try { parseRelease(release({}, [installer, second]), PRODUCT_RELEASE_SOURCE); } catch (error) { caught = error as ServiceError; }
  expect(caught?.code).toBe("SELF_UPDATE_INSTALLER_AMBIGUOUS");
  expect(caught?.publicMessage).toContain("2개");
});

test("a missing or malformed digest refuses the release; an upper-case digest is read as lower case", () => {
  const installer = release().assets[0] as Record<string, unknown>;
  for (const digest of [undefined, "", `sha512:${SHA}`, `sha256:${SHA.slice(1)}`, `sha256:${"g".repeat(64)}`, SHA])
    expect(codeOf(() => parseRelease(release({}, [{ ...installer, digest }]), PRODUCT_RELEASE_SOURCE))).toBe("SELF_UPDATE_DIGEST_INVALID");
  expect(parseRelease(release({}, [{ ...installer, digest: `sha256:${"C".repeat(64)}` }]), PRODUCT_RELEASE_SOURCE).sha256).toBe(SHA);
});

test("a tag that is not v and a plain version refuses the release", () => {
  for (const tag_name of ["0.1.9", "v0.1", "v0.1.9-rc.1", "v0.1.9.1", "version-0.1.9", 9, null])
    expect(codeOf(() => parseRelease(release({ tag_name }), PRODUCT_RELEASE_SOURCE))).toBe("SELF_UPDATE_TAG_INVALID");
});

test("an installer served from elsewhere, for another tag, of no size or with an unsafe name is refused", () => {
  const installer = release().assets[0] as Record<string, unknown>;
  for (const change of [
    { browser_download_url: "https://example.com/Bara.Pet_0.1.9_x64-setup.exe" },
    { browser_download_url: `${PRODUCT_RELEASE_SOURCE.downloadBaseUrl}v0.1.8/Bara.Pet_0.1.9_x64-setup.exe` },
    { size: 0 }, { size: "1234" }, { size: 1.5 }, { size: 2_000_000_000 },
    { name: "../Bara.Pet_0.1.9_x64-setup.exe" }, { name: "Bara Pet_0.1.9_x64-setup.exe" },
  ]) expect(codeOf(() => parseRelease(release({}, [{ ...installer, ...change }]), PRODUCT_RELEASE_SOURCE))).toBe("SELF_UPDATE_ASSET_INVALID");
});

test("an answer that is not a release object, or has no file list, is an unreadable response", () => {
  for (const body of [null, [], "x", { tag_name: "v0.1.9" }, { tag_name: "v0.1.9", assets: {} }])
    expect(codeOf(() => parseRelease(body, PRODUCT_RELEASE_SOURCE))).toBe("SELF_UPDATE_RESPONSE_INVALID");
});
