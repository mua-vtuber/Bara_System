/**
 * server-internal/routes/entity-types.test.ts — 새 엔티티 종류 CRUD 라우트 통합 검증
 * (분류 단계3 T6).
 *
 * 검증 가족:
 *   (a) POST /api/entity-types → 201 + 생성 종류(source user). 멱등(같은 값 재등록).
 *   (b) POST 코드 상수 충돌 = 400(work·person 등 10종 키 재사용 시도).
 *   (c) POST 중복 다른값 = 400(같은 typeName 다른 koName).
 *   (d) POST 빈/공백 koName = 400(koNameOf 가 분류 경로에서 throw 하는 구멍 차단·T3 qa Minor).
 *   (e) GET → 코드 상수 10종(source code) ∪ DB 새 종류(source user) 출처 구분 합집합.
 *   (f) DELETE 새 종류 → 200 + 목록에서 사라짐. 코드 상수 삭제 시도 = 400.
 *   (g) 핵심 2-reset: POST(장비) 후 `#장비:키보드` 입력이 그 종류로 분류되고, DELETE 후
 *       다시 안 잡힌다(setEntityTypeOverride + 두 reset 가 모듈 캐시를 재시작 없이 갱신).
 *   (h) store(entityTypeRegistryDb) 미주입 = CRUD·목록 503(정직한 비활성).
 *
 * 실 SQLite(:memory:) + 실 SqliteMemoryStore + 실 EntityTypeRegistryDb + 실 모듈 캐시.
 * mock 0 — data fixture만. 분류 판정은 실제 classifyEntityTypeDeterministic 를 거친다
 * (LLM 미사용 / 결정 단만).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi } from "../../server.ts";
import { registerEntityTypesRoutes } from "./entity-types.ts";
import type { MemoryApiDeps } from "../types.ts";
import {
  setEntityTypeOverride,
  clearConceptVocabularyOverrides,
} from "../../memory/concept-type-vocabulary.ts";
import {
  classifyEntityTypeDeterministic,
  resetClassifierCache,
} from "../../memory/entity-type-classifier.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

// 각 테스트 후 모듈 캐시를 운영 명부 0개(정적 10종)로 되돌린다 — 라우트가 override 를
// 주입하므로 누수 차단(다른 테스트 파일·다음 케이스가 깨끗한 명부를 본다).
afterEach(() => {
  setEntityTypeOverride([]);
  clearConceptVocabularyOverrides();
  resetClassifierCache();
});

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
}

/**
 * store(EntityTypeRegistryDb 멤버 보유) + 모듈 캐시가 같은 db 를 공유하는 harness.
 * 부팅 흐름(server.ts)을 그대로 미러 — setEntityTypeOverride 로 빈 명부를 주입하고,
 * 같은 store 를 deps 로 넘긴다.
 */
function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();

  // 깨끗한 명부 0개 기준선 — 모듈 캐시도 정적 10종으로 맞춘다.
  setEntityTypeOverride(store.entityTypeRegistryDb.listUserEntityTypes());
  clearConceptVocabularyOverrides();
  resetClassifierCache();

  const app = buildMemoryApi({ store, retriever, assembler });
  return { app, db, store };
}

describe("entity-types CRUD 라우트", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.db.close();
  });

  test("POST /api/entity-types → 201 + entityType(source user)", async () => {
    const res = await h.app.request("/api/entity-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", koName: "장비", idPrefix: "eqp_" }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      entityType: { typeName: string; koName: string; idPrefix: string; source: string };
    };
    expect(json.entityType.typeName).toBe("equipment");
    expect(json.entityType.koName).toBe("장비");
    expect(json.entityType.idPrefix).toBe("eqp_");
    expect(json.entityType.source).toBe("user");
    // DB 에도 실제로 들어갔다.
    expect(
      h.store.entityTypeRegistryDb.listUserEntityTypes().find((u) => u.typeName === "equipment"),
    ).toBeDefined();
  });

  test("POST idPrefix 미지정 → 201(빈 접두사로 생성)", async () => {
    const res = await h.app.request("/api/entity-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "vehicle", koName: "탈것" }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { entityType: { idPrefix: string } };
    expect(json.entityType.idPrefix).toBe("");
  });

  test("POST 같은 값 재등록 = 멱등 201", async () => {
    const body = JSON.stringify({ typeName: "vehicle", koName: "탈것", idPrefix: "veh_" });
    const first = await h.app.request("/api/entity-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(first.status).toBe(201);
    const second = await h.app.request("/api/entity-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(second.status).toBe(201);
    // 한 행만 남는다(멱등 — 중복 행 0).
    expect(
      h.store.entityTypeRegistryDb.listUserEntityTypes().filter((u) => u.typeName === "vehicle")
        .length,
    ).toBe(1);
  });

  test("POST 코드 상수 충돌(work·person) = 400", async () => {
    for (const typeName of ["work", "person"]) {
      const res = await h.app.request("/api/entity-types", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ typeName, koName: "겹침" }),
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toMatch(/코드 상수/);
    }
  });

  test("POST 중복 다른값(같은 typeName 다른 koName) = 400", async () => {
    await h.app.request("/api/entity-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "vehicle", koName: "탈것", idPrefix: "veh_" }),
    });
    const res = await h.app.request("/api/entity-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "vehicle", koName: "다른이름", idPrefix: "veh_" }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/덮어쓰기 금지|이미 등록/);
  });

  test("POST 빈/공백 koName = 400(분류 경로 throw 구멍 차단)", async () => {
    for (const koName of ["", "   "]) {
      const res = await h.app.request("/api/entity-types", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ typeName: "gadget", koName }),
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toMatch(/koName|표시명/);
    }
    // 빈 koName 행이 DB 에 안 남는다(검증이 DB 를 안 건드린다).
    expect(
      h.store.entityTypeRegistryDb.listUserEntityTypes().find((u) => u.typeName === "gadget"),
    ).toBeUndefined();
  });

  test("POST typeName 누락 = 400", async () => {
    const res = await h.app.request("/api/entity-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ koName: "장비" }),
    });
    expect(res.status).toBe(400);
  });

  test("GET /api/entity-types 가 코드 상수(source code) + 새 종류(source user) 출처 구분", async () => {
    await h.app.request("/api/entity-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", koName: "장비", idPrefix: "eqp_" }),
    });

    const res = await h.app.request("/api/entity-types");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      entityTypes: Array<{
        typeName: string;
        koName: string;
        idPrefix: string | null;
        source: string;
        subcategories: string[];
      }>;
    };

    // 코드 상수 10종은 source code·삭제 불가(idPrefix null).
    const work = json.entityTypes.find((e) => e.typeName === "work");
    expect(work).toBeDefined();
    expect(work!.source).toBe("code");
    expect(work!.koName).toBe("작품");
    expect(work!.idPrefix).toBeNull();

    const person = json.entityTypes.find((e) => e.typeName === "person");
    expect(person).toBeDefined();
    expect(person!.source).toBe("code");

    // 코드 상수 10종이 전부 보인다(8 엔티티 타입 + 사람 + 프로젝트).
    expect(json.entityTypes.filter((e) => e.source === "code").length).toBe(10);

    // 새 종류는 source user·idPrefix 보유.
    const equipment = json.entityTypes.find((e) => e.typeName === "equipment");
    expect(equipment).toBeDefined();
    expect(equipment!.source).toBe("user");
    expect(equipment!.koName).toBe("장비");
    expect(equipment!.idPrefix).toBe("eqp_");

    // S7 — 모든 종류 응답에 subcategories 배열이 있다(갈래 없으면 []·가짜 항목 0).
    // 코드 종류 work·person 과 새 종류 equipment 모두 배열 멤버를 가진다(merge vocab 산출).
    expect(Array.isArray(work!.subcategories)).toBe(true);
    expect(Array.isArray(person!.subcategories)).toBe(true);
    expect(Array.isArray(equipment!.subcategories)).toBe(true);
    // 새 종류는 어휘 0개라 빈 배열(어휘는 /api/classify-vocab 로 따로 더한다·정직한 빈 상태).
    expect(equipment!.subcategories).toEqual([]);
  });

  // ── S4(spec 2026-06-28) 일정 전용 날짜 칸 제거 — schedule.columns 가 []가 된다 ────────
  // 입력 폼은 GET /api/entity-types 의 columns 를 받아 종류별 동적 칸을 그린다. schedule 이
  // 0칸 종류가 되면 columns 가 []라 종류=일정 선택 시 텍스트 칸이 0개 그려진다 — 중복 "날짜"
  // 텍스트 칸이 자연 소멸하고 달력 위젯만 남는다(라우트 코드 무수정·columnLabelKeysOf 결과
  // 자연 반영). 시각·레이아웃은 happy-dom 이 안 보므로 라이브 확인은 별도(S6).
  test("(S4) GET /api/entity-types schedule.columns 가 [] — 일정 전용 날짜 칸 제거(달력만 남음)", async () => {
    const res = await h.app.request("/api/entity-types");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      entityTypes: Array<{
        typeName: string;
        columns: Array<{ key: string; label: string; dataType: string }>;
      }>;
    };

    const schedule = json.entityTypes.find((e) => e.typeName === "schedule");
    expect(schedule).toBeDefined();
    // 일정 columns 0 — 옛날엔 [{key:'날짜'}] 가 실려 텍스트 칸을 중복으로 그렸다.
    expect(schedule!.columns).toEqual([]);

    // 다른 칸 보유 종류는 그대로 칸을 돌려준다(회귀 가드 — 일정만 빠졌다).
    const intake = json.entityTypes.find((e) => e.typeName === "intake");
    expect(intake!.columns.map((c) => c.key)).toEqual(["유통기한"]);
    const place = json.entityTypes.find((e) => e.typeName === "place");
    expect(place!.columns.map((c) => c.key)).toEqual(["주소"]);
  });

  test("DELETE /api/entity-types/:typeName(새 종류) → 200 + 목록에서 사라짐", async () => {
    await h.app.request("/api/entity-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "vehicle", koName: "탈것", idPrefix: "veh_" }),
    });

    const delRes = await h.app.request("/api/entity-types/vehicle", { method: "DELETE" });
    expect(delRes.status).toBe(200);
    const delJson = (await delRes.json()) as { deleted: string };
    expect(delJson.deleted).toBe("vehicle");

    const listRes = await h.app.request("/api/entity-types");
    const { entityTypes } = (await listRes.json()) as {
      entityTypes: Array<{ typeName: string }>;
    };
    expect(entityTypes.find((e) => e.typeName === "vehicle")).toBeUndefined();
  });

  test("DELETE 코드 상수 삭제 시도 = 400", async () => {
    const res = await h.app.request("/api/entity-types/work", { method: "DELETE" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/코드 상수/);
  });

  test("핵심 2-reset: 새 종류 추가 후 #장비:키보드 가 그 종류로 분류된다(재시작 없이)", () => {
    // typeName 은 union(PlacementTypeName|null)이라 새 종류 'equipment'(union 밖)를
    // 직접 비교하면 컴파일타임에 막힌다 — string 으로 읽어 비교한다(동적 명부 비대칭).
    const typeNameOf = (text: string): string | null =>
      classifyEntityTypeDeterministic(text).typeName;

    // 추가 전: '장비' 는 종류 명부에 없어 '#장비:키보드' 가 그 종류로 안 잡힌다.
    expect(typeNameOf("#장비:키보드")).not.toBe("equipment");
    return (async () => {
      await h.app.request("/api/entity-types", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ typeName: "equipment", koName: "장비", idPrefix: "eqp_" }),
      });

      // 추가 후: koName '장비' 콜론 키가 타입 지시 키로 인식돼 equipment 로 분류된다
      // (2-reset 가 setEntityTypeOverride + 두 reset 로 모듈 캐시·분류기 키 맵 갱신).
      expect(typeNameOf("#장비:키보드")).toBe("equipment");

      // DELETE 후: 다시 그 종류로 안 잡힌다.
      await h.app.request("/api/entity-types/equipment", { method: "DELETE" });
      expect(typeNameOf("#장비:키보드")).not.toBe("equipment");
    })();
  });
});

describe("entity-types 라우트 — store 미주입 503", () => {
  // store.entityTypeRegistryDb 가 없는 deps 로 라우트만 단독 등록해, 가드가 빈 목록으로
  // 가리지 않고 정직히 503 을 내는지 본다(실제 부팅에선 store 가 항상 있으나, 가드 자체가
  // silent fallback 금지 보장으로 존재해야 한다).
  function appWithoutRegistry(): Hono {
    const app = new Hono({ strict: false });
    // entityTypeRegistryDb 멤버가 빠진 store 를 흉내낸다 — 가드가 그 멤버를 검사한다.
    const deps = {
      store: {} as MemoryApiDeps["store"],
    } as unknown as MemoryApiDeps;
    registerEntityTypesRoutes(app, deps);
    return app;
  }

  test("GET = 503", async () => {
    const res = await appWithoutRegistry().request("/api/entity-types");
    expect(res.status).toBe(503);
  });

  test("POST = 503", async () => {
    const res = await appWithoutRegistry().request("/api/entity-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", koName: "장비" }),
    });
    expect(res.status).toBe(503);
  });

  test("DELETE = 503", async () => {
    const res = await appWithoutRegistry().request("/api/entity-types/equipment", {
      method: "DELETE",
    });
    expect(res.status).toBe(503);
  });
});
