/**
 * person-link-candidate-query.test.ts — person_link 후보 프롤로그 추출 검증 (Task 7).
 *
 * 실 SQLite(:memory:, embeddingDim 1024) + 실 SqliteMemoryStore. mock 객체 0 —
 * 사람·노드는 store 메서드로 실제 삽입한다(데이터 fixture 만). collectPersonLinkCandidates
 * 는 runPersonLinkInferCycle·detectPersonLinkDryRun 이 공유하던 후보 프롤로그(사람 로드 →
 * SQL 후보 → 언급/후보 필터 → top-K → 지문 → 원장 2차 제외 → existingPersonIds)를
 * 그대로 옮긴 것이다. LLM 은 절대 안 부른다.
 *
 * 검증:
 *   (a) 사람 0명 → rows [] (연결 대상 없음).
 *   (b) personCandidates 메타 있는 노드가 targetKey·inputFingerprint·topKPersonIds 동반 회신.
 *   (c) 원장 completed 기록 후 재호출 시 그 노드 제외(2차 멱등).
 *   (d) 지문이 personLinkFingerprint 산출과 일치(외부 표면 재계산 대조 재료).
 */

import { beforeAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { createEmbedder, embeddingDimensionOf } from "../embedding/factory.ts";
import type { Embedder } from "../embedding/types.ts";
import { collectPersonLinkCandidates } from "./person-link-candidate-query.ts";
import { personLinkFingerprint } from "./cleanup-deep-pass/stage-fingerprint.ts";
import { recordStageSuccess } from "./cleanup-deep-pass/stage-results-ledger.ts";

const MODEL = "bge-m3";
const STAGE_VERSION = 1;

let embedder: Embedder;
let db: Database;
let store: SqliteMemoryStore;

beforeAll(async () => {
  embedder = createEmbedder({ model: MODEL });
  await embedder.load();
});

beforeEach(() => {
  db = openMemoryDatabase(":memory:", {
    embeddingDim: embeddingDimensionOf(MODEL),
  });
  store = new SqliteMemoryStore(db, embedder);
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
    metadata: personCandidates.length > 0 ? { personCandidates } : undefined,
  });
}

function collect() {
  return collectPersonLinkCandidates({
    db,
    store,
    batchSize: 20,
    stageVersion: STAGE_VERSION,
  });
}

describe("collectPersonLinkCandidates", () => {
  test("(a) 사람 0명 → rows []", async () => {
    await addMemo("디롱이는 디스코드 봇 캐릭터다.", ["디롱이"]);

    const { people, rows } = await collect();

    expect(people).toHaveLength(0);
    expect(rows).toEqual([]);
  });

  test("(b) 후보 노드가 targetKey·fingerprint·topK 동반 회신", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const nodeId = await addMemo("민수와 회의했다.", ["민수"]);

    const { people, rows } = await collect();

    expect(people.map((p) => p.personId)).toContain(minsu.personId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(nodeId);
    expect(row.content).toBe("민수와 회의했다.");
    expect(row.personCandidates).toEqual(["민수"]);
    expect(row.targetKey).toBe(String(nodeId));
    expect(row.stageVersion).toBe(STAGE_VERSION);
    // 사람 1명(민수)만 존재 → top-K 에 민수 personId 가 실린다.
    expect(row.topKPersonIds).toEqual([minsu.personId]);
    // 아직 연결 안 됨 → existingPersonIds 비어 있음.
    expect(row.existingPersonIds).toEqual([]);
  });

  test("(c) 원장 completed 기록 후 재호출 시 그 노드 제외", async () => {
    await store.findOrCreatePersonByName("민수");
    const nodeId = await addMemo("민수를 만났다.", ["민수"]);

    const first = await collect();
    expect(first.rows.map((r) => r.id)).toEqual([nodeId]);

    // 그 노드를 원장 completed 로 심는다(사이클이 산출 낸 노드처럼).
    const row = first.rows[0]!;
    recordStageSuccess(db, {
      stage: "person_link",
      targetKey: row.targetKey,
      inputFingerprint: row.inputFingerprint,
      stageVersion: row.stageVersion,
      noop: false,
    });

    const second = await collect();
    expect(second.rows).toEqual([]);
  });

  test("(d) inputFingerprint 가 personLinkFingerprint 산출과 일치", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const nodeId = await addMemo("민수와 회의했다.", ["민수"]);

    const { rows } = await collect();
    const row = rows[0]!;
    expect(row.id).toBe(nodeId);
    const expected = personLinkFingerprint({
      content: "민수와 회의했다.",
      personCandidates: ["민수"],
      topKPersonIds: [minsu.personId],
    });
    expect(row.inputFingerprint).toBe(expected);
  });

  test("언급/후보 둘 다 없는 노드는 후보 아님", async () => {
    await store.findOrCreatePersonByName("민수");
    // 민수 언급도 없고 personCandidates 메타도 없다 → 후보에서 걸러진다.
    await addMemo("오늘 날씨가 좋다.");

    const { rows } = await collect();
    expect(rows).toEqual([]);
  });
});
