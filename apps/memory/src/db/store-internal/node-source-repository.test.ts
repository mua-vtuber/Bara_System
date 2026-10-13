/**
 * node-source-repository.test.ts — 출처 목록 저장소(WP-B1-20T 설계 5.4·5.5·6.1).
 *
 * 검증 축: 넣기 멱등, 메시지 조회(플랫폼 있음·없음·행 플랫폼 NULL), 지우기, 보관 이동(계보 행 포함),
 * 복원(행 있음 / 없음 → restore 행 / archived_lineage 는 되돌리지 않음), 보관표 정리(여러 단계 계보 사슬,
 * 다른 행이 남은 보관 노드는 유지), 500개 넘는 listSync, 손상 detail 의 명시 오류, resetAllMemory 의 CASCADE.
 *
 * Mock 0: 실제 openMemoryDatabase(기준 스키마)와 실제 저장소. 노드 행은 원시 INSERT 데이터 fixture.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../migrations.ts";
import {
  NodeSourceRepository,
  isMessageTextRow,
  messageSourceRefOfRow,
  type NodeSourceRow,
} from "./node-source-repository.ts";
import { StatsRepository } from "./stats-repository.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import {
  describeInputSource,
  sourceKeyOf,
  type NodeSourceRef,
} from "../../memory/node-sources/source-ref.ts";

const DIM = 8;

let db: Database;
let repo: NodeSourceRepository;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
  repo = new NodeSourceRepository(db);
});

afterEach(() => db.close());

function liveNode(id: number): void {
  db.run("INSERT INTO knowledge_nodes (id, content) VALUES (?, ?)", [id, `기억 ${id}`]);
}

function archivedNode(id: number): void {
  db.run(
    `INSERT INTO knowledge_nodes_archive
      (id, content, memory_type, source_type, importance, confidence, created_at, last_accessed_at)
     VALUES (?, ?, 'fact', 'auto_capture', 0.5, 0.7, '2026-09-01 00:00:00', '2026-09-01 00:00:00')`,
    [id, `휴지통 기억 ${id}`],
  );
}

function discordMessage(messageId: string, platform = "discord"): NodeSourceRef {
  return describeInputSource({
    source: platform,
    author: "user-1",
    metadata: { messageId, source: `${platform}-channel`, channelId: "c-1", guildId: "g-1" },
  });
}

/** 봇 첨부(POST /ingest sourceMessage)의 출처 — 첨부 키. */
function attachmentRef(messageId: string, attachmentId: string, platform = "discord"): NodeSourceRef {
  return describeInputSource({
    source: `${platform}-channel`,
    author: "user-1",
    sourceMessage: { platform, messageId, channelId: "c-1", guildId: "g-1", attachmentId },
  });
}

const dashboardSave = describeInputSource({ source: "dashboard:manual", author: "owner" });

function archiveRows(nodeId: number): Array<{ key: string; kind: string; platform: string | null; externalId: string | null }> {
  return (
    db
      .query(
        `SELECT source_key AS key, kind, platform, external_id AS externalId
         FROM memory_node_sources_archive WHERE node_id = ? ORDER BY source_key`,
      )
      .all(nodeId) as Array<{ key: string; kind: string; platform: string | null; externalId: string | null }>
  );
}

function liveKeys(nodeId: number): string[] {
  return repo.listSync([nodeId]).get(nodeId)!.map((row) => row.key);
}

function archiveNodeIds(): number[] {
  return (db.query("SELECT id FROM knowledge_nodes_archive ORDER BY id").all() as Array<{ id: number }>).map(
    (r) => r.id,
  );
}

function count(table: string): number {
  return (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

describe("insertSync · listSync", () => {
  test("같은 (노드, 키)는 한 번만 — 처음 true, 다시 false, 행은 그대로", () => {
    liveNode(1);
    const ref = discordMessage("m-1");
    expect(repo.insertSync(1, ref)).toBe(true);
    const first = repo.listSync([1]).get(1)!;
    expect(repo.insertSync(1, ref)).toBe(false);
    expect(repo.listSync([1]).get(1)).toEqual(first);
    expect(first).toHaveLength(1);
    const row = first[0]!;
    expect(row).toMatchObject({
      nodeId: 1,
      key: "msg:discord:m-1",
      kind: "message",
      platform: "discord",
      externalId: "m-1",
      detail: { channelId: "c-1", guildId: "g-1", channel: "discord", actor: "user-1" },
    });
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    expect(repo.insertSync(1, dashboardSave)).toBe(true);
    expect(liveKeys(1)).toEqual(["msg:discord:m-1", "save:dashboard:manual:owner"]);
  });

  test("요청한 id 마다 항목 — 행이 없는 노드는 빈 목록, 중복 id 는 하나로", () => {
    liveNode(1);
    liveNode(2);
    repo.insertSync(1, dashboardSave);
    const map = repo.listSync([1, 2, 1, 999]);
    expect([...map.keys()]).toEqual([1, 2, 999]);
    expect(map.get(1)!.map((r) => r.key)).toEqual(["save:dashboard:manual:owner"]);
    expect(map.get(2)).toEqual([]);
    expect(map.get(999)).toEqual([]);
  });

  test("500개 넘는 id 도 모두 읽는다(IN 500개씩)", () => {
    const ids: number[] = [];
    for (let id = 1; id <= 1203; id++) {
      liveNode(id);
      ids.push(id);
      repo.insertSync(id, discordMessage(`m-${id}`));
      if (id % 2 === 0) repo.insertSync(id, dashboardSave);
    }
    const map = repo.listSync([...ids, 5000]);
    expect(map.size).toBe(1204);
    let total = 0;
    for (const id of ids) {
      const rows = map.get(id)!;
      total += rows.length;
      expect(rows[0]!.key).toBe(`msg:discord:m-${id}`);
      expect(rows.length).toBe(id % 2 === 0 ? 2 : 1);
    }
    expect(total).toBe(1203 + 601);
    expect(map.get(5000)).toEqual([]);
  });

  test("노드 행이 없으면 외래 키로 멈춘다", () => {
    expect(() => repo.insertSync(404, dashboardSave)).toThrow(/FOREIGN KEY constraint failed/);
  });

  test("칸 값과 어긋난 message 참조는 넣지 않는다", () => {
    liveNode(1);
    const good = discordMessage("m-1");
    expect(() => repo.insertSync(1, { ...good, key: "msg:discord:other" })).toThrow(/칸 값으로 만든 키/);
    expect(() =>
      repo.insertSync(1, { ...good, platform: "Discord", key: sourceKeyOf({ kind: "message", platform: "Discord", messageId: "m-1" }) }),
    ).toThrow(/정규화/);
    expect(() => repo.insertSync(1, { ...good, externalId: null })).toThrow(/externalId/);
    expect(count("memory_node_sources")).toBe(0);
  });

  test("첨부 키는 detail 의 attachmentId 와 맞아야 들어간다(WP-B1-20U 설계 17.8)", () => {
    liveNode(1);
    const attachment = attachmentRef("m-1", "a-1");
    expect(attachment.key).toBe("msg:discord:m-1:att:a-1");
    // 첨부 키인데 detail 에 첨부 id 가 없음 / 글 행 키인데 detail 에 첨부 id 가 있음 / 다른 첨부 id.
    expect(() => repo.insertSync(1, { ...attachment, detail: { ...attachment.detail, attachmentId: undefined } }))
      .toThrow(/칸 값으로 만든 키 'msg:discord:m-1'/);
    expect(() => repo.insertSync(1, { ...discordMessage("m-1"), detail: attachment.detail })).toThrow(/칸 값으로 만든 키/);
    expect(() => repo.insertSync(1, { ...attachment, detail: { ...attachment.detail, attachmentId: "a-2" } })).toThrow(/칸 값으로 만든 키/);
    expect(count("memory_node_sources")).toBe(0);
    expect(repo.insertSync(1, attachment)).toBe(true);
    expect(repo.insertSync(1, discordMessage("m-1"))).toBe(true);
    expect(liveKeys(1)).toEqual(["msg:discord:m-1", "msg:discord:m-1:att:a-1"]);
  });

  test("손상된 detail_json 은 빈 값으로 덮지 않고 어느 행인지 밝혀 멈춘다", () => {
    liveNode(1);
    liveNode(2);
    db.run(`INSERT INTO memory_node_sources (node_id, source_key, kind, detail_json, created_at)
      VALUES (1, 'save:x:y', 'direct_save', 'not json', '2026-10-01 00:00:00')`);
    db.run(`INSERT INTO memory_node_sources (node_id, source_key, kind, detail_json, created_at)
      VALUES (2, 'save:x:y', 'direct_save', '[]', '2026-10-01 00:00:00')`);
    expect(() => repo.listSync([1])).toThrow("memory_node_sources 행(node_id=1, source_key=save:x:y)의 detail_json 을 JSON 으로 읽을 수 없습니다");
    expect(() => repo.listSync([2])).toThrow("memory_node_sources 행(node_id=2, source_key=save:x:y)의 detail_json 이 JSON 객체가 아닙니다");
  });

  test("노드가 지워지면 출처 행도 CASCADE 로 사라진다", () => {
    liveNode(1);
    repo.insertSync(1, discordMessage("m-1"));
    db.run("DELETE FROM knowledge_nodes WHERE id = 1");
    expect(count("memory_node_sources")).toBe(0);
  });
});

describe("findMessageSync · deleteSync", () => {
  beforeEach(() => {
    for (const id of [1, 2, 3, 4]) liveNode(id);
    repo.insertSync(1, discordMessage("m-1"));
    // 플랫폼 단서가 없는 입력 → 행 platform NULL.
    const unknownPlatform = describeInputSource({ source: "", metadata: { messageId: "m-1" } });
    expect(unknownPlatform.platform).toBeNull();
    repo.insertSync(2, unknownPlatform);
    repo.insertSync(3, discordMessage("m-1", "telegram"));
    repo.insertSync(4, discordMessage("m-2"));
    repo.insertSync(4, dashboardSave);
  });

  test("platform null 이면 플랫폼 무관 — 행의 platform 도 돌려준다", () => {
    expect(repo.findMessageSync("m-1", null)).toEqual([
      { nodeId: 1, key: "msg:discord:m-1", platform: "discord" },
      { nodeId: 2, key: "msg::m-1", platform: null },
      { nodeId: 3, key: "msg:telegram:m-1", platform: "telegram" },
    ]);
  });

  test("platform 을 주면 같은 플랫폼만 — 행 platform NULL 은 걸리지 않는다, 대소문자·공백 정규화", () => {
    expect(repo.findMessageSync("m-1", "discord")).toEqual([{ nodeId: 1, key: "msg:discord:m-1", platform: "discord" }]);
    expect(repo.findMessageSync("m-1", " Discord ")).toEqual([{ nodeId: 1, key: "msg:discord:m-1", platform: "discord" }]);
    expect(repo.findMessageSync("m-1", "telegram")).toEqual([{ nodeId: 3, key: "msg:telegram:m-1", platform: "telegram" }]);
    expect(repo.findMessageSync("m-1", "slack")).toEqual([]);
    // 빈 플랫폼은 라우트(memories-delete.ts)와 같이 "플랫폼 무관".
    expect(repo.findMessageSync("m-1", "  ").map((r) => r.nodeId)).toEqual([1, 2, 3]);
  });

  test("direct_save 행은 메시지 조회에 걸리지 않는다", () => {
    expect(repo.findMessageSync("m-2", null)).toEqual([{ nodeId: 4, key: "msg:discord:m-2", platform: "discord" }]);
    expect(repo.findMessageSync("", null)).toEqual([]);
  });

  test("같은 메시지의 첨부 행도 찾고, isMessageTextRow 는 글 행만 고른다(WP-B1-20U 설계 17.8)", () => {
    repo.insertSync(1, attachmentRef("m-1", "a-1"));
    repo.insertSync(2, attachmentRef("m-1", "a-2", "telegram"));
    const rows = repo.findMessageSync("m-1", null);
    expect(rows).toEqual([
      { nodeId: 1, key: "msg:discord:m-1", platform: "discord" },
      { nodeId: 1, key: "msg:discord:m-1:att:a-1", platform: "discord" },
      { nodeId: 2, key: "msg::m-1", platform: null },
      { nodeId: 2, key: "msg:telegram:m-1:att:a-2", platform: "telegram" },
      { nodeId: 3, key: "msg:telegram:m-1", platform: "telegram" },
    ]);
    expect(rows.filter((row) => isMessageTextRow(row, "m-1")).map((row) => row.key)).toEqual([
      "msg:discord:m-1", "msg::m-1", "msg:telegram:m-1",
    ]);
    expect(repo.findMessageSync("m-1", "discord").map((row) => row.key)).toEqual(["msg:discord:m-1", "msg:discord:m-1:att:a-1"]);
  });

  test("deleteSync 는 그 키 한 행만 지운다", () => {
    repo.deleteSync(4, "msg:discord:m-2");
    expect(liveKeys(4)).toEqual(["save:dashboard:manual:owner"]);
    expect(repo.findMessageSync("m-2", null)).toEqual([]);
    repo.deleteSync(4, "no-such-key");
    expect(liveKeys(4)).toEqual(["save:dashboard:manual:owner"]);
  });
});

describe("moveRowSync · messageSourceRefOfRow — 메시지 수정 분리(설계 5.6)", () => {
  test("행을 그대로(칸·detail·created_at) 다른 노드로 옮기고 원래 노드에서 지운다", () => {
    liveNode(1);
    liveNode(2);
    const ref = discordMessage("m-move");
    repo.insertSync(1, ref);
    repo.insertSync(1, dashboardSave);
    const [before] = repo.listSync([1]).get(1)!.filter((row) => row.key === ref.key);

    repo.moveRowSync(1, 2, ref.key);

    expect(liveKeys(1)).toEqual([dashboardSave.key]);
    expect(repo.listSync([2]).get(2)).toEqual([{ ...before!, nodeId: 2 }]);
    expect(repo.findMessageSync("m-move", "discord")).toEqual([{ nodeId: 2, key: ref.key, platform: "discord" }]);
  });

  test("대상 노드에 같은 키가 이미 있으면 그 행을 두고 원래 노드의 행만 지운다", () => {
    liveNode(1);
    liveNode(2);
    const ref = discordMessage("m-both");
    repo.insertSync(1, ref);
    repo.insertSync(2, ref);
    const target = repo.listSync([2]).get(2)!;

    repo.moveRowSync(1, 2, ref.key);

    expect(liveKeys(1)).toEqual([]);
    expect(repo.listSync([2]).get(2)).toEqual(target);
  });

  test("원래 노드에 그 키가 없거나 같은 노드로 옮기면 아무것도 쓰지 않고 멈춘다", () => {
    liveNode(1);
    liveNode(2);
    const ref = discordMessage("m-missing");
    expect(() => repo.moveRowSync(1, 2, ref.key)).toThrow(/노드 1 에 출처 행/);
    expect(liveKeys(2)).toEqual([]);
    repo.insertSync(1, ref);
    expect(() => repo.moveRowSync(1, 1, ref.key)).toThrow(/같은 노드 1/);
    expect(liveKeys(1)).toEqual([ref.key]);
  });

  test("message 행은 같은 키·플랫폼·메시지 id·표시 칸의 출처 참조로 되돌아가 다시 넣을 수 있다", () => {
    liveNode(1);
    liveNode(2);
    const ref = discordMessage("m-ref");
    repo.insertSync(1, ref);
    const [row] = repo.listSync([1]).get(1)!;

    const restored = messageSourceRefOfRow(row!);

    expect(restored).toEqual(ref);
    expect(repo.insertSync(2, restored)).toBe(true);
  });

  test("message 가 아닌 행은 출처 참조로 되돌리지 않고 멈춘다", () => {
    liveNode(1);
    repo.insertSync(1, dashboardSave);
    const [row] = repo.listSync([1]).get(1)!;
    expect(() => messageSourceRefOfRow(row!)).toThrow(/message 종류가 아니라 direct_save/);
  });

  test("첨부 행은 detail 의 attachmentId 를 옮겨 같은 첨부 키 참조로 되돌아가고, 칸과 어긋난 키는 멈춘다", () => {
    liveNode(1);
    liveNode(2);
    const ref = attachmentRef("m-att", "a-9");
    repo.insertSync(1, ref);
    const [row] = repo.listSync([1]).get(1)!;

    const restored = messageSourceRefOfRow(row!);

    expect(restored).toEqual(ref);
    expect(repo.insertSync(2, restored)).toBe(true);
    expect(() => messageSourceRefOfRow({ ...row!, detail: { ...row!.detail, attachmentId: "a-other" } }))
      .toThrow(/칸 값으로 만든 키 'msg:discord:m-att:att:a-other'/);
  });
});

describe("moveToArchiveSync", () => {
  test("출처 행을 보관표로 옮기고, 계보 부모를 받은 노드에 archived_lineage 행을 남긴다", () => {
    for (const id of [10, 11, 12]) liveNode(id);
    repo.insertSync(10, discordMessage("m-10"));
    repo.insertSync(10, dashboardSave);
    repo.insertSync(12, dashboardSave);
    // archiveNodesSync 순서: 보관표 노드 행을 먼저 넣고 출처를 옮긴다.
    archivedNode(10);
    archivedNode(11);
    repo.moveToArchiveSync([10, 11, 10], new Map([[11, [10, 12, 12]]]));

    expect(liveKeys(10)).toEqual([]);
    expect(liveKeys(12)).toEqual(["save:dashboard:manual:owner"]);
    expect(archiveRows(10)).toEqual([
      { key: "msg:discord:m-10", kind: "message", platform: "discord", externalId: "m-10" },
      { key: "save:dashboard:manual:owner", kind: "direct_save", platform: null, externalId: null },
    ]);
    expect(archiveRows(11)).toEqual([
      { key: "lineage:10", kind: "archived_lineage", platform: null, externalId: "10" },
      { key: "lineage:12", kind: "archived_lineage", platform: null, externalId: "12" },
    ]);
  });

  test("계보 부모를 받은 노드가 옮기는 목록 밖이거나 자기 자신이 부모면 아무것도 쓰지 않고 멈춘다", () => {
    liveNode(10);
    repo.insertSync(10, dashboardSave);
    archivedNode(10);
    expect(() => repo.moveToArchiveSync([10], new Map([[11, [10]]]))).toThrow(/옮기는 노드 목록에 없습니다/);
    expect(() => repo.moveToArchiveSync([10], new Map([[10, [10]]]))).toThrow(/자기 자신/);
    expect(liveKeys(10)).toEqual(["save:dashboard:manual:owner"]);
    expect(count("memory_node_sources_archive")).toBe(0);
  });

  test("보관표 노드 행이 없으면 외래 키로 멈추고 살아 있는 행은 그대로다", () => {
    liveNode(10);
    repo.insertSync(10, dashboardSave);
    expect(() => repo.moveToArchiveSync([10], new Map())).toThrow(/FOREIGN KEY constraint failed/);
    expect(liveKeys(10)).toEqual(["save:dashboard:manual:owner"]);
  });

  test("바깥 트랜잭션이 되돌려지면 이동도 함께 되돌려진다(저장점 중첩)", () => {
    liveNode(10);
    repo.insertSync(10, dashboardSave);
    archivedNode(10);
    expect(() =>
      db.transaction(() => {
        repo.moveToArchiveSync([10], new Map());
        throw new Error("바깥 작업 실패");
      })(),
    ).toThrow("바깥 작업 실패");
    expect(liveKeys(10)).toEqual(["save:dashboard:manual:owner"]);
    expect(count("memory_node_sources_archive")).toBe(0);
  });
});

describe("restoreFromArchiveSync", () => {
  /** 휴지통 이동을 흉내 낸 상태: 보관표 노드 + 보관 출처 행. 복원 흐름대로 살아 있는 노드 행을 다시 넣는다. */
  function archivedWith(nodeId: number, refs: NodeSourceRef[], lineageParents: number[]): void {
    liveNode(nodeId);
    for (const ref of refs) repo.insertSync(nodeId, ref);
    archivedNode(nodeId);
    repo.moveToArchiveSync([nodeId], lineageParents.length > 0 ? new Map([[nodeId, lineageParents]]) : new Map());
    db.run("DELETE FROM knowledge_nodes WHERE id = ?", [nodeId]);
    liveNode(nodeId);
  }

  test("보관된 출처 행을 되돌리고 archived_lineage 는 되돌리지 않는다 — restore 행 없음", () => {
    liveNode(5);
    archivedWith(20, [discordMessage("m-20"), dashboardSave], [5]);
    const rows = repo.restoreFromArchiveSync(20, "owner");
    expect(rows.map((r: NodeSourceRow) => r.key)).toEqual(["msg:discord:m-20", "save:dashboard:manual:owner"]);
    expect(liveKeys(20)).toEqual(["msg:discord:m-20", "save:dashboard:manual:owner"]);
    expect(archiveRows(20)).toEqual([]);
    expect(repo.findMessageSync("m-20", "discord")).toEqual([{ nodeId: 20, key: "msg:discord:m-20", platform: "discord" }]);
  });

  test("archived_lineage 행만 있으면 restore:<actor> 행 하나", () => {
    liveNode(5);
    archivedWith(21, [], [5]);
    expect(archiveRows(21).map((r) => r.kind)).toEqual(["archived_lineage"]);
    const rows = repo.restoreFromArchiveSync(21, "owner");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      nodeId: 21,
      key: "restore:owner",
      kind: "restore",
      platform: null,
      externalId: null,
      detail: { actor: "owner" },
    });
    expect(archiveRows(21)).toEqual([]);
  });

  test("보관 출처 행이 하나도 없어도 restore 행", () => {
    archivedWith(22, [], []);
    expect(repo.restoreFromArchiveSync(22, "").map((r) => r.key)).toEqual(["restore:"]);
  });

  test("살아 있는 노드 행이 없으면 외래 키로 멈추고 보관 행은 그대로다", () => {
    liveNode(23);
    repo.insertSync(23, dashboardSave);
    archivedNode(23);
    repo.moveToArchiveSync([23], new Map());
    db.run("DELETE FROM knowledge_nodes WHERE id = 23");
    expect(() => repo.restoreFromArchiveSync(23, "owner")).toThrow(/FOREIGN KEY constraint failed/);
    expect(archiveRows(23).map((r) => r.key)).toEqual(["save:dashboard:manual:owner"]);
  });
});

describe("sweepArchiveForMessageSync — 메시지 삭제의 보관표 정리", () => {
  /** 보관 노드 하나와 그 보관 출처 행(원시 INSERT). */
  function archiveWithRows(id: number, rows: Array<{ key: string; kind: string; platform?: string; externalId?: string }>): void {
    archivedNode(id);
    for (const row of rows) {
      db.run(
        `INSERT INTO memory_node_sources_archive (node_id, source_key, kind, platform, external_id, created_at)
         VALUES (?, ?, ?, ?, ?, '2026-10-01 00:00:00')`,
        [id, row.key, row.kind, row.platform ?? null, row.externalId ?? null],
      );
    }
  }
  const lineage = (parentId: number) => ({ key: `lineage:${parentId}`, kind: "archived_lineage", externalId: String(parentId) });
  const message = (platform: string, messageId: string) => ({ key: `msg:${platform}:${messageId}`, kind: "message", platform, externalId: messageId });
  const save = { key: "save:dashboard:manual:owner", kind: "direct_save" };

  // 사슬: A(메시지 M) ← B ← C, B ← D(+살아 있는 부모 L), A ← E(+대시보드 저장), 지워진 살아 있는 X ← F.
  // G 는 이번 정리와 무관한 행 없는 보관 노드, H 는 다른 플랫폼의 같은 메시지 id.
  const A = 101, B = 102, C = 103, D = 104, E = 105, F = 106, G = 107, H = 108, L = 50, X = 60;

  beforeEach(() => {
    liveNode(L);
    archiveWithRows(A, [message("discord", "M")]);
    archiveWithRows(B, [lineage(A)]);
    archiveWithRows(C, [lineage(B)]);
    archiveWithRows(D, [lineage(B), lineage(L)]);
    archiveWithRows(E, [lineage(A), save]);
    archiveWithRows(F, [lineage(X)]);
    archiveWithRows(G, []);
    archiveWithRows(H, [message("telegram", "M")]);
  });

  test("여러 단계 계보를 따라 행이 모두 사라진 보관 노드만 영구 삭제한다", () => {
    const purged = repo.sweepArchiveForMessageSync("M", "discord", [X]);
    expect(purged).toEqual([A, B, C, F]);
    expect(archiveNodeIds()).toEqual([D, E, G, H]);
    expect(archiveRows(D)).toEqual([{ key: `lineage:${L}`, kind: "archived_lineage", platform: null, externalId: String(L) }]);
    expect(archiveRows(E)).toEqual([{ key: save.key, kind: "direct_save", platform: null, externalId: null }]);
    expect(archiveRows(H)).toEqual([{ key: "msg:telegram:M", kind: "message", platform: "telegram", externalId: "M" }]);
    // 지워진 보관 노드의 보관 출처 행은 남지 않는다.
    for (const id of [A, B, C, F]) expect(archiveRows(id)).toEqual([]);
    // 살아 있는 표는 건드리지 않는다.
    expect(count("knowledge_nodes")).toBe(1);
  });

  test("platform null 이면 다른 플랫폼의 같은 메시지 행도 지운다", () => {
    const purged = repo.sweepArchiveForMessageSync("M", null, []);
    expect(purged).toEqual([A, B, C, H]);
    expect(archiveNodeIds()).toEqual([D, E, F, G]);
  });

  test("일치하는 행이 없으면 아무것도 지우지 않는다", () => {
    expect(repo.sweepArchiveForMessageSync("no-such", null, [])).toEqual([]);
    expect(archiveNodeIds()).toEqual([A, B, C, D, E, F, G, H]);
  });

  test("500개 넘는 계보 사슬도 끝까지 따라간다", () => {
    const start = 1000;
    const length = 1200;
    archiveWithRows(start, [message("discord", "chain")]);
    for (let i = 1; i < length; i++) archiveWithRows(start + i, [lineage(start + i - 1)]);
    // 한 부모에 자식 600개, 자식마다 손자 하나 — 후보 확인과 계보 행 지우기가 한 번에 500개 넘는 IN 목록을 받는다.
    const fanParent = 5000;
    const grandchildBase = 7000;
    archiveWithRows(fanParent, [message("discord", "fan")]);
    for (let i = 1; i <= 600; i++) {
      archiveWithRows(fanParent + i, [lineage(fanParent)]);
      archiveWithRows(grandchildBase + i, [lineage(fanParent + i)]);
    }

    expect(repo.sweepArchiveForMessageSync("chain", "discord", [])).toHaveLength(length);
    const fanPurged = repo.sweepArchiveForMessageSync("fan", "discord", []);
    expect(fanPurged).toHaveLength(1 + 600 + 600);
    expect(fanPurged[0]).toBe(fanParent);
    expect(fanPurged[fanPurged.length - 1]).toBe(grandchildBase + 600);
    expect(archiveNodeIds()).toEqual([A, B, C, D, E, F, G, H]);
  });
});

describe("resetAllMemory 와 출처 표", () => {
  test("knowledge_nodes·knowledge_nodes_archive 를 비우면 두 출처 표가 CASCADE 로 비워진다", () => {
    liveNode(1);
    repo.insertSync(1, discordMessage("m-1"));
    repo.insertSync(1, dashboardSave);
    liveNode(2);
    repo.insertSync(2, dashboardSave);
    archivedNode(2);
    repo.moveToArchiveSync([2], new Map([[2, [1]]]));
    db.run("DELETE FROM knowledge_nodes WHERE id = 2");
    expect(count("memory_node_sources")).toBe(2);
    expect(count("memory_node_sources_archive")).toBe(2);
    // openMemoryDatabase 연결은 외래 키 강제가 켜져 있다 — CASCADE 가 도는 조건.
    expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);

    // resetAllMemory 는 임베딩을 쓰지 않는다 — 실제 Bgem3Embedder 를 모델 적재 없이 넘긴다.
    const counts = new StatsRepository(db, new Bgem3Embedder()).resetAllMemory();
    expect(counts.knowledgeNodes).toBe(1);
    expect(counts.knowledgeNodesArchive).toBe(1);
    expect(count("memory_node_sources")).toBe(0);
    expect(count("memory_node_sources_archive")).toBe(0);
  });
});
