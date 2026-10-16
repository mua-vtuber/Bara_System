/**
 * memories-crud.place.test.ts — GET /memories/:id 가 장소(place/places)를 싣는지.
 *
 * 대시보드 정리 제안 검토 화면이 metadata_fill 의 "현재 값"을 보이려고 쓴다. 실 :memory:
 * SQLite 에 장소 연결을 SQL 로 직접 넣고(임베딩 모델 불필요), 라우트는 getNode 한 메서드만
 * 가진 최소 store 로 돌린다(cleanup-proposals.test.ts 선례 — getRawDb 는 실 DB).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { listNodePlaces } from "../../memory/node-places.ts";
import { registerMemoriesCrudRoutes } from "./memories-crud.ts";
import type { MemoryApiDeps } from "../types.ts";
import type { SqliteMemoryStore } from "../../db/store.ts";

let db: Database;
let app: Hono;

function addNode(content: string): number {
  return Number(
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES (?)").run(content).lastInsertRowid,
  );
}

function addConcept(id: string, name: string, flags: { key?: boolean } = {}): void {
  db.prepare(
    "INSERT INTO concept_nodes (concept_id, name, is_classification_key) VALUES (?, ?, ?)",
  ).run(id, name, flags.key ? 1 : 0);
}

function tagNode(nodeId: number, conceptId: string): void {
  db.prepare(
    "INSERT INTO node_concept_edges (node_id, concept_id, role, provenance) VALUES (?, ?, 'classification', 'user_input')",
  ).run(nodeId, conceptId);
}

/** 경로1 — 추론 분류: '장소' 키 개념 아래 값 개념. */
function addHierarchyPlace(nodeId: number, valueName: string): void {
  if (!db.prepare("SELECT 1 FROM concept_nodes WHERE concept_id = 'cpt_key'").get()) {
    addConcept("cpt_key", "장소", { key: true });
  }
  const id = `cpt_${valueName}`;
  addConcept(id, valueName);
  db.prepare(
    "INSERT INTO hierarchy_edges (source_type, source_id, target_type, target_id, relation, provenance) VALUES ('concept', 'cpt_key', 'concept', ?, 'parent_of', 'user_input')",
  ).run(id);
  tagNode(nodeId, id);
}

/** 경로2 — place 엔티티 잎 개념(직접 입력). */
function addEntityPlace(nodeId: number, name: string): void {
  const conceptId = `cpt_ent_${name}`;
  addConcept(conceptId, name);
  db.prepare("INSERT INTO entities (entity_id, type_name, name) VALUES (?, 'place', ?)").run(
    `ent_${name}`,
    name,
  );
  db.prepare(
    "INSERT INTO entity_concept_edges (entity_id, concept_id, role, provenance) VALUES (?, ?, 'identity', 'user_input')",
  ).run(`ent_${name}`, conceptId);
  tagNode(nodeId, conceptId);
}

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
  const store = {
    getRawDb: () => db,
    getNode: async (id: number) => {
      const row = db
        .prepare("SELECT id, content FROM knowledge_nodes WHERE id = ?")
        .get(id) as { id: number; content: string } | null;
      return row ? { ...row, metadata: {} } : null;
    },
  } as unknown as SqliteMemoryStore;
  app = new Hono({ strict: false });
  registerMemoriesCrudRoutes(app, { store } as unknown as MemoryApiDeps);
});

afterEach(() => {
  db.close();
});

describe("listNodePlaces", () => {
  test("장소가 없으면 빈 배열", () => {
    expect(listNodePlaces(db, addNode("메모"))).toEqual([]);
  });

  test("분류 위계·place 엔티티 두 경로를 합쳐 이름순으로 돌려준다", () => {
    const id = addNode("메모");
    addHierarchyPlace(id, "에버랜드");
    addEntityPlace(id, "속초");
    expect(listNodePlaces(db, id)).toEqual(["속초", "에버랜드"].sort());
  });

  test("'장소' 가 아닌 분류 값은 장소로 보지 않는다", () => {
    const id = addNode("메모");
    addConcept("cpt_other_key", "종류", { key: true });
    addConcept("cpt_other_val", "일기");
    db.prepare(
      "INSERT INTO hierarchy_edges (source_type, source_id, target_type, target_id, relation, provenance) VALUES ('concept', 'cpt_other_key', 'concept', 'cpt_other_val', 'parent_of', 'user_input')",
    ).run();
    tagNode(id, "cpt_other_val");
    expect(listNodePlaces(db, id)).toEqual([]);
  });
});

describe("GET /memories/:id — place/places", () => {
  test("장소가 있으면 place(첫 값)와 places(전부)를 싣고 기존 칸은 그대로다", async () => {
    const id = addNode("롯데월드 갔다");
    addHierarchyPlace(id, "롯데월드");
    const res = await app.request(`/memories/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memory: Record<string, unknown> };
    expect(body.memory.id).toBe(id);
    expect(body.memory.content).toBe("롯데월드 갔다");
    expect(body.memory.editableContent).toBe("롯데월드 갔다");
    expect(body.memory.place).toBe("롯데월드");
    expect(body.memory.places).toEqual(["롯데월드"]);
  });

  test("장소가 없으면 place:null, places:[]", async () => {
    const id = addNode("장소 없는 글");
    const body = (await (await app.request(`/memories/${id}`)).json()) as {
      memory: Record<string, unknown>;
    };
    expect(body.memory.place).toBeNull();
    expect(body.memory.places).toEqual([]);
  });
});

describe("GET /memories/:id — 대시보드 정보 블록이 읽는 칸", () => {
  test("작성자·저장 경로·일정·metadata.fieldSources(출처)를 노드 그대로 싣는다", async () => {
    const id = addNode("속초 여행");
    addEntityPlace(id, "속초");
    const store = {
      getRawDb: () => db,
      getNode: async (nodeId: number) => ({
        id: nodeId, content: "속초 여행", author: "민수", platform: "mcp",
        eventAt: "2026-10-20", eventUntil: null,
        metadata: { fieldSources: { place: "direct", event_at: "system" } },
      }),
    } as unknown as SqliteMemoryStore;
    const infoApp = new Hono({ strict: false });
    registerMemoriesCrudRoutes(infoApp, { store } as unknown as MemoryApiDeps);

    const body = (await (await infoApp.request(`/memories/${id}`)).json()) as {
      memory: Record<string, unknown> & { metadata: { fieldSources: Record<string, string> } };
    };
    expect(body.memory.author).toBe("민수");
    expect(body.memory.platform).toBe("mcp");
    expect(body.memory.eventAt).toBe("2026-10-20");
    expect(body.memory.places).toEqual(["속초"]);
    expect(body.memory.metadata.fieldSources).toEqual({ place: "direct", event_at: "system" });
  });
});
