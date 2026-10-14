import { SELF_UPDATE, type ReleaseSource } from "../../shared/self-update.ts";
import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";
import { compareVersions } from "../install/release-record.ts";
import type { CheckOutcome, ReleaseInfo } from "./types.ts";

/** `v` and MAJOR.MINOR.PATCH with the digit counts `compareVersions` accepts. */
const TAG = /^v(\d{1,6}\.\d{1,6}\.\d{1,6})$/;
const DIGEST = /^sha256:([0-9a-fA-F]{64})$/;
/** A file name that stays one path segment on Windows and in a URL without escaping. */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** How much of an unexpected value a failure sentence quotes. */
const SHOWN_CHARS = 80;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const shown = (value: unknown): string => (JSON.stringify(value ?? null) ?? "null").slice(0, SHOWN_CHARS);

/** The installer of a `releases/latest` answer (spec 5.2), or a `ServiceError` naming what is wrong. Exactly one file
 * whose name ends with `SELF_UPDATE.installerSuffix` must be there; no other file is taken in its place. Its address
 * must be `source.downloadBaseUrl` + tag + `/` + name, its size a whole number up to `SELF_UPDATE.maxInstallerBytes`,
 * and its digest `sha256:` with 64 hex digits. */
export function parseRelease(body: unknown, source: ReleaseSource): ReleaseInfo {
  const text = messages.selfUpdateErrors;
  if (!isRecord(body)) throw serviceError("SELF_UPDATE_RESPONSE_INVALID", text.SELF_UPDATE_RESPONSE_INVALID);
  const tag = body.tag_name;
  const version = typeof tag === "string" ? TAG.exec(tag)?.[1] : undefined;
  if (typeof tag !== "string" || version === undefined) throw serviceError("SELF_UPDATE_TAG_INVALID", text.SELF_UPDATE_TAG_INVALID(shown(tag)));
  if (!Array.isArray(body.assets)) throw serviceError("SELF_UPDATE_RESPONSE_INVALID", text.SELF_UPDATE_RESPONSE_INVALID);
  const installers = body.assets.filter((asset): asset is Record<string, unknown> =>
    isRecord(asset) && typeof asset.name === "string" && asset.name.endsWith(SELF_UPDATE.installerSuffix));
  if (installers.length === 0) throw serviceError("SELF_UPDATE_INSTALLER_MISSING", text.SELF_UPDATE_INSTALLER_MISSING);
  if (installers.length > 1) throw serviceError("SELF_UPDATE_INSTALLER_AMBIGUOUS", text.SELF_UPDATE_INSTALLER_AMBIGUOUS(installers.length));
  const asset = installers[0]!;
  const name = asset.name as string;
  const { size, browser_download_url: url } = asset;
  if (!ASSET_NAME.test(name) || url !== `${source.downloadBaseUrl}${tag}/${name}` || typeof size !== "number" ||
      !Number.isSafeInteger(size) || size <= 0 || size > SELF_UPDATE.maxInstallerBytes)
    throw serviceError("SELF_UPDATE_ASSET_INVALID", text.SELF_UPDATE_ASSET_INVALID(shown(name)));
  const digest = typeof asset.digest === "string" ? DIGEST.exec(asset.digest)?.[1] : undefined;
  if (digest === undefined) throw serviceError("SELF_UPDATE_DIGEST_INVALID", text.SELF_UPDATE_DIGEST_INVALID(name));
  return { version, tag, assetName: name, url, size, sha256: digest.toLowerCase() };
}

/** A release is new only when its version is greater than this pet's; the same or an older one (a development build)
 * is current (spec 5.2). */
export function classifyRelease(release: ReleaseInfo, currentVersion: string): CheckOutcome {
  return compareVersions(release.version, currentVersion) > 0
    ? { kind: "available", release } : { kind: "current", latest: release.version };
}
