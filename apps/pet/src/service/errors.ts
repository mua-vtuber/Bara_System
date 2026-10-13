/** What the server itself said about a refused request, when its body names it (today only a 409 body is
 * read: `code` such as "CONFLICT"/"CAPTURE_CONFLICT" and the node's `currentRevision`). */
export interface ServerErrorDetail { serverCode?: string; currentRevision?: number }

export class ServiceError extends Error {
  // `declare`: set only when the server named them, so an error without the detail has no such property at all.
  declare readonly serverCode?: string;
  declare readonly currentRevision?: number;
  constructor(readonly code: string, readonly publicMessage: string, readonly writeNotStarted = false, detail: ServerErrorDetail = {}) {
    super(publicMessage);
    this.name = "ServiceError";
    if (detail.serverCode !== undefined) this.serverCode = detail.serverCode;
    if (detail.currentRevision !== undefined) this.currentRevision = detail.currentRevision;
  }
}

export function serviceError(code: string, message: string, writeNotStarted = false, detail: ServerErrorDetail = {}): ServiceError {
  return new ServiceError(code, message, writeNotStarted, detail);
}

/** The shape of every code a service error or an RPC error frame carries: upper case words joined by `_`.
 * A code from outside (the cleanup server names its own) is checked against this before it is used as one,
 * because a code is shown on the screen next to its cause sentence. */
const SERVICE_ERROR_CODE_SHAPE = /^[A-Z][A-Z0-9_]{1,63}$/;
export function isServiceErrorCode(code: unknown): code is string {
  return typeof code === "string" && SERVICE_ERROR_CODE_SHAPE.test(code);
}

/** The native host drops a service error whose text is longer than this (`src-tauri/src/bridge/protocol.rs`
 * `MAX_SERVICE_MESSAGE`, UTF-8 bytes) and shows its own redaction text instead, so texts carrying a cause shorten it. */
const HOST_MESSAGE_MAX_BYTES = 1_000;

/** `text(cause)` within the host's limit: the cause is cut (by code points, marked with `…`) until it fits. */
export function fitted(text: (cause: string | undefined) => string, cause: string | undefined): string {
  let shown = cause;
  const points = [...(cause ?? "")];
  while (shown !== undefined && Buffer.byteLength(text(shown), "utf8") > HOST_MESSAGE_MAX_BYTES && points.length > 0) {
    points.splice(Math.max(0, points.length - 20));
    shown = `${points.join("")}…`;
  }
  return text(shown);
}
