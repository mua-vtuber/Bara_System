/**
 * entity-register/apply.test.ts — 메모 하나의 반영(spec 5장) 통합 시험. 실제 SQLite + 실제 bge-m3.
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../../db/migrations.ts";
import { SqliteMemoryStore } from "../../../db/store.ts";
import { createEmbedder, embeddingDimensionOf } from "../../../embedding/factory.ts";
import type { Embedder } from "../../../embedding/types.ts";
import { getTypeSubcategories } from "../../concept-type-vocabulary.ts";
import { EntityRegisterRecordsRepository } from "./records-repository.ts";
import { applyMemoChanges, type ApplyContext } from "./apply.ts";

const MODEL = "bge-m3";
let embedder: Embedder;
let db: Database;
let store: SqliteMemoryStore;
let records: EntityRegisterRecordsRepository;

beforeAll(async () => {
  embedder = createEmbedder({ model: MODEL });
  await embedder.load();
});
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: embeddingDimensionOf(MODEL) });
  store = new SqliteMemoryStore(db, embedder);
  records = new EntityRegisterRecordsRepository(db);
});
afterEach(() => db.close());

async function memoCtx(content: string): Promise<ApplyContext> {
  const nodeId = await store.addNode({ content, sourceType: "auto_capture" });
  const node = (await store.getNode(nodeId))!;
  return { store, records, memo: { nodeId, content, createdAt: node.createdAt }, runId: "run_1", proposalId: null, decidedBy: "auto" };
}

function count(table: string): number {
  return (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

test("creates a person, a place and a schedule linked to the memo in one go", async () => {
  const ctx = await memoCtx("지은이랑 12월 24일 강남역에서 만나기로 함");
  const out = await applyMemoChanges(ctx, {
    entities: [
      { memoName: "지은", type: "person", action: { kind: "create", name: "지은", aliasFromMemo: null } },
      { memoName: "강남역", type: "place", action: { kind: "create", name: "강남역", aliasFromMemo: null } },
    ],
    schedule: { title: "지은 만남", date: "2026-12-24", dateText: "12월 24일", replaceNodeId: null },
  });
  const person = out.entities.find((e) => e.type === "person")!;
  expect(person.created).toBe(true);
  // listNodePersonEdges 의 반환 형식에는 provenance 칸이 없어 표를 직접 읽는다.
  expect(db.query("SELECT person_id, relation, provenance FROM node_person_edges WHERE node_id = ?").all(ctx.memo.nodeId)).toEqual([
    { person_id: person.id, relation: "mentions", provenance: "llm_extract" },
  ]);
  const schedule = (await store.getNode(out.scheduleNodeId!))!;
  expect(schedule.content).toBe("지은 만남");
  expect(schedule.eventAt?.slice(0, 10)).toBe("2026-12-24");
  expect(schedule.sourceType).toBe("llm_extract");
  expect(schedule.metadata.scheduleSourceNodeId).toBe(ctx.memo.nodeId);
  const lineage = db.query("SELECT relation FROM knowledge_edges WHERE source_id = ? AND target_id = ?").all(out.scheduleNodeId!, ctx.memo.nodeId);
  expect(lineage).toEqual([{ relation: "merged_into" }]);
  expect((await store.listNodePersonEdges({ nodeId: out.scheduleNodeId! })).map((e) => e.personId)).toEqual([person.id]);
  const place = out.entities.find((e) => e.type === "place")!;
  const identity = db.query("SELECT concept_id FROM entity_concept_edges WHERE entity_id = ? AND role = 'identity'").get(place.id) as { concept_id: string };
  const memoConcept = db.query("SELECT role FROM node_concept_edges WHERE node_id = ? AND concept_id = ?").get(ctx.memo.nodeId, identity.concept_id);
  expect(memoConcept).toEqual({ role: "mention" });
  const scheduleConcept = db.query("SELECT role FROM node_concept_edges WHERE node_id = ? AND concept_id = ?").get(out.scheduleNodeId!, identity.concept_id);
  expect(scheduleConcept).toEqual({ role: "mention" });
  // identity 개념은 해시태그 항목 경로(place-entity-type·place-provenance-flow)와 같은 종류 —
  // 분류 값 개념이고, 사용자가 쓴 #태그 개념으로 표시하지 않는다.
  expect(db.query("SELECT is_tag, is_classification_value FROM concept_nodes WHERE concept_id = ?").get(identity.concept_id))
    .toEqual({ is_tag: 0, is_classification_value: 1 });
  expect(records.listActiveForMemo(ctx.memo.nodeId).map((r) => r.itemKind).sort()).toEqual(["entity_created", "entity_created", "schedule_created"]);
}, 120_000);

test("linking an existing person adds the memo expression as an alias and is idempotent", async () => {
  const minsu = await store.findOrCreatePersonByName("민수");
  const ctx = await memoCtx("민수형한테 축의금 10만원 보냈다");
  const change = { memoName: "민수형", type: "person", action: { kind: "link" as const, targetId: minsu.personId, targetName: "민수", addAlias: true } };
  const first = await applyMemoChanges({ ...ctx, decidedBy: "approved" }, { entities: [change], schedule: null });
  expect(first.entities[0]!.aliasAdded).toBe("민수형");
  expect((await store.getPerson(minsu.personId))!.aliases).toContain("민수형");
  const second = await applyMemoChanges({ ...ctx, decidedBy: "approved" }, { entities: [change], schedule: null });
  expect(second.entities[0]!.recordId).toBeNull();
  expect(records.listActiveForMemo(ctx.memo.nodeId)).toHaveLength(1);
}, 120_000);

test("linking an existing place reuses its identity concept", async () => {
  const placeCtx = await memoCtx("강남역에서 밥");
  const created = await applyMemoChanges(placeCtx, {
    entities: [{ memoName: "강남역", type: "place", action: { kind: "create", name: "강남역", aliasFromMemo: null } }],
    schedule: null,
  });
  const place = created.entities[0]!;
  const ctx = await memoCtx("강남에서 또 만남");
  const out = await applyMemoChanges(ctx, {
    entities: [{ memoName: "강남", type: "place", action: { kind: "link", targetId: place.id, targetName: place.name, addAlias: true } }],
    schedule: null,
  });
  expect(out.entities[0]!.created).toBe(false);
  expect(out.entities[0]!.aliasAdded).toBe("강남");
  expect((await store.entitiesRepo.get(place.id))!.koAliases).toContain("강남");
  expect(count("entity_concept_edges")).toBe(1);
  const identity = db.query("SELECT concept_id FROM entity_concept_edges WHERE entity_id = ?").get(place.id) as { concept_id: string };
  expect(db.query("SELECT role FROM node_concept_edges WHERE node_id = ? AND concept_id = ?").get(ctx.memo.nodeId, identity.concept_id))
    .toEqual({ role: "mention" });
}, 120_000);

test("a failure in the middle rolls back every row of that memo", async () => {
  const ctx = await memoCtx("민수와 철수가 왔다");
  await expect(
    applyMemoChanges(ctx, {
      entities: [
        { memoName: "민수", type: "person", action: { kind: "create", name: "민수", aliasFromMemo: null } },
        { memoName: "철수", type: "person", action: { kind: "link", targetId: "psn_missing", targetName: "철수", addAlias: false } },
      ],
      schedule: null,
    }),
  ).rejects.toThrow("psn_missing");
  expect(db.query("SELECT COUNT(*) AS n FROM persons").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM node_person_edges").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM entity_register_records").get()).toEqual({ n: 0 });
  expect(db.inTransaction).toBe(false);
}, 120_000);

test("a failure after an entity row and its edges were written leaves only the prepared concept behind", async () => {
  const ctx = await memoCtx("민수랑 강남역에서 12월 24일 만남");
  const nodesBefore = count("knowledge_nodes");
  await expect(
    applyMemoChanges(ctx, {
      entities: [
        { memoName: "강남역", type: "place", action: { kind: "create", name: "강남역", aliasFromMemo: null } },
        { memoName: "민수", type: "person", action: { kind: "create", name: "민수", aliasFromMemo: null } },
        { memoName: "철수", type: "person", action: { kind: "link", targetId: "psn_missing", targetName: "철수", addAlias: false } },
      ],
      schedule: { title: "민수 만남", date: "2026-12-24", dateText: "12월 24일", replaceNodeId: null },
    }),
  ).rejects.toThrow("psn_missing");
  expect(count("entities")).toBe(0);
  expect(count("persons")).toBe(0);
  expect(count("entity_concept_edges")).toBe(0);
  expect(count("node_concept_edges")).toBe(0);
  expect(count("node_person_edges")).toBe(0);
  expect(count("entity_register_records")).toBe(0);
  expect(count("knowledge_nodes")).toBe(nodesBefore);
  expect(db.inTransaction).toBe(false);
  // 알려진 한계(사용자 수용): 임베딩이 필요한 identity 개념은 트랜잭션 전에 확보하므로 남을 수 있다.
  expect(db.query("SELECT COUNT(*) AS n FROM concept_nodes WHERE name = ?").get("강남역")).toEqual({ n: 1 });
}, 120_000);

test("a missing link target entity throws before anything is written", async () => {
  const ctx = await memoCtx("강남역에서 밥");
  await expect(
    applyMemoChanges(ctx, {
      entities: [{ memoName: "강남역", type: "place", action: { kind: "link", targetId: "plc_missing", targetName: "강남역", addAlias: false } }],
      schedule: null,
    }),
  ).rejects.toThrow("plc_missing");
  expect(count("concept_nodes")).toBe(0);
}, 120_000);

test("a folder word is skipped with the gate's reason, not created", async () => {
  const folder = getTypeSubcategories("work")[0]!;
  const ctx = await memoCtx(`${folder} 을 읽었다`);
  const out = await applyMemoChanges(ctx, {
    entities: [{ memoName: folder, type: "work", action: { kind: "create", name: folder, aliasFromMemo: null } }],
    schedule: null,
  });
  expect(out.entities).toEqual([]);
  expect(out.skipped[0]!.reason).toContain(folder);
}, 120_000);

test("replacing a schedule trashes the old node and marks its record reverted", async () => {
  const ctx = await memoCtx("민수가 11월 3일 결혼한다더라");
  const first = await applyMemoChanges(ctx, { entities: [], schedule: { title: "민수 결혼", date: "2026-11-02", dateText: "11월 3일", replaceNodeId: null } });
  const second = await applyMemoChanges({ ...ctx, decidedBy: "approved" }, {
    entities: [],
    schedule: { title: "민수 결혼", date: "2026-11-03", dateText: "11월 3일", replaceNodeId: first.scheduleNodeId },
  });
  expect(await store.getNode(first.scheduleNodeId!)).toBeNull();
  expect(await store.getNode(ctx.memo.nodeId)).not.toBeNull();
  expect(records.get(first.scheduleRecordId!)!.status).toBe("reverted");
  expect(records.activeScheduleForMemo(ctx.memo.nodeId)!.nodeId).toBe(second.scheduleNodeId!);
}, 120_000);

test("replacing a schedule that is not this memo's active schedule throws and writes nothing", async () => {
  const ctx = await memoCtx("민수가 11월 3일 결혼한다더라");
  const first = await applyMemoChanges(ctx, { entities: [], schedule: { title: "민수 결혼", date: "2026-11-03", dateText: "11월 3일", replaceNodeId: null } });
  const nodesBefore = count("knowledge_nodes");
  const conceptsBefore = count("concept_nodes");
  await expect(
    applyMemoChanges(ctx, {
      entities: [{ memoName: "강남역", type: "place", action: { kind: "create", name: "강남역", aliasFromMemo: null } }],
      schedule: { title: "민수 결혼", date: "2026-11-04", dateText: "11월 3일", replaceNodeId: first.scheduleNodeId! + 1000 },
    }),
  ).rejects.toThrow(String(first.scheduleNodeId! + 1000));
  expect(count("knowledge_nodes")).toBe(nodesBefore);
  // 일정 검사가 개념 확보보다 먼저라 새 개념 행도 남지 않는다.
  expect(count("concept_nodes")).toBe(conceptsBefore);
  expect(records.activeScheduleForMemo(ctx.memo.nodeId)!.nodeId).toBe(first.scheduleNodeId!);
}, 120_000);

test("an excluded type (schedule, project) is refused before anything is written", async () => {
  for (const type of ["schedule", "project"]) {
    const ctx = await memoCtx(`${type} 메모 결혼식`);
    await expect(
      applyMemoChanges(ctx, {
        entities: [
          { memoName: "강남역", type: "place", action: { kind: "create", name: "강남역", aliasFromMemo: null } },
          { memoName: "결혼식", type, action: { kind: "create", name: "결혼식", aliasFromMemo: null } },
        ],
        schedule: null,
      }),
    ).rejects.toThrow(new RegExp(`${ctx.memo.nodeId}.*${type}`));
  }
  expect(count("concept_nodes")).toBe(0);
  expect(count("entities")).toBe(0);
  expect(count("entity_register_records")).toBe(0);
}, 120_000);

test("an alias that already exists in another normal form is not recorded as added", async () => {
  const minsu = await store.findOrCreatePersonByName("민수");
  await store.addPersonAlias(minsu.personId, "민수형");
  const aliasesBefore = (await store.getPerson(minsu.personId))!.aliases;
  const ctx = await memoCtx("민수형한테 연락함");
  const padded = ` ${"민수형".normalize("NFD")} `;
  const out = await applyMemoChanges(ctx, {
    entities: [{ memoName: padded, type: "person", action: { kind: "link", targetId: minsu.personId, targetName: "민수", addAlias: true } }],
    schedule: null,
  });
  expect(out.entities[0]!.aliasAdded).toBeNull();
  expect((await store.getPerson(minsu.personId))!.aliases).toEqual(aliasesBefore);
  const [record] = records.listActiveForMemo(ctx.memo.nodeId);
  expect(record!.itemKind).toBe("entity_linked");
  expect(record!.detail.aliasAdded).toBeNull();
}, 120_000);

test("a failure after the schedule node is inserted rolls back the node, its vector, lineage and sources", async () => {
  const ctx = await memoCtx("민수랑 강남역에서 12월 24일 만남");
  await applyMemoChanges(ctx, {
    entities: [{ memoName: "강남역", type: "place", action: { kind: "create", name: "강남역", aliasFromMemo: null } }],
    schedule: null,
  });
  // 앞서 이은 장소의 identity 엣지를 지워, 일정 노드를 넣은 뒤 그 장소에 이을 때 실패하게 만든다.
  db.run("DELETE FROM entity_concept_edges");
  const tables = ["knowledge_nodes", "vec_nodes", "knowledge_edges", "memory_node_sources", "persons", "entities",
    "entity_concept_edges", "node_concept_edges", "node_person_edges", "entity_register_records"];
  const before = Object.fromEntries(tables.map((t) => [t, count(t)]));
  await expect(
    applyMemoChanges(ctx, {
      entities: [{ memoName: "민수", type: "person", action: { kind: "create", name: "민수", aliasFromMemo: null } }],
      schedule: { title: "민수 만남", date: "2026-12-24", dateText: "12월 24일", replaceNodeId: null },
    }),
  ).rejects.toThrow("identity 개념이 없음");
  expect(Object.fromEntries(tables.map((t) => [t, count(t)]))).toEqual(before);
  expect(db.inTransaction).toBe(false);
}, 120_000);

test("a person whose stored alias and display name are NFD gets no alias record for the NFC form", async () => {
  const db2 = store.getRawDb();
  const minsu = await store.findOrCreatePersonByName("민수");
  // 옛 경로(findOrCreatePerson 은 trim 만 한다)로 들어온 조합형 저장값을 흉내 낸다.
  db2.query("UPDATE persons SET display_name = ?, aliases = ? WHERE person_id = ?")
    .run("민수".normalize("NFD"), JSON.stringify(["민수".normalize("NFD"), "민수형".normalize("NFD")]), minsu.personId);
  const aliasesBefore = (await store.getPerson(minsu.personId))!.aliases;
  for (const memoName of ["민수형", "민수"]) {
    const ctx = await memoCtx(`${memoName}한테 연락함`);
    const out = await applyMemoChanges(ctx, {
      entities: [{ memoName, type: "person", action: { kind: "link", targetId: minsu.personId, targetName: "민수", addAlias: true } }],
      schedule: null,
    });
    expect(out.entities[0]!.aliasAdded).toBeNull();
    expect(records.listActiveForMemo(ctx.memo.nodeId)[0]!.detail.aliasAdded).toBeNull();
  }
  expect((await store.getPerson(minsu.personId))!.aliases).toEqual(aliasesBefore);
}, 120_000);

test("an entity alias already stored in NFD is not stacked again in NFC", async () => {
  const placeCtx = await memoCtx("강남역에서 밥");
  const created = await applyMemoChanges(placeCtx, {
    entities: [{ memoName: "강남역", type: "place", action: { kind: "create", name: "강남역", aliasFromMemo: null } }],
    schedule: null,
  });
  const place = created.entities[0]!;
  store.entitiesRepo.setKoAliases(place.id, ["강남".normalize("NFD")]);
  const ctx = await memoCtx("강남에서 또 만남");
  const out = await applyMemoChanges(ctx, {
    entities: [{ memoName: "강남", type: "place", action: { kind: "link", targetId: place.id, targetName: place.name, addAlias: true } }],
    schedule: null,
  });
  expect(out.entities[0]!.aliasAdded).toBeNull();
  expect((await store.entitiesRepo.get(place.id))!.koAliases).toEqual(["강남".normalize("NFD")]);
  expect(records.listActiveForMemo(ctx.memo.nodeId)[0]!.detail.aliasAdded).toBeNull();
}, 120_000);
