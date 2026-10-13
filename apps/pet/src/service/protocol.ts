import { RPC_METHODS, type HostReply, type HostRequest, type HostVault, type RpcError, type RpcRequest } from "../shared/contracts.ts";
import { messages } from "../ui/messages.ts";
import { isServiceErrorCode } from "./errors.ts";

export const FRAME_LIMIT = 1_048_576;
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const methods = new Set<string>(RPC_METHODS);
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
/** Methods only the native host sends (a webview request can never name them: `src-tauri/src/policy.rs` allows only
 * `RPC_METHODS`). `service.drain` is the host's graceful quit: see `src/service/main.ts`. */
export const PRIVATE_METHODS = ["dashboard.link", "service.drain"] as const;
export interface PrivateRequest { id: string; method: (typeof PRIVATE_METHODS)[number]; params: Record<string, unknown> }
export type InboundFrame = RpcRequest | PrivateRequest | HostReply;

export function parseFrame(line: string, native = false): InboundFrame {
  if (Buffer.byteLength(line, "utf8") > FRAME_LIMIT) throw new Error("frame too large");
  const value: unknown = JSON.parse(line);
  if (!record(value)) throw new Error("object required");
  if (own(value, "hostReply")) {
    const reply = value.hostReply;
    if (!native || !record(reply) || typeof reply.id !== "string" || !ID.test(reply.id)) throw new Error("invalid host reply");
    if (own(reply, "result") === own(reply, "error")) throw new Error("one reply outcome required");
    if (own(reply, "error") && (!record(reply.error) || typeof reply.error.code !== "string" || typeof reply.error.message !== "string")) {
      throw new Error("invalid host error");
    }
    return value as unknown as HostReply;
  }
  if (typeof value.id !== "string" || !ID.test(value.id) || typeof value.method !== "string" || !record(value.params)) {
    throw new Error("invalid request");
  }
  if (!methods.has(value.method) && !(native && (PRIVATE_METHODS as readonly string[]).includes(value.method))) throw new Error("unknown method");
  return value as unknown as RpcRequest | PrivateRequest;
}

/** Text shaped like a credential. A bearer token follows `bearer` after a space, or straight after it once
 * `causeOf` has removed a character that shows nothing from between them (`Bearer<BOM>TOKEN` reads
 * `BearerTOKEN`). So `bearer` starts a credential when a space or a character a token starts with comes next:
 * a letter, a digit, `_`, `+`, `/` or `-`, the base64 and base64url alphabets tokens are written in. The cost
 * is that a harmless sentence holding a word such as `bearerAuth`, `bearers` or `bearer-only` is withheld
 * too. `bearer` before punctuation (`bearer.`, `bearer:`) starts no token and stays shown. */
const CREDENTIAL_SHAPE = /bearer[\s\w+/-]|bara-token=|-----BEGIN|https?:\/\/[^\s/]*@/i;
const SHOWABLE_TEXT_MAX_CHARS = 1_000;
/** Whether a sentence may reach the screen: short, and with no fragment that looks like a credential. */
export function isShowableText(text: string): boolean {
  return text.length <= SHOWABLE_TEXT_MAX_CHARS && !CREDENTIAL_SHAPE.test(text);
}

export function publicError(error: unknown): RpcError {
  if (record(error) && isServiceErrorCode(error.code) &&
    typeof error.publicMessage === "string" && isShowableText(error.publicMessage)) {
    return { code: error.code, message: error.publicMessage };
  }
  return { code: "INTERNAL", message: messages.rpc.internal };
}

/** Real native-host transport: secrets only cross the private pipe, never renderer IPC results. */
export class NativeVault implements HostVault {
  private sequence = 0;
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly write: (frame: HostRequest) => void) {}

  private call(method: HostRequest["host"]["method"], key: string, value?: string): Promise<unknown> {
    if (this.pending.size >= 32) return Promise.reject(new Error("vault busy"));
    return new Promise((resolve, reject) => {
      const id = `h-${++this.sequence}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error("native vault timeout"), {
          code: "VAULT_UNAVAILABLE", publicMessage: messages.rpc.vaultTimeout,
        }));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ host: { id, method, params: { key, ...(value === undefined ? {} : { value }) } } }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("vault transport failed"));
      }
    });
  }

  accept(frame: HostReply): void {
    const reply = frame.hostReply;
    const item = this.pending.get(reply.id);
    if (!item) return;
    clearTimeout(item.timer);
    this.pending.delete(reply.id);
    if ("error" in reply) item.reject(Object.assign(new Error("native vault rejected"), {
      code: "VAULT_UNAVAILABLE", publicMessage: messages.rpc.vaultRejected,
    }));
    else item.resolve(reply.result);
  }

  async get(key: string): Promise<string | null> {
    const value = await this.call("vault.get", key);
    if (value !== null && typeof value !== "string") throw new Error("invalid vault value");
    return value;
  }
  async set(key: string, value: string): Promise<void> { await this.call("vault.set", key, value); }
  async delete(key: string): Promise<void> { await this.call("vault.delete", key); }
  close(): void {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error("vault transport closed")); }
    this.pending.clear();
  }
}
