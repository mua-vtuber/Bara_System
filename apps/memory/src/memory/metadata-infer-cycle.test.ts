/**
 * metadata-infer-cycle.test.ts — 갈래 2 한 사이클 글루 통합 검증.
 *
 * 실 `:memory:` SQLite + 실 SqliteMemoryStore + 실 EventRepository/EventBus 로 돈다
 * (mock 객체 0). LLM 만 데이터 fixture 응답을 내는 *함수*를 주입한다 — 인터페이스
 * 가짜 구현체가 아니라 SessionInferFn 자리에 함수 인자를 넘기는 구조.
 *
 * 검증:
 *   - 멱등 제외(이미 metadata_fill 제안 있는 노드 다시 제안 안 함)
 *   - 평가 완료 마킹(제안 0건·일부만 제안이어도 세션 노드 마킹 → 무한 재평가 차단)
 *   - ID 검증(세션 밖·환각 nodeId 버림 + field·value 검증)
 *   - 제안 insert(payload 양식 Task 4 정합) + 자동 적용 0(addClassificationTag/setEventAt 미호출)
 *   - eventBus.emit — 제안 ≥1 이면 1회, 0건이면 emit 안 함
 *   - graceful(infer=null no-op)
 *   - 섞인 세션만 LLM 호출(전부 채움/전부 빔 세션 호출 0)
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
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
  METADATA_FILL_KIND,
  runMetadataInferCycle,
  type InferredProposal,
  type SessionInferFn,
  type SessionInferInput,
} from "./metadata-infer-cycle.ts";
import { wireHashtagEntities } from "./hashtag-entity-wiring.ts";
import { METADATA_INFER_MAX_OUTPUT_TOKENS_DEFAULT } from "./metadata-infer-output-limit.ts";

const MODEL = "bge-m3";
const G = 180; // 세션 간격(분).
const LIMIT = METADATA_INFER_MAX_OUTPUT_TOKENS_DEFAULT; // 출력 한도(설정 기본값).

let db: Database;
let store: SqliteMemoryStore;
let eventBus: EventBus;
let events: EventRepository;
// 임베더는 모델 로드가 무거우므로 한 번만 만든다(상태 없는 순수 추론기 — 테스트 간
// 공유 안전). DB·store·bus 만 테스트마다 새로 만들어 격리한다.
let embedder: Embedder;

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

/** 한 노드 입력 — source_type='llm_extract' 로 후보 자격을 준다. */
async function addMemo(
  content: string,
  author: string,
  createdAt: string,
): Promise<number> {
  const id = await store.addNode({
    content,
    sourceType: "llm_extract",
    author,
  });
  // created_at 을 명시 시각으로 고정(세션 묶기 결정성). schema default 가 들어가므로
  // 테스트는 직접 UPDATE 로 원하는 시각을 둔다.
  db.prepare("UPDATE knowledge_nodes SET created_at = ? WHERE id = ?").run(
    createdAt,
    id,
  );
  return id;
}

/** 고정 응답을 내는 fixture infer 함수 + 호출 기록. */
function fixtureInfer(
  responder: (input: SessionInferInput) => InferredProposal[],
): { fn: SessionInferFn; calls: SessionInferInput[] } {
  const calls: SessionInferInput[] = [];
  const fn: SessionInferFn = async (input) => {
    calls.push(input);
    return responder(input);
  };
  return { fn, calls };
}

/** cleanup_proposals 의 metadata_fill 제안 목록(payload 파싱). */
function listFillProposals(): Array<{
  id: string;
  status: string;
  payload: { nodeId: number; field: string; value: string; evidence?: string };
}> {
  const rows = db
    .prepare(
      "SELECT id, status, payload_json FROM cleanup_proposals WHERE kind = ? ORDER BY rowid ASC",
    )
    .all(METADATA_FILL_KIND) as Array<{
    id: string;
    status: string;
    payload_json: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    payload: JSON.parse(r.payload_json),
  }));
}

describe("runMetadataInferCycle — graceful", () => {
  test("(1) infer=null → no-op + 제안 0 + emit 0", async () => {
    await addMemo("에버랜드 왔다", "alice", "2026-06-01 10:00:00");
    await addMemo("롤러코스터 탔다", "alice", "2026-06-01 10:10:00");

    const summary = await runMetadataInferCycle({
      db,
      infer: null,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: () => Date.parse("2026-06-02T00:00:00"),
    });

    expect(summary.proposalsInserted).toBe(0);
    expect(listFillProposals()).toHaveLength(0);
    expect(events.listRecent().length).toBe(0);
  });
});

describe("runMetadataInferCycle — 섞인 세션만 LLM 호출", () => {
  test("(2) 전부 메타 없는 세션 → LLM 호출 0", async () => {
    await addMemo("글 A", "alice", "2026-06-01 10:00:00");
    await addMemo("글 B", "alice", "2026-06-01 10:10:00");

    const { fn, calls } = fixtureInfer(() => []);
    const summary = await runMetadataInferCycle({
      db,
      infer: fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: () => Date.parse("2026-06-02T00:00:00"),
    });

    expect(calls).toHaveLength(0); // 섞인 세션 0 → 호출 0.
    expect(summary.mixedSessions).toBe(0);
  });

  test("(3) 섞인 세션 → LLM 1회 호출", async () => {
    const n1 = await addMemo("에버랜드 왔다", "alice", "2026-06-01 10:00:00");
    await store.addClassificationTag(n1, "장소", "에버랜드", "user_input", n1);
    await addMemo("롤러코스터 탔다", "alice", "2026-06-01 10:10:00"); // 메타 없음.

    const { fn, calls } = fixtureInfer(() => []);
    await runMetadataInferCycle({
      db,
      infer: fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: () => Date.parse("2026-06-02T00:00:00"),
    });

    expect(calls).toHaveLength(1);
    // 입력에 두 노드가 모두 들어가고, 장소 값이 묻어 온다.
    expect(calls[0]!.nodes).toHaveLength(2);
    const placed = calls[0]!.nodes.find((n) => n.place !== null);
    expect(placed?.place).toBe("에버랜드");
  });
});

describe("runMetadataInferCycle — 제안 insert + emit + 자동 적용 0", () => {
  test("(4) 정상 제안 → insert + emit 1회 + 자동 적용 0", async () => {
    const n1 = await addMemo("에버랜드 왔다", "alice", "2026-06-01 10:00:00");
    await store.addClassificationTag(n1, "장소", "에버랜드", "user_input", n1);
    const n2 = await addMemo("롤러코스터 탔다", "alice", "2026-06-01 10:10:00");

    // LLM 이 빈 노드 n2 에 장소 "에버랜드" 전파 제안.
    const { fn } = fixtureInfer(() => [
      { nodeId: n2, field: "place", value: "에버랜드", evidence: "같은 사건" },
    ]);

    const summary = await runMetadataInferCycle({
      db,
      infer: fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: () => Date.parse("2026-06-02T00:00:00"),
    });

    expect(summary.proposalsInserted).toBe(1);

    // insert 양식 — Task 4 payload 정합.
    const proposals = listFillProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.status).toBe("pending");
    expect(proposals[0]!.payload).toEqual({
      nodeId: n2,
      field: "place",
      value: "에버랜드",
      evidence: "같은 사건",
    });

    // emit 1회 — events 큐 적재.
    const recent = events.listRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0]!.type).toBe(CLEANUP_PROPOSALS_READY_EVENT);
    expect(recent[0]!.payload).toEqual({ count: 1, kind: METADATA_FILL_KIND });

    // 자동 적용 0 — n2 에 장소 태그가 *안* 붙었는지(approve 전이라 미적용).
    const placeCount = db
      .prepare(
        "SELECT COUNT(*) AS c FROM node_concept_edges WHERE node_id = ? AND role = 'classification'",
      )
      .get(n2) as { c: number };
    expect(placeCount.c).toBe(0);
    // event_at 도 그대로 NULL.
    const evRow = db
      .prepare("SELECT event_at FROM knowledge_nodes WHERE id = ?")
      .get(n2) as { event_at: string | null };
    expect(evRow.event_at).toBeNull();
  });

  test("(5) 제안 0건 → emit 안 함", async () => {
    const n1 = await addMemo("에버랜드 왔다", "alice", "2026-06-01 10:00:00");
    await store.addClassificationTag(n1, "장소", "에버랜드", "user_input", n1);
    await addMemo("롤러코스터 탔다", "alice", "2026-06-01 10:10:00");

    const { fn } = fixtureInfer(() => []); // 섞인 세션이지만 제안 0.
    const summary = await runMetadataInferCycle({
      db,
      infer: fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: () => Date.parse("2026-06-02T00:00:00"),
    });

    expect(summary.proposalsInserted).toBe(0);
    expect(events.listRecent().length).toBe(0); // 0건 → emit 안 함.
  });
});

describe("runMetadataInferCycle — ID 검증(환각 차단)", () => {
  test("(6) 세션 밖 nodeId 제안 → 버림 + insert 0", async () => {
    const n1 = await addMemo("에버랜드 왔다", "alice", "2026-06-01 10:00:00");
    await store.addClassificationTag(n1, "장소", "에버랜드", "user_input", n1);
    const n2 = await addMemo("롤러코스터 탔다", "alice", "2026-06-01 10:10:00");

    // LLM 이 세션에 없는 nodeId(9999) 를 지어냄 → 버려야 함.
    const { fn } = fixtureInfer(() => [
      { nodeId: 9999, field: "place", value: "에버랜드" },
    ]);
    void n2;

    const summary = await runMetadataInferCycle({
      db,
      infer: fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: () => Date.parse("2026-06-02T00:00:00"),
    });

    expect(summary.rejectedHallucinations).toBe(1);
    expect(summary.proposalsInserted).toBe(0);
    expect(listFillProposals()).toHaveLength(0);
    expect(events.listRecent().length).toBe(0);
  });

  test("(7) 세션 안 정상 nodeId + 세션 밖 환각 섞임 → 정상만 insert", async () => {
    const n1 = await addMemo("에버랜드 왔다", "alice", "2026-06-01 10:00:00");
    await store.addClassificationTag(n1, "장소", "에버랜드", "user_input", n1);
    const n2 = await addMemo("롤러코스터 탔다", "alice", "2026-06-01 10:10:00");

    const { fn } = fixtureInfer(() => [
      { nodeId: n2, field: "place", value: "에버랜드" }, // 정상.
      { nodeId: 8888, field: "place", value: "롯데월드" }, // 환각.
    ]);

    const summary = await runMetadataInferCycle({
      db,
      infer: fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: () => Date.parse("2026-06-02T00:00:00"),
    });

    expect(summary.proposalsInserted).toBe(1);
    expect(summary.rejectedHallucinations).toBe(1);
    const proposals = listFillProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.payload.nodeId).toBe(n2);
  });

  test("(8) 잘못된 field/빈 value → 버림", async () => {
    const n1 = await addMemo("에버랜드 왔다", "alice", "2026-06-01 10:00:00");
    await store.addClassificationTag(n1, "장소", "에버랜드", "user_input", n1);
    const n2 = await addMemo("롤러코스터 탔다", "alice", "2026-06-01 10:10:00");

    const { fn } = fixtureInfer(() => [
      // field 어긋남(타입 캐스트로 강제 — 런타임 방어 확인).
      { nodeId: n2, field: "weird" as "place", value: "x" },
      // 빈 value.
      { nodeId: n2, field: "place", value: "   " },
    ]);

    const summary = await runMetadataInferCycle({
      db,
      infer: fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: () => Date.parse("2026-06-02T00:00:00"),
    });

    expect(summary.proposalsInserted).toBe(0);
    expect(summary.rejectedHallucinations).toBe(2);
  });
});

describe("runMetadataInferCycle — 값 출처 검증(본문 짐작 값 차단)", () => {
  const EVENT_AT = "2026-06-01T10:00:00+09:00";

  async function runWith(fn: SessionInferFn) {
    return runMetadataInferCycle({
      db,
      infer: fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: () => Date.parse("2026-06-02T00:00:00"),
    });
  }

  test("(V1) 세션 다른 메모에 없는 장소 값 → 버림", async () => {
    const n1 = await addMemo("에버랜드 왔다", "alice", "2026-06-01 10:00:00");
    await store.addClassificationTag(n1, "장소", "에버랜드", "user_input", n1);
    const n2 = await addMemo("설정은 연결·진단 화면에만 둔다", "alice", "2026-06-01 10:10:00");

    const { fn } = fixtureInfer(() => [
      { nodeId: n2, field: "place", value: "연결·진단 화면", evidence: "본문에서 짐작" },
    ]);
    const summary = await runWith(fn);

    expect(summary.proposalsInserted).toBe(0);
    expect(summary.rejectedHallucinations).toBe(1);
    expect(listFillProposals()).toHaveLength(0);
  });

  test("(V2) 시각 — 실제 값이 LLM 입력에 실리고, 날짜 아닌 짐작 값은 버리고 복사 값만 남긴다", async () => {
    const n1 = await addMemo("회의 시작", "alice", "2026-06-01 10:00:00");
    db.prepare("UPDATE knowledge_nodes SET event_at = ? WHERE id = ?").run(EVENT_AT, n1);
    const n2 = await addMemo("저장 후 재시작해야 적용된다", "alice", "2026-06-01 10:10:00");
    const n3 = await addMemo("회의 안건 정리", "alice", "2026-06-01 10:20:00");

    const { fn, calls } = fixtureInfer(() => [
      { nodeId: n2, field: "event_at", value: "저장 후" },
      { nodeId: n3, field: "event_at", value: EVENT_AT },
    ]);
    const summary = await runWith(fn);

    expect(calls[0]!.nodes.find((n) => n.id === n1)?.eventAt).toBe(EVENT_AT);
    expect(summary.proposalsInserted).toBe(1);
    expect(summary.rejectedHallucinations).toBe(1);
    const proposals = listFillProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.payload).toMatchObject({ nodeId: n3, field: "event_at", value: EVENT_AT });
  });

  test("(V3) 이미 채워진 칸을 대상으로 한 제안 → 버림", async () => {
    const n1 = await addMemo("에버랜드 왔다", "alice", "2026-06-01 10:00:00");
    await store.addClassificationTag(n1, "장소", "에버랜드", "user_input", n1);
    const n2 = await addMemo("롯데월드도 갔다", "alice", "2026-06-01 10:10:00");
    await store.addClassificationTag(n2, "장소", "롯데월드", "user_input", n2);
    await addMemo("집에 왔다", "alice", "2026-06-01 10:20:00");

    const { fn } = fixtureInfer(() => [
      { nodeId: n1, field: "place", value: "롯데월드" },
    ]);
    const summary = await runWith(fn);

    expect(summary.proposalsInserted).toBe(0);
    expect(summary.rejectedHallucinations).toBe(1);
  });
});

describe("runMetadataInferCycle — 멱등 제외", () => {
  test("(9) 이미 metadata_fill 제안 있는 노드 → 후보에서 빠짐", async () => {
    const n1 = await addMemo("에버랜드 왔다", "alice", "2026-06-01 10:00:00");
    await store.addClassificationTag(n1, "장소", "에버랜드", "user_input", n1);
    const n2 = await addMemo("롤러코스터 탔다", "alice", "2026-06-01 10:10:00");

    // n2 에 대한 제안을 먼저 한 번 만든다(첫 사이클).
    const first = fixtureInfer(() => [
      { nodeId: n2, field: "place", value: "에버랜드" },
    ]);
    await runMetadataInferCycle({
      db,
      infer: first.fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: () => Date.parse("2026-06-02T00:00:00"),
    });
    expect(listFillProposals()).toHaveLength(1);

    // 둘째 사이클 — n2 는 이미 제안이 있어 후보에서 빠진다 → 세션이 더는
    // 섞이지 않아(n2 제외 후 n1 만 남고, n1 은 메타 있음) LLM 호출 0.
    const second = fixtureInfer(() => [
      { nodeId: n2, field: "place", value: "롯데월드" },
    ]);
    const summary = await runMetadataInferCycle({
      db,
      infer: second.fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: () => Date.parse("2026-06-02T00:00:00"),
    });

    expect(second.calls).toHaveLength(0); // n2 빠지면 섞인 세션 0.
    expect(summary.proposalsInserted).toBe(0);
    expect(listFillProposals()).toHaveLength(1); // 첫 제안 그대로 1개.
  });

  test("(10) 거절된(rejected) 제안도 멱등 출처 — 재생성 안 함", async () => {
    const n1 = await addMemo("에버랜드 왔다", "alice", "2026-06-01 10:00:00");
    await store.addClassificationTag(n1, "장소", "에버랜드", "user_input", n1);
    const n2 = await addMemo("롤러코스터 탔다", "alice", "2026-06-01 10:10:00");

    // n2 제안을 만든 뒤 사용자가 거절한 상황을 흉내(status='rejected').
    const first = fixtureInfer(() => [
      { nodeId: n2, field: "place", value: "에버랜드" },
    ]);
    await runMetadataInferCycle({
      db,
      infer: first.fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: () => Date.parse("2026-06-02T00:00:00"),
    });
    db.prepare(
      "UPDATE cleanup_proposals SET status = 'rejected' WHERE kind = ?",
    ).run(METADATA_FILL_KIND);

    // 둘째 사이클 — 거절돼도 그 노드 다시 제안 안 함(거절 재생성 차단).
    const second = fixtureInfer(() => [
      { nodeId: n2, field: "place", value: "에버랜드" },
    ]);
    const summary = await runMetadataInferCycle({
      db,
      infer: second.fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: () => Date.parse("2026-06-02T00:00:00"),
    });

    expect(second.calls).toHaveLength(0);
    expect(summary.proposalsInserted).toBe(0);
  });
});

describe("runMetadataInferCycle — 평가 완료 마킹(무한 재평가 차단)", () => {
  // 한 노드의 metaInferred 플래그를 읽는다(정수 1 또는 부재).
  function readMetaInferred(nodeId: number): number | null {
    const row = db
      .prepare(
        "SELECT metadata_json ->> '$.metaInferred' AS m FROM knowledge_nodes WHERE id = ?",
      )
      .get(nodeId) as { m: number | null };
    return row.m;
  }

  test("(13) 시나리오 A — 빈 배열 회신 → 세션 노드 마킹 → 다음 사이클 재평가 0", async () => {
    const n1 = await addMemo("에버랜드 왔다", "alice", "2026-06-01 10:00:00");
    await store.addClassificationTag(n1, "장소", "에버랜드", "user_input", n1);
    const n2 = await addMemo("롤러코스터 탔다", "alice", "2026-06-01 10:10:00"); // 메타 없음.

    // 첫 사이클 — 섞인 세션이라 LLM 1회 호출, 그러나 빈 배열 회신(제안 0).
    const first = fixtureInfer(() => []);
    const firstSummary = await runMetadataInferCycle({
      db,
      infer: first.fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: () => Date.parse("2026-06-02T00:00:00"),
    });

    expect(first.calls).toHaveLength(1); // 섞인 세션 평가됨.
    expect(firstSummary.proposalsInserted).toBe(0); // 제안 0건.
    expect(listFillProposals()).toHaveLength(0); // 제안 없음(멱등 출처 1 안 걸림).

    // 핵심 — 제안 0건이어도 그 세션 전체 노드가 metaInferred=1 마킹됐는가.
    expect(readMetaInferred(n1)).toBe(1);
    expect(readMetaInferred(n2)).toBe(1);

    // 둘째 사이클 — 마킹된 노드는 후보에서 빠져 LLM 호출 0(무한 루프 안 생김).
    const second = fixtureInfer(() => []);
    const secondSummary = await runMetadataInferCycle({
      db,
      infer: second.fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: () => Date.parse("2026-06-02T00:00:00"),
    });

    expect(secondSummary.candidatesFound).toBe(0); // 두 노드 다 제외 → 후보 0.
    expect(second.calls).toHaveLength(0); // 재평가 0 — 무한 루프 차단.
  });

  test("(14) 시나리오 B — 일부만 제안 → 제안 + 미제안 노드 둘 다 마킹 → 재평가 0", async () => {
    const n1 = await addMemo("에버랜드 왔다", "alice", "2026-06-01 10:00:00");
    await store.addClassificationTag(n1, "장소", "에버랜드", "user_input", n1);
    const n2 = await addMemo("롤러코스터 탔다", "alice", "2026-06-01 10:05:00"); // 빈 노드 — 제안 받음.
    const n3 = await addMemo("팝콘 먹었다", "alice", "2026-06-01 10:10:00"); // 빈 노드 — 제안 못 받음.

    // 첫 사이클 — n2 에만 장소 전파 제안. n3 는 같은 세션이지만 제안 안 나옴.
    const first = fixtureInfer(() => [
      { nodeId: n2, field: "place", value: "에버랜드" },
    ]);
    const firstSummary = await runMetadataInferCycle({
      db,
      infer: first.fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: () => Date.parse("2026-06-02T00:00:00"),
    });

    expect(first.calls).toHaveLength(1);
    expect(firstSummary.proposalsInserted).toBe(1); // n2 만 제안.

    // 세 노드 모두 metaInferred=1 마킹 — 제안 받은 n2 도, 못 받은 n1/n3 도.
    expect(readMetaInferred(n1)).toBe(1);
    expect(readMetaInferred(n2)).toBe(1);
    expect(readMetaInferred(n3)).toBe(1);

    // 둘째 사이클 — 세 노드 다 제외(n2 는 제안 멱등 + 마킹 둘 다, n1/n3 는 마킹).
    const second = fixtureInfer(() => [
      { nodeId: n3, field: "place", value: "에버랜드" },
    ]);
    const secondSummary = await runMetadataInferCycle({
      db,
      infer: second.fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: () => Date.parse("2026-06-02T00:00:00"),
    });

    expect(secondSummary.candidatesFound).toBe(0); // 세 노드 다 제외.
    expect(second.calls).toHaveLength(0); // 재평가 0.
    expect(listFillProposals()).toHaveLength(1); // 첫 제안 1개 그대로(n3 재제안 안 됨).
  });

  test("(15) LLM throw 한 세션은 마킹 안 함 — 다음 사이클 재시도", async () => {
    const n1 = await addMemo("에버랜드 왔다", "alice", "2026-06-01 10:00:00");
    await store.addClassificationTag(n1, "장소", "에버랜드", "user_input", n1);
    const n2 = await addMemo("롤러코스터 탔다", "alice", "2026-06-01 10:10:00");

    // 첫 사이클 — LLM 이 throw → 평가 안 됨 → 마킹 안 함.
    const first = fixtureInfer(() => {
      throw new Error("ollama timeout");
    });
    const firstSummary = await runMetadataInferCycle({
      db,
      infer: first.fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: () => Date.parse("2026-06-02T00:00:00"),
    });

    expect(firstSummary.inferFailures).toBe(1);
    expect(readMetaInferred(n1)).toBeNull(); // throw 한 세션은 마킹 안 됨.
    expect(readMetaInferred(n2)).toBeNull();

    // 둘째 사이클 — 마킹 안 됐으니 후보로 다시 줍히고 재시도(이번엔 빈 배열로 성공).
    const second = fixtureInfer(() => []);
    const secondSummary = await runMetadataInferCycle({
      db,
      infer: second.fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: () => Date.parse("2026-06-02T00:00:00"),
    });

    expect(secondSummary.candidatesFound).toBe(2); // 다시 후보.
    expect(second.calls).toHaveLength(1); // 재시도됨.
    // 이번엔 성공(빈 배열)이라 마킹됨 — 이후엔 무한 재평가 안 함.
    expect(readMetaInferred(n1)).toBe(1);
    expect(readMetaInferred(n2)).toBe(1);
  });
});

describe("runMetadataInferCycle — 익은(닫힌) 세션만", () => {
  test("(11) 진행 중 세션(마지막 글 G 분 이내) → 건너뜀", async () => {
    const n1 = await addMemo("에버랜드 왔다", "alice", "2026-06-01 10:00:00");
    await store.addClassificationTag(n1, "장소", "에버랜드", "user_input", n1);
    await addMemo("롤러코스터 탔다", "alice", "2026-06-01 10:10:00");

    // now = 마지막 글 + (G-1)분 → 아직 안 익음.
    const lastMs = Date.parse("2026-06-01T10:10:00");
    const { fn, calls } = fixtureInfer(() => []);
    const summary = await runMetadataInferCycle({
      db,
      infer: fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: () => lastMs + (G - 1) * 60_000,
    });

    expect(summary.ripeSessions).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("(12) 닫힌 세션(마지막 글 + G ≤ now) → 평가됨", async () => {
    const n1 = await addMemo("에버랜드 왔다", "alice", "2026-06-01 10:00:00");
    await store.addClassificationTag(n1, "장소", "에버랜드", "user_input", n1);
    const n2 = await addMemo("롤러코스터 탔다", "alice", "2026-06-01 10:10:00");

    const lastMs = Date.parse("2026-06-01T10:10:00");
    const { fn, calls } = fixtureInfer(() => [
      { nodeId: n2, field: "place", value: "에버랜드" },
    ]);
    const summary = await runMetadataInferCycle({
      db,
      infer: fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: () => lastMs + G * 60_000, // 정확히 G 분 후 → 익음(경계 포함).
    });

    expect(summary.ripeSessions).toBe(1);
    expect(calls).toHaveLength(1);
    expect(summary.proposalsInserted).toBe(1);
  });
});

describe("runMetadataInferCycle — has_place place-엔티티 정합(후속 M-2)", () => {
  // place-엔티티 모델(직접 입력 setPlace(…,"direct") 고유명사·콜론 #장소 wiring)은
  // glob→잎개념 → place_concept_edges identity → place 행 으로 산다. 옛 has_place SQL
  // (concept→concept hierarchy_edges parent_of·ckey.name='장소')은 이 모양을 못 잡아
  // has_place=0 으로 오인했다(qa M-2). 수정 = concept→place identity 경로를 OR 로 추가.
  // 검증은 has_place 가 정확해야 성립하는 "섞인 세션 판정 + place_value 전달"로 한다.

  /** 한 세션을 익히는 now — 마지막 글 시각 + G 분(경계 포함). */
  function ripeNow(lastIso: string): () => number {
    return () => Date.parse(lastIso.replace(" ", "T")) + G * 60_000;
  }

  test("(M2-a) 직접 입력 place-엔티티('속초') + 메타 없는 글 → 섞인 세션 + place_value 전달", async () => {
    // n1 = 장소 있는 글(place 엔티티·고유명사 "속초" → places 행), n2 = 장소 없는 글.
    const n1 = await addMemo("여행 다녀왔다", "alice", "2026-06-01 10:00:00");
    const res = await store.setPlace(n1, "속초", "direct");
    expect(res.wrote).toBe(true); // 고유명사라 게이트 통과·places 행 1.
    expect(db.query("SELECT name FROM entities WHERE type_name='place' AND name='속초'").all().length).toBe(
      1,
    );
    await addMemo("롤러코스터 탔다", "alice", "2026-06-01 10:10:00");

    const { fn, calls } = fixtureInfer(() => []);
    const summary = await runMetadataInferCycle({
      db,
      infer: fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: ripeNow("2026-06-01 10:10:00"),
    });

    // has_place=1 인 n1 이 메타 없는 n2 와 섞여 LLM 호출 1회(섞인 세션).
    expect(summary.mixedSessions).toBe(1);
    expect(calls).toHaveLength(1);
    // n1 의 place_value 가 SessionInferInput 으로 전달된다(맥락 누락 0).
    const n1Input = calls[0]!.nodes.find((node) => node.id === n1);
    expect(n1Input?.place).toBe("속초");
  });

  test("(M2-b) 콜론 #장소 wiring place-엔티티 + 메타 없는 글 → 섞인 세션", async () => {
    const n1 = await addMemo("여행 #장소:속초", "bob", "2026-06-02 10:00:00");
    await wireHashtagEntities(store, n1, "여행 #장소:속초", {});
    expect(db.query("SELECT name FROM entities WHERE type_name='place' AND name='속초'").all().length).toBe(
      1,
    );
    await addMemo("사진 정리함", "bob", "2026-06-02 10:10:00");

    const { fn, calls } = fixtureInfer(() => []);
    const summary = await runMetadataInferCycle({
      db,
      infer: fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: ripeNow("2026-06-02 10:10:00"),
    });

    expect(summary.mixedSessions).toBe(1);
    expect(calls).toHaveLength(1);
    const n1Input = calls[0]!.nodes.find((node) => node.id === n1);
    expect(n1Input?.place).toBe("속초");
  });

  test("(M2-c) 추론 concept→concept('에버랜드') 회귀 0 — 여전히 섞인 세션(경로1 보존)", async () => {
    const n1 = await addMemo("에버랜드 왔다", "carol", "2026-06-03 10:00:00");
    await store.addClassificationTag(n1, "장소", "에버랜드", "user_input", n1); // 경로1(concept→concept)
    await addMemo("줄 길었다", "carol", "2026-06-03 10:10:00");

    const { fn, calls } = fixtureInfer(() => []);
    const summary = await runMetadataInferCycle({
      db,
      infer: fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: ripeNow("2026-06-03 10:10:00"),
    });

    expect(summary.mixedSessions).toBe(1);
    expect(calls).toHaveLength(1);
    const n1Input = calls[0]!.nodes.find((node) => node.id === n1);
    expect(n1Input?.place).toBe("에버랜드");
  });

  test("(M2-d) 장소 없는 글만 있는 세션 → has_place 0 → LLM 호출 0(섞임 아님)", async () => {
    await addMemo("그냥 일상 글", "dave", "2026-06-04 10:00:00");
    await addMemo("또 일상 글", "dave", "2026-06-04 10:10:00");

    const { fn, calls } = fixtureInfer(() => []);
    const summary = await runMetadataInferCycle({
      db,
      infer: fn,
      eventBus,
      gapMinutes: G,
      batchSize: 50,
      maxOutputTokens: LIMIT,
      now: ripeNow("2026-06-04 10:10:00"),
    });

    // 전부 메타 없는 세션 → 섞임 0 → LLM 호출 0(거짓 has_place 0).
    expect(summary.mixedSessions).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
