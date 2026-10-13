/**
 * server-internal/routes/cleanup-proposals.test.ts — cleanup_proposals 검토 게이트
 * API 통합 검증 (Phase 11b T13 / sidecar acceptance).
 *
 * 검증 정신: *라우트 분기 + Repository 통합 + status 전환 + 호출 시점*.
 *
 * DCL-5 (2026-07-11 효율 가동 spec 단락 6.C-3): 'classification' / 'synonym'
 * approve 분기는 생산자 없는 죽은 코드라 제거됐다 — 이 두 kind 는 이제
 * KNOWN_KINDS 밖이라 다른 미등록 kind 와 동일하게 400 + pending 보존을
 * 받는다(아래 (f2)). D2 동의어 병합 생산자 출하 시 분기가 복원되면 이
 * 테스트도 같은 commit 에서 되돌린다.
 *
 * 격리 양식: `buildMemoryApi` 우회 + `registerCleanupProposalsRoutes` 직접 호출 +
 * storeStub 한 묶음 (옛 assets.test.ts 양식 정합 — `as unknown as SqliteMemoryStore`
 * cast 한 한, 가짜 클래스 만들지 않음). 본 dispatch worktree 환경 한정 onnxruntime
 * EACCES 회피 — A1 ARM64 정합 자가 보존 (옛 T11 commit 메시지 안 환경 한정 흠
 * 양식 정합).
 *
 * 실 SQLite(:memory:) + 실 Repository + 실 Hono app + mock 클래스 0.
 *
 * 검증 가족 8 case:
 *   (a) GET /cleanup-proposals?status=pending → 빈 목록 (proposals=[] / total=0)
 *   (b) GET /cleanup-proposals 여러 건 paging (limit/offset 한 묶음)
 *   (c) GET /cleanup-proposals/:id → 정상 회수 / 없는 id = 404
 *   (f) POST .../:id/approve { kind: 'unknown_kind' } → 400 + status='pending' 보존
 *       (사용자 결정 동결 — silent skip 차단)
 *   (f2) POST .../:id/approve { kind: 'classification' | 'synonym' } → 400 +
 *       status='pending' 보존 (DCL-5 — 생산자 없는 죽은 분기 제거 후 미등록 kind 취급)
 *   (g) POST .../:id/reject → status='rejected' + 적용 함수 호출 안 함
 *   (h) 이미 resolved (status != pending) approve/reject 한 묶음 = 400
 *   (i~n) POST .../:id/approve { kind: 'metadata_fill' } — Phase 7 2차 Task 4:
 *       place→setPlace(…,"inferred") / event_at→setEventAt / payload 어긋남
 *       400+pending 보존 / reject 적용 함수 호출 0
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { CleanupProposalsRepository } from "../../db/store-internal/cleanup-proposals-repository.ts";
import { registerCleanupProposalsRoutes } from "./cleanup-proposals.ts";
import type { MemoryApiDeps } from "../types.ts";
import type { SqliteMemoryStore } from "../../db/store.ts";
import { RegexUserRepo } from "../../memory/regex-l0/user-repo.ts";
import { RegexL0Extractor } from "../../memory/regex-l0/extractor.ts";
import { regexFingerprint } from "../../memory/cleanup-deep-pass/stage-fingerprint.ts";
import { getStageResult } from "../../memory/cleanup-deep-pass/stage-results-ledger.ts";
import { CLEANUP_STAGE_LLM_LIMITS } from "../../memory/cleanup-deep-pass/stage-constants.ts";
import { entityTargetKey } from "../../memory/cleanup-deep-pass/lens-draft-candidate-query.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";

// ── 호출 추적 ──────────────────────────────────────────────────────────────
//
// store 안 두 적용 함수 호출 시점·인자 추적. 옛 assets.test.ts 양식 정합 — 가짜
// 클래스 만들지 않고 `as unknown as SqliteMemoryStore` cast 한 묶음 한정.
// 본 두 함수 자체 정합은 옛 T1 store.classification.test.ts + 옛 6b
// concept-aliases.test.ts 가 권위.

interface ClassificationCall {
  nodeId: number;
  category: string;
  value: string;
}

interface SynonymCall {
  targetConceptId: string;
  sourceConceptId: string;
}

interface EventAtCall {
  nodeId: number;
  eventAt: string;
  source: string;
}

interface PlaceCall {
  nodeId: number;
  value: string;
  source: string;
}

interface PersonLinkCall {
  nodeId: number;
  personId: string;
  relation: string;
  provenance: string;
  sourceNodeId: number | null;
}

let db: Database;
let repo: CleanupProposalsRepository;
let app: Hono;
let classificationCalls: ClassificationCall[];
let synonymCalls: SynonymCall[];
let eventAtCalls: EventAtCall[];
let placeCalls: PlaceCall[];
let personLinkCalls: PersonLinkCall[];
let existingNodes: Set<number>;
let existingPersons: Set<string>;
// setPlace 가 false 를 돌려주게 만드는 테스트 제어값(직접 입력 direct 보호 거부 모사).
let placeWriteAllowed: boolean;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
  repo = new CleanupProposalsRepository(db);
  classificationCalls = [];
  synonymCalls = [];
  eventAtCalls = [];
  placeCalls = [];
  personLinkCalls = [];
  existingNodes = new Set();
  existingPersons = new Set();
  placeWriteAllowed = true;

  // store 안 라우트가 호출하는 메서드만 추적한다 — getRawDb / addClassificationTag /
  // mergeConceptAlias / setEventAt / setPlace / addNodePersonEdge.
  // retriever / assembler 가족은 이 라우트가
  // 닿지 않는다 (undefined cast 한정).
  const storeStub = {
    getRawDb: () => db,
    addClassificationTag: async (
      nodeId: number,
      category: string,
      value: string,
    ) => {
      classificationCalls.push({ nodeId, category, value });
    },
    mergeConceptAlias: async (
      targetConceptId: string,
      sourceConceptId: string,
    ) => {
      synonymCalls.push({ targetConceptId, sourceConceptId });
    },
    setEventAt: async (nodeId: number, eventAt: string, source: string) => {
      eventAtCalls.push({ nodeId, eventAt, source });
      return true;
    },
    setPlace: async (nodeId: number, value: string, source: string) => {
      placeCalls.push({ nodeId, value, source });
      // placeWriteAllowed=false 면 더 높은 출처(직접 입력 direct)가 이미 채워
      // canWriteField 가 거부하는 경우를 모사한다(source-conflict). 라우트는 inferred
      // 라 게이트 거부(gate-rejected)는 안 일어난다(concept 위계 갈래).
      return placeWriteAllowed
        ? { wrote: true }
        : { wrote: false, skipReason: "source-conflict" };
    },
    getNode: async (nodeId: number) =>
      existingNodes.has(nodeId) ? ({ id: nodeId } as unknown) : null,
    getPerson: async (personId: string) =>
      existingPersons.has(personId)
        ? ({ personId, displayName: personId, aliases: [], externalRefs: {} } as unknown)
        : null,
    addNodePersonEdge: async (
      nodeId: number,
      personId: string,
      relation: string,
      provenance: string,
      sourceNodeId: number | null,
    ) => {
      personLinkCalls.push({
        nodeId,
        personId,
        relation,
        provenance,
        sourceNodeId,
      });
      return true;
    },
  } as unknown as SqliteMemoryStore;

  const deps: MemoryApiDeps = {
    store: storeStub,
    retriever: undefined as unknown as MemoryApiDeps["retriever"],
    assembler: undefined as unknown as MemoryApiDeps["assembler"],
  };

  app = new Hono({ strict: false });
  registerCleanupProposalsRoutes(app, deps);
});

afterEach(() => {
  db.close();
});

// ── (a) GET 빈 목록 ─────────────────────────────────────────────────────────

describe("GET /cleanup-proposals — 목록 + paging", () => {
  test("(a) 후보 0건 = proposals:[] + total:0 (정직한 빈 게이트)", async () => {
    const res = await app.request("/cleanup-proposals?status=pending");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposals: unknown[]; total: number };
    expect(body.proposals).toEqual([]);
    expect(body.total).toBe(0);
  });

  // ── (b) GET 여러 건 + paging ──────────────────────────────────────────────

  test("(b) paging — limit/offset 한 묶음 + total 보존", async () => {
    repo.insert("classification", {
      nodeId: 1,
      category: "character",
      value: "흰머리토끼귀",
    });
    repo.insert("synonym", { conceptId: "c_a", alias: "c_b" });
    repo.insert("classification", {
      nodeId: 2,
      category: "mood",
      value: "차분",
    });

    const page1 = await app.request(
      "/cleanup-proposals?status=pending&limit=2&offset=0",
    );
    expect(page1.status).toBe(200);
    const body1 = (await page1.json()) as {
      proposals: { kind: string }[];
      total: number;
    };
    expect(body1.proposals.length).toBe(2);
    expect(body1.total).toBe(3);

    const page2 = await app.request(
      "/cleanup-proposals?status=pending&limit=2&offset=2",
    );
    const body2 = (await page2.json()) as {
      proposals: { kind: string }[];
      total: number;
    };
    expect(body2.proposals.length).toBe(1);
    expect(body2.total).toBe(3);
  });

  test("(b2) 지원 안 하는 status = 400 정직 회신", async () => {
    const res = await app.request("/cleanup-proposals?status=approved");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("approved");
    expect(body.error).toContain("pending 한정");
  });
});

// ── (c) GET /:id ────────────────────────────────────────────────────────────

describe("GET /cleanup-proposals/:id — 한 건 회수", () => {
  test("(c) 정상 회수 — payload + status + createdAt 한 묶음", async () => {
    const id = repo.insert("classification", {
      nodeId: 7,
      category: "character",
      value: "흰머리",
    });
    const res = await app.request(`/cleanup-proposals/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      kind: string;
      payload: { nodeId: number; category: string; value: string };
      status: string;
    };
    expect(body.id).toBe(id);
    expect(body.kind).toBe("classification");
    expect(body.payload.nodeId).toBe(7);
    expect(body.payload.category).toBe("character");
    expect(body.payload.value).toBe("흰머리");
    expect(body.status).toBe("pending");
  });

  test("(c2) 없는 id = 404 정직 회신", async () => {
    const res = await app.request("/cleanup-proposals/cp_nonexistent");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("proposal 없음");
  });
});

// ── (d) POST approve classification ─────────────────────────────────────────

describe("POST /cleanup-proposals/:id/approve — kind 분기", () => {
  // ── (f) unknown kind = 400 + pending 보존 ────────────────────────────────

  test("(f) 알 수 없는 kind = 400 + status='pending' 보존 (사용자 결정 동결)", async () => {
    const id = repo.insert("future_kind_v2", { foo: "bar" });

    const res = await app.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("알 수 없는 kind");
    expect(body.error).toContain("future_kind_v2");
    expect(body.error).toContain("적용 함수 부재");

    // 사용자 결정 동결 — status 변경 안 함.
    const after = repo.findById(id);
    expect(after?.status).toBe("pending");
    expect(after?.resolvedAt).toBeNull();

    // 적용 함수 호출 안 함.
    expect(classificationCalls).toEqual([]);
    expect(synonymCalls).toEqual([]);
  });

  // ── (f2) classification / synonym = 400 + pending 보존 (DCL-5 죽은 분기 제거) ──

  test("(f2) classification = 400 + status='pending' 보존 (생산자 없는 죽은 kind — DCL-5)", async () => {
    const id = repo.insert("classification", {
      nodeId: 42,
      category: "character",
      value: "흰머리토끼귀",
    });

    const res = await app.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("알 수 없는 kind");
    expect(body.error).toContain("classification");
    expect(body.error).toContain("적용 함수 부재");

    const after = repo.findById(id);
    expect(after?.status).toBe("pending");
    expect(after?.resolvedAt).toBeNull();
    expect(classificationCalls).toEqual([]);
  });

  test("(f3) synonym = 400 + status='pending' 보존 (생산자 없는 죽은 kind — DCL-5)", async () => {
    const id = repo.insert("synonym", {
      conceptId: "concept_target_001",
      alias: "concept_source_002",
    });

    const res = await app.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("알 수 없는 kind");
    expect(body.error).toContain("synonym");
    expect(body.error).toContain("적용 함수 부재");

    const after = repo.findById(id);
    expect(after?.status).toBe("pending");
    expect(after?.resolvedAt).toBeNull();
    expect(synonymCalls).toEqual([]);
  });
});

// ── (i) POST approve metadata_fill ──────────────────────────────────────────
//
// Phase 7 2차 Task 4 — 갈래 2 가 만든 빈 칸 채움 제안. field 별 분기:
//   - place    → setPlace(nodeId, value, "inferred")  (활용 단계2 ③·place 엔티티 합류)
//   - event_at → setEventAt(nodeId, value, "inferred") (1차 setter 재사용)
// 수락/거절만 — 수정 X (설계 4.1). payload 어긋남 = 400 + status pending 보존.
// 직접 입력(direct) 장소가 이미 있으면 setPlace 가 false → 400 정직한 skip(spec §5.1·
// err 헬퍼 status 집합에 맞춰 기존 거부 양식 400 에 합류).

describe("POST /cleanup-proposals/:id/approve — metadata_fill kind", () => {
  test("(i) field='place' → setPlace(nodeId, value, 'inferred') + status='approved'", async () => {
    const id = repo.insert("metadata_fill", {
      nodeId: 31,
      field: "place",
      value: "에버랜드",
      evidence: "직전 '에버랜드에 왔다'",
    });

    const res = await app.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approved: string };
    expect(body.approved).toBe(id);

    // 추론 place 는 setPlace(…, "inferred") 진입점으로 합류(place 엔티티·출처 가드).
    expect(placeCalls).toEqual([
      { nodeId: 31, value: "에버랜드", source: "inferred" },
    ]);
    expect(classificationCalls).toEqual([]);
    expect(eventAtCalls).toEqual([]);
    expect(synonymCalls).toEqual([]);

    const after = repo.findById(id);
    expect(after?.status).toBe("approved");
    expect(after?.resolvedAt).not.toBeNull();
  });

  test("(i2) field='place' 직접 입력 보호 — setPlace false → 400 + status pending 보존", async () => {
    placeWriteAllowed = false; // 직접 입력(direct) 장소가 이미 있어 canWriteField 거부 모사.
    const id = repo.insert("metadata_fill", {
      nodeId: 36,
      field: "place",
      value: "속초",
      evidence: "추론 후보",
    });

    const res = await app.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("직접 입력");

    // setPlace 는 한 번 시도했으나 거부됨 — 덮어쓰기 0·재시도 가능하게 pending 보존.
    expect(placeCalls).toEqual([
      { nodeId: 36, value: "속초", source: "inferred" },
    ]);
    const after = repo.findById(id);
    expect(after?.status).toBe("pending");
    expect(after?.resolvedAt).toBeNull();
  });

  test("(j) field='event_at' → setEventAt(nodeId, value) + status='approved'", async () => {
    const id = repo.insert("metadata_fill", {
      nodeId: 32,
      field: "event_at",
      value: "2026-05-25",
      evidence: "같은 세션 '어제 다녀왔다'",
    });

    const res = await app.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(200);

    // 1차 setter 재사용 — setEventAt 한 번, 인자 정합.
    expect(eventAtCalls).toEqual([{ nodeId: 32, eventAt: "2026-05-25", source: "inferred" }]);
    expect(classificationCalls).toEqual([]);
    expect(synonymCalls).toEqual([]);

    const after = repo.findById(id);
    expect(after?.status).toBe("approved");
  });

  test("(k) nodeId 가 number 아님 = 400 + status='pending' 보존 + 적용 함수 호출 0", async () => {
    const id = repo.insert("metadata_fill", {
      nodeId: "31",
      field: "place",
      value: "에버랜드",
    });

    const res = await app.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("metadata_fill payload 어긋남");

    // 재시도 가능하게 pending 보존.
    const after = repo.findById(id);
    expect(after?.status).toBe("pending");
    expect(after?.resolvedAt).toBeNull();

    expect(classificationCalls).toEqual([]);
    expect(eventAtCalls).toEqual([]);
    expect(placeCalls).toEqual([]);
  });

  test("(l) value 빈 문자열 = 400 + pending 보존 + 적용 함수 호출 0", async () => {
    const id = repo.insert("metadata_fill", {
      nodeId: 33,
      field: "place",
      value: "",
    });

    const res = await app.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("metadata_fill payload 어긋남");

    const after = repo.findById(id);
    expect(after?.status).toBe("pending");
    expect(classificationCalls).toEqual([]);
    expect(eventAtCalls).toEqual([]);
    expect(placeCalls).toEqual([]);
  });

  test("(m) field 가 모르는 값 = 400 + pending 보존 + 적용 함수 호출 0", async () => {
    const id = repo.insert("metadata_fill", {
      nodeId: 34,
      field: "mood",
      value: "차분",
    });

    const res = await app.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("metadata_fill field 어긋남");
    expect(body.error).toContain("place");
    expect(body.error).toContain("event_at");

    const after = repo.findById(id);
    expect(after?.status).toBe("pending");
    expect(classificationCalls).toEqual([]);
    expect(eventAtCalls).toEqual([]);
    expect(placeCalls).toEqual([]);
  });

  test("(n) reject metadata_fill → status='rejected' + 적용 함수 호출 0", async () => {
    const id = repo.insert("metadata_fill", {
      nodeId: 35,
      field: "event_at",
      value: "2026-05-25",
    });

    const res = await app.request(`/cleanup-proposals/${id}/reject`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rejected: string };
    expect(body.rejected).toBe(id);

    expect(classificationCalls).toEqual([]);
    expect(eventAtCalls).toEqual([]);
    expect(synonymCalls).toEqual([]);

    const after = repo.findById(id);
    expect(after?.status).toBe("rejected");
    expect(after?.resolvedAt).not.toBeNull();
  });
});

// ── person_link 승인 게이트 ────────────────────────────────────────────────
//
// 데이터 정리 AI 사람 연결 제안은 새 사람 생성 권한이 없다. 승인 payload 는
// 기존 nodeId + 기존 personId 만 허용하며, 문자열 이름이나 임의 id 는 거부한다.

describe("POST /cleanup-proposals/:id/approve — person_link kind", () => {
  test("기존 node + 기존 personId → mentions edge 추가 + status='approved'", async () => {
    existingNodes.add(77);
    existingPersons.add("psn_existing");
    const id = repo.insert("person_link", {
      nodeId: 77,
      personId: "psn_existing",
      confidence: 0.82,
      candidateText: "민수",
      evidence: "기존 사람 별칭과 일치",
    });

    const res = await app.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approved: string };
    expect(body.approved).toBe(id);

    expect(personLinkCalls).toEqual([
      {
        nodeId: 77,
        personId: "psn_existing",
        relation: "mentions",
        provenance: "evolver",
        sourceNodeId: 77,
      },
    ]);
    const after = repo.findById(id);
    expect(after?.status).toBe("approved");
    expect(after?.resolvedAt).not.toBeNull();
  });

  test("personId 가 기존 사람에 없으면 404 + pending 보존 + edge 추가 0", async () => {
    existingNodes.add(78);
    const id = repo.insert("person_link", {
      nodeId: 78,
      personId: "psn_missing",
      confidence: 0.91,
    });

    const res = await app.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("person 없음");

    expect(personLinkCalls).toEqual([]);
    const after = repo.findById(id);
    expect(after?.status).toBe("pending");
    expect(after?.resolvedAt).toBeNull();
  });

  test("사람 이름 문자열만 있는 payload 는 400 + pending 보존", async () => {
    existingNodes.add(79);
    existingPersons.add("psn_minsu");
    const id = repo.insert("person_link", {
      nodeId: 79,
      personName: "민수",
      confidence: 0.95,
    });

    const res = await app.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("person_link payload 어긋남");
    expect(body.error).toContain("personId");

    expect(personLinkCalls).toEqual([]);
    expect(repo.findById(id)?.status).toBe("pending");
  });
});

// ── (g) POST reject ─────────────────────────────────────────────────────────

describe("POST /cleanup-proposals/:id/reject — 적용 함수 호출 안 함", () => {
  test("(g) reject → status='rejected' + 적용 함수 호출 0", async () => {
    const id = repo.insert("classification", {
      nodeId: 99,
      category: "character",
      value: "거절될값",
    });

    const res = await app.request(`/cleanup-proposals/${id}/reject`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rejected: string };
    expect(body.rejected).toBe(id);

    // 적용 함수 호출 안 함.
    expect(classificationCalls).toEqual([]);
    expect(synonymCalls).toEqual([]);

    // status='rejected' + resolved_at 자동.
    const after = repo.findById(id);
    expect(after?.status).toBe("rejected");
    expect(after?.resolvedAt).not.toBeNull();
  });
});

// ── (h) 이미 resolved 한 묶음 = 400 ─────────────────────────────────────────

describe("이미 처리된 proposal — 두 번 적용 차단", () => {
  test("(h) approve 후 다시 approve = 400 + reject 도 400", async () => {
    const id = repo.insert("metadata_fill", {
      nodeId: 11,
      field: "event_at",
      value: "2026-05-25",
    });

    // 첫 번째 approve — 정상.
    const ok = await app.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(ok.status).toBe(200);

    // 두 번째 approve — 400 + status='approved' 그대로.
    const dup = await app.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(dup.status).toBe(400);
    const body = (await dup.json()) as { error: string };
    expect(body.error).toContain("이미 처리된 proposal");
    expect(body.error).toContain("approved");

    // reject 도 같은 차단.
    const rej = await app.request(`/cleanup-proposals/${id}/reject`, {
      method: "POST",
    });
    expect(rej.status).toBe(400);

    // setEventAt 이 두 번 안 불려야 정합 — 첫 approve 한 번 한정.
    expect(eventAtCalls.length).toBe(1);
  });
});

// ── (o) POST approve regex_pattern_add ──────────────────────────────────────
//
// regex-strengthen Task 6 — 깊은 패스가 만든 정규식 추가 제안. 승인 시:
//   - deps.regexUserRepo.addPattern(...) 으로 DB 에 양식 추가
//   - deps.regexL0.reload() 로 추출기 캐시 갱신 (다음 입력부터 매치)
//   - status='approved'
// regexUserRepo/regexL0 미주입(토글 OFF) = 503 + status pending 보존 (정직).
// payload 어긋남 = 400 + pending 보존. 깨진 정규식 = repo throw → 400.
//
// 실 SQLite + 실 RegexUserRepo + 실 RegexL0Extractor (mock 0). userRepo 를 두
// 객체가 공유해야 reload() 가 방금 쓴 행을 다시 읽는다 (regex.ts 단일 권위 정합).

describe("POST /cleanup-proposals/:id/approve — regex_pattern_add kind", () => {
  let regexDb: Database;
  let regexRepoLocal: CleanupProposalsRepository;
  let regexApp: Hono;
  let regexUserRepo: RegexUserRepo;
  let regexL0: RegexL0Extractor;

  beforeEach(() => {
    regexDb = openMemoryDatabase(":memory:", { embeddingDim: 384 });
    regexRepoLocal = new CleanupProposalsRepository(regexDb);
    regexUserRepo = new RegexUserRepo(regexDb);
    // 같은 userRepo 를 추출기에 전달 — reload() 가 addPattern 이 쓴 행을 다시 읽는다.
    regexL0 = new RegexL0Extractor({
      patternPaths: [],
      boosterPaths: [],
      langs: ["ko"],
      userRepo: regexUserRepo,
    });

    const storeStub = {
      getRawDb: () => regexDb,
    } as unknown as SqliteMemoryStore;

    const deps: MemoryApiDeps = {
      store: storeStub,
      retriever: undefined as unknown as MemoryApiDeps["retriever"],
      assembler: undefined as unknown as MemoryApiDeps["assembler"],
      regexUserRepo,
      regexL0,
    };

    regexApp = new Hono({ strict: false });
    registerCleanupProposalsRoutes(regexApp, deps);
  });

  afterEach(() => {
    regexDb.close();
  });

  test("(o) 승인 → regex_user_patterns 행 추가 + reload 후 extract 가 매치 (활성 증명)", async () => {
    // builtin 양식과 겹치지 않는 고유 어구 — 추가 전엔 매치 0, 추가 후 매치를 증명.
    const pattern = "좀비고양이출현";
    const sentence = "오늘 좀비고양이출현 사건이 있었다";
    // 추가 전: 추출기가 이 문장에서 후보 0 (이 양식 아직 없음).
    expect(regexL0.extract(sentence).candidates.length).toBe(0);

    const id = regexRepoLocal.insert("regex_pattern_add", {
      pattern,
      score: 5,
      category: "fact",
      polarity: "neutral",
      description: "깊은 패스 제안 양식",
    });

    const res = await regexApp.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approved: string };
    expect(body.approved).toBe(id);

    // regex_user_patterns 에 행이 실제로 추가됐다.
    const stored = regexUserRepo.listPatterns({ includeDisabled: true });
    expect(stored.length).toBe(1);
    expect(stored[0]?.pattern).toBe(pattern);
    expect(stored[0]?.score).toBe(5);
    expect(stored[0]?.category).toBe("fact");

    // reload() 가 캐시를 갱신해 같은 문장이 이제 후보를 낸다 (활성화 증명).
    const after = regexL0.extract(sentence);
    expect(after.candidates.length).toBeGreaterThan(0);

    // status='approved' + resolved_at 자동.
    const proposal = regexRepoLocal.findById(id);
    expect(proposal?.status).toBe("approved");
    expect(proposal?.resolvedAt).not.toBeNull();
  });

  test("(p) payload 어긋남 (pattern 빈 문자열) = 400 + pending 보존 + 행 추가 0", async () => {
    const id = regexRepoLocal.insert("regex_pattern_add", {
      pattern: "",
      score: 5,
      category: "decision",
    });

    const res = await regexApp.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("regex_pattern_add payload 어긋남");

    expect(regexUserRepo.listPatterns({ includeDisabled: true }).length).toBe(0);
    const proposal = regexRepoLocal.findById(id);
    expect(proposal?.status).toBe("pending");
    expect(proposal?.resolvedAt).toBeNull();
  });

  test("(q) payload 어긋남 (score 가 number 아님) = 400 + pending 보존", async () => {
    const id = regexRepoLocal.insert("regex_pattern_add", {
      pattern: "결정했다",
      score: "5",
      category: "decision",
    });

    const res = await regexApp.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("regex_pattern_add payload 어긋남");

    expect(regexUserRepo.listPatterns({ includeDisabled: true }).length).toBe(0);
    expect(regexRepoLocal.findById(id)?.status).toBe("pending");
  });

  test("(r) payload 어긋남 (category 빈 문자열) = 400 + pending 보존", async () => {
    const id = regexRepoLocal.insert("regex_pattern_add", {
      pattern: "결정했다",
      score: 5,
      category: "",
    });

    const res = await regexApp.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("regex_pattern_add payload 어긋남");

    expect(regexUserRepo.listPatterns({ includeDisabled: true }).length).toBe(0);
    expect(regexRepoLocal.findById(id)?.status).toBe("pending");
  });

  test("(r2) score 소수(5.5) = 400 + pending 보존 + 행 추가 0 (regex.ts 정수 기준 정합)", async () => {
    const id = regexRepoLocal.insert("regex_pattern_add", {
      pattern: "결정했다",
      score: 5.5,
      category: "decision",
    });

    const res = await regexApp.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("regex_pattern_add payload 어긋남");
    expect(body.error).toContain("정수");

    expect(regexUserRepo.listPatterns({ includeDisabled: true }).length).toBe(0);
    expect(regexRepoLocal.findById(id)?.status).toBe("pending");
  });

  test("(r3) category enum 밖(unknown_cat) = 400 + pending 보존 + 행 추가 0 (regex.ts 6-enum 정합)", async () => {
    const id = regexRepoLocal.insert("regex_pattern_add", {
      pattern: "결정했다",
      score: 5,
      category: "unknown_cat",
    });

    const res = await regexApp.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("regex_pattern_add payload 어긋남");
    expect(body.error).toContain("category");

    expect(regexUserRepo.listPatterns({ includeDisabled: true }).length).toBe(0);
    expect(regexRepoLocal.findById(id)?.status).toBe("pending");
  });

  test("(s) 깨진 정규식 = repo 가 컴파일 실패로 throw → 400 + pending 보존 + 행 추가 0", async () => {
    const id = regexRepoLocal.insert("regex_pattern_add", {
      pattern: "(미완 괄호",
      score: 5,
      category: "decision",
    });

    const res = await regexApp.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("적용 실패");

    expect(regexUserRepo.listPatterns({ includeDisabled: true }).length).toBe(0);
    expect(regexRepoLocal.findById(id)?.status).toBe("pending");
  });

  test("(t) reject regex_pattern_add → status='rejected' + 행 추가 0", async () => {
    const id = regexRepoLocal.insert("regex_pattern_add", {
      pattern: "결정했다",
      score: 5,
      category: "decision",
    });

    const res = await regexApp.request(`/cleanup-proposals/${id}/reject`, {
      method: "POST",
    });
    expect(res.status).toBe(200);

    expect(regexUserRepo.listPatterns({ includeDisabled: true }).length).toBe(0);
    expect(regexRepoLocal.findById(id)?.status).toBe("rejected");
  });
});

// ── (u) regex_pattern_add — 토글 OFF (regexUserRepo/regexL0 미주입) = 503 ─────
//
// 별 deps 묶음 — regexUserRepo·regexL0 둘 다 undefined (regex 토글 OFF 상태).
// 승인 시 503 + status pending 보존 (regex.ts 토글 OFF 양식 정합 — 적용 안 함).

describe("POST /cleanup-proposals/:id/approve — regex_pattern_add 토글 OFF", () => {
  let offDb: Database;
  let offRepo: CleanupProposalsRepository;
  let offApp: Hono;

  beforeEach(() => {
    offDb = openMemoryDatabase(":memory:", { embeddingDim: 384 });
    offRepo = new CleanupProposalsRepository(offDb);

    const storeStub = {
      getRawDb: () => offDb,
    } as unknown as SqliteMemoryStore;

    // regexUserRepo/regexL0 미주입 = 토글 OFF.
    const deps: MemoryApiDeps = {
      store: storeStub,
      retriever: undefined as unknown as MemoryApiDeps["retriever"],
      assembler: undefined as unknown as MemoryApiDeps["assembler"],
    };

    offApp = new Hono({ strict: false });
    registerCleanupProposalsRoutes(offApp, deps);
  });

  afterEach(() => {
    offDb.close();
  });

  test("(u) regexUserRepo undefined → 503 + status='pending' 보존 (적용 안 함)", async () => {
    const id = offRepo.insert("regex_pattern_add", {
      pattern: "결정했다",
      score: 5,
      category: "decision",
    });

    const res = await offApp.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("토글 OFF");

    // 적용 안 함 — pending 보존.
    const proposal = offRepo.findById(id);
    expect(proposal?.status).toBe("pending");
    expect(proposal?.resolvedAt).toBeNull();
  });
});

// ── POST /cleanup-proposals — 외부 제안 등록 (spec 6.2·6.4) ───────────────────
//
// 등록 통로. candidate 블록 필수(D-6). 검증·트랜잭션 권위는 submitExternalProposal
// (cleanup-external/proposals.ts) 한 곳이라 이 라우트 테스트는 HTTP 표면(상태 코드·
// 응답 형태·등록→승인 왕복)만 본다. 순서 1~11 각 실패는 proposals.test.ts 가 권위.
//
// regexStrengthen 후보는 실 knowledge_nodes 행 + regexFingerprint({content}) 로 맞춘다.
// 등록 후 approve 왕복까지 보려면 regexUserRepo/regexL0 가 필요해 regex 셋을 재사용한다.

describe("POST /cleanup-proposals — 외부 제안 등록", () => {
  let regDb: Database;
  let regApp: Hono;
  let regUserRepo: RegexUserRepo;
  let regL0: RegexL0Extractor;

  const REGEX_STAGE_VERSION =
    CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion;

  /** 실 raw 노드 삽입 — content 만 regex 지문 입력. */
  function insertNode(content: string): number {
    const info = regDb
      .prepare(
        "INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES (?, 'auto_capture', '2026-07-19 10:00:00')",
      )
      .run(content);
    return Number(info.lastInsertRowid);
  }

  /** 노드를 심고 그에 맞는 정상 regex candidate 를 만든다. */
  function seed(content: string): {
    nodeId: number;
    candidate: {
      stage: string;
      targetKey: string;
      inputFingerprint: string;
      stageVersion: number;
    };
  } {
    const nodeId = insertNode(content);
    return {
      nodeId,
      candidate: {
        stage: "regexStrengthen",
        targetKey: String(nodeId),
        inputFingerprint: regexFingerprint({ content }),
        stageVersion: REGEX_STAGE_VERSION,
      },
    };
  }

  beforeEach(() => {
    regDb = openMemoryDatabase(":memory:", { embeddingDim: 384 });
    regUserRepo = new RegexUserRepo(regDb);
    regL0 = new RegexL0Extractor({
      patternPaths: [],
      boosterPaths: [],
      langs: ["ko"],
      userRepo: regUserRepo,
    });
    const storeStub = {
      getRawDb: () => regDb,
    } as unknown as SqliteMemoryStore;
    const deps: MemoryApiDeps = {
      store: storeStub,
      retriever: undefined as unknown as MemoryApiDeps["retriever"],
      assembler: undefined as unknown as MemoryApiDeps["assembler"],
      regexUserRepo: regUserRepo,
      regexL0: regL0,
      // 외부 regex 제출은 서버 하네스(과매치 임계·표본 크기)를 설정에서 읽는다.
      getSettings: () => structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings,
    };
    regApp = new Hono({ strict: false });
    registerCleanupProposalsRoutes(regApp, deps);
  });

  afterEach(() => {
    regDb.close();
  });

  test("201 성공 — proposalId + 원장 completed 동반", async () => {
    const content = "좀비고양이출현 사건이 있었다";
    const { nodeId, candidate } = seed(content);
    const res = await regApp.request("/cleanup-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "regex_pattern_add",
        payload: {
          pattern: "좀비고양이출현",
          score: 3,
          category: "decision",
          polarity: "neutral",
          exampleInput: "좀비고양이출현 사건이 있었다",
          exampleExtracted: "좀비고양이출현",
          description: "좀비고양이출현 사건 기록",
          sourceNodeId: nodeId,
        },
        candidate,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      proposalId: string;
      status: string;
      ledgerRecorded: boolean;
    };
    expect(body.proposalId).toStartWith("cp_");
    expect(body.status).toBe("pending");
    expect(body.ledgerRecorded).toBe(true);

    // 원장 completed 동반 — 같은 후보가 후보 조회·내부 사이클 양쪽에서 재등장 안 함.
    const ledger = getStageResult(regDb, "regex_strengthen", String(nodeId));
    expect(ledger?.status).toBe("completed");
    expect(ledger?.inputFingerprint).toBe(regexFingerprint({ content }));
  });

  test("서버 하네스 탈락 → status rejected + 사유 + 원장 completed_noop + 제안 0", async () => {
    const content = "좀비고양이출현 사건이 있었다";
    const { nodeId, candidate } = seed(content);
    const res = await regApp.request("/cleanup-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "regex_pattern_add",
        // 점수 범위(1~3) 밖 — 서버 하네스 유효성 시험에서 떨어진다.
        payload: {
          pattern: "좀비고양이출현",
          score: 7,
          category: "decision",
          polarity: "neutral",
          exampleInput: content,
          exampleExtracted: "좀비고양이출현",
          description: "좀비고양이출현 사건 기록",
          sourceNodeId: nodeId,
        },
        candidate,
      }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      proposalId: null,
      status: "rejected",
      ledgerRecorded: true,
      rejected: { reason: "validity", detail: "score 7" },
    });
    expect(getStageResult(regDb, "regex_strengthen", String(nodeId))?.status).toBe("completed_noop");
    const count = regDb.prepare("SELECT COUNT(*) AS n FROM cleanup_proposals").get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("candidate 누락 → 400", async () => {
    const res = await regApp.request("/cleanup-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "regex_pattern_add",
        payload: { pattern: "결정했다", score: 3, category: "decision" },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("candidate");
  });

  test("stage↔kind 불일치(kind=person_link + stage=regexStrengthen) → 400", async () => {
    const res = await regApp.request("/cleanup-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "person_link",
        payload: { nodeId: 1, personId: "psn_x" },
        candidate: {
          stage: "regexStrengthen",
          targetKey: "1",
          inputFingerprint: "x",
          stageVersion: REGEX_STAGE_VERSION,
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("불일치");
  });

  test("kind=metadata_fill → 400 (외부 등록 통로 없음 — D-3)", async () => {
    const res = await regApp.request("/cleanup-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "metadata_fill",
        payload: { nodeId: 1, field: "place", value: "에버랜드" },
        candidate: {
          stage: "regexStrengthen",
          targetKey: "1",
          inputFingerprint: "x",
          stageVersion: REGEX_STAGE_VERSION,
        },
      }),
    });
    expect(res.status).toBe(400);
  });

  test("지문 불일치 → 409 + current(재계산값 동봉)", async () => {
    const content = "좀비고양이출현 사건이 있었다";
    const { nodeId, candidate } = seed(content);
    const res = await regApp.request("/cleanup-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "regex_pattern_add",
        payload: {
          pattern: "좀비고양이출현",
          score: 3,
          category: "decision",
          polarity: "neutral",
          exampleInput: "좀비고양이출현 사건이 있었다",
          exampleExtracted: "좀비고양이출현",
          description: "좀비고양이출현 사건 기록",
          sourceNodeId: nodeId,
        },
        candidate: { ...candidate, inputFingerprint: "stale_fp" },
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      current: { inputFingerprint: string; stageVersion: number };
    };
    expect(body.current.inputFingerprint).toBe(regexFingerprint({ content }));
    expect(body.current.stageVersion).toBe(REGEX_STAGE_VERSION);
  });

  test("lensDraft 대상 부재(삭제된 엔티티) targetKey → 404 + 원장 미기록 (review Fix 1)", async () => {
    // parseEntityTargetKey + isPlacementType 형식 통과만으로 진행하면(수정 전 버그)
    // 존재하지 않는 entityId 도 "빈 엔티티" 지문이 정상 계산돼, stale 재제출이 404 대신
    // 9b(지문 불일치 409)로 오회신되고 심하면 유령 targetKey 제안까지 INSERT 됐다.
    // 대상 확인 추가 후에는 9단에서 대상 부재가 먼저 걸려 404 로 회신하고 원장에도
    // 제안도 남지 않는다.
    const missingKey = entityTargetKey("material", "삭제된-엔티티-id");
    const lensStageVersion = CLEANUP_STAGE_LLM_LIMITS.lens_draft.stageVersion;

    const res = await regApp.request("/cleanup-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "lens_draft",
        payload: {
          typeName: "material",
          entityId: "삭제된-엔티티-id",
          values: {},
        },
        candidate: {
          stage: "lensDraft",
          targetKey: missingKey,
          inputFingerprint: "deadbeef",
          stageVersion: lensStageVersion,
        },
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(missingKey);

    // 원장 미기록 + 제안 행 미생성 — 404 는 대상 부재를 정직하게 알릴 뿐 아무 것도
    // 쓰지 않는다(spec 6.2 "대상 부재 404 + 원장 기록 없음").
    expect(getStageResult(regDb, "lens_draft", missingKey)).toBeNull();
    const proposalCount = regDb
      .prepare("SELECT COUNT(*) AS n FROM cleanup_proposals")
      .get() as { n: number };
    expect(proposalCount.n).toBe(0);
  });

  test("같은 candidate 재등록 → 409 '이미 처리됨' + 제안 행 중복 없음(8단)", async () => {
    const content = "좀비고양이출현 사건이 있었다";
    const { nodeId, candidate } = seed(content);
    const reqBody = JSON.stringify({
      kind: "regex_pattern_add",
      payload: {
        pattern: "좀비고양이출현",
        score: 3,
        category: "decision",
        polarity: "neutral",
        exampleInput: "좀비고양이출현 사건이 있었다",
        exampleExtracted: "좀비고양이출현",
        description: "좀비고양이출현 사건 기록",
        sourceNodeId: nodeId,
      },
      candidate,
    });

    const first = await regApp.request("/cleanup-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: reqBody,
    });
    expect(first.status).toBe(201);

    const second = await regApp.request("/cleanup-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: reqBody,
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toContain("이미 처리된 후보");

    // 중복 INSERT 없음(timeout 재시도 시나리오).
    const count = regDb
      .prepare("SELECT COUNT(*) AS n FROM cleanup_proposals")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("등록 후 원장 completed → filterCandidatesByLedger 재회신 차단(GET /api/cleanup-candidates 근거)", async () => {
    const content = "좀비고양이출현 사건이 있었다";
    const { nodeId, candidate } = seed(content);
    await regApp.request("/cleanup-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "regex_pattern_add",
        payload: {
          pattern: "좀비고양이출현",
          score: 3,
          category: "decision",
          polarity: "neutral",
          exampleInput: "좀비고양이출현 사건이 있었다",
          exampleExtracted: "좀비고양이출현",
          description: "좀비고양이출현 사건 기록",
          sourceNodeId: nodeId,
        },
        candidate,
      }),
    });

    // GET /api/cleanup-candidates 라우트(T8)가 쓰는 것과 같은 원장 헬퍼로 판정한다 —
    // 등록으로 남은 completed 행이 있으니 같은 (stage, targetKey, fingerprint, version)
    // 후보는 재회신에서 제외된다.
    const ledger = getStageResult(regDb, "regex_strengthen", String(nodeId));
    expect(ledger?.status).toBe("completed");
    expect(ledger?.inputFingerprint).toBe(candidate.inputFingerprint);
    expect(ledger?.stageVersion).toBe(candidate.stageVersion);
  });

  test("등록→승인 왕복 — 등록한 제안을 approve 가 현행 그대로 적용", async () => {
    const content = "좀비고양이출현 사건이 있었다";
    const pattern = "좀비고양이출현";
    const { nodeId, candidate } = seed(content);

    // 등록 전: 추출기가 이 문장에서 후보 0(이 양식 아직 없음).
    expect(regL0.extract(content).candidates.length).toBe(0);

    const reg = await regApp.request("/cleanup-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "regex_pattern_add",
        payload: { pattern, score: 3, category: "decision", polarity: "neutral", exampleInput: content, exampleExtracted: pattern, description: "좀비고양이출현 사건 기록", sourceNodeId: nodeId },
        candidate,
      }),
    });
    expect(reg.status).toBe(201);
    const { proposalId } = (await reg.json()) as { proposalId: string };

    // approve — 등록한 제안을 현행 승인 경로가 그대로 적용(패턴 추가 + reload).
    const appr = await regApp.request(`/cleanup-proposals/${proposalId}/approve`, {
      method: "POST",
    });
    expect(appr.status).toBe(200);
    const apprBody = (await appr.json()) as { approved: string };
    expect(apprBody.approved).toBe(proposalId);

    // regex_user_patterns 에 행 추가 + reload 후 같은 문장이 이제 후보를 낸다.
    const stored = regUserRepo.listPatterns({ includeDisabled: true });
    expect(stored.length).toBe(1);
    expect(stored[0]?.pattern).toBe(pattern);
    expect(regL0.extract(content).candidates.length).toBeGreaterThan(0);
  });
});

// ── T32: 제안 승인 semantics 보강 라우트 표면 (spec 5-9) ─────────────────────
//
// 항목 분해·부분 승인 body·원장 동봉·상태 하위 호환을 HTTP 표면에서 확인한다.
// 항목 적용 의미론 자체(부분 승인 결과·checksum·중단 복구)는 실 엔티티가 필요해
// cleanup-external/proposal-items.test.ts 가 권위다 — 여기는 라우트 계약만 본다.

describe("T32 — GET 응답 항목·원장 동봉 (추가형 — 기존 칸 보존)", () => {
  test("추가형 kind 는 items:[] — 현행 단일 승인 흐름 그대로", async () => {
    const id = repo.insert("metadata_fill", {
      nodeId: 3,
      field: "place",
      value: "서울",
    });
    const res = await app.request(`/cleanup-proposals/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      status: string;
      payload: Record<string, unknown>;
      items: unknown[];
      journal: unknown[];
    };
    // 기존 칸 전부 보존(회귀 0).
    expect(body.id).toBe(id);
    expect(body.status).toBe("pending");
    expect(body.payload.nodeId).toBe(3);
    // 신설 칸 — 추가형이라 분해 항목 없음, 원장도 아직 없음.
    expect(body.items).toEqual([]);
    expect(body.journal).toEqual([]);
  });

  test("파괴형 kind(lens_draft)는 항목이 분해돼 실린다 — 부분 승인 선택지", async () => {
    const id = repo.insert("lens_draft", {
      typeName: "usable",
      entityId: "ent_x",
      values: {
        columns: { 사용법: "값1" },
        labels: {},
        relations: {},
        metadata: { place: "서울" },
      },
    });
    const res = await app.request(`/cleanup-proposals/${id}`);
    const body = (await res.json()) as {
      items: Array<{ itemKey: string; group: string; key: string; value: unknown }>;
    };
    expect(body.items.map((i) => i.itemKey)).toEqual([
      "columns:사용법",
      "metadata:place",
    ]);
    expect(body.items[0]?.value).toBe("값1");
  });

  test("목록도 항목을 동봉한다 — total 등 기존 칸 보존", async () => {
    repo.insert("metadata_fill", { nodeId: 1, field: "place", value: "서울" });
    const res = await app.request("/cleanup-proposals?status=pending");
    const body = (await res.json()) as {
      proposals: Array<{ kind: string; items: unknown[] }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.proposals[0]?.kind).toBe("metadata_fill");
    expect(body.proposals[0]?.items).toEqual([]);
  });
});

describe("T32 — 부분 승인 body 검증", () => {
  test("itemKeys 가 문자열 배열이 아니면 400 + pending 보존", async () => {
    const id = repo.insert("lens_draft", {
      typeName: "usable",
      entityId: "ent_x",
      values: { columns: { 사용법: "값1" }, labels: {}, relations: {}, metadata: {} },
    });
    const res = await app.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemKeys: [1, 2] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("itemKeys 어긋남");
    expect(repo.findById(id)?.status).toBe("pending");
  });

  test("추가형 kind 는 itemKeys 를 안 읽는다 — body 없는 옛 호출 그대로 통과", async () => {
    const id = repo.insert("metadata_fill", {
      nodeId: 21,
      field: "event_at",
      value: "2026-08-03",
    });
    const res = await app.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approved: string };
    expect(body.approved).toBe(id);
    // 추가형은 옛 상태 이름을 그대로 쓴다(회귀 0).
    expect(repo.findById(id)?.status).toBe("approved");
  });
});

describe("T32 — status 하위 호환", () => {
  test("옛 'approved' 행은 그대로 읽히고 재처리도 차단된다", async () => {
    const id = repo.insert("metadata_fill", { nodeId: 5, field: "place", value: "부산" });
    // 옛 DB 가 들고 있던 상태 값을 그대로 심는다(이행 UPDATE 없이 읽히는지 확인).
    db.prepare("UPDATE cleanup_proposals SET status = 'approved' WHERE id = ?").run(id);

    expect(repo.findById(id)?.status).toBe("approved");
    const res = await app.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("이미 처리된 proposal");
  });

  test("신설 상태 세 값도 저장·회수된다", () => {
    for (const status of ["applied", "partially_applied", "needs_revision"] as const) {
      const id = repo.insert("lens_draft", {
        typeName: "usable",
        entityId: "ent_x",
        values: { columns: {}, labels: {}, relations: {}, metadata: {} },
      });
      expect(repo.updateStatus(id, status)).toBe(true);
      const found = repo.findById(id);
      expect(found?.status).toBe(status);
      // pending 이 아닌 상태는 resolved_at 이 함께 기록된다(기존 계약 유지).
      expect(found?.resolvedAt).not.toBeNull();
    }
  });

  test("pending 목록은 신설 상태 행을 안 집는다 — 대기 큐 정합", () => {
    const pending = repo.insert("metadata_fill", {
      nodeId: 1,
      field: "place",
      value: "서울",
    });
    const done = repo.insert("metadata_fill", {
      nodeId: 2,
      field: "place",
      value: "부산",
    });
    repo.updateStatus(done, "partially_applied");
    const list = repo.findPending(10, 0);
    expect(list.map((p) => p.id)).toEqual([pending]);
  });
});

// ── entity_register — 승인 본문 검증·거절 무시 기록 (2026-10-10 spec 6장) ──────────

describe("entity_register 제안 — 승인 본문·거절", () => {
  const entityRegisterPayload = () => ({
    nodeId: 41,
    inputFingerprint: "a".repeat(64),
    stageVersion: 1,
    runId: null,
    autoApplied: [],
    items: [
      {
        itemKey: "entity:0",
        type: "person",
        name: "몽룡",
        reason: "similar",
        options: [
          { kind: "link_existing", targetId: "p_1", targetName: "이몽룡", addAlias: true },
          { kind: "ignore" },
        ],
      },
    ],
    schedule: {
      itemKey: "schedule",
      reason: "relative",
      title: "몽룡 이사",
      date: "2026-10-17",
      dateText: "다음 주",
      existingScheduleNodeId: null,
    },
  });

  test("본문 없는 승인 = 400(choices) + pending 보존 + 적용 0", async () => {
    const id = repo.insert("entity_register", entityRegisterPayload());
    const res = await app.request(`/cleanup-proposals/${id}/approve`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("choices");
    expect(repo.findById(id)?.status).toBe("pending");
    expect(personLinkCalls).toEqual([]);
  });

  test("거절 = 200 { rejected } + 모든 이름·일정이 무시 기록으로 남는다", async () => {
    const id = repo.insert("entity_register", entityRegisterPayload());
    const res = await app.request(`/cleanup-proposals/${id}/reject`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rejected: id });
    expect(repo.findById(id)?.status).toBe("rejected");
    expect(
      db.query("SELECT kind, name_key FROM entity_register_ignores WHERE source_node_id = 41 ORDER BY kind").all(),
    ).toEqual([
      { kind: "entity", name_key: "몽룡" },
      { kind: "schedule", name_key: "" },
    ]);
  });
});

describe("entity_register 제안 — 고른 항목 없음", () => {
  test("choices 가 비어 있으면 400(고른 항목 없음) + pending 보존 + 원장 0", async () => {
    const id = repo.insert("entity_register", {
      nodeId: 42, inputFingerprint: "b".repeat(64), stageVersion: 1, runId: null, autoApplied: [], schedule: null,
      items: [{ itemKey: "entity:0", type: "person", name: "몽룡", reason: "similar", options: [{ kind: "ignore" }] }],
    });
    const res = await app.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ choices: {} }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("고른 항목 없음");
    expect(repo.findById(id)?.status).toBe("pending");
    expect(repo.listJournal(id)).toEqual([]);
  });
});
