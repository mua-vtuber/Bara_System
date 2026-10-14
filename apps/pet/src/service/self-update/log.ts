import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { SELF_UPDATE } from "../../shared/self-update.ts";
import { causeOf } from "../fetch-failure.ts";

/** The update's failure record (spec 5.4): one line per failed check, cleanup or install, in
 * `<data folder>/self-update.log`. The service has no other log (its stdout is the host protocol and the host drops
 * its stderr), so this file is where every failure stays, also the ones the pet window does not show again. Past
 * `SELF_UPDATE.logMaxBytes` the older half is dropped. A write that fails does not stop the update: its first cause is
 * kept in `error`, which `selfUpdate.status` reports and the pet window shows once, so a broken log is never silent.
 * `write` itself never rejects: `append` records every failure in `error`, so the queue below cannot break. Writes run one after another: a write that trims the file must not overlap one that appends to it. */
export class SelfUpdateLog {
  private failure: string | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly now: () => Date) {}

  get error(): string | null { return this.failure; }

  write(code: string, message: string): Promise<void> {
    const line = `${this.now().toISOString()} ${code} ${message.replace(/\s+/g, " ").trim()}\n`;
    this.tail = this.tail.then(() => this.append(line));
    return this.tail;
  }

  private async append(line: string): Promise<void> {
    try {
      const size = await stat(this.file).then((info) => info.size, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return 0;
        throw error;
      });
      if (size + Buffer.byteLength(line, "utf8") <= SELF_UPDATE.logMaxBytes) {
        await appendFile(this.file, line, { encoding: "utf8", mode: 0o600 });
        return;
      }
      const lines = (await readFile(this.file, "utf8")).split("\n").filter((entry) => entry.length > 0);
      const kept = lines.slice(Math.ceil(lines.length / 2));
      await writeFile(this.file, `${kept.map((entry) => `${entry}\n`).join("")}${line}`, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      this.failure ??= causeOf(error);
    }
  }
}
