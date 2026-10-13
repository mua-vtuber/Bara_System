// Test-only: times the cause-sentence work (`stripAddressSecrets`, `causeOf`) on server-sized text in a Bun
// process of its own, for `tests/service-cause-bounds.test.ts`. A regular expression runs to its end once it
// has started, so a search that turned quadratic again (hours at 2 MB) would freeze the test's own process
// with no failure to show; run here, it is stopped at the test's deadline and reported as a failure.
// Product code never imports this file.
import { causeOf, stripAddressSecrets } from "../../src/service/fetch-failure.ts";

/** As long as a response, and so a cleanup server's sentence, may be. */
export const TWO_MB = 2_000_000;
/** Runs of scheme characters with no break in them: the shapes the old search was quadratic on. */
export const UNBROKEN_SHAPES = ["a.", "a-", "a+", "1a.", "Ab.9-", "a:/", "a.b.c.d.e."];
/** Many real addresses in one sentence, each with a query string to strip. */
export const ADDRESSES_SHAPE = "http://h/?k=v ";
export const spaced = (shape: string): string => `${shape} `;
export const toLength = (shape: string, length: number): string => shape.repeat(Math.ceil(length / shape.length)).slice(0, length);

/** One timed piece of work: `step` run over `shape` repeated to `TWO_MB`. */
export interface TimedCase { step: "strip" | "cause"; shape: string }
export const caseLabel = (timed: TimedCase): string => `${timed.step} ${JSON.stringify(timed.shape)}`;
const STEPS = { strip: stripAddressSecrets, cause: causeOf } as const;

/** What the child process reported: whether the deadline stopped it, its exit code (`null` when stopped), and
 * the milliseconds each case took (by `caseLabel`) when it finished. */
export interface ChildTiming { timedOut: boolean; exitCode: number | null; times: Record<string, number> }

/** Runs this file as its own process over `cases`, killed when `deadlineMs` has passed. */
export async function timeInChildProcess(cases: TimedCase[], deadlineMs: number): Promise<ChildTiming> {
  const child = Bun.spawn([process.execPath, import.meta.path, JSON.stringify(cases)],
    { stdin: "ignore", stdout: "pipe", stderr: "inherit", timeout: deadlineMs });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  // The deadline ends the process with a signal (`killed` is no help: Bun sets it on every exit).
  return { timedOut: child.signalCode !== null, exitCode: child.exitCode, times: exitCode === 0 ? JSON.parse(stdout) as Record<string, number> : {} };
}

if (import.meta.main) {
  const cases = JSON.parse(Bun.argv[2] ?? "") as TimedCase[];
  const times: Record<string, number> = {};
  for (const timed of cases) {
    const text = toLength(timed.shape, TWO_MB);
    const start = performance.now();
    STEPS[timed.step](text);
    times[caseLabel(timed)] = performance.now() - start;
  }
  process.stdout.write(JSON.stringify(times));
}
