/**
 * entity-lenses.test.ts — 데이터 정리 AI 렌즈 계약 API 검증.
 *
 * 실 SQLite + 실 SqliteMemoryStore + Hono 라우트. 렌즈 조회, unknown key 거부,
 * 사람 관계 existing_only 정책, 문자열 이름 관계값 거부를 확인한다.
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
import { Hono } from "hono";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { createEmbedder, embeddingDimensionOf } from "../../embedding/factory.ts";
import type { Embedder } from "../../embedding/types.ts";
import type { MemoryApiDeps } from "../types.ts";
import { registerEntityLensRoutes } from "./entity-lenses.ts";

const MODEL = "bge-m3";

let embedder: Embedder;
let db: Database;
let store: SqliteMemoryStore;
let app: Hono;

beforeAll(async () => {
  embedder = createEmbedder({ model: MODEL });
  await embedder.load();
});

beforeEach(() => {
  db = openMemoryDatabase(":memory:", {
    embeddingDim: embeddingDimensionOf(MODEL),
  });
  store = new SqliteMemoryStore(db, embedder);
  app = new Hono({ strict: false });
  registerEntityLensRoutes(app, {
    store,
    retriever: undefined as unknown as MemoryApiDeps["retriever"],
    assembler: undefined as unknown as MemoryApiDeps["assembler"],
  });
});

afterEach(() => {
  db.close();
});

async function postJson(path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/entity-lenses", () => {
  test("project 렌즈는 참여자 관계칸을 existing_only/personId 정책으로 내려준다", async () => {
    const res = await app.request("/api/entity-lenses/project");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lens: {
        typeName: string;
        koName: string;
        relations: Array<{
          key: string;
          targetTypes: string[];
          policy: string;
        }>;
        metadataFields: Array<{ key: string }>;
      };
    };

    expect(body.lens.typeName).toBe("project");
    expect(body.lens.koName).toBe("프로젝트");
    const participants = body.lens.relations.find((r) => r.key === "참여자");
    expect(participants).toMatchObject({
      targetTypes: ["person"],
      policy: "existing_only",
    });
    expect(body.lens.metadataFields.map((f) => f.key)).toContain("event_at");
    expect(body.lens.metadataFields.map((f) => f.key)).toContain("place");
  });
});

describe("POST /api/lens-drafts/apply", () => {
  test("렌즈에 없는 relation 키는 거부하고 프로젝트를 만들지 않는다", async () => {
    const res = await postJson("/api/lens-drafts/apply", {
      typeName: "project",
      entity: { name: "Dirong" },
      relations: { 없는키: [] },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("렌즈에 없는 relations 키");
    expect(await store.listProjects({ limit: 10 })).toHaveLength(0);
  });

  test("사람 관계칸에 문자열 이름을 넣으면 거부하고 프로젝트를 만들지 않는다", async () => {
    const res = await postJson("/api/lens-drafts/apply", {
      typeName: "project",
      entity: { name: "Dirong" },
      relations: { 참여자: "민수" },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("문자열 이름이 아니라 기존 id 객체");
    expect(await store.listProjects({ limit: 10 })).toHaveLength(0);
  });

  test("기존 personId 를 참여자로 주면 프로젝트와 participant 관계만 만든다", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");

    const res = await postJson("/api/lens-drafts/apply", {
      typeName: "project",
      entity: {
        name: "Dirong",
        summary: "Discord 음성 세션을 녹음하고 STT, AI 정리까지 이어주는 앱",
      },
      relations: { 참여자: [{ personId: minsu.personId }] },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      applied: boolean;
      entityId: string;
      relationCount: number;
    };
    expect(body.applied).toBe(true);
    expect(body.relationCount).toBe(1);

    const participants = await store.listProjectParticipants(body.entityId);
    expect(participants.map((p) => p.personId)).toEqual([minsu.personId]);
    const people = await store.listPersons({ limit: 10 });
    expect(people.map((p) => p.personId)).toEqual([minsu.personId]);
  });

  test("person 렌즈는 이름만으로 새 사람을 만들 수 없다", async () => {
    const res = await postJson("/api/lens-drafts/apply", {
      typeName: "person",
      entity: { name: "디롱이" },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("새 사람 생성 불가");
    expect(await store.listPersons({ limit: 10 })).toHaveLength(0);
  });
});
