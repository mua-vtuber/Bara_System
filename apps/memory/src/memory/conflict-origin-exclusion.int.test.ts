/**
 * conflict-origin-exclusion.int.test.ts — 충돌 후보의 원문 제외 규칙 (WP-B1-20T T6, 설계 5.11 · D13, QA M1).
 *
 * 새 기억 N 의 충돌 검사에서 추출 원문 O 와 그 자식 C 가 둘 다 후보일 때, 원문을 빼는 판정은 유사도 판정
 * 뒤에, 충돌 쌍이 된 후보들 사이에서만 한다.
 *  - O 와 C 가 둘 다 쌍이면 C 만 잇는다(C 가 O 본문에서 뽑힌 더 구체적인 현재 주장).
 *  - O 만 쌍이면(C 는 다른 주장) O 를 잇는다 — 옛 B1-10S 규칙은 C 가 후보이기만 해도 O 를 빼서 실제 충돌을 잃었다.
 *  - 원자 -> 원문 엣지의 provenance 가 regex 면 규칙 대상이 아니라, 원자와 원문이 둘 다 쌍이면 둘 다 잇는다.
 *  - check 한 번이 벡터 일괄 읽기 1회와 쌍 사이 엣지 일괄 읽기 1회만 한다(후보 수와 무관).
 *
 * 실제 bge-m3 + 실제 SQLite(in-memory) + 실제 ConflictChecker. 계보 엣지는 실제 SQLite 행(merged_into)을
 * 데이터로 넣는다. 문장 쌍의 bge-m3 유사도는 주석에 실측값을 적었고(실행 간 +-0.04 변동 가능), 각 테스트가
 * 쌍 여부의 전제를 단언으로 먼저 확인한다 — 모델이 바뀌어 전제가 깨지면 규칙 단언이 아니라 전제 단언에서
 * 설명 가능한 형태로 실패한다.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { cosineSimilarity } from "../embedding/vector-utils.ts";
import { EMBEDDING_CONFLICT_THRESHOLDS } from "../embedding/factory.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { ConflictChecker } from "./conflict-checker.ts";
import { REGEX_ATOM_SOURCE, readSharedMemory } from "./shared-memory-contract.ts";
import type { Provenance } from "./provenance-vocabulary.ts";
import type { SourceType } from "./types.ts";

const BGE_M3 = EMBEDDING_CONFLICT_THRESHOLDS["bge-m3"];
const AUTHOR = "owner";
/** (b) 전용 좁은 충돌 범위 — 원문은 안쪽, 후보에 든(FTS) 다른 주장 자식은 확실히 바깥이 되도록 주입한다. */
const NARROW_SIM_LOW = 0.7;
const NARROW_SIM_HIGH = 0.95;

// (a)(d) 원문 O -> 자식 C. N 과의 유사도: O 0.675, C 0.754, 독립 후보 X 0.617 (모두 충돌 범위).
const ORIGIN_TEXT = "답변은 한국어로 해 주세요. 코드 주석도 한국어로 남겨 주세요.";
const CHILD_TEXT = "답변은 한국어로 해 주세요";
const OPPOSING_TEXT = "앞으로 답변은 영어로 받고 싶다";
const INDEPENDENT_TEXT = "답변은 짧게 해 주세요";
// (b) 원문 O 는 두 주장을 담고, 자식 C 는 그중 두 번째 주장이다. N 은 O 의 첫 주장과 어긋난다.
// N 과의 유사도: O 0.819, C 0.585 — C 는 FTS 후보에 들지만 좁은 범위(0.70 이상) 밖이다.
const TWO_CLAIM_ORIGIN_TEXT = "배포는 금요일 오후에 한다. 롤백 담당은 운영팀이 맡는다.";
const OTHER_CLAIM_CHILD_TEXT = "롤백 담당은 운영팀이 맡는다";
const FIRST_CLAIM_OPPOSING_TEXT = "배포는 목요일 오전에 한다 운영팀";
// (c) 원문 O 와 그 regex 원자 A. N 과의 유사도: O 0.757, A 0.731.
const NOTICE_ORIGIN_TEXT = "배포 알림은 앞으로 운영팀 채널로 보내기로 확정했다.";
const NOTICE_ATOM_TEXT = "운영팀 채널로 보내기로 확정했다.";
const NOTICE_OPPOSING_TEXT = "알림은 개발팀 채널로 보낸다";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let db: Database;
let store: SqliteMemoryStore;
let checker: ConflictChecker;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  checker = new ConflictChecker(store, { simLow: BGE_M3.conflictLow, simHigh: BGE_M3.conflictHigh });
});
afterEach(() => db.close());

function addFact(content: string, sourceType: SourceType, metadata?: Record<string, unknown>): Promise<number> {
  return store.addNode({ content, memoryType: "fact", sourceType, author: AUTHOR, ...(metadata ? { metadata } : {}) });
}

/** 추출 자식(또는 원자) -> 원문 계보 엣지. */
function mergedInto(child: number, origin: number, provenance: Provenance): Promise<void> {
  return store.addEdge({ sourceId: child, targetId: origin, relation: "merged_into", provenance, sourceNodeId: origin, weight: 1 });
}

async function similarity(a: number, b: number): Promise<number> {
  return cosineSimilarity((await store.getVectorById(a))!, (await store.getVectorById(b))!);
}

/** 새 기억 n 의 충돌 검사 — 새 기억의 본문과 벡터로 부른다(저장 경로와 같은 인자). */
async function checkNew(target: ConflictChecker, newNodeId: number): Promise<number> {
  const node = (await store.getNode(newNodeId))!;
  return target.check({
    newNodeId, content: node.content, author: node.author, memoryType: "fact",
    newVector: (await store.getVectorById(newNodeId))!,
  });
}

function contradictTargets(newNodeId: number): number[] {
  return (db.query("SELECT target_id FROM knowledge_edges WHERE relation = 'contradicts' AND source_id = ? ORDER BY target_id")
    .all(newNodeId) as Array<{ target_id: number }>).map((row) => row.target_id);
}

const ascending = (ids: number[]) => [...ids].sort((a, b) => a - b);

async function expectInBand(a: number, b: number, low = BGE_M3.conflictLow, high = BGE_M3.conflictHigh): Promise<void> {
  const sim = await similarity(a, b);
  expect(sim).toBeGreaterThanOrEqual(low);
  expect(sim).toBeLessThan(high);
}

describe("충돌 후보의 원문 제외 (설계 5.11)", () => {
  test("(a) 새 기억이 원문과 자식 둘 다와 충돌 쌍이면 자식만 잇는다", async () => {
    const origin = await addFact(ORIGIN_TEXT, "auto_capture");
    const child = await addFact(CHILD_TEXT, "llm_extract");
    await mergedInto(child, origin, "system");
    const n = await addFact(OPPOSING_TEXT, "user_explicit");
    await expectInBand(n, origin);
    await expectInBand(n, child);

    expect(await checkNew(checker, n)).toBe(1);

    expect(contradictTargets(n)).toEqual([child]);
    expect(readSharedMemory((await store.getNode(n))!.metadata)).toMatchObject({ status: "disputed", revision: 1 });
    expect(readSharedMemory((await store.getNode(origin))!.metadata)).toMatchObject({ status: "active", revision: 0 });
    expect(db.query("SELECT old_node_id FROM memory_revisions WHERE new_node_id = ?").all(n)).toEqual([{ old_node_id: child }]);
  });

  test("(b) 새 기억이 원문과만 충돌 쌍이고 자식은 다른 주장이면 원문을 잇는다(옛 규칙은 이 충돌을 잃었다)", async () => {
    const narrow = new ConflictChecker(store, { simLow: NARROW_SIM_LOW, simHigh: NARROW_SIM_HIGH });
    const origin = await addFact(TWO_CLAIM_ORIGIN_TEXT, "auto_capture");
    const child = await addFact(OTHER_CLAIM_CHILD_TEXT, "llm_extract");
    await mergedInto(child, origin, "system");
    const n = await addFact(FIRST_CLAIM_OPPOSING_TEXT, "user_explicit");
    await expectInBand(n, origin, NARROW_SIM_LOW, NARROW_SIM_HIGH);
    expect(await similarity(n, child)).toBeLessThan(NARROW_SIM_LOW);
    // 자식은 사전 필터를 통과한 후보다 — 옛 규칙은 자식이 후보이기만 해도 원문을 뺐다.
    const ftsIds = (await store.ftsSearch(FIRST_CLAIM_OPPOSING_TEXT, 10)).map(([id]) => id);
    expect(ftsIds).toContain(origin);
    expect(ftsIds).toContain(child);

    expect(await checkNew(narrow, n)).toBe(1);

    expect(contradictTargets(n)).toEqual([origin]);
    expect(readSharedMemory((await store.getNode(n))!.metadata)).toMatchObject({ status: "disputed", revision: 1 });
  });

  test("(c) regex 원자와 원문이 둘 다 충돌 쌍이면 둘 다 잇는다", async () => {
    const origin = await addFact(NOTICE_ORIGIN_TEXT, "auto_capture");
    const atom = await addFact(NOTICE_ATOM_TEXT, "auto_capture", { source: REGEX_ATOM_SOURCE });
    await mergedInto(atom, origin, "regex");
    const n = await addFact(NOTICE_OPPOSING_TEXT, "user_explicit");
    await expectInBand(n, origin);
    await expectInBand(n, atom);

    expect(await checkNew(checker, n)).toBe(2);

    expect(contradictTargets(n)).toEqual(ascending([origin, atom]));
    expect(readSharedMemory((await store.getNode(n))!.metadata)).toMatchObject({ status: "disputed", revision: 2 });
  });

  test("(c') 같은 모양이어도 엣지 provenance 가 regex 가 아니면 원문을 뺀다 — 규칙은 provenance 로 갈린다", async () => {
    const origin = await addFact(NOTICE_ORIGIN_TEXT, "auto_capture");
    const atom = await addFact(NOTICE_ATOM_TEXT, "auto_capture", { source: REGEX_ATOM_SOURCE });
    await mergedInto(atom, origin, "system");
    const n = await addFact(NOTICE_OPPOSING_TEXT, "user_explicit");

    expect(await checkNew(checker, n)).toBe(1);

    expect(contradictTargets(n)).toEqual([atom]);
  });

  test("(d) check 한 번은 벡터 일괄 읽기 1회와 쌍 사이 엣지 일괄 읽기 1회만 한다 — 후보가 셋이어도 같다", async () => {
    const origin = await addFact(ORIGIN_TEXT, "auto_capture");
    const child = await addFact(CHILD_TEXT, "llm_extract");
    await mergedInto(child, origin, "system");
    const independent = await addFact(INDEPENDENT_TEXT, "user_explicit");
    const n = await addFact(OPPOSING_TEXT, "user_explicit");
    for (const candidate of [origin, child, independent]) await expectInBand(n, candidate);

    const before = checker.readCounts;
    expect(await checkNew(checker, n)).toBe(2);
    const after = checker.readCounts;

    expect(after.vectorReads - before.vectorReads).toBe(1);
    expect(after.edgeReads - before.edgeReads).toBe(1);
    expect(contradictTargets(n)).toEqual(ascending([child, independent]));
  });

  test("(d') 충돌 쌍이 하나뿐이면 비교할 쌍이 없어 엣지를 읽지 않는다(벡터는 1회)", async () => {
    const origin = await addFact(ORIGIN_TEXT, "auto_capture");
    const n = await addFact(OPPOSING_TEXT, "user_explicit");
    await expectInBand(n, origin);

    const before = checker.readCounts;
    expect(await checkNew(checker, n)).toBe(1);
    const after = checker.readCounts;

    expect(after.vectorReads - before.vectorReads).toBe(1);
    expect(after.edgeReads - before.edgeReads).toBe(0);
    expect(contradictTargets(n)).toEqual([origin]);
  });
});
