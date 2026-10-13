import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";
import { REMOTE_LAYOUT } from "./remote-probe.ts";

/** Names the replace procedure keeps inside a component's directory on the host (spec 5.1, 5.2). */
export const RELEASE_RECORD_FILE = "release.json";
/** Written last in a release directory: its files and dependencies are complete, so a later replace may reuse it. */
export const RELEASE_COMPLETE_MARKER = ".bara-release-complete";
/** `mkdir` of this directory is the replace lock: two updates of one component never overlap. */
export const RELEASE_LOCK_DIR = ".bara-release-lock";
/** Release directories kept after a replace: the running one and the one before it (spec 5.2 step 5). */
export const RELEASES_KEPT = 2;
export const SERVER_COMPONENT = "server";

export type ReleaseOrigin = "pet" | "dev";
/** `<release>/release.json` (spec 5.1). `commit` is set for a `dev` release only. */
export interface ReleaseRecord {
  format: 1; component: string; appVersion: string; sourceSha: string; origin: ReleaseOrigin; commit: string | null; installedAt: string;
}
export type ReleaseDraft = Omit<ReleaseRecord, "format" | "installedAt">;

const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const COMPONENT = /^[a-z][a-z0-9-]{0,31}$/;

export function isComponentName(name: string): boolean { return COMPONENT.test(name); }

function parts(version: string): [number, number, number] {
  const match = VERSION.exec(version);
  if (!match) throw serviceError("RELEASE_VERSION_INVALID", messages.releaseErrors.RELEASE_VERSION_INVALID(version));
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when `a` is older than `b`, zero when equal, positive when newer. */
export function compareVersions(a: string, b: string): number {
  const left = parts(a), right = parts(b);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index]! - right[index]!;
  return 0;
}

export function releaseIdOf(sourceSha: string): string {
  if (!SHA256.test(sourceSha)) throw serviceError("RELEASE_DIGEST_INVALID", messages.releaseErrors.RELEASE_DIGEST_INVALID);
  return sourceSha.slice(0, REMOTE_LAYOUT.releaseIdLength);
}

function checked(value: unknown, path: string): ReleaseRecord {
  const invalid = () => serviceError("RELEASE_RECORD_INVALID", messages.releaseErrors.RELEASE_RECORD_INVALID(path));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const r = value as Record<string, unknown>;
  if (r.format !== 1 || typeof r.component !== "string" || !COMPONENT.test(r.component) ||
      typeof r.appVersion !== "string" || !VERSION.test(r.appVersion) || typeof r.sourceSha !== "string" || !SHA256.test(r.sourceSha) ||
      (r.origin !== "pet" && r.origin !== "dev") || typeof r.installedAt !== "string" || Number.isNaN(Date.parse(r.installedAt)))
    throw invalid();
  if (r.origin === "dev" ? typeof r.commit !== "string" || !COMMIT.test(r.commit) : r.commit !== null) throw invalid();
  return { format: 1, component: r.component, appVersion: r.appVersion, sourceSha: r.sourceSha, origin: r.origin,
    commit: r.commit as string | null, installedAt: r.installedAt };
}

export function parseReleaseRecord(text: string, path: string): ReleaseRecord {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw serviceError("RELEASE_RECORD_INVALID", messages.releaseErrors.RELEASE_RECORD_INVALID(path)); }
  return checked(value, path);
}

export function releaseRecordText(draft: ReleaseDraft, installedAt: Date): string {
  return `${JSON.stringify(checked({ format: 1, ...draft, installedAt: installedAt.toISOString() }, draft.component), null, 2)}\n`;
}
