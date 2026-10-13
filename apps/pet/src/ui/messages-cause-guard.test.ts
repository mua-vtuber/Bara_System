import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// WP-PFIX-14 (Minor-2). A cause sentence that came out of `causeOf` can be empty, and written in parentheses it
// shows as `()`. `withCause` and `withCauseThen` (`messages-service-core.ts`) are the only places that decide
// what an empty cause becomes. This scan finds every message-module text that writes a parameter inside
// parentheses, whatever the parameter is called (`cause`, `detail`, `reason`, ...), and makes each one either
// a cause writer or a value named below as needing no empty-cause rule.
const MESSAGE_MODULES = ["messages.ts", "messages-service-core.ts", "messages-service-ai.ts", "messages-service-install.ts", "messages-service-release.ts"];

/** The only functions that write a cause sentence in parentheses: `<function>: <parameter>`. */
const CAUSE_WRITERS = ["withCause: cause", "withCauseThen: cause"];

/** Every other text that writes a parameter in parentheses (`<key path>: <parameter>`), grouped by why it needs
 * no `withCause`. A value that can be a sentence taken from an exception, a response or a server does not
 * belong here: the text that writes it is built with `withCause`. */
const NEEDS_NO_CAUSE_RULE: Record<string, string[]> = {
  "a number: an HTTP status, a count of seconds, a port or an exit code": [
    "cleanupService.mcp.requestFailed: status", "serverClient.http.failed: status", "connectionErrors.SERVER_INCOMPATIBLE: status",
    "connectionErrors.INSTALL_SERVER_TIMEOUT: seconds", "connectionErrors.SSH_SERVER_TIMEOUT: seconds",
    "connectionErrors.REMOTE_PORT_BUSY: port", "installService.stepFailed: exitCode",
    "downloadProgress.models: part", "downloadProgress.models: parts",
    "backup.done: memories", "backup.done: attachments",
    "tunnelPort.inUse: preferred", "tunnelPort.reserved: preferred", "tunnelPort.bindFailed: preferred",
  ],
  "process ids read from the system": [
    "connectionErrors.REMOTE_PORT_BUSY: owners", "installService.localPortTaken: others", "installService.tunnelPortTaken: others",
    "tunnelPort.inUse: owners",
  ],
  "a name or address the Pet was given or read, never a sentence": [
    "connectionErrors.CAPABILITY_MISSING: missing", "connectionErrors.INSTALL_EXISTING_CORE: baseUrl",
    "connectionErrors.REMOTE_TOOLS_MISSING: commands", "connectionErrors.REMOTE_PREFLIGHT_FAILED: item",
    "connectionErrors.REMOTE_EXISTING_CORE: unit", "connectionErrors.REMOTE_EXISTING_CORE: state",
    "connectionErrors.REMOTE_OTHER_PET_SERVER: unit", "connectionErrors.REMOTE_UNIT_FOREIGN: unit",
    "connectionErrors.REMOTE_UNIT_UNRECOGNIZED: unit", "connectionErrors.REMOTE_SERVICE_FAILED: unit",
    "connectionErrors.REMOTE_SERVICE_FAILED: active", "connectionErrors.REMOTE_SERVICE_FAILED: sub",
    "connectionErrors.REMOTE_SERVICE_FAILED: enabled", "memory.unknownCategory: kind",
    "backupErrors.BACKUP_RESULT_UNREADABLE: folderName",
    "restore.last.interrupted: backupName", "restore.last.rolled-back: backupName",
    "serverUpdate.devBuild: commit",
  ],
  "a failure code": ["errors.withCode: code"],
  "a squirrel file name, with its HTTP status for `ASSET_HTTP` (`squirrel-assets.ts`)": [
    "pet.errors.ASSET_HTTP: fileAndStatus", "pet.errors.IMAGE_DECODE: file", "pet.errors.ASSET_MISSING: file",
  ],
  "a name from the squirrel's configuration or skeleton data, or its load time limit in seconds (`motion-validate.ts`, `squirrel-assets.ts`)": [
    "pet.errors.ANIMATION_MISSING: name", "pet.errors.TRANSITION_NOT_ALLOWED: pair", "pet.errors.DARK_TINT_DISABLED: slot",
    "pet.errors.LOAD_TIMEOUT: seconds",
  ],
  "two heights in px measured from the pet page, written as `needed > available` (`squirrel-renderer.ts` `layoutHeights`)": [
    "pet.errors.CAMERA_LAYOUT: heights",
  ],
  "a fixed phrase of `messages.connectionWait`, chosen in `readyTimeout`": [
    "connectionErrors.INSTALL_SERVER_TIMEOUT: detail", "connectionErrors.SSH_SERVER_TIMEOUT: detail",
  ],
  "the screen's own error text (`errorText`), written after a label, so the parentheses are never bare": [
    "quick.bubbleUnpublished: reason",
  ],
};

const OPEN = new Set(["(", "（"]);
const CLOSE = new Set([")", "）"]);

type Part = { text: string } | { expression: ts.Expression };

/** The literal texts and the expressions of a string built by a template literal or by `+`, in reading order. */
function partsOf(node: ts.Expression): Part[] {
  if (ts.isStringLiteralLike(node)) return [{ text: node.text }];
  if (ts.isParenthesizedExpression(node)) return partsOf(node.expression);
  if (ts.isTemplateExpression(node))
    return [{ text: node.head.text }, ...node.templateSpans.flatMap((span): Part[] => [{ expression: span.expression }, { text: span.literal.text }])];
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return [...partsOf(node.left), ...partsOf(node.right)];
  return [{ expression: node }];
}

/** The expressions a string writes while a parenthesis its own text opened is still open. */
function expressionsInParentheses(node: ts.Expression): ts.Expression[] {
  let open = 0;
  const inside: ts.Expression[] = [];
  for (const part of partsOf(node)) {
    if ("expression" in part) {
      if (open > 0) inside.push(part.expression);
      continue;
    }
    for (const char of part.text) {
      if (OPEN.has(char)) open += 1;
      else if (CLOSE.has(char) && open > 0) open -= 1;
    }
  }
  return inside;
}

function nameOf(node: ts.Node): string | null {
  if (!ts.isPropertyAssignment(node) && !ts.isMethodDeclaration(node) && !ts.isFunctionDeclaration(node)) return null;
  const name = node.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)));
}

/** The parameters of every function the node sits in. */
function enclosingParameters(node: ts.Node): Set<string> {
  const names = new Set<string>();
  for (let parent = node.parent; parent; parent = parent.parent)
    if (ts.isFunctionLike(parent)) for (const parameter of parent.parameters) for (const name of bindingNames(parameter.name)) names.add(name);
  return names;
}

function referencedParameters(expression: ts.Expression, parameters: Set<string>): string[] {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    // `.name` after a dot is a property, not a reference to the parameter of that name.
    if (ts.isIdentifier(node) && parameters.has(node.text) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) found.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return [...found];
}

/** `<key path>: <parameter>` for every parameter a message-module text writes inside parentheses. */
function parenthesizedParameters(file: string): string[] {
  const path = join(import.meta.dir, file);
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const isText = ts.isTemplateExpression(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken);
    if (isText) {
      const expressions = expressionsInParentheses(node);
      if (expressions.length > 0) {
        const keyPath: string[] = [];
        for (let parent: ts.Node | undefined = node; parent; parent = parent.parent) {
          const name = nameOf(parent);
          if (name !== null) keyPath.unshift(name);
        }
        const parameters = enclosingParameters(node);
        for (const expression of expressions)
          for (const parameter of referencedParameters(expression, parameters)) found.push(`${keyPath.join(".")}: ${parameter}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const FOUND = [...new Set(MESSAGE_MODULES.flatMap(parenthesizedParameters))].sort();
const LISTED = [...CAUSE_WRITERS, ...Object.values(NEEDS_NO_CAUSE_RULE).flat()];

test("a parameter written in parentheses is a cause built by withCause, or a value named as needing no cause rule", () => {
  expect(FOUND).toEqual(expect.arrayContaining(CAUSE_WRITERS)); // the scan really reads the message modules
  // A new text lands here. A cause sentence (whatever the parameter is called) goes through `withCause` or
  // `withCauseThen`; only a value that can never be a sentence of an exception or a response is listed above.
  expect(FOUND.filter((entry) => !LISTED.includes(entry))).toEqual([]);
  // A text that no longer writes the parameter in parentheses leaves its entry behind: remove it.
  expect(LISTED.filter((entry) => !FOUND.includes(entry))).toEqual([]);
  expect(LISTED.filter((entry, index) => LISTED.indexOf(entry) !== index)).toEqual([]);
});
