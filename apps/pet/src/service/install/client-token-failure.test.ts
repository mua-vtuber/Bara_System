import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_TOKEN_ERRORS, CLIENT_TOKEN_FALLBACK_LINE, type ClientTokenErrorCode } from "../../../../setup/src/client-token-errors.ts";
import { messages } from "../../ui/messages.ts";
import { clientTokenFailure } from "./client-token-failure.ts";
import { runCaptured } from "./process.ts";

const ctx = { signal: new AbortController().signal, progress() {} };
const SECRET = "bara_secret_value_that_must_never_leave_the_step";

/** A real child that writes `stderr` as it is and exits 1, run as a sensitive step that names known causes. */
function failingStep(stderr: string): Promise<unknown> {
  return runCaptured([process.execPath, "-e", `process.stderr.write(${JSON.stringify(stderr)}); process.exit(1)`], ctx,
    { timeoutMs: 10_000, sensitive: clientTokenFailure, stepName: messages.installSteps.prepareCredentials })
    .then(() => { throw new Error("expected a failure"); }, (error: unknown) => error);
}

/** Everything the error exposes: its own fields and its JSON form, where a leaked line would show. */
function exposed(error: unknown): string {
  const fields = Object.getOwnPropertyNames(error).map((name) => String((error as Record<string, unknown>)[name]));
  return [...fields, JSON.stringify(error), String(error)].join("\n");
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bara-pet-client-token-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("every known line of the credentials step has a Korean text, and no text is left without a line", () => {
  expect(Object.keys(messages.clientTokenErrors).sort()).toEqual(Object.keys(CLIENT_TOKEN_ERRORS).sort());
});

test("each known line becomes its own code and Korean text", () => {
  for (const [code, line] of Object.entries(CLIENT_TOKEN_ERRORS) as [ClientTokenErrorCode, string][]) {
    const error = clientTokenFailure(`${line}\n`);
    expect(error).toMatchObject({ code, publicMessage: messages.clientTokenErrors[code], message: messages.clientTokenErrors[code] });
    expect(exposed(error)).not.toContain(line);
  }
});

test("output that is not exactly one known line names no cause", () => {
  for (const output of [CLIENT_TOKEN_FALLBACK_LINE, "", `${CLIENT_TOKEN_ERRORS.CLIENT_TOKEN_FILE_EXISTS}\n${SECRET}\n`, SECRET])
    expect(clientTokenFailure(output)).toBeUndefined();
});

test("a sensitive step that prints a known line fails with that cause and carries none of its output", async () => {
  const line = CLIENT_TOKEN_ERRORS.CLIENT_TOKEN_STOP_UNCONFIRMED;
  const error = await failingStep(`${line}\n`);
  expect(error).toMatchObject({ code: "CLIENT_TOKEN_STOP_UNCONFIRMED", publicMessage: messages.clientTokenErrors.CLIENT_TOKEN_STOP_UNCONFIRMED });
  expect(error).not.toHaveProperty("stderr");
  expect(exposed(error)).not.toContain(line);
});

test("a sensitive step whose output is unexpected, several lines or the fallback keeps the generic failure and leaks nothing", async () => {
  for (const output of [`${SECRET}\n`, `${CLIENT_TOKEN_ERRORS.CLIENT_TOKEN_FILE_MISSING}\n${SECRET}\n`, `${CLIENT_TOKEN_FALLBACK_LINE}\n`]) {
    const error = await failingStep(output);
    expect(error).toMatchObject({ code: "INSTALL_COMMAND_FAILED", publicMessage: messages.installService.sensitiveStepFailed });
    expect(error).not.toHaveProperty("stderr");
    const shown = exposed(error);
    expect(shown).not.toContain(SECRET);
    expect(shown).not.toContain(CLIENT_TOKEN_FALLBACK_LINE);
  }
});

test("the real credentials step's refusal reaches the Pet as its named cause", async () => {
  const tokens = join(dir, "sse-tokens.json");
  writeFileSync(tokens, "{}");
  const script = join(import.meta.dir, "..", "..", "..", "..", "setup", "src", "client-token.ts");
  const error = await runCaptured([process.execPath, "run", script, "--url", "http://127.0.0.1:49157/", "--tokens-file", tokens, "--fresh"],
    ctx, { timeoutMs: 30_000, sensitive: clientTokenFailure, stepName: messages.installSteps.prepareCredentials })
    .then(() => { throw new Error("expected a failure"); }, (failure: unknown) => failure);
  expect(error).toMatchObject({ code: "CLIENT_TOKEN_FILE_EXISTS", publicMessage: messages.clientTokenErrors.CLIENT_TOKEN_FILE_EXISTS });
}, 40_000);
