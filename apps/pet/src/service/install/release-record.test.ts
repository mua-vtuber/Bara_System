import { expect, test } from "bun:test";
import { messages } from "../../ui/messages.ts";
import { compareVersions, isComponentName, parseReleaseRecord, releaseIdOf, releaseRecordText,
  type ReleaseDraft } from "./release-record.ts";

const SHA = "0123456789abcdef".repeat(4);
const DRAFT: ReleaseDraft = { component: "server", appVersion: "0.2.0", sourceSha: SHA, origin: "dev", commit: "a".repeat(40) };

function failure(run: () => unknown): string | undefined {
  try { run(); } catch (error) { return (error as { code?: string }).code; }
  throw new Error("expected a failure");
}

test("versions compare by their three numbers, not as text", () => {
  expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
  expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  expect(compareVersions("0.1.0", "0.1.1")).toBeLessThan(0);
});

test("a version that is not three numbers stops with RELEASE_VERSION_INVALID", () => {
  for (const bad of ["1.0", "1.0.0-beta", "v1.0.0", ""]) expect(failure(() => compareVersions(bad, "1.0.0"))).toBe("RELEASE_VERSION_INVALID");
});

test("a release directory is named by the first 16 hex digits of the bundle digest", () => {
  expect(releaseIdOf(SHA)).toBe("0123456789abcdef");
  expect(failure(() => releaseIdOf("xyz"))).toBe("RELEASE_DIGEST_INVALID");
});

test("a written record reads back unchanged", () => {
  const text = releaseRecordText(DRAFT, new Date("2026-10-08T01:02:03.000Z"));
  expect(parseReleaseRecord(text, "/srv/releases/x/release.json"))
    .toEqual({ format: 1, ...DRAFT, installedAt: "2026-10-08T01:02:03.000Z" });
});

test("a pet record carries no commit and a dev record must carry one", () => {
  const pet = releaseRecordText({ ...DRAFT, origin: "pet", commit: null }, new Date(0));
  expect(parseReleaseRecord(pet, "/p").commit).toBeNull();
  expect(failure(() => releaseRecordText({ ...DRAFT, commit: null }, new Date(0)))).toBe("RELEASE_RECORD_INVALID");
  expect(failure(() => releaseRecordText({ ...DRAFT, origin: "pet" }, new Date(0)))).toBe("RELEASE_RECORD_INVALID");
});

test("a record with a missing or malformed field stops and names the file", () => {
  const good = JSON.parse(releaseRecordText(DRAFT, new Date(0)));
  for (const broken of [{ ...good, format: 2 }, { ...good, appVersion: "x" }, { ...good, sourceSha: "abc" }, { ...good, origin: "git" },
    { ...good, component: "Bad Name" }, { ...good, installedAt: "yesterday" }]) {
    expect(failure(() => parseReleaseRecord(JSON.stringify(broken), "/p/release.json"))).toBe("RELEASE_RECORD_INVALID");
  }
  expect(failure(() => parseReleaseRecord("not json", "/p/release.json"))).toBe("RELEASE_RECORD_INVALID");
});

test("the busy stop names the lock folder and says plainly it may be deleted when no update runs", () => {
  const text = messages.releaseErrors.RELEASE_BUSY("/srv/bara/.bara-release-lock");
  expect(text).toContain("/srv/bara/.bara-release-lock");
  expect(text).toContain("진행 중인 업데이트가 없다면");
  expect(text).toContain("지워도 돼요");
});

test("component names are lower-case words joined by dashes", () => {
  expect(isComponentName("server")).toBe(true);
  expect(isComponentName("discord")).toBe(true);
  expect(isComponentName("Discord")).toBe(false);
  expect(isComponentName("../x")).toBe(false);
});
