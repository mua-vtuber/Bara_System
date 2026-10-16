/**
 * 항목·일정 자동 등록 평가(spec 10장 2번) — 설정의 정리 AI(llm.cleanup)로 평가 자료 40개를 묶음 크기별로
 * 돌려 정확도·판정 분포·형식 오류·호출·토큰·시간을 잰다. 수동 실행용(시험 아님).
 * 모델을 몰래 바꾸지 않는다 — 설정이 비면 키 이름으로 멈추고, 호출이 실패하면 다른 모델로 넘어가지 않고 멈춘다.
 *
 *   bun run scripts/entity-register-eval.ts --batch 1,10,20 --out <결과 폴더> [--model <모델 이름>]
 *
 * --model 은 설정 대신 쓸 모델 이름을 직접 정할 때만 준다(현재 공급자의 모델 칸을 덮어씀). 쓴 모델은 항상 출력한다.
 * 묶음 나누기·지시문·응답 해석은 실제 단계 코드(planEntityRegisterBatches / createEntityRegisterInferFn)를 그대로
 * 쓴다. 사이클의 "쪼개서 다시 시도"는 흉내 내지 않는다 — 답이 빠진 메모는 오류로 세어 표에 보인다.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMemorySettings, resolveSettingsFilePaths } from "../src/settings/memory-settings-io.ts";
import { buildLlmClient } from "../src/server-internal/llm-wiring.ts";
import { LLM_PROVIDER_SPECS } from "../src/llm/provider-registry.ts";
import { asObservableLlmClient } from "../src/llm/observable.ts";
import { CircuitBreaker, CleanupLlmExecutor, createUsageAccumulator } from "../src/memory/cleanup-deep-pass/cleanup-llm-executor.ts";
import { cleanupModelKeyMissing } from "../src/memory/cleanup-deep-pass/scheduler-gate.ts";
import { cleanupStageLlmLimitsOf } from "../src/memory/cleanup-deep-pass/stage-constants.ts";
import { entityRegisterFingerprint } from "../src/memory/cleanup-deep-pass/stage-fingerprint.ts";
import { ENTITY_REGISTER_STATIC_TYPES } from "../src/memory/cleanup-deep-pass/entity-register/constants.ts";
import { planEntityRegisterBatches } from "../src/memory/cleanup-deep-pass/entity-register/cycle.ts";
import type { EntityRegisterCandidateRow } from "../src/memory/cleanup-deep-pass/entity-register/candidate-query.ts";
import { judgeMemo, judgeProfileFromLanguage } from "../src/memory/cleanup-deep-pass/entity-register/judge.ts";
import { addToNameIndex } from "../src/memory/cleanup-deep-pass/entity-register/name-index.ts";
import { createEntityRegisterInferFn } from "../src/memory/cleanup-deep-pass/entity-register/prompt.ts";
import { collectBatchAnswers, loadEvalFixture, scoreCase, scoreMissing, summarize, type CaseScore } from "../src/memory/cleanup-deep-pass/entity-register/eval-scoring.ts";
import type { EntityRegisterAiResult, EntityNameIndex, MemoJudgement } from "../src/memory/cleanup-deep-pass/entity-register/types.ts";

function optionalArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} 뒤에 값이 없음`);
  return v;
}

function arg(name: string): string {
  const v = optionalArg(name);
  if (v === undefined) throw new Error(`필수 인자 ${name} 가 없음 — 예: --batch 1,10,20 --out <결과 폴더>`);
  return v;
}

const batches = arg("--batch").split(",").map((s) => Number(s));
if (batches.some((b) => !Number.isInteger(b) || b < 1)) throw new Error("--batch 는 쉼표로 이은 1 이상 정수");
const out = arg("--out");
mkdirSync(out, { recursive: true });

const files = resolveSettingsFilePaths(process.env);
const settings = getMemorySettings(files.settingsPath, files.secretsPath);
const configured = settings.llm.cleanup;
if (!configured.enabled) throw new Error("llm.cleanup.enabled=false — 평가할 정리 AI 가 꺼져 있음");
const modelOverride = optionalArg("--model");
const slot = { ...configured };
if (modelOverride !== undefined) {
  slot[LLM_PROVIDER_SPECS[slot.provider].modelField] = modelOverride;
}
const missing = cleanupModelKeyMissing(slot);
if (missing) throw new Error(`정리 AI 모델이 설정되지 않음 (${missing})`);
const client = buildLlmClient(slot.provider, { ...slot, timeoutMs: slot.requestTimeoutMs }, "llm.cleanup");
if (!client) throw new Error(`정리 AI 클라이언트를 만들지 못함 (llm.cleanup.provider=${slot.provider})`);
// 비밀값(API 키 칸)은 출력·결과 파일에 남기지 않는다 — 공급자와 모델 이름만.
const model = { provider: slot.provider, model: slot[LLM_PROVIDER_SPECS[slot.provider].modelField] };
console.log(`평가 모델: ${JSON.stringify(model)}${modelOverride !== undefined ? " (--model 로 지정)" : " (설정 llm.cleanup)"}`);

const fixture = loadEvalFixture(join(import.meta.dir, "../test-fixtures/entity-register/cases.json"));
const allowedTypes = [...ENTITY_REGISTER_STATIC_TYPES];
const index: EntityNameIndex = { byType: new Map() };
for (const e of fixture.existing) addToNameIndex(index, e);
const profile = judgeProfileFromLanguage();
const stageVersion = cleanupStageLlmLimitsOf("entity_register").stageVersion;
const perCallInputCap = settings.cleanupDeepPass.budget.maxEstimatedInputTokensPerCall;

const rows: EntityRegisterCandidateRow[] = fixture.cases.map((c) => ({
  nodeId: c.id, content: c.text, createdAt: c.createdAt, alreadyLinked: [],
  targetKey: String(c.id), inputFingerprint: entityRegisterFingerprint({ content: c.text, createdAt: c.createdAt }), stageVersion,
}));

const lines: string[] = [
  "| 묶음 | 맞힘/정답 | 엉뚱한 이름 | 금지 이름 | 일정 맞힘 | 자동/제안/버림 | 형식 오류 묶음 | 답 빠진 메모 | 버린 답(묶음 밖/중복) | 호출 | 입력 토큰 | 출력 토큰 | 시간(ms) |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
];

for (const size of batches) {
  const usage = createUsageAccumulator();
  const executor = new CleanupLlmExecutor({ client: asObservableLlmClient(client, "llm.cleanup"), usage, breaker: new CircuitBreaker(settings.cleanupDeepPass.reliability.circuitBreakerThreshold) });
  const infer = createEntityRegisterInferFn(executor);
  const plan = planEntityRegisterBatches(rows, { allowedTypes, batchSize: size, perCallInputCap });
  const results = new Map<number, EntityRegisterAiResult>();
  let formatErrors = 0;
  const formatErrorReasons: string[] = [];
  // 묶음 밖 메모 번호로 온 답·같은 메모에 둘 이상 온 답 — 버리고 세어 결과에 남긴다(조용히 덮어쓰지 않는다).
  let strayAnswers = 0;
  let duplicateAnswers = 0;
  const started = Date.now();
  for (const group of plan.batches) {
    const res = await infer({ memos: group.map((r) => ({ nodeId: r.nodeId, content: r.content, createdAt: r.createdAt, alreadyLinked: r.alreadyLinked })), allowedTypes });
    if (res.kind === "ok") {
      const got = collectBatchAnswers(group.map((r) => r.nodeId), res.parsed);
      for (const [nodeId, r] of got.accepted) results.set(nodeId, r);
      strayAnswers += got.strayAnswers;
      duplicateAnswers += got.duplicateAnswers;
      continue;
    }
    if (res.kind === "deterministic") {
      // 형식 오류 — 이 묶음의 메모는 답이 없는 것으로 센다(쪼개 다시 시도하지 않는다).
      formatErrors += 1;
      formatErrorReasons.push(res.reason);
      continue;
    }
    throw new Error(`평가 중단 (묶음 ${size}) — ${res.kind}: ${"reason" in res ? res.reason : res.detail}`);
  }
  const durationMs = Date.now() - started;
  console.log(`묶음 ${size}: 묶음 밖 메모 번호로 온 답 ${strayAnswers}개, 같은 메모에 겹쳐 온 답 ${duplicateAnswers}개를 버림`);
  const missingIds: number[] = [];
  const scores: CaseScore[] = [];
  const judgements: MemoJudgement[] = [];
  for (const c of fixture.cases) {
    const r = results.get(c.id);
    if (r === undefined) {
      // 답이 빠진 메모(형식 오류·누락·호출당 상한 초과)는 빈 답으로 채점하지 않고 오류로 센다.
      missingIds.push(c.id);
      scores.push(scoreMissing(c));
      continue;
    }
    scores.push(scoreCase(c, r));
    judgements.push(judgeMemo({
      memo: { nodeId: c.id, content: c.text, createdAt: c.createdAt, alreadyLinked: [] }, result: r, index,
      allowedTypes: new Set(allowedTypes), ignoredNames: new Set(), scheduleIgnored: false, activeSchedule: null,
      // 평가 자료는 DB 없이 새 메모 한 개를 본다 — 메모 날짜 칸은 비어 있고 무시 기록도 없는 상태로 판정한다.
      memoEventAt: { found: true, eventAt: null, source: null }, memoDateIgnored: false, autoApply: true, profile,
    }));
  }
  const sum = summarize(scores, judgements);
  writeFileSync(join(out, `entity-register-eval-batch${size}.json`), JSON.stringify({
    size, model, sum, scores, judgements, usage, formatErrors, formatErrorReasons, missingIds, strayAnswers, duplicateAnswers,
    oversizedIds: plan.oversized.map((r) => r.nodeId), durationMs,
  }, null, 2));
  lines.push(`| ${size} | ${sum.hits}/${sum.required} | ${sum.extra} | ${sum.forbiddenHit} | ${sum.scheduleOk}/${sum.scheduleScored} | ${sum.decisions.auto}/${sum.decisions.propose}/${sum.decisions.discard} | ${formatErrors} | ${missingIds.length} | ${strayAnswers}/${duplicateAnswers} | ${usage.totalCalls} | ${usage.inputTokens} | ${usage.outputTokens} | ${durationMs} |`);
}
writeFileSync(join(out, "summary.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
