import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../migrations.ts";
import { CleanupProposalsRepository } from "./cleanup-proposals-repository.ts";

let db: Database;
let repo: CleanupProposalsRepository;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
  repo = new CleanupProposalsRepository(db);
});

afterEach(() => {
  db.close();
});

describe("CleanupProposalsRepository", () => {
  test("(1) insert — 'cp_' 접두 + uuid 양식 id 회신", () => {
    const id = repo.insert("merge_candidate", { a: 1, b: "x" });
    expect(id.startsWith("cp_")).toBe(true);
    // crypto.randomUUID() = 36 글자 (8-4-4-4-12 dash 양식). 접두 3 = 총 39.
    expect(id.length).toBe(39);
    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM cleanup_proposals").get() as { c: number }).c;
    expect(cnt).toBe(1);
  });

  test("(2) findById — insert 직후 매치 + payload JSON 파싱 정합", () => {
    const id = repo.insert("alias_candidate", { newId: "cpt_a", candidateId: "cpt_b", cosine: 0.97 });
    const got = repo.findById(id);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(id);
    expect(got!.kind).toBe("alias_candidate");
    expect(got!.payload).toEqual({ newId: "cpt_a", candidateId: "cpt_b", cosine: 0.97 });
    expect(got!.status).toBe("pending");
    expect(got!.resolvedAt).toBeNull();
    expect(got!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  test("(3) findById — 없는 id 는 null (실패와 '없음' 구별)", () => {
    const got = repo.findById("cp_nonexistent");
    expect(got).toBeNull();
  });

  test("(4) findPending — 빈 DB 는 빈 배열", () => {
    const rows = repo.findPending(10);
    expect(rows).toEqual([]);
  });

  test("(5) findPending paging — 3 추가 후 limit:2 → 2 회신, offset:2 limit:2 → 1 회신", () => {
    const id1 = repo.insert("kind_a", { n: 1 });
    const id2 = repo.insert("kind_b", { n: 2 });
    const id3 = repo.insert("kind_c", { n: 3 });

    const page1 = repo.findPending(2, 0);
    expect(page1.length).toBe(2);
    // created_at ASC + id ASC 정렬 — insert 순서대로 첫 두 개
    expect(page1.map((p) => p.id)).toEqual([id1, id2]);

    const page2 = repo.findPending(2, 2);
    expect(page2.length).toBe(1);
    expect(page2[0]!.id).toBe(id3);
  });

  test("(6) updateStatus(id, 'approved') — true 회신 + findById status='approved' + resolved_at 채움", () => {
    const id = repo.insert("merge_candidate", { x: 1 });
    const ok = repo.updateStatus(id, "approved");
    expect(ok).toBe(true);
    const got = repo.findById(id);
    expect(got).not.toBeNull();
    expect(got!.status).toBe("approved");
    expect(got!.resolvedAt).not.toBeNull();
    expect(got!.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  test("(7) updateStatus(없는 id, 'rejected') — false 회신 (changes=0)", () => {
    const ok = repo.updateStatus("cp_nonexistent", "rejected");
    expect(ok).toBe(false);
  });

  test("(8) findPending — approved/rejected 후보 안 회신 (status='pending' 단일)", () => {
    const id1 = repo.insert("k1", { n: 1 });
    const id2 = repo.insert("k2", { n: 2 });
    const id3 = repo.insert("k3", { n: 3 });

    repo.updateStatus(id1, "approved");
    repo.updateStatus(id2, "rejected");
    // id3 = pending 그대로

    const pending = repo.findPending(10);
    expect(pending.length).toBe(1);
    expect(pending[0]!.id).toBe(id3);
    expect(pending[0]!.status).toBe("pending");
  });
});
