import { Glob } from "bun";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readBunfigTestTimeoutMs } from "../../../scripts/bunfig-test-timeout.ts";

type SuiteName = "default" | "heavy" | "all" | "list";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const memoryRoot = dirname(scriptDir);

const PURE_EVAL_TESTS = new Set([
  "src/memory/eval/lexical-margin.test.ts",
  "src/memory/eval/metrics.test.ts",
  // 손 정답 fixture 무결성 검사 — 코퍼스 파일과 줄번호만 읽고 임베딩·DB 를 안 쓴다.
  "src/memory/eval/eval-queries-ext.test.ts",
  // 항목·일정 자동 등록 평가 자료 무결성 — JSON 자료만 읽는 순수 검사.
  "src/memory/cleanup-deep-pass/entity-register/eval-cases.test.ts",
]);

const HEAVY_PATH_PATTERNS: RegExp[] = [
  /^src\/memory\/eval\//,
  /\.int\.test\.ts$/,
  /e2e\.test\.ts$/,
  /^src\/embedding\/(?:bge-m3|siglip2|siglip2-text)\.test\.ts$/,
  /^src\/memory\/reranker\.test\.ts$/,
  /^src\/server-internal\/routes\/search\.(?:image-)?reranker\.test\.ts$/,
  /^src\/memory\/retriever-magnitude\.test\.ts$/,
  /^src\/memory\/migration\/re-embed-images\.test\.ts$/,
];

const HEAVY_CONTENT_PATTERNS: RegExp[] = [
  /embedder\.load\(/,
  /reranker\.load\(/,
  /loadSiglipTextEncoder\(/,
  /createImageEmbedder\(/,
  /new\s+Siglip2Embedder\(/,
];

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function parseSuite(args: string[]): { suite: SuiteName; rest: string[] } {
  const first = args[0];
  if (
    first === "default" ||
    first === "heavy" ||
    first === "all" ||
    first === "list"
  ) {
    return { suite: first, rest: args.slice(1) };
  }
  return { suite: "default", rest: args };
}

async function collectTests(): Promise<string[]> {
  const glob = new Glob("**/*.test.ts");
  const files: string[] = [];
  for await (const path of glob.scan({ cwd: memoryRoot, onlyFiles: true })) {
    files.push(normalizePath(path));
  }
  return files.sort();
}

async function isHeavyTest(path: string): Promise<boolean> {
  if (PURE_EVAL_TESTS.has(path)) return false;
  if (HEAVY_PATH_PATTERNS.some((pattern) => pattern.test(path))) return true;

  const text = await Bun.file(join(memoryRoot, path)).text();
  return HEAVY_CONTENT_PATTERNS.some((pattern) => pattern.test(text));
}

async function splitTests(files: string[]): Promise<{
  defaultTests: string[];
  heavyTests: string[];
}> {
  const defaultTests: string[] = [];
  const heavyTests: string[] = [];

  for (const file of files) {
    if (await isHeavyTest(file)) heavyTests.push(file);
    else defaultTests.push(file);
  }

  return { defaultTests, heavyTests };
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

type RunKind = Exclude<SuiteName, "all" | "list">;

async function runBunTest(
  kind: RunKind,
  files: string[],
  rest: string[],
): Promise<number> {
  if (files.length === 0) {
    console.log(`[test-suite] ${kind}: no tests selected`);
    return 0;
  }

  const maxConcurrency =
    kind === "default"
      ? positiveIntFromEnv("BARA_TEST_CONCURRENCY", 4)
      : positiveIntFromEnv("BARA_HEAVY_TEST_CONCURRENCY", 1);
  // 무거운 테스트는 파일마다 모델(bge-m3 약 1GB 등)을 새로 올리고 내려놓지 않는다.
  // bun test 는 한 프로세스에 든 파일의 모듈 변수를 끝까지 붙잡고 있어서, 여러 파일을
  // 한 프로세스에 묶으면 모델이 파일 수만큼 쌓여 메모리가 바닥난다(80파일 묶음 ≈ 100GB).
  // 그래서 무거운 테스트는 기본으로 파일 하나당 프로세스 하나로 돌려, 파일이 끝날 때마다
  // 프로세스와 함께 메모리를 통째로 돌려받는다.
  const batchSize =
    kind === "default"
      ? positiveIntFromEnv("BARA_TEST_BATCH_SIZE", 80)
      : positiveIntFromEnv("BARA_HEAVY_TEST_BATCH_SIZE", 1);
  // Bun 은 bunfig.toml 의 [test] timeout 을 읽지 않아 5000ms 기본값이 적용된다.
  // 기본 스위트는 bunfig 의 설정값을 --timeout 으로 넘겨 실제로 적용한다. 무거운 스위트는
  // 모델 적재·평가 때문에 따로 둔 BARA_HEAVY_TEST_TIMEOUT_MS(기본 600000)를 그대로 쓴다.
  const timeoutMs =
    kind === "default"
      ? await readBunfigTestTimeoutMs(memoryRoot)
      : (process.env.BARA_HEAVY_TEST_TIMEOUT_MS ?? "600000");
  const timeoutArg = [`--timeout=${timeoutMs}`];
  const ignoreOverrideArg =
    "--path-ignore-patterns=__bara_test_suite_runner_no_ignore__";
  const fileBatches = chunks(files, batchSize);

  console.log(
    `[test-suite] ${kind}: ${files.length} files, max-concurrency=${maxConcurrency}, timeout=${timeoutMs}ms, batch-size=${batchSize}, batches=${fileBatches.length}`,
  );

  for (let index = 0; index < fileBatches.length; index++) {
    const batch = fileBatches[index]!;
    console.log(
      `[test-suite] ${kind}: batch ${index + 1}/${fileBatches.length} (${batch.length === 1 ? batch[0] : `${batch.length} files`})`,
    );
    const proc = Bun.spawn(
      [
        "bun",
        "test",
        ignoreOverrideArg,
        `--max-concurrency=${maxConcurrency}`,
        ...timeoutArg,
        ...rest,
        ...batch,
      ],
      {
        cwd: memoryRoot,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const code = await proc.exited;
    if (code !== 0) return code;
  }

  return 0;
}

const { suite, rest } = parseSuite(Bun.argv.slice(2));
const allTests = await collectTests();
const { defaultTests, heavyTests } = await splitTests(allTests);

if (suite === "list") {
  console.log(`all=${allTests.length}`);
  console.log(`default=${defaultTests.length}`);
  console.log(`heavy=${heavyTests.length}`);
  console.log("\n[heavy]");
  for (const file of heavyTests) console.log(file);
  process.exit(0);
}

// "all" 은 가벼운 테스트와 무거운 테스트를 각자의 묶음 규칙으로 차례로 돌린다.
let exitCode = 0;
if (suite === "default" || suite === "all") {
  exitCode = await runBunTest("default", defaultTests, rest);
}
if (exitCode === 0 && (suite === "heavy" || suite === "all")) {
  exitCode = await runBunTest("heavy", heavyTests, rest);
}
process.exit(exitCode);
