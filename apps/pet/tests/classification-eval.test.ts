import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTURE_KINDS, DEFAULT_AI_URLS, type CaptureKind, type RequestContext } from "../src/shared/contracts.ts";
import { AiClient, buildClassificationPrompt, CLASSIFICATION_INPUT_MAX_CHARS, parseClassification } from "../src/service/ai.ts";
import { ConfigStore } from "../src/service/config.ts";
import { ServiceError } from "../src/service/errors.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";
import evalFile from "./fixtures/classification-eval.json";

// Ground truth for this evaluation is the current CAPTURE_KINDS plus "undecided" (the model's
// {"kind": null} answer, reported by Assistant.save as classification outcome "undecided").
const UNDECIDED = "undecided";
type Label = CaptureKind | typeof UNDECIDED;
const GROUPS = ["clear", "ambiguous"] as const;
const TRAITS = ["short", "typo", "deixis", "multi-kind", "no-kind"] as const;
interface EvalCase { id: string; text: string; expected: string; group: (typeof GROUPS)[number]; traits: (typeof TRAITS)[number][] }

const SHORT_MAX_CHARS = 12;
const MIN_CLEAR_PER_KIND = 5;
const MIN_AMBIGUOUS_CASES = 10;
const REQUIRED_TRAITS = ["short", "typo", "deixis"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** Like an assertion, but the failure names the sentence or kind that broke it. */
function check(condition: boolean, message: string): void { if (!condition) throw new Error(message); }
const toLabel = (kind: CaptureKind | null): Label => kind ?? UNDECIDED;
const replyFor = (label: string): string => JSON.stringify({ kind: label === UNDECIDED ? null : label });

/** Reads the fixture with explicit checks so a malformed edit names the offending case instead of scoring garbage. */
function loadCases(raw: unknown): EvalCase[] {
  if (!isRecord(raw) || !Array.isArray(raw.cases) || raw.cases.length === 0) throw new Error("classification-eval.json: cases 배열이 없습니다.");
  const ids = new Set<string>();
  return raw.cases.map((entry: unknown, index: number): EvalCase => {
    const at = `classification-eval.json cases[${index}]`;
    if (!isRecord(entry)) throw new Error(`${at}: 객체가 아닙니다.`);
    const { id, text, expected, group, traits } = entry;
    if (typeof id !== "string" || !id || ids.has(id)) throw new Error(`${at}: id 가 없거나 중복입니다.`);
    ids.add(id);
    if (typeof text !== "string" || !text.trim()) throw new Error(`${at} (${id}): text 가 비었습니다.`);
    if (typeof expected !== "string") throw new Error(`${at} (${id}): expected 가 문자열이 아닙니다.`);
    if (!GROUPS.includes(group as EvalCase["group"])) throw new Error(`${at} (${id}): group 은 ${GROUPS.join(" 또는 ")} 이어야 합니다.`);
    if (!Array.isArray(traits) || traits.some((trait) => !TRAITS.includes(trait as EvalCase["traits"][number]))) throw new Error(`${at} (${id}): traits 는 ${TRAITS.join(", ")} 만 쓸 수 있습니다.`);
    return { id, text, expected, group: group as EvalCase["group"], traits: traits as EvalCase["traits"] };
  });
}
const loadEvalCases = (): EvalCase[] => loadCases(evalFile);

// --- scoring ---------------------------------------------------------------------------------

/** A reply the parser accepted (`label`), or one the parser refused (`invalid`, the ServiceError code). */
type Outcome = { label: Label } | { invalid: string };
interface Tally { total: number; correct: number }
interface Score { perLabel: Record<string, Tally>; clear: Tally; ambiguousTotal: number; forcedDecisions: number; invalid: number; misses: string[] }

function scoreEvaluation(cases: readonly EvalCase[], outcomes: readonly Outcome[]): Score {
  if (cases.length !== outcomes.length) throw new Error(`평가 결과 ${outcomes.length}건이 평가 문장 ${cases.length}건과 맞지 않습니다.`);
  const score: Score = { perLabel: {}, clear: { total: 0, correct: 0 }, ambiguousTotal: 0, forcedDecisions: 0, invalid: 0, misses: [] };
  cases.forEach((item, index) => {
    const outcome = outcomes[index]!;
    const correct = "label" in outcome && outcome.label === item.expected;
    const tally = score.perLabel[item.expected] ??= { total: 0, correct: 0 };
    tally.total++;
    if (correct) tally.correct++;
    if (item.group === "clear") { score.clear.total++; if (correct) score.clear.correct++; }
    else score.ambiguousTotal++;
    if ("invalid" in outcome) score.invalid++;
    // A forced decision is a kind named for a sentence whose right answer is to withhold judgment.
    else if (item.group === "ambiguous" && outcome.label !== UNDECIDED) score.forcedDecisions++;
    if (!correct) score.misses.push(`${item.id} "${item.text}" 기대=${item.expected} 결과=${"label" in outcome ? outcome.label : `형식 오류(${outcome.invalid})`}`);
  });
  return score;
}
const percent = ({ total, correct }: Tally): string => `${correct}/${total} (${total ? Math.round((correct / total) * 100) : 0}%)`;

function formatReport(model: string, baseUrl: string, score: Score): string {
  const kindLines = [...CAPTURE_KINDS, UNDECIDED].map((label) => `  ${label}: ${percent(score.perLabel[label] ?? { total: 0, correct: 0 })}`);
  return [
    `[classification-eval] model=${model} address=${baseUrl}`, "분류별 정확도:", ...kindLines,
    `명확한 문장 묶음 정확도: ${percent(score.clear)}`,
    `모호한 문장에서 억지 확정: ${score.forcedDecisions}/${score.ambiguousTotal}건`,
    `형식 오류 응답: ${score.invalid}건`,
    ...(score.misses.length ? ["틀린 문장:", ...score.misses.map((line) => `  ${line}`)] : []),
  ].join("\n");
}

// --- always-run: data set and the real pure logic ---------------------------------------------

test("eval data set is well formed and its labels follow the group", () => {
  const cases = loadEvalCases();
  for (const item of cases) {
    if (item.group === "ambiguous" && item.expected !== UNDECIDED) throw new Error(`${item.id}: 모호한 문장의 기대 분류는 ${UNDECIDED} 여야 합니다.`);
    if (item.group === "clear" && item.expected === UNDECIDED) throw new Error(`${item.id}: 명확한 문장은 ${UNDECIDED} 를 기대할 수 없습니다.`);
    // Both directions, so the trait cannot drift from the text it describes.
    check(item.traits.includes("short") === item.text.length <= SHORT_MAX_CHARS, `${item.id}: short 표시가 글자 수(${item.text.length}자, 기준 ${SHORT_MAX_CHARS}자 이하)와 맞지 않습니다.`);
  }
});

test("eval data set uses exactly the current CAPTURE_KINDS plus undecided", () => {
  const used = new Set(loadEvalCases().map((item) => item.expected));
  const required = new Set<string>([...CAPTURE_KINDS, UNDECIDED]);
  const missing = [...required].filter((label) => !used.has(label));
  const extra = [...used].filter((label) => !required.has(label));
  if (missing.length || extra.length) {
    throw new Error(`평가 자료의 분류가 CAPTURE_KINDS 와 다릅니다. 자료에 없는 분류: [${missing.join(", ")}], 자료에만 있는 분류: [${extra.join(", ")}]. `
      + "tests/fixtures/classification-eval.json 을 현재 분류 목록에 맞게 고쳐 주세요.");
  }
});

test("eval data set has enough clear sentences per kind, enough ambiguous ones, and every required trait", () => {
  const cases = loadEvalCases();
  for (const kind of CAPTURE_KINDS) {
    const count = cases.filter((item) => item.group === "clear" && item.expected === kind).length;
    check(count >= MIN_CLEAR_PER_KIND, `${kind}: 명확한 문장이 ${count}건뿐입니다 (최소 ${MIN_CLEAR_PER_KIND}건).`);
  }
  expect(cases.filter((item) => item.group === "ambiguous").length).toBeGreaterThanOrEqual(MIN_AMBIGUOUS_CASES);
  for (const trait of REQUIRED_TRAITS) check(cases.some((item) => item.traits.includes(trait)), `${trait} 성질의 문장이 자료에 없습니다.`);
});

test("the classification prompt offers every current kind, asks for null when unsure, and carries the sentence untouched", () => {
  for (const item of loadEvalCases()) {
    const { system, user } = buildClassificationPrompt(item.text, CAPTURE_KINDS);
    check(user === item.text, `${item.id}: 문장이 프롬프트에서 바뀌었습니다.`);
    check(system.includes(JSON.stringify(CAPTURE_KINDS)), `${item.id}: 프롬프트가 현재 분류를 모두 제시하지 않습니다.`);
    check(system.includes("uncertain means null"), `${item.id}: 프롬프트가 불확실하면 null 로 답하라고 요청하지 않습니다.`);
  }
});

test("the classification prompt lists only the kinds the server allows and cuts over-long notes", () => {
  const allowed: CaptureKind[] = ["idea", "task"];
  const { system } = buildClassificationPrompt("x", allowed);
  expect(system).toContain(JSON.stringify(allowed));
  expect(system).toContain("- idea:");
  expect(system).toContain("- task:");
  for (const unavailable of ["decision", "question", "preference", "information"]) expect(system).not.toContain(`- ${unavailable}:`);
  expect(system).toContain("Factual notes must return null");
  const tooLong = "가".repeat(CLASSIFICATION_INPUT_MAX_CHARS + 50);
  expect(buildClassificationPrompt(tooLong, CAPTURE_KINDS).user).toHaveLength(CLASSIFICATION_INPUT_MAX_CHARS);
});

test("the reply a correct model would give parses back to each sentence's expected label", () => {
  for (const item of loadEvalCases()) {
    const parsed = toLabel(parseClassification(replyFor(item.expected), CAPTURE_KINDS));
    check(parsed === item.expected, `${item.id}: 기대 분류 ${item.expected} 의 정상 응답이 ${parsed} 로 해석되었습니다.`);
  }
});

test("undecided must be the JSON null: the word, other casing, extra keys and unknown kinds are all refused", () => {
  expect(parseClassification('{"kind":null}', CAPTURE_KINDS)).toBeNull();
  for (const reply of ['{"kind":"undecided"}', '{"kind":"Idea"}', '{"kind":"idea","reason":"x"}', 'Sure: {"kind":"idea"}', '{"kind":"habit"}', '{}', '[]']) {
    expect(() => parseClassification(reply, CAPTURE_KINDS), reply).toThrow();
  }
  // A kind the server did not offer is refused even though this Pet knows it.
  expect(() => parseClassification('{"kind":"decision"}', ["idea", "task"])).toThrow();
});

test("scoring counts per-kind accuracy, forced decisions on ambiguous sentences and unreadable replies", () => {
  const cases = loadEvalCases();
  const clearTotal = cases.filter((item) => item.group === "clear").length;
  const ambiguousTotal = cases.length - clearTotal;
  const perfect = scoreEvaluation(cases, cases.map((item): Outcome => ({ label: item.expected as Label })));
  expect(perfect.clear).toEqual({ total: clearTotal, correct: clearTotal });
  expect(perfect.forcedDecisions).toBe(0);
  expect(perfect.invalid).toBe(0);
  expect(perfect.misses).toEqual([]);
  expect(perfect.perLabel[UNDECIDED]).toEqual({ total: ambiguousTotal, correct: ambiguousTotal });

  // Every ambiguous sentence forced into "task", and the first clear sentence unreadable.
  const firstClear = cases.findIndex((item) => item.group === "clear");
  const firstClearKind = cases[firstClear]!.expected;
  const kindTotal = cases.filter((item) => item.expected === firstClearKind).length;
  const worse = scoreEvaluation(cases, cases.map((item, index): Outcome =>
    index === firstClear ? { invalid: "AI_RESPONSE" } : item.group === "ambiguous" ? { label: "task" } : { label: item.expected as Label }));
  expect(worse.clear).toEqual({ total: clearTotal, correct: clearTotal - 1 });
  expect(worse.forcedDecisions).toBe(ambiguousTotal);
  expect(worse.invalid).toBe(1);
  expect(worse.perLabel[UNDECIDED]).toEqual({ total: ambiguousTotal, correct: 0 });
  expect(worse.perLabel[firstClearKind]).toEqual({ total: kindTotal, correct: kindTotal - 1 });
  expect(worse.misses).toHaveLength(ambiguousTotal + 1);
  expect(() => scoreEvaluation(cases, [])).toThrow();
});

// --- live: real client over HTTP against a real local model -------------------------------------

const ENV = { model: "PET_EVAL_AI_MODEL", url: "PET_EVAL_AI_URL", provider: "PET_EVAL_AI_PROVIDER" } as const;
const EVAL_PROVIDERS = ["ollama", "openai-compatible"] as const;
const CLEAR_MIN_ACCURACY = 0.8;
const LIVE_TIMEOUT_MS = 600_000;
const LIVE_TEST_NAME = "live local-model classification meets the minimum accuracy on the clear sentences";
const context: RequestContext = { signal: new AbortController().signal, progress() {} };

interface LiveTarget { ai: AiClient; model: string; baseUrl: string }
type LiveResolution = { run: LiveTarget } | { skip: string } | { invalid: string };

let liveDir: string | undefined;
afterAll(() => { if (liveDir) rmSync(liveDir, { recursive: true, force: true }); });

/** Decides whether the live part can run. Only a missing or unreachable model skips; a value that is
 * set but wrong is reported as a failure of the live test instead of hiding behind a skip. */
async function resolveLive(): Promise<LiveResolution> {
  const provider = process.env[ENV.provider]?.trim() || "ollama";
  if (!EVAL_PROVIDERS.includes(provider as (typeof EVAL_PROVIDERS)[number])) return { invalid: `${ENV.provider} 는 ${EVAL_PROVIDERS.join(" 또는 ")} 이어야 합니다 (입력값: ${provider}).` };
  const kind = provider as (typeof EVAL_PROVIDERS)[number];
  const baseUrl = process.env[ENV.url]?.trim() || DEFAULT_AI_URLS[kind];
  const model = process.env[ENV.model]?.trim();
  if (!model) return { skip: `${ENV.model} 환경변수가 없어 평가할 모델이 정해지지 않았습니다 (AI 주소: ${baseUrl}).` };
  liveDir = mkdtempSync(join(tmpdir(), "pet-classification-eval-"));
  // No secret is saved, so the DPAPI-backed test vault is never asked to encrypt or decrypt anything.
  const config = new ConfigStore({ dataDir: liveDir, resourceDir: liveDir, bunPath: process.execPath }, new DpapiVault());
  try { await config.save({ ai: { provider: kind, baseUrl, model } }); }
  catch (error) { return { invalid: `AI 설정을 저장하지 못했습니다: ${error instanceof ServiceError ? error.publicMessage : String(error)}` }; }
  const ai = new AiClient(config);
  const probe = await ai.probe("answer", context);
  if (!probe.available) return { skip: `모델 "${model}" 을(를) AI 주소 ${baseUrl} 에서 사용할 수 없습니다 (${probe.message})` };
  return { run: { ai, model, baseUrl } };
}

const live = await resolveLive();
if ("skip" in live) console.warn(`[classification-eval] 실제 모델 평가를 건너뜁니다: ${live.skip}`);

/** A reply the model gave but the parser refused is a quality miss; any other failure (server down,
 * timeout, bad settings) is not a quality result, so it is thrown rather than scored. */
async function classifyOne(ai: AiClient, text: string): Promise<Outcome> {
  try { return { label: toLabel(await ai.classify(text, CAPTURE_KINDS, context)) }; }
  catch (error) {
    if (error instanceof ServiceError && error.code === "AI_RESPONSE") return { invalid: error.code };
    throw error;
  }
}

test.skipIf("skip" in live)("skip" in live ? `${LIVE_TEST_NAME} [skipped: ${live.skip}]` : LIVE_TEST_NAME, async () => {
  if ("invalid" in live) throw new Error(live.invalid);
  if (!("run" in live)) throw new Error("live target is missing");
  const { ai, model, baseUrl } = live.run;
  const cases = loadEvalCases();
  const outcomes: Outcome[] = [];
  for (const item of cases) outcomes.push(await classifyOne(ai, item.text)); // one at a time: one local model, stable timing
  const score = scoreEvaluation(cases, outcomes);
  console.log(formatReport(model, baseUrl, score));
  expect(score.clear.correct / score.clear.total).toBeGreaterThanOrEqual(CLEAR_MIN_ACCURACY);
  const information = score.perLabel.information!;
  expect(information.correct / information.total).toBeGreaterThanOrEqual(CLEAR_MIN_ACCURACY);
  // Overall accuracy cannot hide a regression in the reported hardware input or its contrasts.
  for (const [id, label] of [["information-01", "information"], ["preference-07", "preference"], ["task-07", "task"], ["idea-07", "idea"]] as const) {
    expect(outcomes[cases.findIndex((item) => item.id === id)], id).toEqual({ label });
  }
}, LIVE_TIMEOUT_MS);

const LEGACY_TEST_NAME = "live factual notes remain undecided when the server does not offer information";
test.skipIf("skip" in live)("skip" in live ? `${LEGACY_TEST_NAME} [skipped: ${live.skip}]` : LEGACY_TEST_NAME, async () => {
  if ("invalid" in live) throw new Error(live.invalid);
  if (!("run" in live)) throw new Error("live target is missing");
  const allowed: CaptureKind[] = ["idea", "decision", "question", "preference", "task"];
  const cases = loadEvalCases();
  for (const id of ["information-01", "information-03", "information-04"]) {
    const item = cases.find((candidate) => candidate.id === id)!;
    expect(await live.run.ai.classify(item.text, allowed, context), id).toBeNull();
  }
}, LIVE_TIMEOUT_MS);
