/** The only lines `client-token.ts` ever writes to stderr besides `CLIENT_TOKEN_FALLBACK_LINE`. Each is
 * free of secrets and paths, so an installer may name the cause by matching a line here exactly; anything
 * else it receives from that step stays unexplained. Keyed by a stable code the installer uses as its own
 * error code. The English lines are the CLI's public output: an installed older server prints the same
 * lines, so change a line only together with its code and every reader of `clientTokenErrorCode`. */
export const CLIENT_TOKEN_ERRORS = {
  CLIENT_TOKEN_FILE_EXISTS: "Token file already exists; use enrollment for an existing installation",
  CLIENT_TOKEN_FILE_MISSING: "Token file does not exist",
  CLIENT_TOKEN_FILE_INVALID: "Existing token file is invalid",
  CLIENT_TOKEN_SCOPES_MISSING: "Existing token file lacks the required pet and dashboard scopes",
  CLIENT_TOKEN_SERVER_RESPONDING: "Target server is responding; stop and use enrollment",
  CLIENT_TOKEN_STOP_UNCONFIRMED: "Could not confirm the target server is stopped",
  CLIENT_TOKEN_PATH_NOT_ABSOLUTE: "--tokens-file must be absolute",
  CLIENT_TOKEN_URL_INVALID: "Use a loopback HTTP(S) server root URL without credentials, query, or fragment",
  CLIENT_TOKEN_USAGE: "Usage: bun run src/client-token.ts --url <loopback root URL> --tokens-file <absolute path> (--fresh | --read-existing)",
} as const;

export type ClientTokenErrorCode = keyof typeof CLIENT_TOKEN_ERRORS;

/** What the CLI writes for any failure whose message is not one of `CLIENT_TOKEN_ERRORS`: such a message may
 * come from a library and could carry a path or worse, so it is never printed. */
export const CLIENT_TOKEN_FALLBACK_LINE = "Client token preparation failed; check the target directory and URL";

const CODE_BY_LINE: ReadonlyMap<string, ClientTokenErrorCode> = new Map(
  (Object.entries(CLIENT_TOKEN_ERRORS) as [ClientTokenErrorCode, string][]).map(([code, line]) => [line, code]));

/** The code of a failure line the CLI printed, or undefined. Only a whole output that is, after trimming,
 * exactly one known line counts: more lines, a partial match or the fallback line are left unexplained,
 * because the caller must not guess the cause from output it cannot vouch for. */
export function clientTokenErrorCode(stderr: string): ClientTokenErrorCode | undefined {
  const line = stderr.trim();
  if (/[\r\n]/.test(line)) return undefined;
  return CODE_BY_LINE.get(line);
}

/** The line the CLI prints for `error`: its own message when it is one of `CLIENT_TOKEN_ERRORS`, otherwise the fallback. */
export function clientTokenErrorLine(error: unknown): string {
  return error instanceof Error && CODE_BY_LINE.has(error.message) ? error.message : CLIENT_TOKEN_FALLBACK_LINE;
}
