/**
 * person-link-infer-cycle.test.ts — 데이터 정리 AI 기존 사람 연결 사이클 검증.
 *
 * 실 SQLite + 실 SqliteMemoryStore + 실 EventBus. LLM 은 데이터 fixture 응답 함수만
 * 주입한다. 검증 초점은 새 사람 생성 금지, 기존 personId 검증, confidence 기준
 * 자동 연결/proposal 분기, 멱등성이다.
 */

import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { createEmbedder, embeddingDimensionOf } from "../embedding/factory.ts";
import type { Embedder } from "../embedding/types.ts";
import { EventRepository } from "../db/store-internal/event-repository.ts";
import { EventBus } from "../server-internal/event-bus.ts";
import {
  CLEANUP_PROPOSALS_READY_EVENT,
  PERSON_LINK_KIND,
  estimatePersonLinkNodeTokens,
  parsePersonLinkResponse,
  personLinkFixedOverheadTokens,
  runPersonLinkInferCycle,
  type PersonLinkDecision,
  type PersonLinkInferCycleDeps,
  type PersonLinkInferFn,
  type PersonLinkInferInput,
  type PersonLinkNodeContext,
  type PersonLinkPersonContext,
} from "./person-link-infer-cycle.ts";
import { getStageResult } from "./cleanup-deep-pass/stage-results-ledger.ts";

/** 실행층 경유 계약 상수(index 배선 대신). */
const STAGE_VERSION = 1;
const MAX_ATTEMPTS = 3;

const MODEL = "bge-m3";

let embedder: Embedder;
let db: Database;
let store: SqliteMemoryStore;
let events: EventRepository;
let eventBus: EventBus;

beforeAll(async () => {
  embedder = createEmbedder({ model: MODEL });
  await embedder.load();
});

beforeEach(() => {
  db = openMemoryDatabase(":memory:", {
    embeddingDim: embeddingDimensionOf(MODEL),
  });
  store = new SqliteMemoryStore(db, embedder);
  events = new EventRepository(db);
  eventBus = new EventBus(events);
});

afterEach(() => {
  db.close();
});

async function addMemo(
  content: string,
  personCandidates: string[] = [],
): Promise<number> {
  return store.addNode({
    content,
    sourceType: "llm_extract",
    metadata:
      personCandidates.length > 0 ? { personCandidates } : undefined,
  });
}

function fixtureInfer(
  responder: (input: PersonLinkInferInput) => PersonLinkDecision[],
): { fn: PersonLinkInferFn; calls: PersonLinkInferInput[] } {
  const calls: PersonLinkInferInput[] = [];
  // 실행층 경유 계약 — responder 가 낸 결정 배열을 ok StageInferResult 로 감싼다.
  const fn: PersonLinkInferFn = async (input) => {
    calls.push(input);
    return { kind: "ok", parsed: responder(input) };
  };
  return { fn, calls };
}

/** 공통 deps 조립 — stageVersion·maxAttemptsPerTarget 를 매 호출에 채워 넣는다. */
function deps(
  overrides: Pick<PersonLinkInferCycleDeps, "infer"> &
    Partial<PersonLinkInferCycleDeps>,
): PersonLinkInferCycleDeps {
  return {
    db,
    store,
    eventBus,
    batchSize: 20,
    stageVersion: STAGE_VERSION,
    maxAttemptsPerTarget: MAX_ATTEMPTS,
    // A-6 호출당 입력 상한 — 기본은 넉넉히 커 짧은 노드는 한 배치로 돈다. microbatch·
    // input_over_cap 테스트는 override 로 작은 값을 넣는다.
    perCallInputCap: 30000,
    ...overrides,
  };
}

function listPersonLinkProposals(): Array<{
  status: string;
  payload: Record<string, unknown>;
}> {
  const rows = db
    .prepare(
      "SELECT status, payload_json FROM cleanup_proposals WHERE kind = ? ORDER BY rowid ASC",
    )
    .all(PERSON_LINK_KIND) as Array<{ status: string; payload_json: string }>;
  return rows.map((r) => ({
    status: r.status,
    payload: JSON.parse(r.payload_json) as Record<string, unknown>,
  }));
}

function personCount(): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM persons").get() as { c: number }).c;
}

describe("runPersonLinkInferCycle — 생성 금지와 graceful", () => {
  test("기존 사람이 없으면 LLM 호출 없이 no-op, person row 생성 0", async () => {
    await addMemo("디롱이는 디스코드 봇 캐릭터다.", ["디롱이"]);
    const infer = fixtureInfer(() => []);

    const summary = await runPersonLinkInferCycle(deps({ infer: infer.fn }));

    expect(infer.calls).toHaveLength(0);
    expect(summary.peopleLoaded).toBe(0);
    expect(personCount()).toBe(0);
    expect(listPersonLinkProposals()).toHaveLength(0);
  });

  test("infer=null 이면 no-op", async () => {
    await store.findOrCreatePersonByName("민수");
    await addMemo("민수를 만났다.", ["민수"]);

    const summary = await runPersonLinkInferCycle(deps({ infer: null }));

    expect(summary.autoLinked).toBe(0);
    expect(summary.proposalsInserted).toBe(0);
    expect(events.listRecent()).toHaveLength(0);
  });
});

describe("runPersonLinkInferCycle — confidence 분기", () => {
  test("confidence >= 0.90 + 유효 후보 1명 → 자동 mentions 연결", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const nodeId = await addMemo("민수와 회의했다.", ["민수"]);
    const infer = fixtureInfer((input) => {
      expect(input.nodes[0]?.personCandidates).toEqual(["민수"]);
      expect(input.people.map((p) => p.personId)).toContain(minsu.personId);
      return [
        {
          nodeId,
          personId: minsu.personId,
          confidence: 0.95,
          candidateText: "민수",
          evidence: "이름이 정확히 일치",
        },
      ];
    });

    const summary = await runPersonLinkInferCycle(deps({ infer: infer.fn }));

    expect(summary.autoLinked).toBe(1);
    expect(summary.proposalsInserted).toBe(0);
    expect(await store.listNodePersonEdges({ nodeId })).toMatchObject([
      { nodeId, personId: minsu.personId, relation: "mentions" },
    ]);
    expect(listPersonLinkProposals()).toHaveLength(0);
  });

  test("0.60 <= confidence < 0.90 → person_link proposal", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const nodeId = await addMemo("민수일 수도 있는 사람 이야기를 했다.", ["민수"]);
    const infer = fixtureInfer(() => [
      {
        nodeId,
        personId: minsu.personId,
        confidence: 0.72,
        candidateText: "민수",
        evidence: "이름은 맞지만 맥락 근거가 약함",
      },
    ]);

    const summary = await runPersonLinkInferCycle(deps({ infer: infer.fn }));

    expect(summary.autoLinked).toBe(0);
    expect(summary.proposalsInserted).toBe(1);
    expect(await store.listNodePersonEdges({ nodeId })).toHaveLength(0);
    const proposals = listPersonLinkProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.status).toBe("pending");
    expect(proposals[0]!.payload).toMatchObject({
      nodeId,
      personId: minsu.personId,
      confidence: 0.72,
      candidateText: "민수",
    });
    expect(events.listRecent()[0]?.type).toBe(CLEANUP_PROPOSALS_READY_EVENT);
    expect(events.listRecent()[0]?.payload).toEqual({
      count: 1,
      kind: PERSON_LINK_KIND,
    });
  });

  test("여러 유효 후보가 있으면 고신뢰여도 자동 연결하지 않고 proposal 로 남긴다", async () => {
    const a = await store.findOrCreatePersonByName("민수 A");
    await store.addPersonAlias(a.personId, "민수");
    const b = await store.findOrCreatePersonByName("민수 B");
    await store.addPersonAlias(b.personId, "민수");
    const nodeId = await addMemo("민수와 다시 이야기했다.", ["민수"]);
    const infer = fixtureInfer(() => [
      { nodeId, personId: a.personId, confidence: 0.95, candidateText: "민수" },
      { nodeId, personId: b.personId, confidence: 0.92, candidateText: "민수" },
    ]);

    const summary = await runPersonLinkInferCycle(deps({ infer: infer.fn }));

    expect(summary.autoLinked).toBe(0);
    expect(summary.proposalsInserted).toBe(2);
    expect(await store.listNodePersonEdges({ nodeId })).toHaveLength(0);
    expect(listPersonLinkProposals().map((p) => p.payload.personId).sort()).toEqual(
      [a.personId, b.personId].sort(),
    );
  });
});

describe("runPersonLinkInferCycle — autoApply 게이트 (spec 5.B-2)", () => {
  test("autoApply=false → conf>=0.9 확실 연결도 자동 쓰기 없이 제안 경유", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const nodeId = await addMemo("민수와 회의했다.", ["민수"]);
    const infer = fixtureInfer(() => [
      {
        nodeId,
        personId: minsu.personId,
        confidence: 0.95,
        candidateText: "민수",
        evidence: "이름이 정확히 일치",
      },
    ]);

    const summary = await runPersonLinkInferCycle(
      deps({ infer: infer.fn, autoApply: false }),
    );

    // 자동 연결 0 — 확실한 연결도 제안으로. mentions 엣지 자동 생성 안 됨.
    expect(summary.autoLinked).toBe(0);
    expect(summary.proposalsInserted).toBe(1);
    expect(await store.listNodePersonEdges({ nodeId })).toHaveLength(0);
    const proposals = listPersonLinkProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.payload).toMatchObject({
      nodeId,
      personId: minsu.personId,
      confidence: 0.95,
      // 자동 연결 대상이었으나 게이트로 보류됨을 카드가 드러낸다.
      autoApplyWithheld: true,
    });
    // 원장은 completed(산출 있음 — 제안 생성) → 재과금 안 됨.
    expect(getStageResult(db, "person_link", String(nodeId))?.status).toBe(
      "completed",
    );
  });

  test("autoApply=true → conf>=0.9 자동 mentions 연결(현행 동작 보존)", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const nodeId = await addMemo("민수와 회의했다.", ["민수"]);
    const infer = fixtureInfer(() => [
      {
        nodeId,
        personId: minsu.personId,
        confidence: 0.95,
        candidateText: "민수",
        evidence: "이름이 정확히 일치",
      },
    ]);

    const summary = await runPersonLinkInferCycle(
      deps({ infer: infer.fn, autoApply: true }),
    );

    expect(summary.autoLinked).toBe(1);
    expect(summary.proposalsInserted).toBe(0);
    expect(await store.listNodePersonEdges({ nodeId })).toMatchObject([
      { nodeId, personId: minsu.personId, relation: "mentions" },
    ]);
    expect(listPersonLinkProposals()).toHaveLength(0);
  });

  test("autoApply 무관 — 낮은 확신(0.6~0.9)은 언제나 제안 경유", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const nodeId = await addMemo("민수일 수도 있는 사람.", ["민수"]);
    const infer = fixtureInfer(() => [
      {
        nodeId,
        personId: minsu.personId,
        confidence: 0.72,
        candidateText: "민수",
        evidence: "맥락 근거 약함",
      },
    ]);

    // autoApply=true 여도 낮은 확신은 제안 — 자동 연결 대상 아님(autoApplyWithheld 표기 없음).
    const summary = await runPersonLinkInferCycle(
      deps({ infer: infer.fn, autoApply: true }),
    );

    expect(summary.autoLinked).toBe(0);
    expect(summary.proposalsInserted).toBe(1);
    const proposals = listPersonLinkProposals();
    expect(proposals[0]!.payload.autoApplyWithheld).toBeUndefined();
  });
});

describe("runPersonLinkInferCycle — 서버 검증", () => {
  test("없는 personId 또는 이름 문자열은 거부되고 새 사람을 만들지 않는다", async () => {
    await store.findOrCreatePersonByName("민수");
    const nodeId = await addMemo("디롱이는 앱 마스코트다.", ["디롱이"]);
    const infer = fixtureInfer(() => [
      {
        nodeId,
        personId: "디롱이",
        confidence: 0.99,
        candidateText: "디롱이",
      },
    ]);

    const summary = await runPersonLinkInferCycle(deps({ infer: infer.fn }));

    expect(summary.rejectedInvalid).toBe(1);
    expect(summary.autoLinked).toBe(0);
    expect(summary.proposalsInserted).toBe(0);
    expect(personCount()).toBe(1);
    expect(await store.listNodePersonEdges({ nodeId })).toHaveLength(0);
    expect(listPersonLinkProposals()).toHaveLength(0);
  });

  test("같은 사이클을 반복해도 결과 원장 제외 때문에 중복 edge 가 생기지 않는다", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const nodeId = await addMemo("민수를 만났다.", ["민수"]);
    const first = fixtureInfer(() => [
      { nodeId, personId: minsu.personId, confidence: 0.96 },
    ]);

    await runPersonLinkInferCycle(deps({ infer: first.fn }));
    expect(await store.listNodePersonEdges({ nodeId })).toHaveLength(1);
    // 자동 연결 노드는 결과 원장에 completed 로 남는다(무산출형 재과금 차단 + 재등장 제외).
    expect(getStageResult(db, "person_link", String(nodeId))!.status).toBe("completed");

    const second = fixtureInfer(() => [
      { nodeId, personId: minsu.personId, confidence: 0.96 },
    ]);
    const summary = await runPersonLinkInferCycle(deps({ infer: second.fn }));

    expect(second.calls).toHaveLength(0);
    expect(summary.candidatesFound).toBe(0);
    expect(await store.listNodePersonEdges({ nodeId })).toHaveLength(1);
  });

  test("실행층 transient → 입력 노드 전건 retryable_failure 원장 + inferFailures 1", async () => {
    await store.findOrCreatePersonByName("민수");
    const nodeId = await addMemo("민수를 만났다.", ["민수"]);
    const infer: PersonLinkInferFn = async () => ({
      kind: "transient",
      retryAfterMs: 3000,
      reason: "429 rate limited",
    });

    const summary = await runPersonLinkInferCycle(deps({ infer }));
    expect(summary.inferFailures).toBe(1);
    expect(summary.autoLinked).toBe(0);
    const row = getStageResult(db, "person_link", String(nodeId))!;
    expect(row.status).toBe("retryable_failure");
    expect(row.nextRetryAt).not.toBeNull();
  });

  test("명시적 빈 값 결정(personId=null) → completed_noop 원장 + 다음 사이클 재과금 0", async () => {
    await store.findOrCreatePersonByName("민수");
    const nodeId = await addMemo("민수를 만났다.", ["민수"]);
    // 모델이 그 노드를 보고 "연결할 사람 없음"을 명시(personId=null) — 커버된 무산출.
    const empty = fixtureInfer((input) => [
      { nodeId: input.nodes[0]!.id, personId: null, confidence: 0 },
    ]);
    const summary = await runPersonLinkInferCycle(deps({ infer: empty.fn }));
    expect(summary.completedNoop).toBe(1);
    expect(getStageResult(db, "person_link", String(nodeId))!.status).toBe("completed_noop");

    // 다음 사이클 — 원장 제외로 후보에서 빠진다(재과금 0).
    const again = fixtureInfer(() => []);
    const summary2 = await runPersonLinkInferCycle(deps({ infer: again.fn }));
    expect(summary2.candidatesFound).toBe(0);
    expect(again.calls).toHaveLength(0);
  });
});

describe("parsePersonLinkResponse — null 표기", () => {
  test("따옴표 없는 JSON null 은 null 그대로, 문자열 \"null\" 도 null 로 읽는다", () => {
    const out = parsePersonLinkResponse(
      '[{"nodeId":1,"links":[{"personId":null,"confidence":0}]},{"nodeId":2,"links":[{"personId":"null","confidence":0}]},{"nodeId":3,"links":[{"personId":"p1","confidence":0.9}]}]',
    );
    expect(out.map((d) => d.personId)).toEqual([null, null, "p1"]);
  });

  test("JSON null 회신 → completed_noop (검증 탈락 아님)", async () => {
    await store.findOrCreatePersonByName("민수");
    const nodeId = await addMemo("민수를 만났다.", ["민수"]);
    const infer: PersonLinkInferFn = async (input) => ({
      kind: "ok",
      parsed: parsePersonLinkResponse(
        `[{"nodeId":${input.nodes[0]!.id},"links":[{"personId":null,"confidence":0}]}]`,
      ),
    });
    const summary = await runPersonLinkInferCycle(deps({ infer }));
    expect(summary.completedNoop).toBe(1);
    expect(summary.rejectedInvalid).toBe(0);
    expect(getStageResult(db, "person_link", String(nodeId))!.status).toBe("completed_noop");
  });
});

describe("runPersonLinkInferCycle — 노드 단위 커버리지 (A-7)", () => {
  test("배치에서 빠진 노드는 단독 호출로 다시 보내고, 거기서 답하면 정상 완료된다", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const first = await addMemo("민수와 회의했다.", ["민수"]);
    const second = await addMemo("민수와 점심을 먹었다.", ["민수"]);

    // 2노드 배치 호출에서는 first 만 답하고, 단독 재호출(노드 1개)에서는 정상 답한다.
    const infer = fixtureInfer((input) => {
      if (input.nodes.length > 1) {
        return [{ nodeId: first, personId: minsu.personId, confidence: 0.96 }];
      }
      return [{ nodeId: input.nodes[0]!.id, personId: minsu.personId, confidence: 0.96 }];
    });

    const summary = await runPersonLinkInferCycle(deps({ infer: infer.fn }));

    expect(infer.calls.map((c) => c.nodes.map((n) => n.id))).toEqual([
      [first, second],
      [second],
    ]);
    expect(summary.autoLinked).toBe(2);
    expect(summary.completed).toBe(2);
    expect(summary.coverageMisses).toBe(0);
    expect(getStageResult(db, "person_link", String(second))!.status).toBe("completed");
  });

  test("단독 재호출에서도 빠지면 결정적 실패로 원장에 남고 attempt 가 세어진다", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const decided = await addMemo("민수와 회의했다.", ["민수"]);
    const omitted = await addMemo("지현과 점심을 먹었다.", ["지현"]);

    // omitted 노드는 어떤 호출에서도 답하지 않는다.
    const infer = fixtureInfer((input) =>
      input.nodes.some((n) => n.id === decided)
        ? [{ nodeId: decided, personId: minsu.personId, confidence: 0.96 }]
        : [],
    );

    const summary = await runPersonLinkInferCycle(deps({ infer: infer.fn }));
    expect(infer.calls.map((c) => c.nodes.map((n) => n.id))).toEqual([
      [decided, omitted],
      [omitted],
    ]);
    expect(summary.autoLinked).toBe(1);
    expect(summary.coverageMisses).toBe(1);
    expect(getStageResult(db, "person_link", String(decided))!.status).toBe("completed");
    const row = getStageResult(db, "person_link", String(omitted))!;
    expect(row.status).toBe("retryable_failure");
    expect(row.attemptCount).toBe(1);
    expect(row.lastError).toContain("결정이 없음");

    // 상한(MAX_ATTEMPTS)까지 반복하면 terminal 로 끝나 더는 후보로 안 올라온다.
    for (let n = 2; n <= MAX_ATTEMPTS; n += 1) {
      await runPersonLinkInferCycle(deps({ infer: infer.fn }));
    }
    expect(getStageResult(db, "person_link", String(omitted))!.status).toBe("terminal_failure");
    const after = fixtureInfer(() => []);
    const last = await runPersonLinkInferCycle(deps({ infer: after.fn }));
    expect(last.candidatesFound).toBe(0);
    expect(after.calls).toHaveLength(0);
  });

  test("커버된 노드마다 결과 원장 정확히 1행(연결/제안/빈 값 모두 완료 처리)", async () => {
    const a = await store.findOrCreatePersonByName("민수");
    const b = await store.findOrCreatePersonByName("지현");
    const linked = await addMemo("민수와 회의했다.", ["민수"]);
    const proposed = await addMemo("지현일 수도 있다.", ["지현"]);
    const emptied = await addMemo("철수 이야기.", ["철수"]);

    const infer = fixtureInfer(() => [
      { nodeId: linked, personId: a.personId, confidence: 0.95 },
      { nodeId: proposed, personId: b.personId, confidence: 0.7 },
      { nodeId: emptied, personId: null, confidence: 0 },
    ]);

    const summary = await runPersonLinkInferCycle(deps({ infer: infer.fn }));
    expect(summary.autoLinked).toBe(1);
    expect(summary.proposalsInserted).toBe(1);
    expect(summary.completed).toBe(2); // linked + proposed
    expect(summary.completedNoop).toBe(1); // emptied
    expect(summary.coverageMisses).toBe(0);
    expect(getStageResult(db, "person_link", String(linked))!.status).toBe("completed");
    expect(getStageResult(db, "person_link", String(proposed))!.status).toBe("completed");
    expect(getStageResult(db, "person_link", String(emptied))!.status).toBe("completed_noop");
  });

  test("top-K 사전 필터가 fingerprint 에 실려 원장 대조에 반영된다", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const nodeId = await addMemo("민수와 회의했다.", ["민수"]);

    // 첫 사이클 — 사람 1명(민수)만 존재 → top-K 에 민수 personId 가 실린다.
    const first = fixtureInfer((input) => {
      // 노드 후보 사람이 사전 필터로 좁혀져 있다(민수만).
      expect(input.nodes[0]!.topKPersonIds).toEqual([minsu.personId]);
      return [{ nodeId, personId: minsu.personId, confidence: 0.7 }];
    });
    await runPersonLinkInferCycle(deps({ infer: first.fn }));
    expect(getStageResult(db, "person_link", String(nodeId))!.status).toBe("completed");
  });
});

describe("runPersonLinkInferCycle — 토큰 인지 microbatch + 호출당 상한 (A-6)", () => {
  /**
   * 두 노드가 한 배치엔 못 들지만 각자엔 드는 상한을 실측으로 계산한다 — 공유 오버헤드
   * (system + 사람 명단)에 노드 한 개는 얹히고 두 개는 못 얹히는 좁은 창을 잡는다.
   */
  function capForOneNodePerBatch(
    people: PersonLinkPersonContext[],
    nodes: PersonLinkNodeContext[],
  ): number {
    const overhead = personLinkFixedOverheadTokens(people);
    const nodeTokens = nodes.map(estimatePersonLinkNodeTokens);
    const largest = Math.max(...nodeTokens);
    const twoSmallest = nodeTokens
      .slice()
      .sort((a, b) => a - b)
      .slice(0, 2)
      .reduce((s, t) => s + t, 0);
    // 오버헤드 + 가장 큰 노드는 들되(상한 이상), 오버헤드 + 가장 작은 두 노드는 못 들게.
    const cap = overhead + largest;
    // 이 가정이 깨지면(두 작은 노드가 오히려 상한 안) 테스트 전제가 무효 — 조기 실패.
    expect(overhead + twoSmallest).toBeGreaterThan(cap);
    return cap;
  }

  test("노드가 상한 안에 들도록 여러 배치로 나뉘어 배치별 호출 + 전부 처리", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    // 노드 본문을 길게 해 노드별 추정이 오버헤드에 비해 크게 만든다(좁은 창 확보).
    const long = "민수와 나눈 긴 대화 기록. ".repeat(20);
    const n1 = await addMemo(`${long} 하나`, ["민수"]);
    const n2 = await addMemo(`${long} 둘`, ["민수"]);

    // 실측 컨텍스트로 상한 계산(people 은 실제 로드 형태 근사).
    const peopleCtx: PersonLinkPersonContext[] = [
      {
        personId: minsu.personId,
        displayName: "민수",
        // 실제 로드 형태 그대로 — findOrCreatePersonByName 은 이름을 별칭에도 넣는다.
        aliases: ["민수"],
        facts: { birthday: null, address: null, gender: null },
        attributes: [],
      },
    ];
    const nodeCtx: PersonLinkNodeContext[] = [
      { id: n1, content: `${long} 하나`, personCandidates: ["민수"], existingPersonIds: [], topKPersonIds: [minsu.personId] },
      { id: n2, content: `${long} 둘`, personCandidates: ["민수"], existingPersonIds: [], topKPersonIds: [minsu.personId] },
    ];
    const cap = capForOneNodePerBatch(peopleCtx, nodeCtx);

    // 각 배치는 노드 1개만 실려 온다 — 그 노드를 답한다.
    const infer = fixtureInfer((input) => {
      expect(input.nodes).toHaveLength(1);
      const node = input.nodes[0]!;
      return [{ nodeId: node.id, personId: minsu.personId, confidence: 0.95 }];
    });

    const summary = await runPersonLinkInferCycle(
      deps({ infer: infer.fn, perCallInputCap: cap }),
    );

    // 두 노드가 서로 다른 배치로 → 호출 2회, 둘 다 자동 연결·원장 completed.
    expect(infer.calls).toHaveLength(2);
    expect(summary.autoLinked).toBe(2);
    expect(summary.coverageMisses).toBe(0);
    expect(getStageResult(db, "person_link", String(n1))!.status).toBe("completed");
    expect(getStageResult(db, "person_link", String(n2))!.status).toBe("completed");
  });

  test("노드 하나 + 공유 오버헤드만으로도 상한 초과 → 호출 없이 terminal(input_over_cap)", async () => {
    await store.findOrCreatePersonByName("민수");
    const nodeId = await addMemo("민수와 회의했다.", ["민수"]);

    // 아주 작은 상한 — 공유 오버헤드(system + 사람 명단)만으로도 이미 넘어 모든 노드가 oversized.
    const infer = fixtureInfer(() => []);
    const summary = await runPersonLinkInferCycle(
      deps({ infer: infer.fn, perCallInputCap: 1 }),
    );

    // LLM 호출 0(oversized 는 호출 안 함), terminal 원장 + input_over_cap 사유.
    expect(infer.calls).toHaveLength(0);
    expect(summary.inferFailures).toBe(1);
    const row = getStageResult(db, "person_link", String(nodeId))!;
    expect(row.status).toBe("terminal_failure");
    expect(row.lastError).toContain("input_over_cap");
    // terminal 노드는 다음 사이클 후보에서 제외(같은 fingerprint) — 재과금 안 함.
    const second = fixtureInfer(() => []);
    const summary2 = await runPersonLinkInferCycle(
      deps({ infer: second.fn, perCallInputCap: 30000 }),
    );
    expect(summary2.candidatesFound).toBe(0);
  });

  test("커버리지는 배치 안에서만 판정 — 다른 배치가 안 답한 노드는 커버리지 미달이 아니다", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const long = "민수와 나눈 긴 대화 기록. ".repeat(20);
    const n1 = await addMemo(`${long} 하나`, ["민수"]);
    const n2 = await addMemo(`${long} 둘`, ["민수"]);

    const peopleCtx: PersonLinkPersonContext[] = [
      {
        personId: minsu.personId,
        displayName: "민수",
        // 실제 로드 형태 그대로 — findOrCreatePersonByName 은 이름을 별칭에도 넣는다.
        aliases: ["민수"],
        facts: { birthday: null, address: null, gender: null },
        attributes: [],
      },
    ];
    const nodeCtx: PersonLinkNodeContext[] = [
      { id: n1, content: `${long} 하나`, personCandidates: ["민수"], existingPersonIds: [], topKPersonIds: [minsu.personId] },
      { id: n2, content: `${long} 둘`, personCandidates: ["민수"], existingPersonIds: [], topKPersonIds: [minsu.personId] },
    ];
    const cap = capForOneNodePerBatch(peopleCtx, nodeCtx);

    // 각 배치는 자기 노드만 답한다(배치 간 교차 없음).
    const infer = fixtureInfer((input) => {
      const node = input.nodes[0]!;
      return [{ nodeId: node.id, personId: minsu.personId, confidence: 0.95 }];
    });

    const summary = await runPersonLinkInferCycle(
      deps({ infer: infer.fn, perCallInputCap: cap }),
    );

    // 두 노드 다 자기 배치에서 커버됨 → 커버리지 미달 0(배치 간 미답을 미달로 몰지 않음).
    expect(summary.coverageMisses).toBe(0);
    expect(summary.completed).toBe(2);
  });
});

describe("runPersonLinkInferCycle — nodeIds 로 특정 메모만 (입력 직후 정리)", () => {
  test("nodeIds 를 주면 그 메모만 후보가 된다", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    await addMemo("민수와 점심을 먹었다.", ["민수"]);
    const target = await addMemo("민수와 회의했다.", ["민수"]);
    const infer = fixtureInfer((input) =>
      input.nodes.map((n) => ({ nodeId: n.id, personId: minsu.personId, confidence: 0.95, candidateText: "민수" })),
    );

    const summary = await runPersonLinkInferCycle(deps({ infer: infer.fn, nodeIds: [target] }));

    expect(summary.candidatesFound).toBe(1);
    expect(infer.calls.flatMap((c) => c.nodes.map((n) => n.id))).toEqual([target]);
  });

  test("빈 nodeIds 면 후보 0 이고 LLM 을 부르지 않는다", async () => {
    await store.findOrCreatePersonByName("민수");
    await addMemo("민수와 회의했다.", ["민수"]);
    const infer = fixtureInfer(() => []);

    const summary = await runPersonLinkInferCycle(deps({ infer: infer.fn, nodeIds: [] }));

    expect(summary.candidatesFound).toBe(0);
    expect(infer.calls).toHaveLength(0);
  });
});
