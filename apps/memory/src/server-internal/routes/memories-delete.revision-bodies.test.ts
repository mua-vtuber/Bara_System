/**
 * memories-delete.revision-bodies.test.ts — 메시지를 지운 뒤에도 다른 출처로 남는 기억에서, 그 메시지의 동기
 * 수정(PATCH by-source)이 남긴 수정 이력 행의 본문을 지우고 누가·언제·왜는 남긴다(WP-B1-20U 설계 17.6, 사용자 결정 1).
 *
 * memory_revisions 의 source_message_id·source_platform 칸이 "이 행은 그 메시지의 동기 수정이 남겼다"를 적는다(by-source
 * 같은 id 수정과 분리 이력만 쓴다). 메시지 삭제가 같은 트랜잭션에서 그 칸으로 행을 찾아 old_content·new_content 와
 * 두 칸을 비운다. 플랫폼 일치 규칙은 출처 행 조회와 같다(플랫폼 없으면 플랫폼 무관, 주면 같은 플랫폼만).
 *
 * 알려진 차이(결정 범위 그대로): by-id 편집(대시보드 PATCH /memories/:id)이 남긴 행은 메시지 동기 수정이 아니라
 * 본문이 남는다 — 아래 한 테스트가 그 사실을 단언으로 고정한다.
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 실제 Hono 라우트(POST /memories, PATCH /memories/by-source,
 * PATCH /memories/:id, DELETE /memories/by-source, POST /memories/:id/trash, GET /memories/:id/revisions).
 * 저장 라우트는 추출기 없이 plain 갈래라 LLM 을 부르지 않는다. 모든 제거 뒤 계보 불변식 도우미를 부른다.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";

import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import type { DeleteBySourceResult, EditBySourceResult } from "../../api-client-types.ts";
import type { MemoryRevision } from "../../memory/types.ts";
import { buildMemoryApi } from "../../server.ts";
import { lineageOrphans } from "../../test-utils/lineage-invariant.ts";
import { MESSAGE_EDIT_SPLIT_REASON_PREFIX } from "./memories-edit-split.ts";

const AUTHOR = "owner";
const DISCORD = "discord";
const SLACK = "slack";
const MESSAGE_EDITOR = "discord-user-1";
const MESSAGE_EDIT_REASON = "discord message edit";
const JSON_HEADERS = { "Content-Type": "application/json" };

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

interface Harness {
  app: Hono;
  db: Database;
}

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.db.close();
});

function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const app = buildMemoryApi({ store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler() });
  const h = { app, db };
  harnesses.push(h);
  return h;
}

/** 메시지 봇이 보내는 모양(platform, messageId·channelId 칸)으로 저장한다. */
async function postMessage(h: Harness, content: string, messageId: string, platform: string = DISCORD): Promise<number> {
  const res = await h.app.request("/memories", {
    method: "POST", headers: JSON_HEADERS,
    body: JSON.stringify({
      content, platform, author: AUTHOR, force: true,
      metadata: { source: `${platform}-channel`, user_id: "user-1", messageId, channelId: "channel-1" },
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json() as { id: number }).id;
}

/** 대시보드 저장 — 같은 본문이면 저장 경로가 기존 기억으로 흡수하고 그 기억에 대시보드 출처 행을 더한다. */
async function postDashboard(h: Harness, content: string): Promise<number> {
  const res = await h.app.request("/memories", {
    method: "POST", headers: JSON_HEADERS,
    body: JSON.stringify({ content, platform: "dashboard", author: AUTHOR, force: true }),
  });
  expect(res.status).toBe(201);
  return (await res.json() as { id: number }).id;
}

/** 메시지 수정 동기화. platform 이 null 이면 플랫폼 칸 없이 보낸다. */
async function editBySource(
  h: Harness,
  messageId: string,
  content: string,
  platform: string | null = DISCORD,
): Promise<EditBySourceResult> {
  const body: Record<string, unknown> = {
    messageId, content, reason: MESSAGE_EDIT_REASON, editor: MESSAGE_EDITOR, source: platform ?? DISCORD,
  };
  if (platform !== null) body.platform = platform;
  const res = await h.app.request("/memories/by-source", { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  return await res.json() as EditBySourceResult;
}

/** 대시보드의 by-id 편집(PATCH /memories/:id). */
async function editById(h: Harness, id: number, content: string): Promise<void> {
  const res = await h.app.request(`/memories/${id}`, {
    method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ content, editor: AUTHOR }),
  });
  expect(res.status).toBe(200);
}

/** 메시지 삭제 동기화. platform 이 null 이면 플랫폼 없이 부른다. 지운 뒤 계보 불변식을 확인한다. */
async function deleteBySource(h: Harness, messageId: string, platform: string | null = DISCORD): Promise<DeleteBySourceResult> {
  const query = platform === null ? `messageId=${messageId}` : `messageId=${messageId}&platform=${platform}`;
  const res = await h.app.request(`/memories/by-source?${query}`, { method: "DELETE" });
  expect(res.status).toBe(200);
  const body = await res.json() as DeleteBySourceResult;
  expect(lineageOrphans(h.db)).toEqual([]);
  return body;
}

async function trash(h: Harness, id: number): Promise<void> {
  const res = await h.app.request(`/memories/${id}/trash`, { method: "POST" });
  expect(res.status).toBe(200);
  expect(lineageOrphans(h.db)).toEqual([]);
}

async function revisionsOf(h: Harness, id: number): Promise<MemoryRevision[]> {
  const res = await h.app.request(`/memories/${id}/revisions`);
  expect(res.status).toBe(200);
  return (await res.json() as { revisions: MemoryRevision[] }).revisions;
}

interface RevisionRecord {
  id: number;
  old_node_id: number;
  new_node_id: number | null;
  revision_type: string;
  reason: string | null;
  old_content: string | null;
  new_content: string | null;
  editor: string | null;
  edit_source: string | null;
  created_at: string;
  source_message_id: string | null;
  source_platform: string | null;
}

function revisionRows(db: Database): RevisionRecord[] {
  return db.query("SELECT * FROM memory_revisions ORDER BY id").all() as RevisionRecord[];
}

function onlyRevisionRow(db: Database): RevisionRecord {
  const rows = revisionRows(db);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** 살아 있는 기억·휴지통·수정 이력 어디에든 그 글이 남아 있는 곳의 수. */
function textCount(db: Database, text: string): number {
  const count = (sql: string, ...params: string[]): number => (db.query(sql).get(...params) as { n: number }).n;
  return (
    count("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE instr(content, ?) > 0", text) +
    count("SELECT COUNT(*) AS n FROM knowledge_nodes_archive WHERE instr(content, ?) > 0", text) +
    count(
      `SELECT COUNT(*) AS n FROM memory_revisions
       WHERE instr(COALESCE(old_content, ''), ?) > 0 OR instr(COALESCE(new_content, ''), ?) > 0`,
      text, text,
    )
  );
}

function nodeContent(db: Database, id: number): string | null {
  return (db.query("SELECT content FROM knowledge_nodes WHERE id = ?").get(id) as { content: string } | null)?.content ?? null;
}

/** 본문과 메시지 칸만 비고, 누가·언제·왜와 어느 노드였는지는 그대로인 행. */
function clearedFrom(before: RevisionRecord): RevisionRecord {
  return { ...before, old_content: null, new_content: null, source_message_id: null, source_platform: null };
}

describe("메시지 삭제 뒤 남는 기억의 메시지 동기 수정 이력 본문 (설계 17.6)", () => {
  test("QA 재현 3: 메시지 수정 → 대시보드가 새 문장 저장 → 메시지 삭제: 기억은 남고 그 이력 행은 누가·언제만 남긴다", async () => {
    const h = makeHarness();
    const oldSentence = "다음 주 비공개 회의 장소는 판교역 이번 출구 앞 카페다";
    const newSentence = "다음 주 비공개 회의 장소는 정자역 삼번 출구 앞 서점으로 바뀌었다";
    const id = await postMessage(h, oldSentence, "msg-qa3");

    const edited = await editBySource(h, "msg-qa3", newSentence);
    expect(edited).toMatchObject({ editedIds: [id], splits: [] });
    const before = onlyRevisionRow(h.db);
    expect(before).toMatchObject({
      old_node_id: id, new_node_id: id, revision_type: "manual", reason: MESSAGE_EDIT_REASON,
      old_content: oldSentence, new_content: newSentence, editor: MESSAGE_EDITOR, edit_source: DISCORD,
      source_message_id: "msg-qa3", source_platform: DISCORD,
    });

    expect(await postDashboard(h, newSentence)).toBe(id);
    const deleted = await deleteBySource(h, "msg-qa3");
    expect(deleted).toMatchObject({ deletedIds: [], derivedDeletedIds: [], keptIds: [id], archivePurgedIds: [], revisionBodiesCleared: 1 });

    expect(nodeContent(h.db, id)).toBe(newSentence);
    expect(onlyRevisionRow(h.db)).toEqual(clearedFrom(before));
    expect(textCount(h.db, oldSentence)).toBe(0);
    expect(await revisionsOf(h, id)).toEqual([{
      id: before.id, oldNodeId: id, newNodeId: id, revisionType: "manual", reason: MESSAGE_EDIT_REASON, similarityScore: null,
      oldContent: null, newContent: null, editor: MESSAGE_EDITOR, editSource: DISCORD, createdAt: before.created_at,
    }]);
  }, 120_000);

  test("분리 이력(E -> N)에서 N 이 다른 출처로 남으면 그 행의 본문이 지워진다", async () => {
    const h = makeHarness();
    const shared = "올해 동아리 정기 모임은 매달 첫째 주 토요일 오후에 연다";
    const changed = "올해 동아리 정기 모임은 매달 셋째 주 일요일 저녁으로 옮겼다";
    const origin = await postMessage(h, shared, "msg-split");
    expect(await postDashboard(h, shared)).toBe(origin);

    const edited = await editBySource(h, "msg-split", changed);
    expect(edited.editedIds).toEqual([]);
    expect(edited.splits).toHaveLength(1);
    const { newNodeId } = edited.splits[0]!;
    const before = onlyRevisionRow(h.db);
    expect(before).toMatchObject({
      old_node_id: origin, new_node_id: newNodeId, old_content: shared, new_content: changed,
      editor: MESSAGE_EDITOR, edit_source: DISCORD, source_message_id: "msg-split", source_platform: DISCORD,
    });
    expect(before.reason!.startsWith(MESSAGE_EDIT_SPLIT_REASON_PREFIX)).toBe(true);

    expect(await postDashboard(h, changed)).toBe(newNodeId);
    const deleted = await deleteBySource(h, "msg-split");
    expect(deleted).toMatchObject({ deletedIds: [], keptIds: [newNodeId], revisionBodiesCleared: 1 });

    expect(onlyRevisionRow(h.db)).toEqual(clearedFrom(before));
    expect(nodeContent(h.db, origin)).toBe(shared);
    expect(nodeContent(h.db, newNodeId)).toBe(changed);
    const [revision] = await revisionsOf(h, newNodeId);
    expect(revision).toMatchObject({ oldNodeId: origin, newNodeId, oldContent: null, newContent: null, editor: MESSAGE_EDITOR });
  }, 120_000);

  test("알려진 차이: by-id 대시보드 편집 행은 메시지 동기 수정이 아니라 본문이 남는다", async () => {
    const h = makeHarness();
    const typo = "다음 달 정산 마감일은 이십오일 오후 여섯시 까지다";
    const fixed = "다음 달 정산 마감일은 이십오일 오후 여섯시까지다";
    const id = await postMessage(h, typo, "msg-by-id");
    await editById(h, id, fixed);
    expect(await postDashboard(h, fixed)).toBe(id);

    const deleted = await deleteBySource(h, "msg-by-id");
    expect(deleted).toMatchObject({ keptIds: [id], revisionBodiesCleared: 0 });
    // 결정 범위 그대로 — by-id 행은 메시지 칸이 없어 메시지 삭제가 찾지 않는다. 수정 전 메시지 원문이 남는다.
    expect(onlyRevisionRow(h.db)).toMatchObject({
      old_node_id: id, old_content: typo, new_content: fixed, editor: AUTHOR, source_message_id: null, source_platform: null,
    });
    expect(textCount(h.db, typo)).toBe(1);
  }, 120_000);

  test("다른 플랫폼의 같은 messageId 는 플랫폼 준 삭제에 걸리지 않고, 플랫폼 없이 부른 삭제는 플랫폼 무관으로 지운다", async () => {
    const h = makeHarness();
    const slackOld = "슬랙 공지: 서버 점검은 화요일 새벽 두시에 시작한다";
    const slackNew = "슬랙 공지: 서버 점검은 목요일 새벽 세시로 미뤘다";
    const discordOld = "디스코드 공지: 신규 회원 환영회는 금요일 저녁 일곱시다";
    const discordNew = "디스코드 공지: 신규 회원 환영회는 토요일 낮 열두시로 바뀌었다";
    const slackId = await postMessage(h, slackOld, "msg-same", SLACK);
    // 플랫폼 칸 없이 보낸 수정도 그 기억의 메시지 출처 행 플랫폼을 이력에 적는다.
    expect(await editBySource(h, "msg-same", slackNew, null)).toMatchObject({ editedIds: [slackId] });
    const discordId = await postMessage(h, discordOld, "msg-same", DISCORD);
    expect(await editBySource(h, "msg-same", discordNew, DISCORD)).toMatchObject({ editedIds: [discordId] });
    expect(await postDashboard(h, slackNew)).toBe(slackId);
    expect(await postDashboard(h, discordNew)).toBe(discordId);
    const [slackRow, discordRow] = revisionRows(h.db);
    expect(slackRow).toMatchObject({ old_node_id: slackId, old_content: slackOld, source_message_id: "msg-same", source_platform: SLACK });
    expect(discordRow).toMatchObject({ old_node_id: discordId, old_content: discordOld, source_message_id: "msg-same", source_platform: DISCORD });

    const discordDeleted = await deleteBySource(h, "msg-same", DISCORD);
    expect(discordDeleted).toMatchObject({ keptIds: [discordId], revisionBodiesCleared: 1 });
    expect(revisionRows(h.db)).toEqual([slackRow!, clearedFrom(discordRow!)]);

    const anyDeleted = await deleteBySource(h, "msg-same", null);
    expect(anyDeleted).toMatchObject({ keptIds: [slackId], revisionBodiesCleared: 1 });
    expect(revisionRows(h.db)).toEqual([clearedFrom(slackRow!), clearedFrom(discordRow!)]);
    expect(textCount(h.db, slackOld)).toBe(0);
    expect(textCount(h.db, discordOld)).toBe(0);
  }, 120_000);

  test("휴지통에 있는 남는 기억의 메시지 동기 수정 이력 본문도 지워진다", async () => {
    const h = makeHarness();
    const oldSentence = "창고 비밀번호 보관 위치는 사무실 두번째 서랍이다";
    const newSentence = "창고 비밀번호 보관 위치를 사무실 금고로 옮겼다";
    const id = await postMessage(h, oldSentence, "msg-trash");
    await editBySource(h, "msg-trash", newSentence);
    expect(await postDashboard(h, newSentence)).toBe(id);
    const before = onlyRevisionRow(h.db);
    await trash(h, id);

    const deleted = await deleteBySource(h, "msg-trash");
    // 휴지통의 기억은 대시보드 출처 행이 남아 보관표에 그대로 있다.
    expect(deleted).toMatchObject({ deletedIds: [], keptIds: [], archivePurgedIds: [], revisionBodiesCleared: 1 });
    expect((h.db.query("SELECT content FROM knowledge_nodes_archive WHERE id = ?").get(id) as { content: string }).content)
      .toBe(newSentence);
    expect(onlyRevisionRow(h.db)).toEqual(clearedFrom(before));
    expect(textCount(h.db, oldSentence)).toBe(0);
  }, 120_000);

  test("메시지가 유일한 출처라 기억이 영구 삭제되면 그 이력 행은 통째로 지워지고 지운 본문 수는 0이다", async () => {
    const h = makeHarness();
    const oldSentence = "택배 수령 대리인은 옆집 이웃으로 정했다";
    const newSentence = "택배 수령 대리인은 관리사무소로 바꿨다";
    const id = await postMessage(h, oldSentence, "msg-only");
    await editBySource(h, "msg-only", newSentence);
    expect(revisionRows(h.db)).toHaveLength(1);

    const deleted = await deleteBySource(h, "msg-only");
    expect(deleted).toMatchObject({ deletedIds: [id], keptIds: [], revisionBodiesCleared: 0 });
    expect(revisionRows(h.db)).toEqual([]);
  }, 120_000);
});
