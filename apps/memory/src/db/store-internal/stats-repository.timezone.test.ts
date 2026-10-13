/**
 * stats-repository.timezone.test.ts — P3 G3-b 시간대 통일 실증(9시간 오차 수정).
 *
 * 실버그: archived_at 은 trashNodes 가 nowKst(설정 zone)로 저장하는데, 옛 컷오프는
 * toISOString()(UTC)라 KST 저장값과 9시간 어긋났다. 옛 store.test.ts 의 purge 테스트는
 * archived_at 을 UTC 로 직접 설정해 컷오프도 UTC 라 우연히 통과했다 — 실제 저장 경로
 * (nowKst)를 안 거쳐 버그를 못 잡았다.
 *
 * 이 테스트는 실제 trashNodes(→ nowKst 저장)를 거친 뒤, 저장값과 컷오프가 같은 zone
 * 이라 경과 판정이 정확한지 실증한다. UTC zone 으로 바꿔서도 저장·컷오프가 함께 이동해
 * 여전히 정합함을 확인한다(zone 파라미터화 실증).
 *
 * Real bun:sqlite + sqlite-vec + real Bgem3Embedder. Mock 없음(테스트 정책) —
 * restoreArchived 가 임베딩을 재생성하므로 실 embedder 필요.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { SqliteMemoryStore } from "../store.ts";
import { getConfiguredTimeZone, setTimeZone } from "./helpers.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let db: Database;
let store: SqliteMemoryStore;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
});
afterEach(() => {
  db.close();
  // 전역 zone 오염 차단 — 다른 테스트가 KST 를 가정한다.
  setTimeZone("Asia/Seoul");
});

/** WP-B1-20U 설계 17.17 — 문서·이미지 노드가 아니라 해제한 첨부가 없는 보관 만료의 assetCleanup. */
const NO_ASSET_CLEANUP = { documentIds: [], removedSha256s: [], missingSha256s: [], failed: [] };

/**
 * 현재 설정 zone 기준 N일 전 시각을 "YYYY-MM-DD HH:MM:SS" 로 만든다. trashNodes 가
 * 실제로 쓰는 nowInZone(설정 zone)과 같은 zone 문자열이라 저장값과 같은 시간대다 —
 * 옛 테스트가 UTC(toISOString)로 넣어 버그를 숨긴 것과 대비되는 핵심 지점.
 */
function pastInZone(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 3600 * 1000).toLocaleString(
    "sv-SE",
    { timeZone: getConfiguredTimeZone(), hour12: false },
  );
}

describe("purgeOldArchive — 저장 zone·컷오프 zone 정합(9시간 오차 수정)", () => {
  test("KST: trashNodes 가 저장한 KST 값 기준으로 경과 판정이 정확하다", async () => {
    setTimeZone("Asia/Seoul");
    const id = await store.addNode({ content: "오래된 메모", importance: 0.2 });
    await store.trashNodes([id], "cascade"); // archived_at = nowKst() (KST)

    // 실 저장 경로와 같은 zone(nowInZone)으로 35일 전으로 민다.
    db.prepare(
      "UPDATE knowledge_nodes_archive SET archived_at = ? WHERE id = ?",
    ).run(pastInZone(35), id);

    // 30일 컷오프 — 35일 전 노드는 삭제 대상(9시간 오차 없이 정확히 걸린다).
    const purged = await store.purgeOldArchive(30);
    expect(purged).toEqual({ nodesPurged: 1, assetCleanup: NO_ASSET_CLEANUP });
    expect(await store.getArchive()).toHaveLength(0);
  });

  test("KST: 컷오프 안쪽(25일) 노드는 삭제되지 않는다 — 9시간 오차라면 오판할 자리", async () => {
    setTimeZone("Asia/Seoul");
    const id = await store.addNode({ content: "경계 노드", importance: 0.2 });
    await store.trashNodes([id], "cascade");

    db.prepare(
      "UPDATE knowledge_nodes_archive SET archived_at = ? WHERE id = ?",
    ).run(pastInZone(25), id);

    const purged = await store.purgeOldArchive(30);
    expect(purged).toEqual({ nodesPurged: 0, assetCleanup: NO_ASSET_CLEANUP });
    expect(await store.getArchive()).toHaveLength(1);
  });

  test("UTC zone: 저장·컷오프가 함께 UTC 로 이동해도 경과 판정 정확(zone 파라미터화)", async () => {
    // zone 을 UTC 로 바꾸면 trashNodes 저장값도 UTC, 컷오프도 UTC — 여전히 정합.
    setTimeZone("UTC");
    const id = await store.addNode({ content: "UTC 저장 메모", importance: 0.2 });
    await store.trashNodes([id], "cascade"); // archived_at = nowInZone(UTC)

    db.prepare(
      "UPDATE knowledge_nodes_archive SET archived_at = ? WHERE id = ?",
    ).run(pastInZone(35), id);

    const purged = await store.purgeOldArchive(30);
    expect(purged).toEqual({ nodesPurged: 1, assetCleanup: NO_ASSET_CLEANUP });
  });
});

describe("getArchiveSoonToPurge — 임박 판정도 저장 zone 정합", () => {
  test("25일 전 노드는 30일 한계·7일 경고 창(23~30일) 안에 든다", async () => {
    setTimeZone("Asia/Seoul");
    const id = await store.addNode({ content: "임박 메모", importance: 0.2 });
    await store.trashNodes([id], "cascade");

    db.prepare(
      "UPDATE knowledge_nodes_archive SET archived_at = ? WHERE id = ?",
    ).run(pastInZone(25), id);

    const soon = await store.getArchiveSoonToPurge(7, 30);
    expect(soon).toHaveLength(1);
    expect(soon[0]!.id).toBe(id);
  });
});
