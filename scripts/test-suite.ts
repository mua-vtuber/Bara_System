import { Glob } from "bun";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readBunfigTestTimeoutMs } from "./bunfig-test-timeout.ts";

type SuiteName = "default" | "heavy" | "all" | "list";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);

const BOT_HEAVY_PATTERNS: RegExp[] = [/\.integration\.test\.ts$/];

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

async function collectTests(pattern: string): Promise<string[]> {
  const glob = new Glob(pattern);
  const files: string[] = [];
  for await (const path of glob.scan({ cwd: repoRoot, onlyFiles: true })) {
    files.push(normalizePath(path));
  }
  return files.sort();
}

function splitBotTests(files: string[]): {
  defaultTests: string[];
  heavyTests: string[];
} {
  const defaultTests: string[] = [];
  const heavyTests: string[] = [];

  for (const file of files) {
    if (BOT_HEAVY_PATTERNS.some((pattern) => pattern.test(file))) {
      heavyTests.push(file);
    } else {
      defaultTests.push(file);
    }
  }

  return { defaultTests, heavyTests };
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function runCommand(args: string[], cwd = repoRoot): Promise<number> {
  const proc = Bun.spawn(args, {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}

async function runMemorySuite(
  suite: Exclude<SuiteName, "list">,
  rest: string[],
): Promise<number> {
  const memorySuite = suite === "all" ? "all" : suite;
  return runCommand([
    "bun",
    "run",
    "apps/memory/scripts/test-suite.ts",
    memorySuite,
    ...rest,
  ]);
}

async function runBunFiles(
  suite: Exclude<SuiteName, "list">,
  label: string,
  files: string[],
  rest: string[],
): Promise<number> {
  if (files.length === 0) {
    console.log(`[test-suite] ${label}: no tests selected`);
    return 0;
  }

  const maxConcurrency =
    suite === "default"
      ? positiveIntFromEnv("BARA_TEST_CONCURRENCY", 4)
      : positiveIntFromEnv("BARA_HEAVY_TEST_CONCURRENCY", 1);

  // Bun 은 bunfig.toml 의 [test] timeout 을 읽지 않아 5000ms 기본값이 적용된다.
  // bunfig 의 설정값을 --timeout 으로 넘겨 실제로 적용한다.
  const timeoutMs = await readBunfigTestTimeoutMs(repoRoot);

  console.log(
    `[test-suite] ${label}: ${files.length} files, max-concurrency=${maxConcurrency}, timeout=${timeoutMs}ms`,
  );

  return runCommand([
    "bun",
    "test",
    `--max-concurrency=${maxConcurrency}`,
    `--timeout=${timeoutMs}`,
    ...rest,
    ...files,
  ]);
}

const { suite, rest } = parseSuite(Bun.argv.slice(2));
const setupTests = await collectTests("apps/setup/**/*.test.ts");
const botTests = await collectTests("apps/bot-discord/**/*.test.ts");
const { defaultTests: botDefaultTests, heavyTests: botHeavyTests } =
  splitBotTests(botTests);

if (suite === "list") {
  console.log(`setup=${setupTests.length}`);
  console.log(`botDefault=${botDefaultTests.length}`);
  console.log(`botHeavy=${botHeavyTests.length}`);
  console.log("\n[botHeavy]");
  for (const file of botHeavyTests) console.log(file);
  console.log("\n[memory]");
  const code = await runCommand([
    "bun",
    "run",
    "apps/memory/scripts/test-suite.ts",
    "list",
  ]);
  process.exit(code);
}

const code = await runMemorySuite(suite, rest);
if (code !== 0) process.exit(code);

const selectedBotTests =
  suite === "default"
    ? botDefaultTests
    : suite === "heavy"
      ? botHeavyTests
      : botTests;

const nonMemoryTests = suite === "heavy" ? selectedBotTests : [
  ...setupTests,
  ...selectedBotTests,
];

const nonMemoryCode = await runBunFiles(
  suite,
  suite === "heavy" ? "bot-heavy" : "non-memory",
  nonMemoryTests,
  rest,
);
process.exit(nonMemoryCode);
