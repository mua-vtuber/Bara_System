/**
 * lens-apply.test.ts — 렌즈 초안 검증·적용 공유 함수 검증 (spec 6.C-2 선행 정비 6종).
 *
 * 실 SQLite + 실 SqliteMemoryStore + 실 bge-m3 임베더(mock 클래스 0). buildEntityLens
 * 산출을 LensApplyView 로 좁혀 applyLensDraft 를 직접 부른다(HTTP 자기호출 없음). 6종
 * 처방을 각각 단언한다:
 *   1. 전 검증 후 단일 트랜잭션 — 부분 실패 시 앞 쓰기까지 전부 롤백(아무 것도 안 남음).
 *   2. AI 경로는 기존 entityId 필수 — 없는 id 는 거부.
 *   3. fill-only — 채워진 칸은 안 덮고, overwriteColumns 지정 칸만 덮는다.
 *   4. person columns 계약 정합 — person 렌즈는 columns 미광고 + 적용도 거부.
 *   5. dataType 검증 — date 칸에 형식 어긋난 값 거부.
 *   6. 오래된 초안 방어 — fingerprint 어긋나면 적용 거부.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { createEmbedder, embeddingDimensionOf } from "../../embedding/factory.ts";
import type { Embedder } from "../../embedding/types.ts";
import type { MemoryApiDeps } from "../../server-internal/types.ts";
import { buildEntityLens } from "../../server-internal/routes/entity-lenses.ts";
import { lensDraftFingerprint } from "./stage-fingerprint.ts";
import {
  applyLensDraft,
  LensApplyError,
  serializeEntityStructuredValue,
  type LensApplyView,
  type LensDraftValues,
} from "./lens-apply.ts";

const MODEL = "bge-m3";

let embedder: Embedder;
let db: Database;
let store: SqliteMemoryStore;
let deps: MemoryApiDeps;

beforeAll(async () => {
  embedder = createEmbedder({ model: MODEL });
  await embedder.load();
});

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: embeddingDimensionOf(MODEL) });
  store = new SqliteMemoryStore(db, embedder);
  deps = {
    store,
    retriever: undefined as unknown as MemoryApiDeps["retriever"],
    assembler: undefined as unknown as MemoryApiDeps["assembler"],
  };
});

afterEach(() => {
  db.close();
});

/** buildEntityLens 산출을 적용 함수용 LensApplyView 로 좁힌다(route toApplyView 와 동형). */
function applyView(typeName: string): LensApplyView {
  const lens = buildEntityLens(typeName);
  return {
    typeName: lens.typeName,
    columns: lens.columns.map((c) => ({ key: c.key, dataType: c.dataType })),
    attributeKeys: lens.attributes.map((a) => a.key),
    relations: lens.relations.map((r) => ({
      key: r.key,
      relation: r.relation,
      targetTypes: r.targetTypes,
      defaultTargetType: r.defaultTargetType,
    })),
    metadataKeys: lens.metadataFields.map((m) => m.key),
  };
}

function emptyValues(partial: Partial<LensDraftValues>): LensDraftValues {
  return {
    columns: partial.columns ?? {},
    labels: partial.labels ?? {},
    relations: partial.relations ?? {},
    metadata: partial.metadata ?? {},
  };
}

describe("point 2 — AI 경로는 기존 entityId 필수", () => {
  test("존재하지 않는 entityId 는 aiPath=true 에서 거부한다", async () => {
    await expect(
      applyLensDraft(deps, {
        lens: applyView("material"),
        entityId: "mat_nonexistent",
        values: emptyValues({ columns: { 주제: "그래프" } }),
        sourceNodeId: null,
        aiPath: true,
      }),
    ).rejects.toBeInstanceOf(LensApplyError);
    // 후보 종류 엔티티가 새로 생기지 않았다.
    const list = await store.entitiesRepo.list("material", { limit: 10 });
    expect(list).toHaveLength(0);
  });

  test("기존 entityId 는 aiPath=true 에서 통과한다", async () => {
    const ent = await store.entitiesRepo.findOrCreateEntity("material", "자료A");
    const res = await applyLensDraft(deps, {
      lens: applyView("material"),
      entityId: ent.id,
      values: emptyValues({ columns: { 주제: "그래프 이론" } }),
      sourceNodeId: null,
      aiPath: true,
    });
    expect(res.applied).toBe(true);
    const cols = store.entitiesRepo.listAttributes(ent.id).filter((a) => a.isColumn);
    expect(cols.find((c) => c.key === "주제")?.value).toBe("그래프 이론");
  });
});

describe("point 3 — fill-only 칸 단위 병합", () => {
  test("이미 채워진 칸은 덮지 않는다(overwrite 미지정)", async () => {
    const ent = await store.entitiesRepo.findOrCreateEntity("material", "자료B");
    store.entitiesRepo.setAttribute(ent.id, "주제", "원래주제", true);

    await applyLensDraft(deps, {
      lens: applyView("material"),
      entityId: ent.id,
      values: emptyValues({ columns: { 주제: "새주제" } }),
      sourceNodeId: null,
      aiPath: true,
    });

    const cols = store.entitiesRepo.listAttributes(ent.id).filter((a) => a.isColumn);
    expect(cols.find((c) => c.key === "주제")?.value).toBe("원래주제");
  });

  test("overwriteColumns 에 든 칸은 덮는다", async () => {
    const ent = await store.entitiesRepo.findOrCreateEntity("material", "자료C");
    store.entitiesRepo.setAttribute(ent.id, "주제", "원래주제", true);

    await applyLensDraft(deps, {
      lens: applyView("material"),
      entityId: ent.id,
      values: emptyValues({ columns: { 주제: "덮은주제" } }),
      sourceNodeId: null,
      aiPath: true,
      overwriteColumns: new Set(["주제"]),
    });

    const cols = store.entitiesRepo.listAttributes(ent.id).filter((a) => a.isColumn);
    expect(cols.find((c) => c.key === "주제")?.value).toBe("덮은주제");
  });

  test("빈 칸은 채운다", async () => {
    const ent = await store.entitiesRepo.findOrCreateEntity("material", "자료D");
    await applyLensDraft(deps, {
      lens: applyView("material"),
      entityId: ent.id,
      values: emptyValues({ columns: { 주제: "채운값" } }),
      sourceNodeId: null,
      aiPath: true,
    });
    const cols = store.entitiesRepo.listAttributes(ent.id).filter((a) => a.isColumn);
    expect(cols.find((c) => c.key === "주제")?.value).toBe("채운값");
  });

  test("project 렌즈는 columns 를 광고하지 않아 columns 초안은 렌즈 밖 키로 거부된다", async () => {
    // 프로젝트 구조화 값은 참여자 관계 + metadata 로 흐른다(project 렌즈 columns=[]).
    // 그래서 project attributes 통째 교체 위험(spec point 3)은 lens 경로로는 도달 불가다 —
    // per-key 병합 구현은 방어로 남기되, project columns 자체가 렌즈 밖 키로 먼저 걸린다.
    expect(buildEntityLens("project").columns).toHaveLength(0);
    const project = await store.findOrCreateProject({ name: "Dirong" });
    await expect(
      applyLensDraft(deps, {
        lens: applyView("project"),
        entityId: project.projectId,
        values: emptyValues({ columns: { 저장소: "github" } }),
        sourceNodeId: null,
        aiPath: true,
      }),
    ).rejects.toBeInstanceOf(LensApplyError);
  });
});

describe("point 4 — person columns 계약 정합", () => {
  test("person 렌즈는 columns 를 광고하지 않는다", () => {
    const lens = buildEntityLens("person");
    expect(lens.columns).toHaveLength(0);
  });

  test("person 렌즈에 columns 를 넣으면 렌즈 밖 키로 거부한다", async () => {
    const person = await store.findOrCreatePersonByName("민수");
    await expect(
      applyLensDraft(deps, {
        lens: applyView("person"),
        entityId: person.personId,
        values: emptyValues({ columns: { 생일: "1990-01-01" } }),
        sourceNodeId: null,
        aiPath: true,
      }),
    ).rejects.toBeInstanceOf(LensApplyError);
  });
});

describe("point 5 — dataType 검증", () => {
  test("date 칸에 형식 어긋난 값은 거부한다", async () => {
    const ent = await store.entitiesRepo.findOrCreateEntity("intake", "우유");
    await expect(
      applyLensDraft(deps, {
        lens: applyView("intake"),
        entityId: ent.id,
        values: emptyValues({ columns: { 유통기한: "내일" } }),
        sourceNodeId: null,
        aiPath: true,
      }),
    ).rejects.toBeInstanceOf(LensApplyError);
    // 거부됐으니 칸이 안 써졌다.
    const cols = store.entitiesRepo.listAttributes(ent.id).filter((a) => a.isColumn);
    expect(cols.find((c) => c.key === "유통기한")).toBeUndefined();
  });

  test("date 칸에 올바른 YYYY-MM-DD 는 통과한다", async () => {
    const ent = await store.entitiesRepo.findOrCreateEntity("intake", "요구르트");
    const res = await applyLensDraft(deps, {
      lens: applyView("intake"),
      entityId: ent.id,
      values: emptyValues({ columns: { 유통기한: "2026-08-01" } }),
      sourceNodeId: null,
      aiPath: true,
    });
    expect(res.applied).toBe(true);
    const cols = store.entitiesRepo.listAttributes(ent.id).filter((a) => a.isColumn);
    expect(cols.find((c) => c.key === "유통기한")?.value).toBe("2026-08-01");
  });
});

describe("point 1 — 전 검증 후 단일 트랜잭션 롤백", () => {
  test("relation 대상 부재로 실패하면 앞선 column 쓰기도 전부 롤백한다", async () => {
    // intake 는 실제 column(유통기한·date) + 관계(관련사람·person)를 가진 종류다.
    // 존재하지 않는 personId 를 관련사람에 주면 대상 존재 검증에서 throw — 트랜잭션 처방이면
    // 같은 초안의 유통기한 칸도 안 남아야 한다(부분 쓰기 잔류 0).
    const ent = await store.entitiesRepo.findOrCreateEntity("intake", "우유팩");

    await expect(
      applyLensDraft(deps, {
        lens: applyView("intake"),
        entityId: ent.id,
        values: emptyValues({
          columns: { 유통기한: "2026-08-01" },
          relations: { 관련사람: [{ personId: "psn_nonexistent" }] },
        }),
        sourceNodeId: null,
        aiPath: true,
      }),
    ).rejects.toBeInstanceOf(LensApplyError);

    // 유통기한 칸 미적용(롤백)
    const cols = store.entitiesRepo.listAttributes(ent.id).filter((a) => a.isColumn);
    expect(cols.find((c) => c.key === "유통기한")).toBeUndefined();
    // 관계도 미적용
    const rels = store.entityRelationEdgeRepo.getRelationsFromSource("intake", ent.id);
    expect(rels).toHaveLength(0);
  });

  test("정상 초안은 column·relation 을 한 번에 적용한다", async () => {
    const ent = await store.entitiesRepo.findOrCreateEntity("intake", "정상우유");
    const minsu = await store.findOrCreatePersonByName("민수");

    const res = await applyLensDraft(deps, {
      lens: applyView("intake"),
      entityId: ent.id,
      values: emptyValues({
        columns: { 유통기한: "2026-08-01" },
        relations: { 관련사람: [{ personId: minsu.personId }] },
      }),
      sourceNodeId: null,
      aiPath: true,
    });

    expect(res.applied).toBe(true);
    expect(res.relationCount).toBe(1);
    const cols = store.entitiesRepo.listAttributes(ent.id).filter((a) => a.isColumn);
    expect(cols.find((c) => c.key === "유통기한")?.value).toBe("2026-08-01");
    const rels = store.entityRelationEdgeRepo.getRelationsFromSource("intake", ent.id);
    expect(rels).toHaveLength(1);
    expect(rels[0]?.targetId).toBe(minsu.personId);
  });
});

describe("point 6 — 오래된 초안 방어(fingerprint 재대조)", () => {
  test("초안 시점 fingerprint 와 현재 엔티티가 어긋나면 거부한다", async () => {
    const ent = await store.entitiesRepo.findOrCreateEntity("material", "지문자료");
    // 초안 생성 시점 fingerprint(엔티티 값이 비어 있을 때).
    const lensSerialization = "material-lens-v1";
    const evidenceNodeIds = [1, 2];
    const draftFingerprint = lensDraftFingerprint({
      entityStructuredValue: serializeEntityStructuredValue(deps, ent.id),
      lensSerialization,
      evidenceNodeIds,
    });

    // 초안과 승인 사이에 엔티티가 바뀐다(다른 통로가 주제 칸을 채움).
    store.entitiesRepo.setAttribute(ent.id, "주제", "경합값", true);

    await expect(
      applyLensDraft(deps, {
        lens: applyView("material"),
        entityId: ent.id,
        values: emptyValues({ columns: { 주제: "초안값" } }),
        sourceNodeId: null,
        aiPath: true,
        fingerprintGuard: {
          expectedFingerprint: draftFingerprint,
          lensSerialization,
          evidenceNodeIds,
        },
      }),
    ).rejects.toBeInstanceOf(LensApplyError);
  });

  test("엔티티가 그대로면 fingerprint 가 맞아 통과한다", async () => {
    const ent = await store.entitiesRepo.findOrCreateEntity("material", "지문자료2");
    const lensSerialization = "material-lens-v1";
    const evidenceNodeIds = [3];
    const draftFingerprint = lensDraftFingerprint({
      entityStructuredValue: serializeEntityStructuredValue(deps, ent.id),
      lensSerialization,
      evidenceNodeIds,
    });

    const res = await applyLensDraft(deps, {
      lens: applyView("material"),
      entityId: ent.id,
      values: emptyValues({ columns: { 주제: "초안값" } }),
      sourceNodeId: null,
      aiPath: true,
      fingerprintGuard: {
        expectedFingerprint: draftFingerprint,
        lensSerialization,
        evidenceNodeIds,
      },
    });
    expect(res.applied).toBe(true);
    const cols = store.entitiesRepo.listAttributes(ent.id).filter((a) => a.isColumn);
    expect(cols.find((c) => c.key === "주제")?.value).toBe("초안값");
  });
});

describe("metadata 근거 노드 경로(트랜잭션 뒤 적용)", () => {
  test("sourceNodeId 근거로 event_at·place 를 채운다", async () => {
    const nodeId = await store.addNode({ content: "회의 준비 메모" });
    const ent = await store.entitiesRepo.findOrCreateEntity("schedule", "회의");

    const res = await applyLensDraft(deps, {
      lens: applyView("schedule"),
      entityId: ent.id,
      values: emptyValues({ metadata: { event_at: "2026-07-20", place: "강남" } }),
      sourceNodeId: nodeId,
      aiPath: true,
    });
    expect(res.applied).toBe(true);
  });

  test("metadata 가 있는데 sourceNodeId 가 없으면 거부한다", async () => {
    const ent = await store.entitiesRepo.findOrCreateEntity("schedule", "회의2");
    await expect(
      applyLensDraft(deps, {
        lens: applyView("schedule"),
        entityId: ent.id,
        values: emptyValues({ metadata: { event_at: "2026-07-20" } }),
        sourceNodeId: null,
        aiPath: true,
      }),
    ).rejects.toBeInstanceOf(LensApplyError);
  });
});

describe("렌즈 밖 키·관계값 불변식", () => {
  test("렌즈에 없는 columns 키는 거부한다", async () => {
    const ent = await store.entitiesRepo.findOrCreateEntity("material", "키자료");
    await expect(
      applyLensDraft(deps, {
        lens: applyView("material"),
        entityId: ent.id,
        values: emptyValues({ columns: { 없는칸: "x" } }),
        sourceNodeId: null,
        aiPath: true,
      }),
    ).rejects.toBeInstanceOf(LensApplyError);
  });

  test("사람 관계값에 문자열 이름을 넣으면 거부한다", async () => {
    const project = await store.findOrCreateProject({ name: "이름거부" });
    await expect(
      applyLensDraft(deps, {
        lens: applyView("project"),
        entityId: project.projectId,
        values: emptyValues({ relations: { 참여자: "민수" } }),
        sourceNodeId: null,
        aiPath: true,
      }),
    ).rejects.toBeInstanceOf(LensApplyError);
  });
});
