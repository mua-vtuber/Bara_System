import type { ProgressDetail } from "./contracts.ts";
import nativeHost from "./native-host.json";
import { PET_VERSION } from "./version.ts";

/** Every fixed value of the pet's own update (docs/decisions/2026-10-14-pet-self-update-spec.md 5.1): how often it
 * checks, its time and size limits and where downloads go. Nothing else repeats these numbers or addresses. The
 * installer name rule and the download folder's name are also the native host's (`src-tauri/src/self_update.rs`
 * runs no other file), so they live in `native-host.json` `contract` and are read from there. */
export const SELF_UPDATE = {
  /** How often the service checks again after the first check of a start (spec 5.1). */
  checkIntervalMs: 3 * 60 * 60 * 1000,
  /** How often the pet window asks the service for the check's state; a result reaches the pet within this. */
  statusPollMs: 30_000,
  /** Longest a check's one request may take. */
  checkTimeoutMs: 30_000,
  /** Longest a download may go without receiving a byte before it stops. */
  downloadStallMs: 60_000,
  /** Largest installer the pet downloads (the 0.1.8 installer is 210 MB). */
  maxInstallerBytes: 1_000_000_000,
  /** The installer is the one release file whose name ends with this (spec 5.2). */
  installerSuffix: nativeHost.contract.installerSuffix,
  /** The folder under the pet data folder that holds downloads; nothing outside it is written or removed (spec 6.2). */
  updatesDirName: nativeHost.contract.updatesDirName,
  /** Added to a download's name until it is complete and checked (spec 6.2). */
  partialSuffix: ".partial",
  /** Every check and install failure is appended to this file in the pet data folder (spec 5.4). */
  logFileName: "self-update.log",
  /** Beyond this size the older half of the log is dropped. */
  logMaxBytes: 64 * 1024,
  /** The version whose notice bubble already showed is kept in this file in the pet data folder (spec 5.3), apart from
   * `pet-settings.json`, whose absence the host reads as "first-run setup not finished". */
  recordFileName: "self-update.json",
  /** The `format` of that file this app writes and reads; any other value is reported, never guessed. */
  recordFormat: 1,
  acceptHeader: "application/vnd.github+json",
  userAgentProduct: "BaraPet",
} as const;

/** Where a check reads the latest release (`latestUrl`) and where that release's files must be served from: an
 * installer's address is `downloadBaseUrl`, the tag, `/` and the file name. */
export interface ReleaseSource { latestUrl: string; downloadBaseUrl: string }

/** The one public repository the pet updates from (spec 9: fixed, with no setting, variable or switch to another
 * address). Only tests build another `ReleaseSource`, pointing at their own loopback server. */
export const PRODUCT_RELEASE_SOURCE: ReleaseSource = {
  latestUrl: "https://api.github.com/repos/mua-vtuber/Bara_System/releases/latest",
  downloadBaseUrl: "https://github.com/mua-vtuber/Bara_System/releases/download/",
};

function userAgent(): string { return `${SELF_UPDATE.userAgentProduct}/${PET_VERSION}`; }

/** The only headers a check sends (spec 5.2): no memory, setting or device information. */
export function selfUpdateHeaders(): Record<string, string> {
  return { Accept: SELF_UPDATE.acceptHeader, "User-Agent": userAgent() };
}

/** Whole percent of a download, at most 100; null when its size is unknown. The service sends a progress event only
 * when this changes (`src/service/self-update/download.ts`) and the update bubble shows it (`src/ui/update-bubble-model.ts`). */
export function downloadPercent(detail: ProgressDetail | undefined): number | null {
  if (!detail || detail.total <= 0) return null;
  return Math.min(100, Math.floor((Math.min(detail.loaded, detail.total) * 100) / detail.total));
}

/** The only header a download sends: the release file host serves the file whatever `Accept` says. */
export function downloadHeaders(): Record<string, string> {
  return { "User-Agent": userAgent() };
}
