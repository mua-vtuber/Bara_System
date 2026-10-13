/**
 * persons.test.ts — 공통 인프라 1.2 T12: 사람 REST 통로 통합 검증.
 *
 * 설계 권위 = docs/decisions/2026-06-05-common-infra-1.2-spec(공통 인프라 1.2 프로젝트
 * 엔티티 테이블).md §3.4·5.9, plan(2026-06-06) Task 12.
 *
 * registerPersonsRoutes 가 붙이는 다섯 라우트를 실 DB + 실 임베더로 검증한다:
 *   - POST  /persons                고유 사실·별칭 입력·수정 + 요약 임베딩
 *   - GET   /persons                목록(최근 갱신 순)
 *   - GET   /persons/by-attribute   "개발자인 사람들" 역방향(:id 보다 먼저)
 *   - GET   /persons/:id            상세(별칭 + 라벨 + 참여 프로젝트)
 *   - POST  /persons/:id/attributes `#직업:개발자` 라벨 → has_attribute 연결
 *
 * 임베딩 미가용 정직(spec 5.9): applyPersonEmbedding 이 throw 하면 행은 살리고
 * embeddingSkipped: true 로 정직하게 드러낸다 — 가짜 벡터·빈 성공 위장 금지. 이 갈래는
 * *실제로 throw 하는 실 Embedder*(임베더 로드 실패를 흉내내는 실패 주입 하네스)로 검증한다.
 * 가짜 데이터를 들고 있는 mock 이 아니라 실패 경로만 강제하는 실 인터페이스다.
 *
 * 라우트 등록 순서(함정 4): /persons/by-attribute 가 /persons/:id 보다 먼저 등록돼야
 * "by-attribute" 가 사람 id 로 빨려 404 가 되지 않는다 — 그 점을 직접 검증한다.
 *
 * 실 bun:sqlite(:memory:) + 실 Bgem3Embedder. mock 0(데이터 fixture·실패 주입만). 운영 DB 비접근.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import type { Embedder } from "../../embedding/types.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi } from "../../server.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
}

/** 실 임베더 하네스 — 보통 검증용(임베딩 정상 적재). */
function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const app = buildMemoryApi({ store, retriever, assembler });
  return { app, db, store };
}

/**
 * 임베더 로드 실패를 흉내내는 실 Embedder — embed 호출 시 throw 한다. 가짜 *데이터*
 * 를 들고 있지 않다(빈 배열·default 벡터를 만들지 않음). spec 5.9 의 "임베딩 미가용 =
 * 행은 살리고 정직하게 skip" 경로를 강제하는 실패 주입 하네스다. dimension 은 실
 * 임베더와 같게 둬, 차원 불일치가 아니라 embed 자체가 throw 하는 경로를 본다.
 */
class FailingEmbedder implements Embedder {
  readonly dimension: number;
  constructor(dimension: number) {
    this.dimension = dimension;
  }
  async load(): Promise<void> {}
  async embed(): Promise<Float32Array> {
    throw new Error("embedder unavailable (load failed)");
  }
  async embedBatch(): Promise<Float32Array[]> {
    throw new Error("embedder unavailable (load failed)");
  }
}

/** 임베더가 throw 하는 하네스 — POST /persons 임베딩 skip 경로 전용. */
function makeFailingEmbedHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const failing = new FailingEmbedder(embedder.dimension);
  const store = new SqliteMemoryStore(db, failing);
  const retriever = new HybridRetriever(store, failing);
  const assembler = new ContextAssembler();
  const app = buildMemoryApi({ store, retriever, assembler });
  return { app, db, store };
}

async function postJson(
  app: Hono,
  path: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function getJson(
  app: Hono,
  path: string,
): Promise<{ status: number; body: any }> {
  const res = await app.request(path);
  return { status: res.status, body: await res.json() };
}

describe("POST /persons — 고유 사실·별칭 입력·수정 (Task 12)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("이름 생성 → 고유 사실·별칭 채움 → GET /persons/:id 상세로 이어진다", async () => {
    const created = await postJson(h.app, "/persons", {
      name: "민수",
      birthday: "3월 5일",
      gender: "남",
      aliases: ["민짱", "수수"],
    });
    expect(created.status).toBe(201);
    expect(created.body.person.personId.startsWith("psn_")).toBe(true);
    expect(created.body.person.displayName).toBe("민수");
    expect(created.body.person.birthday).toBe("3월 5일");
    expect(created.body.person.gender).toBe("남");
    // display_name + 두 별칭이 aliases 에 누적된다(중복 0).
    expect(created.body.person.aliases.sort()).toEqual(["민수", "민짱", "수수"]);
    expect(created.body.embeddingSkipped).toBe(false);

    const personId = created.body.person.personId;
    const detail = await getJson(h.app, `/persons/${personId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.person.birthday).toBe("3월 5일");
    // 라벨·참여 프로젝트 0건이면 빈 배열(정직한 빈 표시).
    expect(detail.body.labels).toEqual([]);
    expect(detail.body.projects).toEqual([]);
  });

  test("명시 personId 통로 = 그 사람만 수정(동명이인 보존 / UNIQUE 아님)", async () => {
    // 같은 이름 사람 둘 — 첫 동명은 findOrCreatePersonByName 재사용이지만, 명시
    // personId 로 만든 두 번째 사람은 별 행으로 공존한다(spec 3.4.1).
    const first = await postJson(h.app, "/persons", { name: "지훈" });
    const firstId = first.body.person.personId;
    // facade 로 동명이인 한 명을 더 만든다(REST 이름 통로는 첫 동명을 재사용하므로).
    const twin = await h.store.findOrCreatePerson({
      displayName: "지훈",
      userId: "u-twin",
      source: "discord",
    });
    expect(twin.personId).not.toBe(firstId);

    // 명시 personId 로 twin 만 수정 — firstId 는 손대지 않는다.
    const updated = await postJson(h.app, "/persons", {
      personId: twin.personId,
      address: "서울",
    });
    expect(updated.status).toBe(201);
    expect(updated.body.person.personId).toBe(twin.personId);
    expect(updated.body.person.address).toBe("서울");

    const firstDetail = await getJson(h.app, `/persons/${firstId}`);
    expect(firstDetail.body.person.address).toBe(null);
  });

  test("name·personId 둘 다 없으면 400 / 없는 personId = 404", async () => {
    const noKey = await postJson(h.app, "/persons", { birthday: "1월 1일" });
    expect(noKey.status).toBe(400);

    const missing = await postJson(h.app, "/persons", {
      personId: "psn_nope",
      address: "어디",
    });
    expect(missing.status).toBe(404);
  });

  test("임베더 미가용 = 행은 살리고 embeddingSkipped: true (가짜 벡터 금지)", async () => {
    const fh = makeFailingEmbedHarness();
    try {
      const created = await postJson(fh.app, "/persons", {
        name: "임베딩 미가용 사람",
        birthday: "12월",
      });
      // 행 자체는 저장됐다(글자·고유 사실만 등록).
      expect(created.status).toBe(201);
      expect(created.body.person.displayName).toBe("임베딩 미가용 사람");
      expect(created.body.person.birthday).toBe("12월");
      // 정직한 skip 신호 — 가짜 성공 위장 없이 까닭까지 노출.
      expect(created.body.embeddingSkipped).toBe(true);
      expect(typeof created.body.embeddingSkipReason).toBe("string");
      expect(created.body.embeddingSkipReason.length).toBeGreaterThan(0);

      // GET 상세도 그대로 회신된다(행이 진짜 살아 있다).
      const detail = await getJson(
        fh.app,
        `/persons/${created.body.person.personId}`,
      );
      expect(detail.status).toBe(200);
      expect(detail.body.person.displayName).toBe("임베딩 미가용 사람");
    } finally {
      fh.db.close();
    }
  });
});

describe("GET /persons — 목록 (Task 12)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("등록한 사람들이 목록에 모두 보인다", async () => {
    await postJson(h.app, "/persons", { name: "사람 1" });
    await postJson(h.app, "/persons", { name: "사람 2" });

    const list = await getJson(h.app, "/persons");
    expect(list.status).toBe(200);
    expect(list.body.count).toBe(2);
    expect(list.body.persons.map((p: any) => p.displayName).sort()).toEqual([
      "사람 1",
      "사람 2",
    ]);
  });
});

describe("POST /persons/:id/attributes — `#직업:개발자` 라벨 (Task 12)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("직업 라벨이 has_attribute 로 연결되고 상세 labels 에 보인다", async () => {
    const created = await postJson(h.app, "/persons", { name: "라벨 대상자" });
    const personId = created.body.person.personId;

    const labeled = await postJson(h.app, `/persons/${personId}/attributes`, {
      text: "#직업:개발자",
    });
    expect(labeled.status).toBe(201);
    expect(labeled.body.added.length).toBe(1);
    expect(labeled.body.added[0].category).toBe("직업");
    expect(labeled.body.added[0].value).toBe("개발자");
    expect(labeled.body.added[0].attributeAdded).toBe(true);
    const attrEdge = h.db
      .query<{ provenance: string; source_node_id: number | null }, [string, string]>(
        `SELECT provenance, source_node_id
           FROM concept_edges
          WHERE source_concept_id=? AND target_concept_id=? AND relation='has_attribute'`,
      )
      .get(personId, labeled.body.added[0].conceptId);
    expect(attrEdge).toEqual({ provenance: "user_input", source_node_id: null });

    // 상세 labels 에 개념 이름이 보강돼 보인다(소문자 정규화 없음 — 한국어 값).
    const detail = await getJson(h.app, `/persons/${personId}`);
    expect(detail.body.labels.map((l: any) => l.name)).toEqual(["개발자"]);
    expect(detail.body.labels.map((l: any) => l.category)).toEqual(["직업"]);
  });

  test("라벨 없는 입력 = 400(빈 성공 위장 금지) / 없는 사람 id = 404", async () => {
    const created = await postJson(h.app, "/persons", { name: "빈 라벨자" });
    const personId = created.body.person.personId;
    const empty = await postJson(h.app, `/persons/${personId}/attributes`, {
      text: "그냥 평범한 글, 분류 태그가 없다",
    });
    expect(empty.status).toBe(400);

    const missing = await postJson(h.app, "/persons/psn_nope/attributes", {
      text: "#직업:디자이너",
    });
    expect(missing.status).toBe(404);
  });
});

describe("GET /persons/by-attribute — 역방향 '개발자인 사람들' (Task 12)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("같은 직업 라벨을 단 사람들이 역방향으로 모두 회신된다", async () => {
    // 두 사람에 #직업:개발자, 한 사람에 #직업:디자이너 를 단다.
    const p1 = (await postJson(h.app, "/persons", { name: "개발자 A" })).body
      .person.personId;
    const p2 = (await postJson(h.app, "/persons", { name: "개발자 B" })).body
      .person.personId;
    const p3 = (await postJson(h.app, "/persons", { name: "디자이너 C" })).body
      .person.personId;
    await postJson(h.app, `/persons/${p1}/attributes`, { text: "#직업:개발자" });
    await postJson(h.app, `/persons/${p2}/attributes`, { text: "#직업:개발자" });
    await postJson(h.app, `/persons/${p3}/attributes`, { text: "#직업:디자이너" });

    const devs = await getJson(h.app, "/persons/by-attribute?concept=개발자");
    expect(devs.status).toBe(200);
    expect(devs.body.concept).toBe("개발자");
    expect(devs.body.count).toBe(2);
    expect(
      devs.body.persons.map((p: any) => p.personId).sort(),
    ).toEqual([p1, p2].sort());
  });

  test("없는 개념 = 빈 후보(정직한 빈) / concept 파라미터 없으면 400", async () => {
    const none = await getJson(h.app, "/persons/by-attribute?concept=한번도안쓴직업");
    expect(none.status).toBe(200);
    expect(none.body.persons).toEqual([]);

    const noParam = await getJson(h.app, "/persons/by-attribute");
    expect(noParam.status).toBe(400);
  });

  // 함정 4 — 라우트 등록 순서 검증. /persons/by-attribute 가 /persons/:id 보다 먼저
  // 등록돼야 "by-attribute" 가 사람 id 로 빨려 404 가 되지 않는다. 그 차이를 직접 본다:
  // by-attribute 는 200(역방향 라우트), 진짜 없는 id 는 404.
  test("등록 순서 — by-attribute 가 :id 에 안 빨린다(200) / 없는 id 는 404", async () => {
    const byAttr = await getJson(h.app, "/persons/by-attribute?concept=개발자");
    expect(byAttr.status).toBe(200);
    expect(Array.isArray(byAttr.body.persons)).toBe(true);

    const missing = await getJson(h.app, "/persons/psn_definitely_missing");
    expect(missing.status).toBe(404);
  });
});
