import { createHash } from "node:crypto";
import { isIngestSuccess } from "../../memory/ingest-result.ts";

export const INGEST_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface Receipt {
  fingerprint: string;
  state: "pending" | "saved" | "unknown";
  finishedAt?: number;
  response?: { body: string; status: number; headers: [string, string][] };
  result?: unknown;
}

/** Process-local receipts prove completed writes; absence never proves a write failed.
 * No request content is retained. Completed receipts expire; active writes are never evicted.
 */
export class IngestReceipts {
  private readonly receipts = new Map<string, Receipt>();
  constructor(private readonly maxCount = 256, private readonly maxAgeMs = 24 * 60 * 60 * 1_000) {}

  private key(caller: string | undefined, requestId: string): string { return JSON.stringify([caller ?? null, requestId]); }

  private expire(now: number): void {
    for (const [key, receipt] of this.receipts) {
      if (receipt.finishedAt !== undefined && now - receipt.finishedAt >= this.maxAgeMs) this.receipts.delete(key);
    }
  }

  get(caller: string | undefined, requestId: string, now = Date.now()): Receipt | undefined {
    this.expire(now);
    return this.receipts.get(this.key(caller, requestId));
  }

  /** Only a proven prewrite rejection may free its own pending identity. */
  release(caller: string | undefined, requestId: string, receipt: Receipt): void {
    const key = this.key(caller, requestId);
    if (this.receipts.get(key) === receipt && receipt.state === "pending") this.receipts.delete(key);
  }

  begin(caller: string | undefined, requestId: string, input: unknown, now = Date.now()):
    { kind: "started"; receipt: Receipt } | { kind: "existing"; receipt: Receipt } | { kind: "conflict" | "full" } {
    this.expire(now);
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const key = this.key(caller, requestId);
    const prior = this.receipts.get(key);
    if (prior) return prior.fingerprint === fingerprint ? { kind: "existing", receipt: prior } : { kind: "conflict" };
    if (this.receipts.size >= this.maxCount) {
      let oldest: string | undefined;
      let oldestTime = Infinity;
      for (const [candidate, receipt] of this.receipts) {
        if (receipt.finishedAt !== undefined && receipt.finishedAt < oldestTime) {
          oldest = candidate;
          oldestTime = receipt.finishedAt;
        }
      }
      if (oldest === undefined) return { kind: "full" };
      this.receipts.delete(oldest);
    }
    const receipt: Receipt = { fingerprint, state: "pending" };
    this.receipts.set(key, receipt);
    return { kind: "started", receipt };
  }

  async finish(receipt: Receipt, response?: Response, now = Date.now()): Promise<void> {
    // Keep even error responses for identical-request protection. Post-dispatch errors can
    // happen after partial writes, so they do not authorize another write attempt.
    if (response) receipt.response = {
      body: await response.clone().text(), status: response.status, headers: Array.from(response.headers.entries()),
    };
    if (response?.ok) {
      try {
        const result: unknown = JSON.parse(receipt.response!.body);
        receipt.state = isIngestSuccess(result) ? "saved" : "unknown";
        if (receipt.state === "saved") receipt.result = result;
      } catch { receipt.state = "unknown"; }
    } else receipt.state = "unknown";
    receipt.finishedAt = now;
  }
}
