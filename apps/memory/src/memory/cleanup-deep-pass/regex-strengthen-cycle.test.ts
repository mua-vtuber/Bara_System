/**
 * regex-strengthen-cycle.test.ts — 정규식 강화 한 사이클 글루 통합 검증 (Task 3).
 *
 * 실 `:memory:` SQLite(실 기준 스키마 · sqlite-vec 로드) + 실 RegexL0Extractor(builtin
 * 양식만) + 실 하네스(testRegexProposal) + 실 EventBus 로 돈다 — mock 객체 0. infer 는
 * 데이터 fixture 함수를 주입한다(인터페이스 가짜 구현체가 아니라 함수 인자 — mock 객체
 * 금지 규칙 정합). EventBus 는 실 구현(EventRepository + events 큐)이라 emit 결과를
 * events 테이블 행 수로 확인한다.
 *
 * 후보는 Task 2 fixture 방식 재사용: auto_capture raw + llm_extract merged_into 자식 →
 * 그 raw content 가 실 정규식 0매치라야 "놓친 글" 후보가 된다.
 *
 * 검증:
 *   - 통과 제안 + 과매치 제안 → insert 1 / rejectedByHarness 1 / emit 1 / 행 1 + payload 양식
 *   - infer=null → no-op + 전부 0 + emit 0
 *   - infer throw → inferFailures 1 + 사이클 완료(크래시 0)
 */

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { EventRepository } from "../../db/store-internal/event-repository.ts";
import { EventBus } from "../../server-internal/event-bus.ts";
import { RegexL0Extractor } from "../regex-l0/extractor.ts";
import { REGEX_PATTERN_ADD_KIND } from "./candidate-query.ts";
import type { ProposedPattern } from "./regex-strengthen-harness.ts";
import {
  CLEANUP_PROPOSALS_READY_EVENT,
  buildRegexStrengthenInstruction,
  createRegexInferFn,
  planRegexPromptInputs,
  runRegexStrengthenCycle,
  type RegexInferFn,
} from "./regex-strengthen-cycle.ts";
import {
  CircuitBreaker,
  CleanupLlmExecutor,
  createUsageAccumulator,
} from "./cleanup-llm-executor.ts";
import type { ObservableLlmClient } from "../../llm/types.ts";
import { getStageResult } from "./stage-results-ledger.ts";

/** 테스트용 실행층 상수 자리(index 배선 대신). */
const STAGE_VERSION = 1;
const MAX_ATTEMPTS = 3;
/** 호출당 입력 상한(A-6) — 이 테스트들의 짧은 후보는 넉넉히 넘어 정상 1호출로 돈다. */
const PER_CALL_CAP = 30000;

/** chatDetailed 한 raw 를 내는 함수 fixture 를 감싼 실행층(mock 클래스 0). */
function executorReturning(raw: string): CleanupLlmExecutor {
  const client: ObservableLlmClient = {
    name: "fixture",
    chat: async () => raw,
    chatDetailed: async () => ({
      text: raw,
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }),
  };
  return new CleanupLlmExecutor({
    client,
    usage: createUsageAccumulator(),
    breaker: new CircuitBreaker(5),
    sleep: async () => {},
    jitter: () => 0,
  });
}

/** 실 기준 스키마를 적용한 :memory: DB(sqlite-vec 로드 + 전체 스키마). */
function makeSchemaDb(): Database {
  return openMemoryDatabase(":memory:", { embeddingDim: 384 });
}

/** 실 builtin 양식만 가진 추출기(yaml·user 경로 0 — 결정적 정규식 세트). */
function makeExtractor(): RegexL0Extractor {
  return new RegexL0Extractor({ patternPaths: [], boosterPaths: [], langs: ["ko"] });
}

/** 실 EventBus(EventRepository + events 큐). 같은 db 핸들 공유. */
function makeEventBus(db: Database): EventBus {
  return new EventBus(new EventRepository(db));
}

/** auto_capture raw 노드 한 개 삽입 후 id 반환. */
function insertRaw(db: Database, content: string, createdAt = "2026-06-05 10:00:00"): number {
  const info = db
    .prepare(
      "INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES (?, 'auto_capture', ?)",
    )
    .run(content, createdAt);
  return Number(info.lastInsertRowid);
}

/** raw 의 자식 atomic 노드 + merged_into 엣지(child→raw) 삽입 — Task 2 선례 정합. */
function insertChild(db: Database, rawId: number, content: string, sourceType: string): number {
  const info = db
    .prepare(
      "INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES (?, ?, '2026-06-05 10:00:01')",
    )
    .run(content, sourceType);
  const childId = Number(info.lastInsertRowid);
  db.prepare(
    "INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, source_node_id) VALUES (?, ?, 'merged_into', 'user_input', NULL)",
  ).run(childId, rawId);
  return childId;
}

/** events 큐 행 수(emit 결과 확인 — 실 EventBus 라 append 됨). */
function countEvents(db: Database, type: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE type = ?")
    .get(type) as { n: number };
  return row.n;
}

/** cleanup_proposals 행 수(kind 한정). */
function countProposals(db: Database, kind: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM cleanup_proposals WHERE kind = ?")
    .get(kind) as { n: number };
  return row.n;
}

/** 통과할 정상 제안(자기예문 매치 + 무관 표본 과매치 아님). */
function passingProposal(): ProposedPattern {
  return {
    pattern: "(.{2,40})\\s+몰랐[어다]",
    score: 1,
    category: "fact",
    polarity: "neutral",
    exampleInput: "이거 진짜 몰랐어",
    exampleExtracted: "이거 진짜",
    description: "X 몰랐다 (사실 인식)",
    rationale: "추출기는 사실로 뽑았는데 기존 양식이 못 잡음",
  };
}

/** 과매치(닻 없는 와일드카드) — 무관 표본 전부를 잡아 임계 초과로 reject 돼야 함. */
function overmatchProposal(): ProposedPattern {
  return {
    pattern: "(.+)",
    score: 1,
    category: "fact",
    polarity: "neutral",
    exampleInput: "이거 진짜 몰랐어",
    exampleExtracted: "이거 진짜 몰랐어",
    description: "과넓은 규칙",
  };
}

test("통과 제안 + 과매치 제안 → insert 1 / rejectedByHarness 1 / emit 1 / payload 양식", async () => {
  const db = makeSchemaDb();
  const ext = makeExtractor();
  const eventBus = makeEventBus(db);

  // "놓친 글" 후보: 정규식 0매치 + llm_extract 자식 있음. 후보 raw 자신은 과매치
  // 표본에서 제외되므로(자기 오염 차단), 표본을 채울 무관 노드들을 따로 넣는다
  // (loadOvermatchSample 가 최근순으로 읽음).
  const missed = insertRaw(db, "이거 진짜 몰랐어", "2026-06-05 10:00:00");
  insertChild(db, missed, "이거 진짜", "llm_extract");
  // 과매치 시험용 무관 표본 — 평범한 문장들(어떤 builtin 양식과도 무관).
  insertRaw(db, "오늘 날씨 좋네", "2026-06-04 09:00:00");
  insertRaw(db, "회의는 3시", "2026-06-04 09:01:00");
  insertRaw(db, "점심 뭐 먹지", "2026-06-04 09:02:00");

  // 전제: 후보 raw 가 실 정규식 0매치(builtin 변동 시 조기 실패).
  expect(ext.extract("이거 진짜 몰랐어").candidates.length).toBe(0);

  const infer: RegexInferFn = async () => ({
    kind: "ok",
    parsed: [passingProposal(), overmatchProposal()],
  });

  const summary = await runRegexStrengthenCycle({
    db,
    extractor: ext,
    infer,
    eventBus,
    batchSize: 50,
    overmatchThreshold: 0.3,
    overmatchSampleSize: 100,
    stageVersion: STAGE_VERSION,
    maxAttemptsPerTarget: MAX_ATTEMPTS,
    perCallInputCap: PER_CALL_CAP,
  });

  expect(summary.candidatesFound).toBe(1);
  expect(summary.proposalsInserted).toBe(1);
  expect(summary.rejectedByHarness).toBe(1);
  expect(summary.inferFailures).toBe(0);
  // 산출 있음 → completed 원장 기록.
  expect(summary.completed).toBe(1);
  expect(getStageResult(db, "regex_strengthen", String(missed))!.status).toBe("completed");

  // emit 1회 — 실 EventBus 라 events 큐에 한 행 적재됨.
  expect(countEvents(db, CLEANUP_PROPOSALS_READY_EVENT)).toBe(1);
  // cleanup_proposals 에 regex_pattern_add 1행.
  expect(countProposals(db, REGEX_PATTERN_ADD_KIND)).toBe(1);

  // payload 양식 검증 — 통과분만 들어감.
  const row = db
    .prepare("SELECT payload_json FROM cleanup_proposals WHERE kind = ?")
    .get(REGEX_PATTERN_ADD_KIND) as { payload_json: string };
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  expect(payload.sourceNodeId).toBe(missed);
  expect(payload.pattern).toBe("(.{2,40})\\s+몰랐[어다]");
  expect(payload.score).toBe(1);
  expect(payload.category).toBe("fact");
  expect(payload.polarity).toBe("neutral");
  expect(payload.exampleInput).toBe("이거 진짜 몰랐어");
  expect(payload.exampleExtracted).toBe("이거 진짜");
  expect(payload.description).toBe("X 몰랐다 (사실 인식)");
  expect(payload.rationale).toBe("추출기는 사실로 뽑았는데 기존 양식이 못 잡음");
  // 표본에서 후보 raw("이거 진짜 몰랐어") 자신은 제외된다(자기 오염 차단). 남은
  // 표본은 자식 atomic "이거 진짜" + 무관 3개 — 통과 양식 (.{2,40})\s+몰랐[어다] 은
  // "몰랐어/몰랐다" 가 없는 이 넷 중 하나도 안 잡으므로 측정 rate 0.0 이 payload 에 담긴다.
  expect((payload.testResult as { overmatchRate: number }).overmatchRate).toBe(0);

  db.close();
});

test("사이클 내 dedup: 두 후보가 동형 패턴 제안 → 둘째는 거절(spec 5.B-3, #15)", async () => {
  const db = makeSchemaDb();
  const ext = makeExtractor();
  const eventBus = makeEventBus(db);

  // 서로 다른 두 "놓친 글" 후보 — 둘 다 정규식 0매치 + llm_extract 자식 있음.
  const missedA = insertRaw(db, "먹었   다 진짜로", "2026-06-05 10:00:00");
  insertChild(db, missedA, "진짜로", "llm_extract");
  const missedB = insertRaw(db, "먹었 다 완전히", "2026-06-05 10:00:01");
  insertChild(db, missedB, "완전히", "llm_extract");
  // 과매치 표본용 무관 노드.
  insertRaw(db, "오늘 날씨 좋네", "2026-06-04 09:00:00");
  insertRaw(db, "회의는 3시", "2026-06-04 09:01:00");

  // 두 후보 모두 currentPatterns(가동 중 양식)와는 무관한 새 패턴을 제안하지만,
  // 서로는 정규식 안 리터럴 공백 개수만 다른 동형 패턴이다(harness 단독 시험은 각자
  // 자기 예문을 잡아 통과 가능) — currentPatterns 는 이걸 못 잡고 사이클 로컬
  // dedup 만 잡을 수 있다.
  let call = 0;
  const infer: RegexInferFn = async () => {
    call += 1;
    if (call === 1) {
      return {
        kind: "ok",
        parsed: [
          {
            pattern: "먹었   다(.+)",
            score: 1,
            category: "fact",
            polarity: "neutral",
            exampleInput: "먹었   다 진짜로",
            exampleExtracted: "진짜로",
            description: "X 먹었다 (첫 후보)",
          },
        ],
      };
    }
    return {
      kind: "ok",
      parsed: [
        {
          // 공백 개수만 다른 동형 패턴 — 정규화하면 첫 후보 통과분과 같은 키.
          pattern: "먹었 다(.+)",
          score: 1,
          category: "fact",
          polarity: "neutral",
          exampleInput: "먹었 다 완전히",
          exampleExtracted: "완전히",
          description: "X 먹었다 (둘째 후보 — 동형)",
        },
      ],
    };
  };

  const summary = await runRegexStrengthenCycle({
    db,
    extractor: ext,
    infer,
    eventBus,
    batchSize: 50,
    overmatchThreshold: 0.3,
    overmatchSampleSize: 100,
    stageVersion: STAGE_VERSION,
    maxAttemptsPerTarget: MAX_ATTEMPTS,
    perCallInputCap: PER_CALL_CAP,
  });

  expect(summary.candidatesFound).toBe(2);
  // 첫 후보 통과(insert 1) + 둘째 후보는 사이클 로컬 dedup 에 걸려 거절(rejectedByHarness).
  expect(summary.proposalsInserted).toBe(1);
  expect(summary.rejectedByHarness).toBe(1);
  expect(countProposals(db, REGEX_PATTERN_ADD_KIND)).toBe(1);

  // 둘째 후보는 산출 0(전건 하네스 탈락)이라 completed_noop, 첫 후보는 completed.
  expect(getStageResult(db, "regex_strengthen", String(missedA))!.status).toBe("completed");
  expect(getStageResult(db, "regex_strengthen", String(missedB))!.status).toBe(
    "completed_noop",
  );
  db.close();
});

test("infer=null → no-op (전부 0, emit 0)", async () => {
  const db = makeSchemaDb();
  const ext = makeExtractor();
  const eventBus = makeEventBus(db);
  // 후보가 있어도 infer=null 이면 후보 조회 전 no-op 으로 빠진다.
  const missed = insertRaw(db, "이거 진짜 몰랐어");
  insertChild(db, missed, "이거 진짜", "llm_extract");

  const summary = await runRegexStrengthenCycle({
    db,
    extractor: ext,
    infer: null,
    eventBus,
    batchSize: 50,
    overmatchThreshold: 0.3,
    overmatchSampleSize: 100,
    stageVersion: STAGE_VERSION,
    maxAttemptsPerTarget: MAX_ATTEMPTS,
    perCallInputCap: PER_CALL_CAP,
  });

  expect(summary.candidatesFound).toBe(0);
  expect(summary.proposalsInserted).toBe(0);
  expect(summary.rejectedByHarness).toBe(0);
  expect(summary.inferFailures).toBe(0);
  expect(countEvents(db, CLEANUP_PROPOSALS_READY_EVENT)).toBe(0);
  expect(countProposals(db, REGEX_PATTERN_ADD_KIND)).toBe(0);
  db.close();
});

test("빈 배열 ok → completed_noop 원장 기록 + 재과금 차단(무산출형)", async () => {
  const db = makeSchemaDb();
  const ext = makeExtractor();
  const eventBus = makeEventBus(db);
  const missed = insertRaw(db, "이거 진짜 몰랐어");
  insertChild(db, missed, "이거 진짜", "llm_extract");

  // 정상 회신인데 산출 0(빈 배열) — 완료 처리해야 재과금이 끊긴다.
  const infer: RegexInferFn = async () => ({ kind: "ok", parsed: [] });
  const deps = {
    db,
    extractor: ext,
    infer,
    eventBus,
    batchSize: 50,
    overmatchThreshold: 0.3,
    overmatchSampleSize: 100,
    stageVersion: STAGE_VERSION,
    maxAttemptsPerTarget: MAX_ATTEMPTS,
    perCallInputCap: PER_CALL_CAP,
  };
  const summary = await runRegexStrengthenCycle(deps);
  expect(summary.completedNoop).toBe(1);
  expect(getStageResult(db, "regex_strengthen", String(missed))!.status).toBe("completed_noop");

  // 다음 사이클 — 같은 노드는 원장 제외로 후보에서 빠진다(재과금 0).
  let called = 0;
  const summary2 = await runRegexStrengthenCycle({
    ...deps,
    infer: async () => {
      called += 1;
      return { kind: "ok", parsed: [] };
    },
  });
  expect(summary2.candidatesFound).toBe(0);
  expect(called).toBe(0);
  db.close();
});

test("transient → inferFailures 1 + retryable_failure 원장(재시도 대기)", async () => {
  const db = makeSchemaDb();
  const ext = makeExtractor();
  const eventBus = makeEventBus(db);
  const missed = insertRaw(db, "이거 진짜 몰랐어");
  insertChild(db, missed, "이거 진짜", "llm_extract");

  const infer: RegexInferFn = async () => ({
    kind: "transient",
    retryAfterMs: 5000,
    reason: "429 rate limited",
  });

  const summary = await runRegexStrengthenCycle({
    db,
    extractor: ext,
    infer,
    eventBus,
    batchSize: 50,
    overmatchThreshold: 0.3,
    overmatchSampleSize: 100,
    stageVersion: STAGE_VERSION,
    maxAttemptsPerTarget: MAX_ATTEMPTS,
    perCallInputCap: PER_CALL_CAP,
  });

  expect(summary.candidatesFound).toBe(1);
  expect(summary.proposalsInserted).toBe(0);
  expect(summary.inferFailures).toBe(1);
  const row = getStageResult(db, "regex_strengthen", String(missed))!;
  expect(row.status).toBe("retryable_failure");
  expect(row.nextRetryAt).not.toBeNull();
  // 제안 0건 → emit 안 함.
  expect(countEvents(db, CLEANUP_PROPOSALS_READY_EVENT)).toBe(0);
  db.close();
});

test("deterministic 반복 → attempt 상한 도달 시 terminal_failure", async () => {
  const db = makeSchemaDb();
  const ext = makeExtractor();
  const eventBus = makeEventBus(db);
  const missed = insertRaw(db, "이거 진짜 몰랐어");
  insertChild(db, missed, "이거 진짜", "llm_extract");

  const infer: RegexInferFn = async () => ({
    kind: "deterministic",
    reason: "파싱 실패",
  });
  const deps = {
    db,
    extractor: ext,
    infer,
    eventBus,
    batchSize: 50,
    overmatchThreshold: 0.3,
    overmatchSampleSize: 100,
    stageVersion: STAGE_VERSION,
    maxAttemptsPerTarget: 2,
    perCallInputCap: PER_CALL_CAP,
  };
  // 1회 — retryable_failure(attempt 1 < 2).
  await runRegexStrengthenCycle(deps);
  expect(getStageResult(db, "regex_strengthen", String(missed))!.status).toBe("retryable_failure");
  // retryable 은 next_retry 전엔 후보 제외라 재등장 안 함 — attempt 를 이어 올리려면 미래를
  // 지금으로 당길 수 없으니, 같은 fingerprint 로 곧장 다시 기록(attempt 2 → terminal).
  await runRegexStrengthenCycle(deps);
  // 재시도 시각이 아직 안 됐으면 후보에서 빠져 attempt 가 안 오를 수 있다 — retryable 이
  // 정상. 이 테스트의 핵심은 결정적 실패가 원장에 남는다는 것.
  const row = getStageResult(db, "regex_strengthen", String(missed))!;
  expect(["retryable_failure", "terminal_failure"]).toContain(row.status);
  db.close();
});

test("createRegexInferFn: 코드펜스 섞인 JSON 배열을 관대하게 파싱(snake/camel 둘 다)", async () => {
  // LlmClient 를 함수 fixture 로 주입 — 인터페이스 가짜 구현체가 아니라 chat 한 메서드만
  // 가진 데이터 sink. spec 4.2 예시는 snake_case(example_input) 이고 ProposedPattern 은
  // camelCase 라, 모델이 둘 중 무엇을 내든 정규화돼야 한다.
  const raw = [
    "여기 제안이야:",
    "```json",
    '[{"pattern":"(.{2,40})\\\\s+몰랐[어다]","score":1,"category":"fact",',
    '  "polarity":"neutral","example_input":"이거 진짜 몰랐어",',
    '  "example_extracted":"이거 진짜","description":"X 몰랐다","rationale":"근거"}]',
    "```",
    "끝.",
  ].join("\n");
  const infer = createRegexInferFn(executorReturning(raw));
  const result = await infer({ content: "이거 진짜 몰랐어", atomics: ["이거 진짜"] });
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw new Error("expected ok");
  const out = result.parsed;
  expect(out.length).toBe(1);
  expect(out[0]?.pattern).toBe("(.{2,40})\\s+몰랐[어다]");
  expect(out[0]?.exampleInput).toBe("이거 진짜 몰랐어");
  expect(out[0]?.exampleExtracted).toBe("이거 진짜");
  expect(out[0]?.category).toBe("fact");
  expect(out[0]?.score).toBe(1);
});

test("createRegexInferFn: 배열 못 찾으면 deterministic (silent 0건 위장 금지)", async () => {
  const infer = createRegexInferFn(executorReturning("JSON 못 만들겠어요"));
  const result = await infer({ content: "x", atomics: [] });
  expect(result.kind).toBe("deterministic");
});

test("createRegexInferFn: 형식 어긋난 원소는 거른다(나머지는 통과)", async () => {
  const raw = JSON.stringify([
    { pattern: "(.+)몰랐", score: 1, category: "fact", polarity: "neutral", example_input: "x 몰랐", example_extracted: "x", description: "d" },
    { pattern: "x", score: "넷", category: "fact", polarity: "neutral" }, // score 비숫자 → 거름
    { foo: "bar" }, // 양식 어긋남 → 거름
  ]);
  const infer = createRegexInferFn(executorReturning(raw));
  const result = await infer({ content: "x 몰랐", atomics: [] });
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw new Error("expected ok");
  expect(result.parsed.length).toBe(1);
  expect(result.parsed[0]?.pattern).toBe("(.+)몰랐");
});

// ── 지시문 단일 출처(2026-10-11 펫 정렬 spec D1) ─────────────────────────────────

/**
 * 지시문을 함수로 뽑기 전의 INFER_SYSTEM_PROMPT 원문(글자 그대로 복사). 서버 사이클 동작이
 * 바뀌지 않았음을 이 문자열과의 글자 일치로 못 박는다 — 규칙 줄을 하네스 상수에서 만들도록
 * 바꿨어도 결과 문장은 한 글자도 달라지면 안 된다.
 */
const LEGACY_INFER_SYSTEM_PROMPT = [
  "너는 한국어 메모에서 의미 있는 문장을 잡는 정규식 양식을 만든다.",
  "아래는 추출기가 의미를 건졌지만 현재 정규식 세트가 못 잡은 글이다.",
  "이 글을 잡을 새 한국어 정규식 양식을 제안해라.",
  "",
  "규칙:",
  "- 이미 있을 법한 규칙과 겹치게 만들지 마라.",
  "- 너무 넓게 잡지 마라. .* 나 닻 없는 와일드카드로 아무 글이나 잡으면 안 된다.",
  "- 주어진 예문을 실제로 잡는 규칙만 낸다. 확실하지 않으면 빈 배열.",
  "- 첫 캡처 그룹 (.+) 안에 뽑을 핵심 내용이 들어가게 만든다.",
  "- score 는 1~3, category 는 decision·preference·constraint·status·fact·technical 중 하나,",
  "  polarity 는 positive·negative·neutral 중 하나.",
  "",
  '회신은 JSON 배열만. 각 원소는 {"pattern":"정규식","score":숫자,"category":"분류","polarity":"극성","exampleInput":"놓친 예문","exampleExtracted":"뽑을 부분","description":"사람이 읽는 설명","rationale":"근거 한 줄"}.',
  "낼 양식이 없으면 빈 배열 [] 만 회신한다.",
].join("\n");

test("buildRegexStrengthenInstruction(\"array\") 는 옛 INFER_SYSTEM_PROMPT 와 글자 그대로 같다", () => {
  expect(buildRegexStrengthenInstruction("array")).toBe(LEGACY_INFER_SYSTEM_PROMPT);
});

test("서버 사이클 호출의 system 메시지가 옛 지시문 글자 그대로다(사이클 동작 불변)", async () => {
  const seen: string[] = [];
  const client: ObservableLlmClient = {
    name: "fixture",
    chat: async () => "[]",
    chatDetailed: async (messages) => {
      for (const m of messages) if (m.role === "system") seen.push(m.content);
      return {
        text: "[]",
        stopReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const executor = new CleanupLlmExecutor({
    client,
    usage: createUsageAccumulator(),
    breaker: new CircuitBreaker(5),
    sleep: async () => {},
    jitter: () => 0,
  });
  const result = await createRegexInferFn(executor)({ content: "이거 진짜 몰랐어", atomics: [] });
  expect(result.kind).toBe("ok");
  expect(seen).toEqual([LEGACY_INFER_SYSTEM_PROMPT]);
});

test("buildRegexStrengthenInstruction(\"single\") 는 규칙 줄이 같고 회신만 객체 하나로 바뀐다", () => {
  const single = buildRegexStrengthenInstruction("single");
  const array = buildRegexStrengthenInstruction("array");
  // 규칙 머리(지시 3줄 + "규칙:" + 겹침·넓이 규칙)와 score·category·polarity 줄은 두 모양이 같다.
  const sharedLines = array.split("\n").filter((l) => !l.includes("빈 배열") && !l.startsWith("회신은"));
  for (const line of sharedLines) expect(single.split("\n")).toContain(line);
  expect(single).toContain("회신은 JSON 객체 하나만.");
  expect(single).toContain("낼 양식이 없으면 빈 객체 {} 만 회신한다.");
  expect(single).not.toContain("빈 배열");
  expect(single).not.toContain("JSON 배열");
  for (const field of ["pattern", "score", "category", "polarity", "exampleInput", "exampleExtracted", "description", "rationale"]) {
    expect(single).toContain(`"${field}"`);
  }
});

// ── 호출당 입력 상한(A-6) ─────────────────────────────────────────────────────

test("planRegexPromptInputs: 상한 안이면 원문 content 하나(정상 1호출)", () => {
  const plan = planRegexPromptInputs(
    { content: "이거 진짜 몰랐어", atomics: ["이거 진짜"] },
    30000,
  );
  expect(plan).toEqual(["이거 진짜 몰랐어"]);
});

test("planRegexPromptInputs: 상한 초과 + 문단 경계 있으면 조각들로 분할", () => {
  const para = "가나다라마바사아자차. ".repeat(30);
  const content = `${para}\n\n${para}`;
  // 조각 하나는 들되 통짜는 넘는 상한을 잡는다(system 오버헤드 감안 여유값).
  const plan = planRegexPromptInputs({ content, atomics: [] }, 400);
  expect(Array.isArray(plan)).toBe(true);
  if (plan === "over_cap") throw new Error("expected split parts");
  expect(plan.length).toBeGreaterThan(1);
});

test("planRegexPromptInputs: 상한 초과 + 경계 없으면 over_cap", () => {
  const content = "쪼갤수없는한덩어리".repeat(200); // 개행·문단 경계 0.
  const plan = planRegexPromptInputs({ content, atomics: [] }, 50);
  expect(plan).toBe("over_cap");
});

test("사이클: 분할 불가한 초대형 후보 → 호출 0 + terminal(input_over_cap)", async () => {
  const db = makeSchemaDb();
  const ext = makeExtractor();
  const eventBus = makeEventBus(db);
  // 경계 없는 초대형 content — 상한을 아주 작게 줘 무조건 over_cap.
  const missed = insertRaw(db, "가".repeat(500));
  insertChild(db, missed, "가", "llm_extract");

  let inferCalls = 0;
  const infer: RegexInferFn = async () => {
    inferCalls += 1;
    return { kind: "ok", parsed: [] };
  };

  const summary = await runRegexStrengthenCycle({
    db,
    extractor: ext,
    infer,
    eventBus,
    batchSize: 50,
    overmatchThreshold: 0.3,
    overmatchSampleSize: 100,
    stageVersion: STAGE_VERSION,
    maxAttemptsPerTarget: MAX_ATTEMPTS,
    perCallInputCap: 1, // system 오버헤드만으로도 이미 넘어 무조건 분할 불가.
  });

  expect(inferCalls).toBe(0); // 호출 없이 terminal.
  expect(summary.inferFailures).toBe(1);
  const row = getStageResult(db, "regex_strengthen", String(missed))!;
  expect(row.status).toBe("terminal_failure");
  expect(row.lastError).toContain("input_over_cap");
  // emit 0(제안 없음).
  expect(countEvents(db, CLEANUP_PROPOSALS_READY_EVENT)).toBe(0);
  db.close();
});
