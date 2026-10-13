/**
 * production-node-provenance.test.ts — 운영 코드의 노드 저장 호출은 출처(provenance)를 명시한다
 * (WP-B1-20T 설계 3.5, 9절 위험 1).
 *
 * 출처 없이 만들어진 직접 저장은 메시지 삭제로 지워지지 않는다(개인정보). AddNodeArgs.provenance 는
 * 테스트의 짧은 호출(`store.addNode({ content })`)을 위해 선택 칸으로 두고 저장소가 인자에서 도출하므로,
 * 운영 코드가 빠뜨려도 타입 검사가 잡지 못한다. 이 테스트가 그 틈을 막는다: 테스트·평가 도구가 아닌
 * 파일의 `.addNode(`·`.addNodeIdempotent(`·`.addNodesBatch(`·`.insertNodeWithVecSync(`·`addImageAssetNode(`
 * 호출은 인자 객체 리터럴에 provenance 칸을 직접 둬야 한다.
 *
 * 판정은 TypeScript 구문 트리로 한다(typescript 는 이 앱의 typecheck 가 쓰는 기존 의존) — 주석·문자열 속
 * 이름에 속지 않는다. 저장소 자신(facade·repository)이 호출자의 인자를 그대로 넘기는 호출만 예외 목록에
 * 두고, 목록의 항목이 코드에서 사라지면 이 테스트가 실패해 목록이 낡지 않게 한다.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import ts from "typescript";

/** apps/memory — 이 파일은 src/db/ 에 있다. */
const APP_ROOT = join(import.meta.dir, "..", "..");
const SCAN_DIRS = ["src", "scripts"] as const;

type ArgShape = "object" | "array";
/** 노드를 저장하는 진입점과, 저장 인자가 들어오는 인자 위치. */
const CHECKED_CALLS: Readonly<Record<string, { argIndex: number; shape: ArgShape }>> = {
  addNode: { argIndex: 0, shape: "object" },
  addNodeIdempotent: { argIndex: 0, shape: "object" },
  addNodesBatch: { argIndex: 0, shape: "array" },
  insertNodeWithVecSync: { argIndex: 0, shape: "object" },
  addImageAssetNode: { argIndex: 1, shape: "object" },
};

/**
 * 저장소가 호출자의 인자를 그대로 넘기는 호출 — 여기서 provenance 가 비면 저장소가 도출한다
 * (node-absorption.ts resolveNodeProvenance). 키 = "파일::호출 원문".
 */
const STORE_FORWARDING_CALLS = new Set([
  "src/db/store/base.ts::this.nodeRepo.addNode(args)",
  "src/db/store/base.ts::this.nodeRepo.addNodeIdempotent(args)",
  "src/db/store/base.ts::this.nodeRepo.addNodesBatch(argsList)",
  "src/db/store-internal/node-repo-ingest-mixin.ts::this.addNodeIdempotent(args)",
]);

/**
 * 설계 2.1 흡수 통로 가운데 노드를 직접 저장하는 파일 — 검사가 실제로 이 파일들의 호출을 봤는지 확인해,
 * 스캔 경로가 어긋나 아무것도 보지 못한 채 통과하는 일을 막는다.
 */
const EXPECTED_CHANNEL_FILES = [
  "src/server-internal/save-input-plain.ts",
  "src/server-internal/save-input-regex.ts",
  "src/server-internal/save-input-entity-branches.ts",
  "src/server-internal/save-input-immediate.ts",
  "src/server-internal/routes/memories-from-text.ts",
  "src/server-internal/routes/documents-ocr-apply.ts",
  "src/memory/extractor.ts",
  "src/memory/extractor-internal/hashtag-wiring.ts",
  "src/memory/origin-chunks.ts",
  "src/memory/ingest-image.ts",
  "src/db/store/search-mixin.ts",
  "src/db/store-internal/document-graph-repository.ts",
];

/** 테스트·평가 도구 파일 — 운영 경로가 아니다. */
function isTestOrEvalFile(relPath: string): boolean {
  return relPath.endsWith(".test.ts") ||
    relPath.endsWith("test-helpers.ts") ||
    relPath.includes("/test-utils/") ||
    relPath.includes("/__tests__/") ||
    relPath.includes("/eval/");
}

function hasProvenanceProperty(node: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some((property) =>
    (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
    ts.isIdentifier(property.name) && property.name.text === "provenance");
}

function argumentNamesProvenance(arg: ts.Expression | undefined, shape: ArgShape): boolean {
  if (arg === undefined) return false;
  if (shape === "object") return hasProvenanceProperty(arg);
  return ts.isArrayLiteralExpression(arg) && arg.elements.length > 0 &&
    arg.elements.every((element) => hasProvenanceProperty(element));
}

function calleeName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  return null;
}

interface CheckedCall {
  file: string;
  line: number;
  text: string;
  explicit: boolean;
}

/** 파일 한 개의 노드 저장 호출. text 는 공백을 한 칸으로 줄인 호출 원문. */
function findNodeInsertCalls(relPath: string, sourceText: string): CheckedCall[] {
  const sourceFile = ts.createSourceFile(relPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: CheckedCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const rule = name === null ? undefined : CHECKED_CALLS[name];
      if (rule !== undefined) {
        calls.push({
          file: relPath,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          text: node.getText(sourceFile).replace(/\s+/g, " "),
          explicit: argumentNamesProvenance(node.arguments[rule.argIndex], rule.shape),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

async function scanProductionCalls(): Promise<CheckedCall[]> {
  const pattern = /\b(addNode|addNodeIdempotent|addNodesBatch|insertNodeWithVecSync|addImageAssetNode)\s*\(/;
  const calls: CheckedCall[] = [];
  for (const dir of SCAN_DIRS) {
    for await (const rel of new Bun.Glob("**/*.ts").scan({ cwd: join(APP_ROOT, dir) })) {
      const relPath = `${dir}/${rel.replaceAll("\\", "/")}`;
      if (isTestOrEvalFile(relPath)) continue;
      const text = await Bun.file(join(APP_ROOT, relPath)).text();
      if (!pattern.test(text)) continue;
      calls.push(...findNodeInsertCalls(relPath, text));
    }
  }
  return calls;
}

describe("운영 코드의 노드 저장 호출은 provenance 를 명시한다", () => {
  test("검사기 자체 — 객체 리터럴의 provenance 칸만 명시로 보고, 주석·변수 전달은 명시가 아니다", () => {
    const fixture = [
      "store.addNode({ content, provenance });",
      "store.addNode({ ...args, provenance: { kind: 'source', source } });",
      "// store.addNode({ content }) 는 주석이라 호출이 아니다",
      "store.addNode(chunkArgs);",
      "store.addNodeIdempotent({ content, metadata: { provenance: 1 } });",
      "addImageAssetNode(db, { content, provenance });",
      "store.addNodesBatch([{ content, provenance }, { content }]);",
    ].join("\n");
    const calls = findNodeInsertCalls("fixture.ts", fixture);
    expect(calls.map((call) => [call.line, call.explicit])).toEqual([
      [1, true], [2, true], [4, false], [5, false], [6, true], [7, false],
    ]);
  });

  test("테스트·평가 도구가 아닌 파일의 호출은 모두 provenance 를 명시한다", async () => {
    const calls = await scanProductionCalls();
    const forwarded = new Set<string>();
    const violations: string[] = [];
    for (const call of calls) {
      const key = `${call.file}::${call.text}`;
      if (STORE_FORWARDING_CALLS.has(key)) {
        forwarded.add(key);
        continue;
      }
      if (!call.explicit) violations.push(`${call.file}:${call.line} — ${call.text}`);
    }
    expect(violations).toEqual([]);
    // 예외 목록의 항목이 모두 아직 코드에 있다(낡은 예외가 새 호출을 가리지 않게).
    expect([...forwarded].sort()).toEqual([...STORE_FORWARDING_CALLS].sort());
    // 설계 2.1 의 저장 통로 파일을 실제로 봤다(스캔 경로가 어긋나 빈 검사로 통과하지 않게).
    const seenFiles = new Set(calls.map((call) => call.file));
    expect(EXPECTED_CHANNEL_FILES.filter((file) => !seenFiles.has(file))).toEqual([]);
  });
});
