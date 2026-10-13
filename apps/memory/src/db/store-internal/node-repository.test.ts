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
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { NodeRepository } from "./node-repository.ts";
import { SqliteMemoryStore } from "../store.ts";
import type { SourceType } from "../../memory/types.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

describe("NodeRepository — project_id 라벨", () => {
  let db: Database;
  let repo: NodeRepository;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    repo = new NodeRepository(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("addNode — project_id 라벨 저장·조회(미지정 시 NULL)", async () => {
    const labeled = await repo.addNode({ content: "둥지 회의록", project_id: "nest" });
    const plain = await repo.addNode({ content: "평소 메모" });
    const r1 = db
      .prepare("SELECT project_id FROM knowledge_nodes WHERE id=?")
      .get(labeled) as { project_id: string | null };
    const r2 = db
      .prepare("SELECT project_id FROM knowledge_nodes WHERE id=?")
      .get(plain) as { project_id: string | null };
    expect(r1.project_id).toBe("nest");
    expect(r2.project_id).toBeNull();
  });

  // ── 공통 인프라 1.1c T1 — polarity 입력 통로 ─────────────────────────────
  test("addNode — polarity 라벨 저장·조회(미지정 시 NULL)", async () => {
    const pos = await repo.addNode({ content: "포근한 디자인 좋아함", polarity: "positive" });
    const neg = await repo.addNode({ content: "요란한 디자인 싫음", polarity: "negative" });
    const neu = await repo.addNode({ content: "흰 배경 무난함", polarity: "neutral" });
    const plain = await repo.addNode({ content: "라벨 없는 메모" });
    const read = (id: number) =>
      (db.prepare("SELECT polarity FROM knowledge_nodes WHERE id=?").get(id) as {
        polarity: string | null;
      }).polarity;
    expect(read(pos)).toBe("positive");
    expect(read(neg)).toBe("negative");
    expect(read(neu)).toBe("neutral");
    expect(read(plain)).toBeNull();
  });

  test("addNode — project_id 와 polarity 둘 다 한 노드에 저장", async () => {
    const id = await repo.addNode({
      content: "바라 디자인 결정",
      project_id: "bara_system",
      polarity: "positive",
    });
    const row = db
      .prepare("SELECT project_id, polarity FROM knowledge_nodes WHERE id=?")
      .get(id) as { project_id: string | null; polarity: string | null };
    expect(row.project_id).toBe("bara_system");
    expect(row.polarity).toBe("positive");
  });
});

// ── 프로젝트 노드 D2 — getProjectMemberNodes(그래프 허브 표시 조회) ─────────
describe("NodeRepository — getProjectMemberNodes 프로젝트 글 조회", () => {
  let db: Database;
  let repo: NodeRepository;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    repo = new NodeRepository(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("같은 project_id 글 N개를 최신순(id DESC tie-break)으로 돌려준다", async () => {
    const a = await repo.addNode({ content: "좀비 글 첫 번째", project_id: "zombie" });
    const b = await repo.addNode({ content: "좀비 글 두 번째", project_id: "zombie" });
    const c = await repo.addNode({ content: "좀비 글 세 번째", project_id: "zombie" });

    const got = await repo.getProjectMemberNodes("zombie", 100);
    expect(got.map((n) => n.id)).toEqual([c, b, a]);
    expect(got.every((n) => n.projectId === "zombie")).toBe(true);
  });

  test("자식 종류(document_chunk·llm_extract·image_caption)는 결과에서 빠진다", async () => {
    const origin = await repo.addNode({
      content: "원본 좀비 메모",
      project_id: "zombie",
      sourceType: "auto_capture",
    });
    await repo.addNode({
      content: "청크 조각",
      project_id: "zombie",
      sourceType: "document_chunk",
    });
    await repo.addNode({
      content: "추출 atomic",
      project_id: "zombie",
      sourceType: "llm_extract",
    });
    await repo.addNode({
      content: "이미지 캡션",
      project_id: "zombie",
      sourceType: "image_caption",
    });

    const got = await repo.getProjectMemberNodes("zombie", 100);
    expect(got.map((n) => n.id)).toEqual([origin]);
  });

  test("다른 프로젝트 글·projectId NULL 글은 섞이지 않는다", async () => {
    const mine = await repo.addNode({ content: "내 프로젝트 글", project_id: "mine" });
    await repo.addNode({ content: "남의 프로젝트 글", project_id: "other" });
    await repo.addNode({ content: "프로젝트 없는 글" });

    const got = await repo.getProjectMemberNodes("mine", 100);
    expect(got.map((n) => n.id)).toEqual([mine]);
  });

  test("없는 프로젝트·빈 projectId·limit≤0 이면 빈 배열(정직한 빈 결과)", async () => {
    await repo.addNode({ content: "어떤 글", project_id: "zombie" });

    expect(await repo.getProjectMemberNodes("nonexistent", 100)).toEqual([]);
    expect(await repo.getProjectMemberNodes("", 100)).toEqual([]);
    expect(await repo.getProjectMemberNodes("zombie", 0)).toEqual([]);
    expect(await repo.getProjectMemberNodes("zombie", -5)).toEqual([]);
  });

  test("limit 가 글 수보다 작으면 최신 limit 개만 돌려준다", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await repo.addNode({ content: `좀비 글 ${i}`, project_id: "zombie" }));
    }
    const got = await repo.getProjectMemberNodes("zombie", 2);
    // 최신 2개 = 마지막에 넣은 두 글(id 큰 순).
    const last = ids[ids.length - 1] as number;
    const secondLast = ids[ids.length - 2] as number;
    expect(got.map((n) => n.id)).toEqual([last, secondLast]);
  });
});

// ── Phase 7 갈래 1 — event_at(사건 발생 시각) 칸 ──────────────────────────
describe("NodeRepository — event_at 사건 시각", () => {
  let db: Database;
  let repo: NodeRepository;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    repo = new NodeRepository(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("addNode — eventAt 저장 후 getNode 가 그 값을 반환", async () => {
    const id = await repo.addNode({
      content: "5월 25일 회의에서 결정한 일",
      eventAt: "2026-05-25",
    });
    const node = await repo.getNode(id);
    expect(node).not.toBeNull();
    expect(node?.eventAt).toBe("2026-05-25");
  });

  test("addNode — eventAt 생략 시 NULL 저장 + getNode 가 eventAt null 반환", async () => {
    const id = await repo.addNode({ content: "사건 시각 없는 평소 메모" });
    const dbRow = db
      .prepare("SELECT event_at FROM knowledge_nodes WHERE id=?")
      .get(id) as { event_at: string | null };
    expect(dbRow.event_at).toBeNull();
    const node = await repo.getNode(id);
    expect(node?.eventAt).toBeNull();
  });

  test("setEventAt — 갱신 후 getNode 가 새 값을 반환", async () => {
    const id = await repo.addNode({ content: "나중에 사건 시각을 채울 메모" });
    const before = await repo.getNode(id);
    expect(before?.eventAt).toBeNull();
    await repo.setEventAt(id, "2026-05-25", "system");
    const after = await repo.getNode(id);
    expect(after?.eventAt).toBe("2026-05-25");
  });

  test("setEventAt — dbRevision 카운터 상승(검색 캐시 무효화 합류)", async () => {
    const id = await repo.addNode({ content: "사건 시각 갱신 신호 검증" });
    const before = repo.getDbRevision();
    await repo.setEventAt(id, "2026-05-25", "system");
    expect(repo.getDbRevision()).toBe(before + 1);
  });
});

// ── SL-2 — 백필 후보의 추출 상태 판정과 편집 무효화 ──────────────────────────
describe("NodeRepository — 백필 후보 추출 상태와 편집 무효화 (SL-2)", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  /** 판정만 보는 fixture 는 임베딩을 데이터로 넣는다(모델 계산 없음). 본문은 흡수되지 않게 모두 다르다. */
  const FIXTURE_EMBEDDING = new Float32Array(1024).fill(1 / 32);
  let serial = 0;
  function node(sourceType: SourceType, metadata: Record<string, unknown> = {}): Promise<number> {
    serial += 1;
    return store.addNode({ content: `추출 상태 fixture ${serial}`, sourceType, metadata, embedding: FIXTURE_EMBEDDING });
  }
  const invalidatedBy = (id: number) => ({
    sharedMemory: { status: "retracted", revision: 1, assertionKind: "unknown", invalidatedBy: id },
  });
  const withdrawnByClient = { sharedMemory: { status: "retracted", revision: 1, assertionKind: "unknown" } };
  const disputed = { sharedMemory: { status: "disputed", revision: 1, assertionKind: "ai_inference" } };
  async function child(
    parent: number,
    relation: "merged_into" | "parent_of",
    metadata: Record<string, unknown> = {},
    provenance: "system" | "regex" = "system",
  ): Promise<number> {
    const id = await node(relation === "parent_of" ? "document_chunk" : "llm_extract", metadata);
    await store.addEdge({ sourceId: id, targetId: parent, relation, provenance, sourceNodeId: id, weight: 1 });
    return id;
  }
  async function candidates(): Promise<number[]> {
    return (await store.getBackfillCandidates({ limit: 100 })).map((n) => n.id);
  }
  function totalChanges(): number {
    return (db.query("SELECT total_changes() AS n").get() as { n: number }).n;
  }

  /** 상태별 원문 묶음 — 각 칸의 기대 판정은 테스트가 적는다. */
  async function fixtureSet() {
    const pendingWithStaleChild = await node("auto_capture", { extracted: 0 });
    await child(pendingWithStaleChild, "merged_into");
    const pendingRechunked = await node("auto_capture", { extracted: 0 });
    const liveChunk = await child(pendingRechunked, "parent_of");
    const pendingShortened = await node("auto_capture", { extracted: 0 });
    await child(pendingShortened, "parent_of", invalidatedBy(pendingShortened));

    const voided = await node("auto_capture");
    await store.markNodeExtracted(voided, [await child(voided, "merged_into", invalidatedBy(voided))]);
    const legacyListOnlyChild = await node("llm_extract", invalidatedBy(voided));
    const legacyVoided = await node("auto_capture", { extractedTo: [legacyListOnlyChild] });
    const partlyLive = await node("auto_capture");
    await store.markNodeExtracted(partlyLive, [
      await child(partlyLive, "merged_into", invalidatedBy(partlyLive)),
      await child(partlyLive, "merged_into"),
    ]);
    const clientWithdrawn = await node("auto_capture");
    await store.markNodeExtracted(clientWithdrawn, [await child(clientWithdrawn, "merged_into", withdrawnByClient)]);
    const contested = await node("auto_capture");
    await store.markNodeExtracted(contested, [await child(contested, "merged_into", disputed)]);
    const dangling = await node("auto_capture");
    await store.markNodeExtracted(dangling, [999_999]);
    const nothingExtracted = await node("auto_capture");
    await store.markNodeExtracted(nothingExtracted, []);

    const regexInvalidated = await node("auto_capture");
    await child(regexInvalidated, "merged_into", invalidatedBy(regexInvalidated), "regex");
    const regexWithdrawn = await node("auto_capture");
    await child(regexWithdrawn, "merged_into", withdrawnByClient, "regex");
    // WP-B1-31 — 청크만 계보 무효화되고 대기 표시가 없는 원문(WP-B1-06 이전 편집)은 후보다. 긴 글이면
    // 백필이 재청크하고, 짧은 글이면 직접 추출해 추출 기록이 생긴 뒤에는 다시 후보가 되지 않는다.
    const longInvalidatedChunks = await node("auto_capture");
    await child(longInvalidatedChunks, "parent_of", invalidatedBy(longInvalidatedChunks));
    const extractedAfterChunkRepair = await node("auto_capture");
    await child(extractedAfterChunkRepair, "parent_of", invalidatedBy(extractedAfterChunkRepair));
    await store.markNodeExtracted(extractedAfterChunkRepair, []);
    const chunkWithdrawnByClient = await node("auto_capture");
    await child(chunkWithdrawnByClient, "parent_of", withdrawnByClient);

    return {
      eligible: [pendingWithStaleChild, pendingShortened, voided, legacyVoided, regexInvalidated, liveChunk,
        longInvalidatedChunks],
      excluded: [pendingRechunked, partlyLive, clientWithdrawn, contested, dangling, nothingExtracted,
        regexWithdrawn, extractedAfterChunkRepair, chunkWithdrawnByClient],
      longInvalidatedChunks, pendingRechunked,
    };
  }

  test("대기·무효 기록·계보 무효화된 자식만 남은 원문은 후보, 살아 있거나 직접 거둔 파생물이 있으면 제외", async () => {
    const set = await fixtureSet();
    const listed = await candidates();
    expect([...listed].sort((a, b) => a - b)).toEqual([...set.eligible].sort((a, b) => a - b));
    for (const id of set.eligible) expect(store.nodeRepo.isBackfillCandidateEligible(id)).toBe(true);
    for (const id of set.excluded) expect(store.nodeRepo.isBackfillCandidateEligible(id)).toBe(false);
  });

  test("긴 글 판정은 SQL 로 하지 않는다 — 청크가 모두 계보 무효화된 옛 원문의 청크 상태를 백필이 읽는다", async () => {
    const set = await fixtureSet();
    expect(store.nodeRepo.getOriginChunkState(set.longInvalidatedChunks))
      .toEqual({ pending: false, activeChunk: false, invalidatedChunk: true });
    expect(store.nodeRepo.getOriginChunkState(set.pendingRechunked))
      .toEqual({ pending: true, activeChunk: true, invalidatedChunk: false });
    expect(store.nodeRepo.getOriginChunkState(999_999)).toBeNull();
  });

  test("판정은 저장 행을 쓰지 않고 반복해도 같다", async () => {
    const set = await fixtureSet();
    const before = totalChanges();
    const first = await candidates();
    const second = await candidates();
    for (const id of [...set.eligible, ...set.excluded]) store.nodeRepo.isBackfillCandidateEligible(id);
    store.nodeRepo.getOriginChunkState(set.longInvalidatedChunks);
    expect(second).toEqual(first);
    expect(totalChanges()).toBe(before);
  });

  test("태그만 바뀐 편집은 파생물을 유지하고, 주장이 바뀐 편집은 자식을 철회하며 원문을 추출 대기로 돌린다", async () => {
    const body = "배포 창구는 금요일 오후로 정했다. 롤백은 운영팀이 맡는다.";
    const origin = await store.addNode({ content: body });
    const extracted = await child(origin, "merged_into");
    await store.markNodeExtracted(origin, [extracted]);

    const tagOnly = await store.editNodeContent({ nodeId: origin, content: `${body}\n\n#배포` });
    expect(tagOnly).toMatchObject({ contentChanged: true, claimChanged: false, affectedNodeIds: [origin] });
    expect((await store.getNode(origin))!.metadata).toMatchObject({ extracted: 1, extractedTo: [extracted] });
    expect((await store.getNode(extracted))!.metadata.sharedMemory).toBeUndefined();
    expect(await candidates()).toEqual([]);

    const claim = await store.editNodeContent({ nodeId: origin, content: "배포 창구는 화요일 오전으로 옮겼다. 롤백은 운영팀이 맡는다.\n\n#배포" });
    expect(claim).toMatchObject({ contentChanged: true, claimChanged: true, affectedNodeIds: [origin, extracted] });
    const pending = (await store.getNode(origin))!;
    expect(pending.metadata.extracted).toBe(0);
    expect(pending.metadata).not.toHaveProperty("extractedTo");
    expect((await store.getNode(extracted))!.metadata.sharedMemory).toMatchObject({ status: "retracted", invalidatedBy: origin });
    expect(await candidates()).toEqual([origin]);
  });

  test("잠금 밖 쓰기로 저장 본문이 바뀌었는데 새 임베딩이 없으면 편집은 아무것도 쓰지 않고 멈춘다", async () => {
    const id = await node("auto_capture");
    const before = db.query("SELECT content, metadata_json FROM knowledge_nodes WHERE id = ?").get(id);
    expect(() => store.nodeRepo.editNodeContentPrepared({ nodeId: id, content: "잠금 밖에서 바뀐 본문" }, null))
      .toThrow("content changed outside the mutation lock");
    expect(db.query("SELECT content, metadata_json FROM knowledge_nodes WHERE id = ?").get(id)).toEqual(before);
    expect(await store.getRevisionsForNode(id)).toHaveLength(0);
  });
});
