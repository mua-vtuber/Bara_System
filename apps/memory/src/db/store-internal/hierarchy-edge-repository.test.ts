/**
 * hierarchy-edge-repository.test.ts — 위계 단일 출처 읽기/쓰기 헬퍼 가드
 * (Stage 0 Task 3 · spec 2026-06-14 §4.1).
 *
 * 실제 bun:sqlite(:memory:) + 실제 schema(openMemoryDatabase, v20 hierarchy_edges +
 * idx_he_source·idx_he_target 포함)로 통합 검증한다 — Mock 클래스 0. hierarchy_edges 는
 * FK 0 이라(끝점이 concept·person·8 엔티티·project 어느 타입 행이든 가리킴) 끝점 행을
 * 미리 넣지 않아도 엣지를 적을 수 있다. 끝점 행 실재는 wiring(S0-T4 이후)이 책임지고,
 * 이 repository 는 멱등 저장·삭제·자식 BFS·1단 부모/자식 조회만 본다.
 *
 * 이 task 는 새 테이블 위 헬퍼만 만든다 — 옛 concept_edges parent_of 통로(edge-repository)
 * 는 그대로 두고 호출자 전환은 후속 task 가 한다.
 */
import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../migrations.ts";
import { HierarchyEdgeRepository } from "./hierarchy-edge-repository.ts";

let db: Database;
let repo: HierarchyEdgeRepository;

const TEST_PROVENANCE = "system" as const;
const TEST_SOURCE_NODE_ID = null;

function testHierarchyMeta(): {
  provenance: typeof TEST_PROVENANCE;
  sourceNodeId: null;
} {
  return { provenance: TEST_PROVENANCE, sourceNodeId: TEST_SOURCE_NODE_ID };
}

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
  repo = new HierarchyEdgeRepository(db);
});
afterEach(() => {
  db.close();
});

describe("addHierarchyEdge — 쓰기·멱등·기본값", () => {
  test("신규는 true, 한 행이 들어가고 weight 기본 0.9·relation='parent_of'", () => {
    const created = repo.addHierarchyEdge({
      sourceType: "concept",
      sourceId: "cpt_생물",
      targetType: "creature",
      targetId: "crt_고양이",
      ...testHierarchyMeta(),
});
    expect(created).toBe(true);

    const row = db
      .query(
        `SELECT relation, weight FROM hierarchy_edges
         WHERE source_id = ? AND target_id = ?`,
      )
      .get("cpt_생물", "crt_고양이") as { relation: string; weight: number };
    expect(row.relation).toBe("parent_of");
    expect(row.weight).toBe(0.9);
  });

  test("멱등 — 같은 끝점 두 번이면 두 번째는 false·한 행만", () => {
    const first = repo.addHierarchyEdge({
      sourceType: "concept",
      sourceId: "cpt_만화",
      targetType: "concept",
      targetId: "cpt_주술회전",
      ...testHierarchyMeta(),
});
    const second = repo.addHierarchyEdge({
      sourceType: "concept",
      sourceId: "cpt_만화",
      targetType: "concept",
      targetId: "cpt_주술회전",
      provenance: "hashtag",
      sourceNodeId: 999,
    });
    expect(first).toBe(true);
    expect(second).toBe(false);

    const cnt = db
      .query(
        `SELECT COUNT(*) AS c FROM hierarchy_edges
         WHERE source_id = ? AND target_id = ?`,
      )
      .get("cpt_만화", "cpt_주술회전") as { c: number };
    expect(cnt.c).toBe(1);
    const row = db
      .query(
        `SELECT provenance, source_node_id FROM hierarchy_edges
         WHERE source_id = ? AND target_id = ?`,
      )
      .get("cpt_만화", "cpt_주술회전") as { provenance: string; source_node_id: number | null };
    expect(row.provenance).toBe("system");
    expect(row.source_node_id).toBeNull();
  });

  test("weight 를 주면 그 값으로 저장한다", () => {
    repo.addHierarchyEdge({
      sourceType: "concept",
      sourceId: "cpt_a",
      targetType: "concept",
      targetId: "cpt_b",
      ...testHierarchyMeta(),
      weight: 0.5,
    });
    const row = db
      .query("SELECT weight FROM hierarchy_edges WHERE source_id = ?")
      .get("cpt_a") as { weight: number };
    expect(row.weight).toBe(0.5);
  });
});

describe("removeHierarchyEdge — 삭제·멱등", () => {
  test("있는 엣지를 떼면 행이 사라진다", () => {
    repo.addHierarchyEdge({
      sourceType: "concept",
      sourceId: "cpt_x",
      targetType: "concept",
      targetId: "cpt_y",
      ...testHierarchyMeta(),
});
    repo.removeHierarchyEdge("concept", "cpt_x", "concept", "cpt_y");
    const cnt = db
      .query("SELECT COUNT(*) AS c FROM hierarchy_edges WHERE source_id = ?")
      .get("cpt_x") as { c: number };
    expect(cnt.c).toBe(0);
  });

  test("멱등 — 없는 엣지 삭제는 no-op(throw 없음)", () => {
    expect(() =>
      repo.removeHierarchyEdge("concept", "cpt_없음", "concept", "cpt_역시없음"),
    ).not.toThrow();
  });
});

describe("getParentOfChildrenTransitive — 자식 BFS", () => {
  test("빈 seed → 빈 배열(IN () 빈 절 방어)", () => {
    expect(repo.getParentOfChildrenTransitive([], 0.5, 50)).toEqual([]);
  });

  test("종류 섞인(cpt_·crt_) 자식을 BFS 깊이 순으로 회신", () => {
    // 사슬: cpt_생물 → crt_동물(깊이1) → crt_고양이(깊이2)
    //       cpt_생물 → cpt_식물(깊이1)
    repo.addHierarchyEdge({
      sourceType: "concept",
      sourceId: "cpt_생물",
      targetType: "creature",
      targetId: "crt_동물",
      ...testHierarchyMeta(),
});
    repo.addHierarchyEdge({
      sourceType: "concept",
      sourceId: "cpt_생물",
      targetType: "concept",
      targetId: "cpt_식물",
      ...testHierarchyMeta(),
});
    repo.addHierarchyEdge({
      sourceType: "creature",
      sourceId: "crt_동물",
      targetType: "creature",
      targetId: "crt_고양이",
      ...testHierarchyMeta(),
});

    const children = repo.getParentOfChildrenTransitive(["cpt_생물"], 0.5, 50);
    // 깊이1(crt_동물·cpt_식물)이 깊이2(crt_고양이)보다 앞.
    expect(children).toContain("crt_동물");
    expect(children).toContain("cpt_식물");
    expect(children).toContain("crt_고양이");
    expect(children.indexOf("crt_고양이")).toBeGreaterThan(
      children.indexOf("crt_동물"),
    );
    // seed 자신은 결과에서 제외.
    expect(children).not.toContain("cpt_생물");
  });

  test("weight < minWeight 자식은 따라가지 않는다", () => {
    repo.addHierarchyEdge({
      sourceType: "concept",
      sourceId: "cpt_부모",
      targetType: "concept",
      targetId: "cpt_약한자식",
      ...testHierarchyMeta(),
      weight: 0.3,
    });
    const children = repo.getParentOfChildrenTransitive(["cpt_부모"], 0.5, 50);
    expect(children).not.toContain("cpt_약한자식");
  });

  test("limit 상한을 넘지 않는다", () => {
    for (let i = 0; i < 5; i++) {
      repo.addHierarchyEdge({
        sourceType: "concept",
        sourceId: "cpt_root",
        targetType: "concept",
        targetId: `cpt_child${i}`,
        ...testHierarchyMeta(),
});
    }
    const children = repo.getParentOfChildrenTransitive(["cpt_root"], 0.5, 3);
    expect(children.length).toBe(3);
  });
});

describe("getDirectChildConceptIds / getDirectParentConceptIds — 1단 조회", () => {
  test("직접 자식만(깊이1) 회신, 손주는 제외", () => {
    repo.addHierarchyEdge({
      sourceType: "concept",
      sourceId: "cpt_조부",
      targetType: "concept",
      targetId: "cpt_부",
      ...testHierarchyMeta(),
});
    repo.addHierarchyEdge({
      sourceType: "concept",
      sourceId: "cpt_부",
      targetType: "concept",
      targetId: "cpt_손",
      ...testHierarchyMeta(),
});
    const direct = repo.getDirectChildConceptIds("cpt_조부");
    expect(direct).toEqual(["cpt_부"]);
  });

  test("직접 부모만(깊이1) 회신", () => {
    repo.addHierarchyEdge({
      sourceType: "concept",
      sourceId: "cpt_부모",
      targetType: "concept",
      targetId: "cpt_자식",
      ...testHierarchyMeta(),
});
    const parents = repo.getDirectParentConceptIds("cpt_자식");
    expect(parents).toEqual(["cpt_부모"]);
  });

  test("자식 없는 잎 → 빈 배열 / 부모 없는 루트 → 빈 배열", () => {
    expect(repo.getDirectChildConceptIds("cpt_외톨이")).toEqual([]);
    expect(repo.getDirectParentConceptIds("cpt_외톨이")).toEqual([]);
  });
});

describe("addReducedHierarchyEdge — 타입 섞인 leaf shortcut 감축", () => {
  test("긴 경로가 이미 있으면 concept→project 직통을 skip 한다", () => {
    repo.addHierarchyEdge({
      sourceType: "concept",
      sourceId: "cpt_프로젝트",
      targetType: "concept",
      targetId: "cpt_코딩",
      ...testHierarchyMeta(),
    });
    repo.addHierarchyEdge({
      sourceType: "concept",
      sourceId: "cpt_코딩",
      targetType: "project",
      targetId: "prj_바라",
      ...testHierarchyMeta(),
    });

    const result = repo.addReducedHierarchyEdge({
      sourceType: "concept",
      sourceId: "cpt_프로젝트",
      targetType: "project",
      targetId: "prj_바라",
      ...testHierarchyMeta(),
    });

    expect(result).toEqual({
      inserted: false,
      skippedAsShortcut: true,
      prunedShortcutCount: 0,
    });
    const cnt = db
      .query(
        `SELECT COUNT(*) AS c FROM hierarchy_edges
         WHERE source_id = 'cpt_프로젝트' AND target_id = 'prj_바라'`,
      )
      .get() as { c: number };
    expect(cnt.c).toBe(0);
  });

  test("leaf 직통이 먼저 있으면 중간 사슬 완성 시 concept→work 직통을 소급 제거한다", () => {
    repo.addHierarchyEdge({
      sourceType: "concept",
      sourceId: "cpt_작품",
      targetType: "work",
      targetId: "wrk_네스트",
      ...testHierarchyMeta(),
    });
    repo.addHierarchyEdge({
      sourceType: "concept",
      sourceId: "cpt_작품",
      targetType: "concept",
      targetId: "cpt_소설",
      ...testHierarchyMeta(),
    });

    const result = repo.addReducedHierarchyEdge({
      sourceType: "concept",
      sourceId: "cpt_소설",
      targetType: "work",
      targetId: "wrk_네스트",
      ...testHierarchyMeta(),
    });

    expect(result.inserted).toBe(true);
    expect(result.skippedAsShortcut).toBe(false);
    expect(result.prunedShortcutCount).toBe(1);
    const direct = db
      .query(
        `SELECT COUNT(*) AS c FROM hierarchy_edges
         WHERE source_id = 'cpt_작품' AND target_id = 'wrk_네스트'`,
      )
      .get() as { c: number };
    expect(direct.c).toBe(0);
    const via = db
      .query(
        `SELECT COUNT(*) AS c FROM hierarchy_edges
         WHERE source_id = 'cpt_소설' AND target_id = 'wrk_네스트'`,
      )
      .get() as { c: number };
    expect(via.c).toBe(1);
  });
});
