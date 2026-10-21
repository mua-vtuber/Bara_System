/**
 * person-link-multi-person.test.ts — 한 메모에 여러 사람이 나오는 경우의 사람 연결 사이클 검증.
 *
 * 실 SQLite + 실 SqliteMemoryStore + 실 EventBus. LLM 회신은 답 형식 그대로의 데이터 fixture
 * 문자열을 실제 파서(parsePersonLinkResponse)로 읽어 넘긴다 — 인터페이스 가짜 구현 없음.
 * 검증 초점: 서로 다른 사람은 각각 자동 연결, 같은 언급이 갈리거나 불확실 표시면 애매 제안,
 * 빈 links 는 completed_noop, 노드 수가 많으면 호출당 상한으로 나눠 부른다.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { createEmbedder, embeddingDimensionOf } from "../embedding/factory.ts";
import type { Embedder } from "../embedding/types.ts";
import { EventRepository } from "../db/store-internal/event-repository.ts";
import { EventBus } from "../server-internal/event-bus.ts";
import {
  PERSON_LINK_KIND,
  PERSON_LINK_MAX_NODES_PER_CALL,
  parsePersonLinkResponse,
  runPersonLinkInferCycle,
  type PersonLinkInferCycleDeps,
  type PersonLinkInferFn,
  type PersonLinkInferInput,
} from "./person-link-infer-cycle.ts";
import { getStageResult } from "./cleanup-deep-pass/stage-results-ledger.ts";
import { cleanupStageLlmLimitsOf } from "./cleanup-deep-pass/stage-constants.ts";

const MODEL = "bge-m3";
const STAGE_VERSION = cleanupStageLlmLimitsOf("person_link").stageVersion;
const MAX_ATTEMPTS = 3;

let embedder: Embedder;
let db: Database;
let store: SqliteMemoryStore;
let eventBus: EventBus;

beforeAll(async () => {
  embedder = createEmbedder({ model: MODEL });
  await embedder.load();
});

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: embeddingDimensionOf(MODEL) });
  store = new SqliteMemoryStore(db, embedder);
  eventBus = new EventBus(new EventRepository(db));
});

afterEach(() => {
  db.close();
});

async function addMemo(content: string, personCandidates: string[]): Promise<number> {
  return store.addNode({ content, sourceType: "llm_extract", metadata: { personCandidates } });
}

/** 회신 글 fixture 를 실제 파서로 읽어 ok 결과로 돌려주는 infer fn. */
function textInfer(
  responder: (input: PersonLinkInferInput) => string,
): { fn: PersonLinkInferFn; calls: PersonLinkInferInput[] } {
  const calls: PersonLinkInferInput[] = [];
  const fn: PersonLinkInferFn = async (input) => {
    calls.push(input);
    return { kind: "ok", parsed: parsePersonLinkResponse(responder(input)) };
  };
  return { fn, calls };
}

function deps(
  overrides: Pick<PersonLinkInferCycleDeps, "infer"> & Partial<PersonLinkInferCycleDeps>,
): PersonLinkInferCycleDeps {
  return {
    db,
    store,
    eventBus,
    batchSize: 50,
    stageVersion: STAGE_VERSION,
    maxAttemptsPerTarget: MAX_ATTEMPTS,
    perCallInputCap: 200000,
    ...overrides,
  };
}

function proposals(): Array<Record<string, unknown>> {
  return (
    db
      .prepare("SELECT payload_json FROM cleanup_proposals WHERE kind = ? ORDER BY rowid ASC")
      .all(PERSON_LINK_KIND) as Array<{ payload_json: string }>
  ).map((r) => JSON.parse(r.payload_json) as Record<string, unknown>);
}

type Link = { personId: string; candidateText: string; confidence: number; uncertain?: boolean };
function answer(nodeId: number, links: Link[]): string {
  return JSON.stringify([{ nodeId, links: links.map((l) => ({ evidence: "본문 근거", ...l })) }]);
}

describe("runPersonLinkInferCycle — 한 메모의 여러 사람", () => {
  test("서로 다른 두 사람이 나오는 메모 → 두 사람 모두 자동 연결", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const jiyoung = await store.findOrCreatePersonByName("지영");
    const nodeId = await addMemo("민수와 지영을 만났다.", ["민수", "지영"]);
    const infer = textInfer(() =>
      answer(nodeId, [
        { personId: minsu.personId, candidateText: "민수", confidence: 0.95 },
        { personId: jiyoung.personId, candidateText: "지영", confidence: 0.94 },
      ]),
    );

    const summary = await runPersonLinkInferCycle(deps({ infer: infer.fn }));

    expect(summary.autoLinked).toBe(2);
    expect(summary.proposalsInserted).toBe(0);
    const edges = await store.listNodePersonEdges({ nodeId });
    expect(edges.map((e) => e.personId).sort()).toEqual([minsu.personId, jiyoung.personId].sort());
    expect(getStageResult(db, "person_link", String(nodeId))!.status).toBe("completed");
  });

  test("같은 사람을 두 번 내면 연결 하나로 합친다", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const nodeId = await addMemo("민수, 그러니까 김민수를 만났다.", ["민수"]);
    const infer = textInfer(() =>
      answer(nodeId, [
        { personId: minsu.personId, candidateText: "민수", confidence: 0.92 },
        { personId: minsu.personId, candidateText: "김민수", confidence: 0.97 },
      ]),
    );

    const summary = await runPersonLinkInferCycle(deps({ infer: infer.fn }));

    expect(summary.autoLinked).toBe(1);
    expect(await store.listNodePersonEdges({ nodeId })).toHaveLength(1);
  });

  test("같은 언급이 두 사람 후보로 갈리면 자동 연결 없이 애매 제안 두 건", async () => {
    const a = await store.findOrCreatePersonByName("민수 A");
    await store.addPersonAlias(a.personId, "민수");
    const b = await store.findOrCreatePersonByName("민수 B");
    await store.addPersonAlias(b.personId, "민수");
    const nodeId = await addMemo("민수와 다시 이야기했다.", ["민수"]);
    const infer = textInfer(() =>
      answer(nodeId, [
        { personId: a.personId, candidateText: "민수", confidence: 0.95, uncertain: true },
        { personId: b.personId, candidateText: "민수", confidence: 0.92, uncertain: true },
      ]),
    );

    const summary = await runPersonLinkInferCycle(deps({ infer: infer.fn }));

    expect(summary.autoLinked).toBe(0);
    expect(summary.proposalsInserted).toBe(2);
    expect(await store.listNodePersonEdges({ nodeId })).toHaveLength(0);
    const rows = proposals();
    expect(rows.map((p) => p.personId).sort()).toEqual([a.personId, b.personId].sort());
    expect(rows.every((p) => p.ambiguous === true)).toBe(true);
  });

  test("uncertain 표시가 없어도 같은 언급이 두 사람으로 갈리면 애매 제안", async () => {
    const a = await store.findOrCreatePersonByName("민수 A");
    await store.addPersonAlias(a.personId, "민수");
    const b = await store.findOrCreatePersonByName("민수 B");
    await store.addPersonAlias(b.personId, "민수");
    const nodeId = await addMemo("민수와 다시 이야기했다.", ["민수"]);
    const infer = textInfer(() =>
      answer(nodeId, [
        { personId: a.personId, candidateText: "민수", confidence: 0.95 },
        { personId: b.personId, candidateText: "민수", confidence: 0.92 },
      ]),
    );

    const summary = await runPersonLinkInferCycle(deps({ infer: infer.fn }));

    expect(summary.autoLinked).toBe(0);
    expect(proposals().map((p) => p.ambiguous)).toEqual([true, true]);
  });

  test("한 사람은 확실, 다른 사람은 모델이 불확실 표시 → 하나는 자동 연결, 하나는 애매 제안", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const jiyoung = await store.findOrCreatePersonByName("지영");
    const nodeId = await addMemo("민수와 지영(?)을 만났다.", ["민수", "지영"]);
    const infer = textInfer(() =>
      answer(nodeId, [
        { personId: minsu.personId, candidateText: "민수", confidence: 0.95 },
        { personId: jiyoung.personId, candidateText: "지영", confidence: 0.91, uncertain: true },
      ]),
    );

    const summary = await runPersonLinkInferCycle(deps({ infer: infer.fn }));

    expect(summary.autoLinked).toBe(1);
    expect(summary.proposalsInserted).toBe(1);
    expect((await store.listNodePersonEdges({ nodeId })).map((e) => e.personId)).toEqual([minsu.personId]);
    expect(proposals()[0]).toMatchObject({ personId: jiyoung.personId, ambiguous: true });
  });

  test("없는 personId 연결 하나만 버리고 같은 메모의 다른 연결은 그대로 처리", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const nodeId = await addMemo("민수와 디롱이를 봤다.", ["민수", "디롱이"]);
    const infer = textInfer(() =>
      answer(nodeId, [
        { personId: "디롱이", candidateText: "디롱이", confidence: 0.95 },
        { personId: minsu.personId, candidateText: "민수", confidence: 0.95 },
      ]),
    );

    const summary = await runPersonLinkInferCycle(deps({ infer: infer.fn }));

    expect(summary.rejectedInvalid).toBe(1);
    expect(summary.autoLinked).toBe(1);
    expect(getStageResult(db, "person_link", String(nodeId))!.status).toBe("completed");
  });

  test("빈 links → completed_noop(검증 탈락 아님, 다음 사이클 재과금 0)", async () => {
    await store.findOrCreatePersonByName("민수");
    const nodeId = await addMemo("민수 이야기는 아니다.", ["민수"]);
    const infer = textInfer((input) => JSON.stringify(input.nodes.map((n) => ({ nodeId: n.id, links: [] }))));

    const summary = await runPersonLinkInferCycle(deps({ infer: infer.fn }));

    expect(summary.completedNoop).toBe(1);
    expect(summary.rejectedInvalid).toBe(0);
    expect(getStageResult(db, "person_link", String(nodeId))!.status).toBe("completed_noop");
    const again = textInfer(() => "[]");
    await runPersonLinkInferCycle(deps({ infer: again.fn }));
    expect(again.calls).toHaveLength(0);
  });

  test("links 모양이 틀린 회신 → 그 노드는 결정적 실패(빈 값으로 위장하지 않음)", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const nodeId = await addMemo("민수를 만났다.", ["민수"]);
    const infer = textInfer(() =>
      JSON.stringify([{ nodeId, personId: minsu.personId, confidence: 0.95 }]),
    );

    const summary = await runPersonLinkInferCycle(deps({ infer: infer.fn }));

    expect(summary.autoLinked).toBe(0);
    expect(summary.completedNoop).toBe(0);
    expect(summary.rejectedInvalid).toBe(1);
    expect(getStageResult(db, "person_link", String(nodeId))!.status).not.toMatch(/^completed/);
  });
});

describe("runPersonLinkInferCycle — 호출당 노드 수 상한", () => {
  test("후보가 상한보다 많으면 상한 개수씩 나눠 부르고 전부 처리한다", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const total = PERSON_LINK_MAX_NODES_PER_CALL + 5;
    for (let i = 0; i < total; i++) {
      await addMemo(`민수와 ${i}번째로 만났다.`, ["민수"]);
    }
    const infer = textInfer((input) =>
      JSON.stringify(
        input.nodes.map((n) => ({
          nodeId: n.id,
          links: [{ personId: minsu.personId, candidateText: "민수", confidence: 0.95 }],
        })),
      ),
    );

    const summary = await runPersonLinkInferCycle(deps({ infer: infer.fn, batchSize: total }));

    expect(infer.calls.map((c) => c.nodes.length)).toEqual([PERSON_LINK_MAX_NODES_PER_CALL, 5]);
    expect(summary.autoLinked).toBe(total);
  });
});
