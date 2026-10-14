/** The installer of the latest release, as `parseRelease` checked it (spec 5.2). `version` is the tag without its `v`;
 * `sha256` is lower-case hex. */
export interface ReleaseInfo { version: string; tag: string; assetName: string; url: string; size: number; sha256: string }

/** One check's result: no newer version (`latest` is the release's version), a newer one, or a failure with its code
 * and the sentence the pet window and the log show. */
export type CheckOutcome =
  | { kind: "current"; latest: string }
  | { kind: "available"; release: ReleaseInfo }
  | { kind: "failed"; code: string; message: string };

/** The notice record (`self-update.json`, `notified-record.ts`) as the service read it: the acknowledged version (null
 * when none is recorded yet), or `failed` when the file exists but could not be read or is not the known shape. */
export type NotifiedRead = { kind: "read"; version: string | null } | { kind: "failed" };
