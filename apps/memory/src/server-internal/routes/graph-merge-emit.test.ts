/**
 * graph-merge-emit.test.ts — 그래프 라이브 연출 2c 서버 발행 검증 (Task 6).
 *
 * DCL-5 (e7f4a590, 2026-07-12 T13/C-3): 'synonym' approve 분기는 생산자 없는
 * 죽은 코드라 제거됐다 — KNOWN_KINDS 밖이라 미등록 kind 와 동일하게 400 정직
 * 회신 + status pending 보존을 받고, mergeConceptAlias 도 graph_merge 발행도
 * 일어나지 않는다. 이 파일은 그 현재 계약(400 + 발행 0)을 검증한다.
 *
 * 복원 계획: D2 동의어 병합 생산자 출하 시 생산자와 같은 commit 에서 approve
 * 분기가 복원되면, 이 테스트도 같은 commit 에서 200 + graph_merge 발행 검증으로
 * 되돌린다. 그때 되살릴 방향 계약(ff90637e 시점 코드로 확정):
 *   mergeConceptAlias(targetConceptId, sourceConceptId) — source 가 target 에
 *   흡수되어 *삭제*된다. 라우트는 mergeConceptAlias(conceptId, alias) 로 부른다 →
 *   conceptId = target(남음) / alias = source 개념 id(사라짐). payload 칸 이름이
 *   `alias` 라 별칭 문자열처럼 보이지만, 함수 본문이 그 값으로 concept_nodes 를
 *   조회·삭제하므로 실제로는 source 개념 id 다. 따라서:
 *     from(사라지는 source) = concept:<alias>
 *     into(남는 target)     = concept:<conceptId>
 *
 * 실 SqliteMemoryStore(:memory:) + 실 EventBus + 실 EventRepository + 실 Hono
 * 라우트(Mock 클래스 0). 두 개념을 실제로 만들어(findOrCreateConcept) 유효한
 * payload 로도 kind 게이트가 거부하는 사실 + events 큐에 graph_merge 가 0건인
 * 사실을 listSince 로 확인한다. 두 번째 테스트(없는 source 개념)도 분기 제거
 * 이후로는 같은 kind 게이트에서 400 을 받는다.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { CleanupProposalsRepository } from "../../db/store-internal/cleanup-proposals-repository.ts";
import { registerCleanupProposalsRoutes } from "./cleanup-proposals.ts";
import type { MemoryApiDeps } from "../types.ts";
import { EventBus, EVENT_TYPES } from "../event-bus.ts";
import { EventRepository } from "../../db/store-internal/event-repository.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

let db: Database;
let store: SqliteMemoryStore;
let repo: CleanupProposalsRepository;
let eventRepository: EventRepository;
let eventBus: EventBus;
let app: Hono;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  repo = new CleanupProposalsRepository(db);
  eventRepository = new EventRepository(db);
  eventBus = new EventBus(eventRepository);

  const deps: MemoryApiDeps = {
    store,
    retriever: undefined as unknown as MemoryApiDeps["retriever"],
    assembler: undefined as unknown as MemoryApiDeps["assembler"],
    eventBus,
    eventRepository,
  };

  app = new Hono({ strict: false });
  registerCleanupProposalsRoutes(app, deps);
});

/** events 큐에서 graph_merge 레코드만 골라 반환. */
function listMerge() {
  return eventRepository
    .listSince(0, 1000)
    .filter((r) => r.type === EVENT_TYPES.GRAPH_MERGE);
}

describe("그래프 라이브 연출 2c — graph_merge 발행 (Task 6)", () => {
  test("synonym approve = 400 + pending 보존 + graph_merge 발행 0 (DCL-5 분기 제거 후 계약)", async () => {
    // 두 진짜 개념을 만든다 — payload 가 유효해도 kind 게이트가 거부함을 증명한다.
    const targetId = await store.findOrCreateConcept("주술회전");
    const sourceId = await store.findOrCreateConcept("주회");
    expect(targetId).not.toBe(sourceId);

    // synonym 제안 — payload.conceptId = target(남음) / payload.alias = source id(사라짐).
    // 복원 시 검증할 계약: 200 + graph_merge { from: concept:<sourceId>, into: concept:<targetId> }
    // (파일 머리 주석의 방향 계약 참조 — e7f4a590 이 분기를 제거하며 D2 생산자
    // commit 에서 함께 복원하기로 명시).
    const id = repo.insert("synonym", { conceptId: targetId, alias: sourceId });

    const res = await app.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    // 미등록 kind 정직 회신 — cleanup-proposals.ts KNOWN_KINDS 게이트.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(
      "알 수 없는 kind 'synonym' — 이 종류는 아직 적용 함수 부재",
    );

    // 사용자 결정 동결 — status pending 보존(재시도 가능).
    const after = repo.findById(id);
    expect(after?.status).toBe("pending");
    expect(after?.resolvedAt).toBeNull();

    // 합침이 일어나지 않았다 — source 개념 노드가 그대로 남아 있다.
    const sourceStillThere = db
      .query("SELECT 1 FROM concept_nodes WHERE concept_id = ?")
      .get(sourceId);
    expect(sourceStillThere).not.toBeNull();

    // 발행 통로도 조용하다 — graph_merge 가 events 큐에 0건.
    expect(listMerge().length).toBe(0);
  });

  test("merge 가 throw 하면(없는 source 개념) graph_merge 발행 안 함", async () => {
    const targetId = await store.findOrCreateConcept("존재하는개념");
    // source 가 실제 개념이 아니라 mergeConceptAlias 가 "source not found" 로 throw.
    const id = repo.insert("synonym", {
      conceptId: targetId,
      alias: "concept_does_not_exist_999",
    });

    const res = await app.request(`/cleanup-proposals/${id}/approve`, {
      method: "POST",
    });
    // 적용 실패 → 400, status 는 pending 보존(라우트 계약).
    expect(res.status).toBe(400);

    // 성공 경로가 아니므로 graph_merge 가 적재되지 않았다.
    expect(listMerge().length).toBe(0);
  });
});
