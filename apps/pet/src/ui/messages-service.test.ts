import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { causeOf } from "../service/fetch-failure.ts";
import { validateText } from "../service/validation.ts";
import { messages } from "./messages.ts";
import { serviceAiMessages } from "./messages-service-ai.ts";
import { serviceCoreMessages } from "./messages-service-core.ts";
import { selfUpdateMessages } from "./messages-self-update.ts";
import { serviceInstallMessages } from "./messages-service-install.ts";

// Texts of the service that are built from parameters or by a condition (`messages-service-*.ts`).
test("the local port text names the holding program's ids, or no id when none could be read", () => {
  const named = messages.installService.localPortTaken(41031, [412, 9001]);
  expect(named).toContain("41031");
  expect(named).toContain("PID 412, 9001");
  const unnamed = messages.installService.localPortTaken(41031, []);
  expect(unnamed).toContain("41031");
  expect(unnamed).not.toContain("PID");
});

test("the SSH tunnel port text names the port and every holding program", () => {
  const text = messages.installService.tunnelPortTaken(41031, [7, 8]);
  expect(text).toContain("41031");
  expect(text).toContain("PID 7, 8");
});

test("an install step's name is the subject of its timeout, stall and failure text", () => {
  const step = messages.installSteps.koreanDictionary;
  expect(messages.installService.stepTimeout(step)).toContain(step);
  expect(messages.installService.stepStalled(step)).toContain(step);
  const failed = messages.installService.stepFailed(step, 7);
  expect(failed).toContain(step);
  expect(failed).toContain("exit 7");
});

test("a failed input check names the value in the validation sentence", () => {
  expect(() => validateText("", messages.fieldLabels.question))
    .toThrow(messages.validation.checkValue(messages.fieldLabels.question));
});

test("a cleanup CLI probe has a ready text for each provider it can check", () => {
  expect(Object.keys(messages.cleanupService.cli.probeAvailable).sort()).toEqual(["claude", "codex"]);
});

test("the AI probe texts carry the cause the server gave", () => {
  expect(messages.aiService.probe.authRejected("CAUSE")).toContain("CAUSE");
  expect(messages.aiService.probe.notModelList("CAUSE")).toContain("CAUSE");
});

// WP-PFIX-13 (M4): a cause sentence that held only spaces or characters that show nothing comes out of
// `causeOf` empty, and every text below used to show it as `... 오류가 났습니다. ()`.
/** Every text that writes a cause sentence in parentheses after its own sentence. */
const CAUSE_TEXTS: Record<string, (cause: string) => string> = {
  "serverClient.requestUnexpected": messages.serverClient.requestUnexpected,
  "serverClient.responseReadFailed": messages.serverClient.responseReadFailed,
  "serverClient.connectionCheckFailed": messages.serverClient.connectionCheckFailed,
  "serverClient.saveInputCheckFailed": messages.serverClient.saveInputCheckFailed,
  "serverClient.saveConnectionCheckFailed": messages.serverClient.saveConnectionCheckFailed,
  "aiService.probe.authRejected": messages.aiService.probe.authRejected,
  "aiService.probe.notModelList": messages.aiService.probe.notModelList,
  "cleanupService.mcp.responseReadFailed": messages.cleanupService.mcp.responseReadFailed,
  "cleanupService.mcp.requestUnexpected": messages.cleanupService.mcp.requestUnexpected,
  "memory.editReloadFailed": messages.memory.editReloadFailed,
};

test("an empty cause is named in a sentence of its own, never shown as empty parentheses", () => {
  const empties = ["", "   ", causeOf("\u200b\ufeff \u00ad\u202e\n")];
  expect(empties[2]).toBe(""); // what causeOf leaves of a sentence that shows nothing
  for (const [name, text] of Object.entries(CAUSE_TEXTS)) {
    const named = text("CAUSE");
    expect({ name, named: named.endsWith(" (CAUSE)") }).toEqual({ name, named: true });
    const sentence = named.slice(0, -" (CAUSE)".length);
    for (const empty of empties) {
      expect({ name, empty, text: text(empty) }).toEqual({ name, empty, text: `${sentence} ${messages.serverClient.causeEmpty}.` });
    }
  }
  // The cleanup screen writes a cause after its code instead: the code is never followed by nothing.
  expect(messages.cleanup.failureWithCause("INTERNAL", "boom")).toBe("INTERNAL: boom");
  for (const empty of empties) expect(messages.cleanup.failureWithCause("INTERNAL", empty)).toBe(`INTERNAL: ${messages.serverClient.causeEmpty}`);
});

// WP-PFIX-14: `editRereadFailed` writes its cause in the middle of the text, and has none when the failure
// carried no sentence at all. The non-empty and no-cause texts are pinned as they were before `withCauseThen`.
test("the saved-but-not-reread text keeps its cause against the sentence, names an empty cause, or has none", () => {
  const lead = "수정은 서버에 저장됐지만 최신 내용을 다시 불러오지 못했습니다";
  const follow = "최신 내용을 다시 불러와 확인해 주세요.";
  expect(messages.memory.editRereadFailed("CAUSE")).toBe(`${lead}(CAUSE). ${follow}`);
  expect(messages.memory.editRereadFailed()).toBe(`${lead}. ${follow}`);
  for (const empty of ["", "   ", causeOf("​﻿ ­‮\n")]) {
    const named = messages.memory.editRereadFailed(empty);
    expect({ empty, named }).toEqual({ empty, named: `${lead}. ${messages.serverClient.causeEmpty}. ${follow}` });
    expect(named).not.toContain("(");
  }
});

// Where a cause may be written in parentheses is guarded in `messages-cause-guard.test.ts`.

// `messages.ts` spreads the three service modules after the keys it writes itself, and a spread silently
// replaces a key that came earlier. A key two modules share, or one a module shares with `messages.ts`, would
// therefore make one section vanish without any error, so each overlap fails here.
const SERVICE_MODULES = { core: serviceCoreMessages, ai: serviceAiMessages, install: serviceInstallMessages, selfUpdate: selfUpdateMessages } as const;

/** The top-level keys `messages.ts` writes itself (not the ones its spreads bring in). */
function keysWrittenInMessagesSource(): string[] {
  const path = join(import.meta.dir, "messages.ts");
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const keys: string[] = [];
  source.forEachChild((statement) => {
    if (!ts.isVariableStatement(statement)) return;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "messages" || !declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) continue;
      for (const property of declaration.initializer.properties) {
        if (ts.isSpreadAssignment(property) || !property.name) continue;
        if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) keys.push(property.name.text);
      }
    }
  });
  return keys;
}

test("the three service message modules share no top-level key", () => {
  const owners = new Map<string, string[]>();
  for (const [name, module] of Object.entries(SERVICE_MODULES))
    for (const key of Object.keys(module)) owners.set(key, [...(owners.get(key) ?? []), name]);
  expect(owners.size).toBeGreaterThan(10);
  expect([...owners].filter(([, names]) => names.length > 1).map(([key, names]) => `${key}: ${names.join(", ")}`)).toEqual([]);
});

test("no top-level key written in messages.ts is also a key of a service module", () => {
  const written = keysWrittenInMessagesSource();
  expect(written).toContain("common"); // the scan really found the keys messages.ts writes itself
  const serviceKeys = new Set(Object.values(SERVICE_MODULES).flatMap((module) => Object.keys(module)));
  expect(written.filter((key) => serviceKeys.has(key))).toEqual([]);
});

test("every section of every service module reaches `messages` as that module's own object", () => {
  for (const module of Object.values(SERVICE_MODULES))
    for (const [key, section] of Object.entries(module)) expect((messages as Record<string, unknown>)[key]).toBe(section);
});
