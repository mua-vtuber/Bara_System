/**
 * store.classification.test.ts — Phase 11b T1.
 *
 * `SqliteMemoryStore.addClassificationTag` 통합 검증. 실 bun:sqlite + 실 schema v7
 * + 실 Bgem3Embedder (concept 신규 시 임베딩 호출 — Mock 0, CLAUDE.md 정합).
 *
 * 흐름 — image_asset 노드(11a T3) + `addClassificationTag` →
 *  1. category concept 노드 자동 만들기 (is_classification_key=1)
 *  2. value concept 노드 자동 만들기 (is_classification_value=1)
 *  3. hierarchy_edges(parent_of) — concept(category) → concept(value) (콜론 선언
 *     위계 weight 0.9 / S0-T4 — 옛 concept_edges 에서 단일 출처 테이블로 이동)
 *  4. node_concept_edges(role='classification') — image_asset → value (위계 아닌 mention)
 *
 * plan 안 옛 `tagged_with` 양식 가족은 1.0b 이주(EdgeRelation 안 'tagged_with' 폐기) 후
 * `node_concept_edges(role='classification')` 양식으로 풀이 — 옛 hashtag 흐름
 * (`applyHashtagWiring` 안 `addNodeConceptEdge(.., 'tag')`) 같은 갈래 통로 정합.
 *
 * 6 갈래:
 *  (1) 첫 호출 = 두 concept 노드 + node_concept_edges(classification) 1 + concept_edges(parent_of) 1
 *  (2) idempotent — 같은 호출 두 번 = 노드 1 + edge 1 (중복 0)
 *  (3) 여러 category·value = node_concept_edges 3개
 *  (4) 같은 value 다른 category — value 노드 1 + edge 두 갈래(같은 value 두 번 tag)
 *  (5) 옛 concept 재사용 — 같은 category·value 다른 image = value 노드 1 / 두 image 모두 edge
 *  (6) 신규 concept 안 role flag 정합 (is_classification_key / is_classification_value)
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
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "./migrations.ts";
import { SqliteMemoryStore } from "./store.ts";
import { addImageAssetNode } from "../memory/image-asset.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

afterAll(() => {});

function seedImageAsset(db: Database, sha: string, suffix: string): number {
  // FK 정합 — image_asset 노드 metadata 안 asset_sha256 는 자유 글자라 직접 FK 아니지만,
  // 옛 11a image-asset.test.ts 양식 정합 위해 asset_files 행 한 가지 추가된 상태 보존.
  db.run(
    `INSERT OR IGNORE INTO asset_files
       (sha256, asset_type, asset_path, byte_size, mime_type, first_imported_at)
     VALUES (?, 'image', ?, 100, 'image/png', ?)`,
    [sha, `image/${suffix}/${sha}.png`, Date.now()],
  );
  return addImageAssetNode(db, {
    content: `이미지 자산 (assetSha256=${sha})`,
    embedding: null, // image_vec 미사용 — classification 흐름 단위라 vector 영향 0.
    assetSha256: sha,
    author: "user",
    platform: "discord",
  });
}

describe("SqliteMemoryStore.addClassificationTag", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let imageId: number;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    imageId = seedImageAsset(db, "aaa111", "aa");
  });

  afterEach(() => {
    db.close();
  });

  /**
   * 개념↔개념 위계(parent_of) 엣지를 hierarchy_edges 에서 읽는다(S0-T4 — 옛
   * concept_edges 가 아닌 단일 출처 테이블). targetId 로 거른 행을 돌려줘
   * "한 value 를 가리키는 부모가 몇이냐" 단정에 쓴다.
   */
  function hierarchyParentsOf(
    targetConceptId: string,
  ): Array<{ sourceId: string; targetId: string }> {
    return db
      .prepare(
        `SELECT source_id AS sourceId, target_id AS targetId
         FROM hierarchy_edges
         WHERE relation = 'parent_of'
           AND source_type = 'concept' AND target_type = 'concept'
           AND target_id = ?`,
      )
      .all(targetConceptId) as Array<{ sourceId: string; targetId: string }>;
  }

  // ── (1) 첫 호출 = 두 concept 노드 + 두 갈래 edge ──
  test("첫 호출 = category·value concept 노드 + node_concept_edges(classification) + hierarchy_edges(parent_of)", async () => {
    await store.addClassificationTag(imageId, "character", "흰머리토끼귀", "user_input", imageId);

    const categoryConcept = await store.findConceptByName("character");
    const valueConcept = await store.findConceptByName("흰머리토끼귀");
    expect(categoryConcept).not.toBeNull();
    expect(valueConcept).not.toBeNull();

    // node_concept_edges — image_asset → value
    const nodeEdges = await store.listNodeConceptEdges({
      nodeId: imageId,
      role: "classification",
    });
    expect(nodeEdges).toHaveLength(1);
    expect(nodeEdges[0]!.conceptId).toBe(valueConcept!.conceptId);

    // hierarchy_edges(parent_of) — concept(category) → concept(value)
    const match = hierarchyParentsOf(valueConcept!.conceptId).find(
      (e) => e.sourceId === categoryConcept!.conceptId,
    );
    expect(match).toBeDefined();
  });

  // ── (2) idempotent ──
  test("idempotent — 같은 (imageId, category, value) 두 번 호출 = 노드 1 + edge 1", async () => {
    await store.addClassificationTag(imageId, "character", "흰머리토끼귀", "user_input", imageId);
    await store.addClassificationTag(imageId, "character", "흰머리토끼귀", "user_input", imageId);

    // value concept 노드 한 가지만
    const valueConcept = await store.findConceptByName("흰머리토끼귀");
    expect(valueConcept).not.toBeNull();

    // node_concept_edges 한 행만 (INSERT OR IGNORE)
    const nodeEdges = await store.listNodeConceptEdges({
      nodeId: imageId,
      role: "classification",
    });
    expect(nodeEdges).toHaveLength(1);

    // hierarchy_edges(parent_of) 한 행만
    const matching = hierarchyParentsOf(valueConcept!.conceptId);
    expect(matching).toHaveLength(1);
  });

  // ── (3) 여러 category·value ──
  test("여러 category·value = node_concept_edges 3 행", async () => {
    await store.addClassificationTag(imageId, "character", "흰머리토끼귀", "user_input", imageId);
    await store.addClassificationTag(imageId, "style", "수채화", "user_input", imageId);
    await store.addClassificationTag(imageId, "mood", "포근함", "user_input", imageId);

    const nodeEdges = await store.listNodeConceptEdges({
      nodeId: imageId,
      role: "classification",
    });
    expect(nodeEdges).toHaveLength(3);
  });

  // ── (4) 같은 value 다른 category — value 노드 1 / 두 갈래 edge ──
  test("같은 value '봄' 두 category — concept 노드 1 + tagged edge 두 갈래", async () => {
    await store.addClassificationTag(imageId, "character", "봄", "user_input", imageId);
    await store.addClassificationTag(imageId, "mood", "봄", "user_input", imageId);

    // 같은 이름 = 같은 노드(name UNIQUE) — D2 결정 정합
    const valueConcept = await store.findConceptByName("봄");
    expect(valueConcept).not.toBeNull();

    // node_concept_edges 한 행만 — 같은 (nodeId, conceptId, role) 이라 INSERT OR IGNORE
    const nodeEdges = await store.listNodeConceptEdges({
      nodeId: imageId,
      role: "classification",
    });
    expect(nodeEdges).toHaveLength(1);

    // hierarchy_edges(parent_of) 두 행 — character → 봄 / mood → 봄
    const targetingValue = hierarchyParentsOf(valueConcept!.conceptId);
    expect(targetingValue).toHaveLength(2);
  });

  // ── (5) 옛 concept 재사용 — 다른 image_asset 도 자연 합류 ──
  test("같은 category·value 다른 image — value 노드 1 / 두 image 모두 edge", async () => {
    const secondImageId = seedImageAsset(db, "bbb222", "bb");
    await store.addClassificationTag(imageId, "character", "흰머리토끼귀", "user_input", imageId);
    await store.addClassificationTag(secondImageId, "character", "흰머리토끼귀", "user_input", secondImageId);

    const valueConcept = await store.findConceptByName("흰머리토끼귀");
    expect(valueConcept).not.toBeNull();

    const firstEdges = await store.listNodeConceptEdges({
      nodeId: imageId,
      role: "classification",
    });
    const secondEdges = await store.listNodeConceptEdges({
      nodeId: secondImageId,
      role: "classification",
    });
    expect(firstEdges).toHaveLength(1);
    expect(secondEdges).toHaveLength(1);
    expect(firstEdges[0]!.conceptId).toBe(valueConcept!.conceptId);
    expect(secondEdges[0]!.conceptId).toBe(valueConcept!.conceptId);
  });

  // ── (6) role flag 정합 ──
  test("신규 concept role flag — category=is_classification_key / value=is_classification_value", async () => {
    await store.addClassificationTag(imageId, "character", "흰머리토끼귀", "user_input", imageId);

    const categoryConcept = await store.findConceptByName("character");
    const valueConcept = await store.findConceptByName("흰머리토끼귀");
    expect(categoryConcept!.isClassificationKey).toBe(true);
    expect(valueConcept!.isClassificationValue).toBe(true);
  });

  // ── (7) M-5 회귀 가드 — 둘째 엣지 쓰기 실패 시 첫째 엣지도 롤백 ──
  // 두 엣지 쓰기(hierarchy_edges parent_of + node_concept_edges classification)를 한
  // 트랜잭션으로 묶었음을 실 SqliteMemoryStore 로 증명한다. Mock 0 — 실패는 실제
  // 제약 위반(존재하지 않는 nodeId 라 node_concept_edges.node_id FK 위배)으로 주입한다.
  // 둘째 쓰기가 throw 하면 트랜잭션이 롤백돼 첫째 위계 엣지가 커밋되지 않아야 한다.
  test("둘째 엣지 실패 시 첫째(hierarchy parent_of)도 롤백 — 부분 상태 차단(M-5)", async () => {
    const ghostNodeId = 999_999; // knowledge_nodes 에 없는 id → FK 위배 유발

    await expect(
      store.addClassificationTag(ghostNodeId, "character", "흰머리토끼귀", "user_input", ghostNodeId),
    ).rejects.toThrow();

    // 두 개념은 트랜잭션 밖에서 자기-원자적으로 먼저 만들어지므로 존재한다.
    const categoryConcept = await store.findConceptByName("character");
    const valueConcept = await store.findConceptByName("흰머리토끼귀");
    expect(categoryConcept).not.toBeNull();
    expect(valueConcept).not.toBeNull();

    // 위계 엣지(첫째 쓰기)는 롤백돼 hierarchy_edges 에 한 행도 없어야 한다.
    const leaked = hierarchyParentsOf(valueConcept!.conceptId).filter(
      (e) => e.sourceId === categoryConcept!.conceptId,
    );
    expect(leaked).toHaveLength(0);

    // classification 엣지(둘째 쓰기)도 당연히 없다.
    const nodeEdges = await store.listNodeConceptEdges({
      nodeId: ghostNodeId,
      role: "classification",
    });
    expect(nodeEdges).toHaveLength(0);
  });
});
