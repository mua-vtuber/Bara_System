import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** Every sentence the service shows the user lives in the messages layer (`src/ui/messages*.ts`). This scan
 * reads the service's own source files and fails in two cases, so a new error text cannot skip the layer:
 * a Korean string or template literal written anywhere in them, and a string or template literal of any
 * language passed as the message of a `serviceError(...)` call (an English sentence has no Hangul, so the
 * first rule alone would let it through). Comments are not literals and are not scanned. */
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;
const SERVICE_DIR = import.meta.dir;

/** Korean literals that may stay in `src/service`, each with the reason. A literal belongs here only when
 * it is not a sentence shown to the user (a log-only line, an identifier, text matched against another
 * program's output); prompts sent to a model are English and need no entry, except Korean example notes quoted inside them
 * (the classifier reads Korean notes), listed below. */
const CLASSIFICATION_EXAMPLE = "Korean example inside the English classification prompt; sent to the model, never shown to the user.";
const ALLOWED: ReadonlyArray<{ file: string; text: string; reason: string }> = [
  { file: "ai.ts", text: "A proposed possibility, improvement or invention, not a statement of an existing fact. Example: '회의 메모에 음성 검색을 넣어보면 어떨까'.",
    reason: CLASSIFICATION_EXAMPLE },
  { file: "ai.ts", text: "An explicitly settled choice or commitment. Example: '백업은 매주 월요일에 하기로 정했다'. Merely reporting what happened is not a settled choice.",
    reason: CLASSIFICATION_EXAMPLE },
  { file: "ai.ts", text: "A question or an explicit desire to learn an answer. Example: '백업은 어떻게 복원하지?'. A suggestion phrased as '어떨까' is not asking for factual knowledge.",
    reason: CLASSIFICATION_EXAMPLE },
  { file: "ai.ts", text: "An expressed liking, dislike or preferred choice. Example: '나는 작은 키보드가 더 좋다'. Ownership, hardware specifications, current state and what someone usually uses do not by themselves express a liking.",
    reason: CLASSIFICATION_EXAMPLE },
  { file: "ai.ts", text: "An action still to do, a future obligation or a concrete to-do item. Example: '내일까지 드라이버 업데이트하기'. An action already completed or a past event is not a to-do.",
    reason: CLASSIFICATION_EXAMPLE },
  { file: "ai.ts", text: "Facts, current state, specifications, reference knowledge, observations and experienced events. Examples: '노트북 메모리는 32GB다', '평소 작업에는 노트북을 사용한다', 'USB-C는 커넥터 규격이다', '어제 드라이버를 업데이트했다'. No liking, proposal, settled choice, open question or future obligation is required.",
    reason: CLASSIFICATION_EXAMPLE },
  { file: "ai.ts", text: "Hashtags and tag prefixes such as '#주제:값' are topic metadata, not evidence of a category. Classify the statement itself; a tag alone is insufficient.",
    reason: CLASSIFICATION_EXAMPLE },
  { file: "ai.ts", text: "Return null for contextless fragments, unclear references such as '그거' or '저번에 말한 거', equally plausible categories, or content that fits none of the allowed definitions. Do not invent missing context or intent.",
    reason: CLASSIFICATION_EXAMPLE },
  { file: "test-utils/restore-harness.ts", text: "Bara 백업",
    reason: "Test-only fixture: the name of the settings backup folder a restore test lays out; never shown to the user." },
];

interface Hit { file: string; line: number; text: string; inServiceError: boolean }

/** Korean string and template literals in `source`, marking those inside a `serviceError(...)` call. */
function findKoreanLiterals(file: string, source: string): Hit[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const hits: Hit[] = [];
  const visit = (node: ts.Node, inServiceError: boolean): void => {
    const inCall = inServiceError
      || (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "serviceError");
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      && HANGUL.test(node.text)) {
      hits.push({ file, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, text: node.text, inServiceError: inCall });
    }
    ts.forEachChild(node, (child) => visit(child, inCall));
  };
  visit(sourceFile, false);
  return hits;
}

/** Whether the expression handed to `serviceError` as its message is, or is built from, a string or
 * template literal written in place: a sentence, a concatenation, a template with substitutions, or a
 * conditional or fallback that holds one. A message from the layer (`messages.group.key`, `messages.group.fn(...)`,
 * `messages.group[code]`) or a variable is not: a literal given to a message function is that function's
 * argument, not the message. */
function isWrittenInPlace(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))
    return isWrittenInPlace(node.expression);
  if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) return true;
  if (ts.isBinaryExpression(node)) return isWrittenInPlace(node.left) || isWrittenInPlace(node.right);
  if (ts.isConditionalExpression(node)) return isWrittenInPlace(node.whenTrue) || isWrittenInPlace(node.whenFalse);
  return false;
}

interface LiteralMessage { file: string; line: number; text: string }

/** The `serviceError(code, message, ...)` calls in `source` whose `message` is written in place. */
function findLiteralMessages(file: string, source: string): LiteralMessage[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const hits: LiteralMessage[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "serviceError") {
      const message = node.arguments[1];
      if (message && !ts.isSpreadElement(message) && isWrittenInPlace(message))
        hits.push({ file, line: sourceFile.getLineAndCharacterOfPosition(message.getStart(sourceFile)).line + 1, text: message.getText(sourceFile) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

function serviceSources(): string[] {
  return (readdirSync(SERVICE_DIR, { recursive: true }) as string[])
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .sort();
}

function scanService(): Hit[] {
  return serviceSources().flatMap((file) => findKoreanLiterals(file, readFileSync(join(SERVICE_DIR, file), "utf8")))
    .filter((hit) => !ALLOWED.some((allowed) => allowed.file === hit.file && allowed.text === hit.text));
}

const describeHits = (hits: Hit[]) => hits.map((hit) => `${hit.file}:${hit.line} ${JSON.stringify(hit.text)}`);

test("the scan flags Korean literals in serviceError arguments and ignores comments", () => {
  const source = [
    'serviceError("X", "한글");',
    'serviceError("Y", `값 ${a} 확인`);',
    'serviceError("Z", messages.group.key); // 한글 주석',
    "/* 한글 블록 주석 */ const fine = 1;",
    'const other = "한글";',
  ].join("\n");
  expect(findKoreanLiterals("sample.ts", source).map((hit) => [hit.line, hit.inServiceError]))
    .toEqual([[1, true], [2, true], [2, true], [5, false]]);
});

test("the message scan flags a literal message in any language and accepts the messages layer", () => {
  const source = [
    'serviceError("A", "Cleanup failed");',
    'serviceError("B", `Failed ${reason}`);',
    'serviceError("C", `plain template`);',
    'serviceError("D", "Cleanup failed: " + reason);',
    'serviceError("E", ok ? messages.a.b : "fallback");',
    'serviceError("F", (messages.a.b ?? "fallback") as string);',
    'serviceError("G", messages.group.key);',
    'serviceError("H", messages.group.fn(`value ${x}`));',
    'serviceError("I", text);',
    'serviceError("J", messages.group[code]);',
    'serviceError(`K${x}`, messages.group.key);',
    'serviceError("L");',
    'other("M", "Not a service error");',
  ].join("\n");
  expect(findLiteralMessages("sample.ts", source).map((hit) => hit.line)).toEqual([1, 2, 3, 4, 5, 6]);
});

test("the scan reads the service's source files", () => {
  expect(serviceSources().length).toBeGreaterThan(20);
  expect(serviceSources()).toContain("install/remote.ts");
});

test("no serviceError call in src/service passes a Korean literal directly", () => {
  expect(describeHits(scanService().filter((hit) => hit.inServiceError))).toEqual([]);
});

test("no serviceError call in src/service passes a written-in-place message, in any language", () => {
  const hits = serviceSources().flatMap((file) => findLiteralMessages(file, readFileSync(join(SERVICE_DIR, file), "utf8")));
  expect(hits.map((hit) => `${hit.file}:${hit.line} ${hit.text}`)).toEqual([]);
});

test("no Korean literal stays in src/service code outside the allow-list", () => {
  expect(describeHits(scanService())).toEqual([]);
});

test("every allow-list entry still matches a literal in the source", () => {
  const all = serviceSources().flatMap((file) => findKoreanLiterals(file, readFileSync(join(SERVICE_DIR, file), "utf8")));
  const stale = ALLOWED.filter((allowed) => !all.some((hit) => hit.file === allowed.file && hit.text === allowed.text));
  expect(stale).toEqual([]);
});
