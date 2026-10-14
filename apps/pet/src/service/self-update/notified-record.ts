import { randomUUID } from "node:crypto";
import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { SELF_UPDATE } from "../../shared/self-update.ts";
import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";
import { isReleaseVersion } from "../install/release-record.ts";
import { renameWithRetry, type Rename } from "../restore-journal.ts";
import { failureText } from "./failure.ts";
import { isRecord } from "./release.ts";

/** `<data folder>/self-update.json`: the version whose new-version bubble already showed (spec 5.3). It is its own file,
 * not a key of `pet-settings.json`: that file's absence is how the host knows the first-run setup has not finished
 * (`src-tauri/src/main.rs`), and the settings writers rebuild it from the fields they know (user decision 2026-10-14). */
export function notifiedRecordPath(dataDir: string): string {
  return join(dataDir, SELF_UPDATE.recordFileName);
}

/** Reads and writes the notice record. A record that is there but cannot be read, or is not exactly
 * `{"format": SELF_UPDATE.recordFormat, "notifiedVersion": "<release version>"}`, is an error naming the file, never
 * "nothing notified". A write replaces the file whole (temporary file, flushed, renamed over it), so a cut-off write
 * leaves the old record or the new one; writes run one at a time. */
export class NotifiedRecord {
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly file: string, private readonly rename: Rename = renameWithRetry) {}

  async read(): Promise<string | null> {
    const text = messages.selfUpdateErrors;
    let raw: string;
    try { raw = await readFile(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw serviceError("SELF_UPDATE_RECORD_UNREADABLE", failureText((cause) => text.SELF_UPDATE_RECORD_UNREADABLE(this.file, cause), error));
    }
    const invalid = () => serviceError("SELF_UPDATE_RECORD_INVALID", text.SELF_UPDATE_RECORD_INVALID(this.file));
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw invalid(); }
    if (!isRecord(value) || Object.keys(value).length !== 2 || value.format !== SELF_UPDATE.recordFormat ||
        typeof value.notifiedVersion !== "string" || !isReleaseVersion(value.notifiedVersion)) throw invalid();
    return value.notifiedVersion;
  }

  write(version: string): Promise<void> {
    const run = this.queue.then(() => this.writeNow(version));
    this.queue = run.catch(() => {}); // the next write waits for this one, whatever its outcome; the caller gets the outcome
    return run;
  }

  private async writeNow(version: string): Promise<void> {
    if (!isReleaseVersion(version)) throw serviceError("SELF_UPDATE_VERSION_INVALID", messages.selfUpdateErrors.SELF_UPDATE_VERSION_INVALID);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ format: SELF_UPDATE.recordFormat, notifiedVersion: version }, null, 2)}\n`);
        await handle.sync();
      } finally { await handle.close(); }
      await this.rename(temporary, this.file);
    } catch (error) {
      throw serviceError("SELF_UPDATE_RECORD_SAVE_FAILED",
        failureText((cause) => messages.selfUpdateErrors.SELF_UPDATE_RECORD_SAVE_FAILED(this.file, cause), error));
    } finally {
      await rm(temporary, { force: true }).catch(() => {}); // already renamed, or the write above already failed loudly
    }
  }
}
