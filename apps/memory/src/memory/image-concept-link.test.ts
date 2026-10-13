/**
 * image-concept-link.test.ts — image-search-foundation Task 5 (b-B3) 검증.
 *
 * 실제 SQLite(`openMemoryDatabase(":memory:", { embeddingDim: 384 })`) + 실제 concept_siglip_vec + 실제
 * image_vec + 실제 vec0 KNN 으로 "threshold 컷 / 기존 개념만 / 새 개념 생성 0 /
 * 'visual' role / graceful skip / 멱등 / lazy backfill" 로직을 검증한다.
 * Mock 클래스 금지(CLAUDE.md) — 임베딩은 데이터 fixture(순수 Float32Array)다.
 *
 * 이미지 임베딩 fixture 설계: 768-dim L2-normalized 벡터를 결정적으로 만든다.
 * cosine = (둘 다 L2-norm 이므로) 내적. 한 dim 에 몰면 그 dim 에 몰린 개념과
 * cosine 이 높고, 다른 dim 에 몰린 개념과는 낮다 — threshold 컷을 정확히 통제한다.
 *
 * 마지막 한 케이스는 실제 SigLIP text encoder 로 lazy backfill 이 비교 직전
 * 동작하는지 E2E 로 본다(WSL bun ~2초 로드, T4 가 hang 미재현 확인).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import {
  linkImageToConceptsBySiglip,
  SIGLIP_DIM,
} from "./image-concept-link.ts";
import {
  defaultSiglipTextEmbedder,
  type SiglipTextEmbedder,
} from "../db/store-internal/concept-siglip-backfill.ts";

// ── 데이터 fixture helper ───────────────────────────────────────────────────

/** 한 dim 에 1, 나머지 0 인 768-dim 단위벡터(이미 L2-norm). */
function unitAt(dim: number): Float32Array {
  const v = new Float32Array(SIGLIP_DIM);
  v[dim] = 1;
  return v;
}

/** 두 단위벡터의 가중 혼합 후 L2-norm. cosine 을 통제하려고 쓴다. */
function mix(a: Float32Array, wa: number, b: Float32Array, wb: number): Float32Array {
  const v = new Float32Array(SIGLIP_DIM);
  for (let i = 0; i < SIGLIP_DIM; i++) v[i] = a[i]! * wa + b[i]! * wb;
  let sum = 0;
  for (let i = 0; i < SIGLIP_DIM; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < SIGLIP_DIM; i++) v[i] = v[i]! / norm;
  return v;
}

/** 개념 노드 INSERT (concept_id NOT NULL, name UNIQUE NOT NULL). rowid 반환. */
function insertConcept(
  db: Database,
  conceptId: string,
  name: string,
  isTag = 1,
): number {
  db.run("INSERT INTO concept_nodes(concept_id, name, is_tag) VALUES (?, ?, ?)", [
    conceptId,
    name,
    isTag,
  ]);
  return Number(
    (
      db
        .prepare("SELECT rowid AS r FROM concept_nodes WHERE concept_id = ?")
        .get(conceptId) as { r: number }
    ).r,
  );
}

/** 엔티티 identity 개념 edge fixture. */
function insertEntityIdentity(
  db: Database,
  entityId: string,
  typeName: string,
  name: string,
  conceptId: string,
): void {
  db.run("INSERT INTO entities(entity_id, type_name, name) VALUES (?, ?, ?)", [
    entityId,
    typeName,
    name,
  ]);
  db.run(
    `INSERT INTO entity_concept_edges
       (entity_id, concept_id, role, provenance, source_node_id)
     VALUES (?, ?, 'identity', 'hashtag', NULL)`,
    [entityId, conceptId],
  );
}

/** concept_siglip_vec 에 개념 임베딩을 직접 적재(데이터 fixture). */
function setConceptSiglip(db: Database, rowid: number, vec: Float32Array): void {
  db.run("INSERT INTO concept_siglip_vec(concept_rowid, embedding) VALUES (?, ?)", [
    rowid,
    vec,
  ]);
}

/** image_asset 노드 + image_vec 임베딩 직접 적재. knowledge_nodes.id 반환. */
function insertImageNode(db: Database, vec: Float32Array | null): number {
  db.run(
    `INSERT INTO knowledge_nodes(content, memory_type, source_type)
     VALUES ('이미지 자산 fixture', 'fact', 'image_asset')`,
  );
  const id = Number(
    (db.prepare("SELECT last_insert_rowid() AS r").get() as { r: number }).r,
  );
  if (vec !== null) {
    db.run("INSERT INTO image_vec(node_id, embedding) VALUES (?, ?)", [id, vec]);
  }
  return id;
}

function countEdges(db: Database, nodeId: number, role?: string): number {
  const where = role ? "AND role = ?" : "";
  const params = role ? [nodeId, role] : [nodeId];
  return Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM node_concept_edges WHERE node_id = ? ${where}`,
        )
        .get(...params) as { c: number }
    ).c,
  );
}

function countConcepts(db: Database): number {
  return Number(
    (db.prepare("SELECT COUNT(*) AS c FROM concept_nodes").get() as { c: number })
      .c,
  );
}

/**
 * 데이터 fixture SigLIP text 임베더 — load 가용성만 제어(개념 임베딩은 테스트가
 * concept_siglip_vec 에 직접 넣으므로 embed 는 호출되지 않는 게 보통). mock 클래스
 * 아님 — 순수 객체.
 */
function fixtureEmbedder(opts?: {
  available?: boolean;
  embed?: (text: string) => Float32Array | null;
}): SiglipTextEmbedder {
  return {
    dim: SIGLIP_DIM,
    load: async () => opts?.available ?? true,
    embed: async (text: string) =>
      opts?.embed ? opts.embed(text) : unitAt(0),
  };
}

// ── 테스트 ──────────────────────────────────────────────────────────────────

describe("linkImageToConceptsBySiglip — threshold·기존 개념만·visual role", () => {
  let db: Database;
  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
  });
  afterEach(() => {
    db.close();
  });

  test("(1) threshold 넘는 개념과 연결 — 닮은 개념만 잇는다", async () => {
    // 개념 둘: '노란색'은 image 와 같은 축(cosine≈1), '농구'는 다른 축(cosine≈0).
    const yellowRowid = insertConcept(db, "cpt_yellow", "노란색");
    const ballRowid = insertConcept(db, "cpt_ball", "농구");
    setConceptSiglip(db, yellowRowid, unitAt(0));
    setConceptSiglip(db, ballRowid, unitAt(5));

    // 이미지 = 거의 dim0(노란색)에 몰림 + dim5 약간 → 노란색 cosine 높음, 농구 낮음.
    const imageVec = mix(unitAt(0), 0.98, unitAt(5), 0.05);
    const nodeId = insertImageNode(db, imageVec);

    const linked = await linkImageToConceptsBySiglip({
      db,
      nodeId,
      threshold: 0.1,
      embedder: fixtureEmbedder(),
    });

    const ids = linked.map((l) => l.conceptId);
    expect(ids).toContain("cpt_yellow");
    expect(ids).not.toContain("cpt_ball");
    // 닮은 개념 cosine 이 threshold 이상.
    const yellow = linked.find((l) => l.conceptId === "cpt_yellow")!;
    expect(yellow.cosine).toBeGreaterThanOrEqual(0.1);
    expect(yellow.inserted).toBe(true);
    // 실제 엣지가 DB 에 생겼다(role='visual').
    expect(countEdges(db, nodeId, "visual")).toBe(1);
  });

  test("(2) threshold 미달 개념 비연결", async () => {
    const ballRowid = insertConcept(db, "cpt_ball", "농구");
    setConceptSiglip(db, ballRowid, unitAt(5));

    // 이미지는 dim0 에 몰림 → 농구(dim5)와 cosine≈0 < threshold.
    const imageVec = unitAt(0);
    const nodeId = insertImageNode(db, imageVec);

    const linked = await linkImageToConceptsBySiglip({
      db,
      nodeId,
      threshold: 0.1,
      embedder: fixtureEmbedder(),
    });

    expect(linked).toEqual([]);
    expect(countEdges(db, nodeId)).toBe(0);
  });

  test("(3) 매칭 개념 0건 → 엣지 0 + 새 개념 생성 0", async () => {
    const ballRowid = insertConcept(db, "cpt_ball", "농구");
    setConceptSiglip(db, ballRowid, unitAt(5));
    const before = countConcepts(db);

    const imageVec = unitAt(0); // 어떤 개념과도 안 닮음
    const nodeId = insertImageNode(db, imageVec);

    const linked = await linkImageToConceptsBySiglip({
      db,
      nodeId,
      threshold: 0.5,
      embedder: fixtureEmbedder(),
    });

    expect(linked).toEqual([]);
    expect(countEdges(db, nodeId)).toBe(0);
    // 새 개념을 절대 만들지 않는다(사용자 확정 U3).
    expect(countConcepts(db)).toBe(before);
  });

  test("(4) 연결 엣지 role = 'visual'", async () => {
    const rowid = insertConcept(db, "cpt_yellow", "노란색");
    setConceptSiglip(db, rowid, unitAt(0));
    const nodeId = insertImageNode(db, unitAt(0));

    await linkImageToConceptsBySiglip({
      db,
      nodeId,
      threshold: 0.1,
      embedder: fixtureEmbedder(),
    });

    const role = (
      db
        .prepare(
          "SELECT role FROM node_concept_edges WHERE node_id = ? LIMIT 1",
        )
        .get(nodeId) as { role: string }
    ).role;
    expect(role).toBe("visual");
    // 손 태그('tag')와 섞이지 않았다.
    expect(countEdges(db, nodeId, "tag")).toBe(0);
  });

  test("(5) 이미지 임베딩 없음 → skip + warn (가짜 엣지 0)", async () => {
    const rowid = insertConcept(db, "cpt_yellow", "노란색");
    setConceptSiglip(db, rowid, unitAt(0));
    // image_vec 행 없이 노드만 만든다(임베딩 skip 된 이미지).
    const nodeId = insertImageNode(db, null);

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
    try {
      const linked = await linkImageToConceptsBySiglip({
        db,
        nodeId,
        threshold: 0.1,
        embedder: fixtureEmbedder(),
      });
      expect(linked).toEqual([]);
    } finally {
      console.warn = origWarn;
    }
    expect(countEdges(db, nodeId)).toBe(0);
    expect(warnings.some((w) => w.includes("SigLIP 임베딩 없음"))).toBe(true);
  });

  test("(6) 같은 이미지 두 번 연결 → 엣지 중복 0 (멱등)", async () => {
    const rowid = insertConcept(db, "cpt_yellow", "노란색");
    setConceptSiglip(db, rowid, unitAt(0));
    const nodeId = insertImageNode(db, unitAt(0));

    const first = await linkImageToConceptsBySiglip({
      db,
      nodeId,
      threshold: 0.1,
      embedder: fixtureEmbedder(),
    });
    expect(first[0]!.inserted).toBe(true);
    expect(countEdges(db, nodeId, "visual")).toBe(1);

    const second = await linkImageToConceptsBySiglip({
      db,
      nodeId,
      threshold: 0.1,
      embedder: fixtureEmbedder(),
    });
    // 두 번째도 같은 개념을 반환하되 새로 안 생김(inserted=false).
    expect(second[0]!.conceptId).toBe("cpt_yellow");
    expect(second[0]!.inserted).toBe(false);
    // 엣지 중복 0 — 여전히 1행.
    expect(countEdges(db, nodeId, "visual")).toBe(1);
  });

  test("엔티티 identity 개념은 자동 visual 링크 후보에서 제외한다", async () => {
    const yellowRowid = insertConcept(db, "cpt_yellow", "노란색");
    const petRowid = insertConcept(db, "cpt_daljae", "얼룩이", 0);
    setConceptSiglip(db, yellowRowid, unitAt(0));
    setConceptSiglip(db, petRowid, unitAt(0));
    insertEntityIdentity(
      db,
      "cre_daljae",
      "creature",
      "얼룩이",
      "cpt_daljae",
    );

    const nodeId = insertImageNode(db, unitAt(0));

    const linked = await linkImageToConceptsBySiglip({
      db,
      nodeId,
      threshold: 0.1,
      embedder: fixtureEmbedder(),
    });

    const ids = linked.map((l) => l.conceptId);
    expect(ids).toContain("cpt_yellow");
    expect(ids).not.toContain("cpt_daljae");
    expect(countEdges(db, nodeId, "visual")).toBe(1);
    expect(
      Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM node_concept_edges
                WHERE node_id = ? AND concept_id = 'cpt_daljae'`,
            )
            .get(nodeId) as { c: number }
        ).c,
      ),
    ).toBe(0);
  });

  test("(7) lazy backfill 이 비교 직전 동작 — SigLIP 없던 개념이 연결 대상에 들어온다", async () => {
    // 개념을 만들되 concept_siglip_vec 는 일부러 비워둔다 — backfill 이 채워야 한다.
    insertConcept(db, "cpt_yellow", "노란색");
    expect(
      Number(
        (
          db
            .prepare("SELECT COUNT(*) AS c FROM concept_siglip_vec")
            .get() as { c: number }
        ).c,
      ),
    ).toBe(0);

    // backfill 임베더가 '노란색' → unitAt(0) 을 채우게 한다(데이터 fixture).
    const embedder = fixtureEmbedder({
      embed: (text) => (text === "노란색" ? unitAt(0) : unitAt(7)),
    });

    const nodeId = insertImageNode(db, unitAt(0));
    const linked = await linkImageToConceptsBySiglip({
      db,
      nodeId,
      threshold: 0.1,
      embedder,
    });

    // backfill 이 채운 개념이 연결 대상에 들어왔다.
    expect(linked.map((l) => l.conceptId)).toContain("cpt_yellow");
    // concept_siglip_vec 가 backfill 로 채워졌다.
    expect(
      Number(
        (
          db
            .prepare("SELECT COUNT(*) AS c FROM concept_siglip_vec")
            .get() as { c: number }
        ).c,
      ),
    ).toBe(1);
  });

  test("(graceful) SigLIP encoder 미가용 → backfill 0 + 비교할 개념 임베딩 없으면 연결 0", async () => {
    // 개념은 있으나 SigLIP 임베딩이 없고, encoder 도 미가용 → backfill 0 채움.
    insertConcept(db, "cpt_yellow", "노란색");
    const nodeId = insertImageNode(db, unitAt(0));

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
    try {
      const linked = await linkImageToConceptsBySiglip({
        db,
        nodeId,
        threshold: 0.1,
        embedder: fixtureEmbedder({ available: false }),
      });
      // 비교할 개념 SigLIP 임베딩이 0개라 연결 0(정직한 비활성, 가짜 엣지 0).
      expect(linked).toEqual([]);
    } finally {
      console.warn = origWarn;
    }
    expect(countEdges(db, nodeId)).toBe(0);
    expect(warnings.some((w) => w.includes("backfill skipped"))).toBe(true);
  });

  test("(dim 방어) 이미지 임베딩 차원 불일치 → 구체 에러 throw", async () => {
    const rowid = insertConcept(db, "cpt_yellow", "노란색");
    setConceptSiglip(db, rowid, unitAt(0));
    const nodeId = insertImageNode(db, null);

    expect(
      linkImageToConceptsBySiglip({
        db,
        nodeId,
        threshold: 0.1,
        embedder: fixtureEmbedder(),
        imageEmbedding: new Float32Array(384), // 잘못된 차원
      }),
    ).rejects.toThrow(/dim mismatch.*got 384.*expected 768/);
  });
});

describe("linkImageToConceptsBySiglip — 실제 SigLIP text encoder lazy backfill(E2E)", () => {
  let db: Database;
  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
  });
  afterEach(() => {
    db.close();
  });

  test("실제 모델이 lazy backfill 로 개념 SigLIP 임베딩을 채운다", async () => {
    insertConcept(db, "cpt_yellow", "노란색");
    insertConcept(db, "cpt_ball", "농구");

    // 이미지 임베딩은 데이터 fixture(image encoder hang 회피 — dispatch 허용).
    // backfill 은 실제 text encoder 로 개념을 채운다.
    const nodeId = insertImageNode(db, unitAt(0));

    await linkImageToConceptsBySiglip({
      db,
      nodeId,
      threshold: 0.05,
      embedder: defaultSiglipTextEmbedder,
    });

    // 실제 모델로 두 개념 SigLIP 임베딩이 채워졌다(768-dim).
    const count = Number(
      (
        db.prepare("SELECT COUNT(*) AS c FROM concept_siglip_vec").get() as {
          c: number;
        }
      ).c,
    );
    expect(count).toBe(2);
    const dim = (
      db
        .prepare("SELECT vec_length(embedding) AS n FROM concept_siglip_vec LIMIT 1")
        .get() as { n: number }
    ).n;
    expect(dim).toBe(SIGLIP_DIM);
  }, 60_000);
});
