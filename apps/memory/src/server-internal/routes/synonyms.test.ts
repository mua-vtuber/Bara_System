/**
 * server-internal/routes/synonyms.test.ts — 동의어 사전 CRUD 라우트 통합 검증
 * (웨이브3 동의어 설정 탭 항목12 B2 / plan Step 3).
 *
 * 검증 가족:
 *   (a) POST /api/synonyms → 201 + 생성 entry(id 는 syn_user_ 접두 / source user).
 *   (b) GET  /api/synonyms → yaml(읽기전용·id null·source yaml) + user(entryId·source
 *       user) 출처 구분 합집합 목록.
 *   (c) DELETE /api/synonyms/:id → 200 + 그 쌍이 목록에서 사라짐.
 *   (d) 핵심 단일 권위: POST → 그 동의어로만 적힌 글이 retriever fts 채널로 잡히고,
 *       DELETE → 다시 fts 로 안 잡힌다(reloadSynonymDict 가 *같은* retriever 인스턴스
 *       사전을 재시작 없이 갈아끼운다).
 *   (e) repo/yaml 미주입 = CRUD·목록 503(정직한 비활성).
 *   (f) 잘못된 body(term/synonym 누락) = 400.
 *
 * 실 SQLite(:memory:) + 실 SynonymUserRepo + 실 HybridRetriever + 실 Bgem3Embedder.
 * mock 객체 없음(CLAUDE.md "테스트 정책"). data fixture(입력 문자열·yaml Map)만 사용.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi } from "../../server.ts";
import { SynonymUserRepo } from "../../memory/synonyms/synonym-user-repo.ts";
import { mergeSynonymDict } from "../../memory/synonyms/merge-synonym-dict.ts";
import type { SynonymDictionary } from "../../memory/synonym-dictionary.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
  retriever: HybridRetriever;
  repo: SynonymUserRepo;
}

/**
 * synonymUserRepo + retriever 가 *같은* db + *같은* 병합 사전을 공유하는 harness.
 * 부팅 흐름(server.ts)을 그대로 미러 — yaml 원본 + repo.listEntries() 를 합쳐
 * retriever 에 주입하고, 같은 repo·yaml·retriever 를 deps 로 넘긴다.
 *
 * @param yamlDict  yaml 원본 기준선(data fixture). 미지정 시 빈 Map.
 * @param withRepo  false 면 synonymUserRepo·synonymYamlDict 미주입 → CRUD 503 검증용.
 */
function makeHarness(
  yamlDict: SynonymDictionary = new Map(),
  withRepo = true,
): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const repo = new SynonymUserRepo(db);
  const merged = mergeSynonymDict(yamlDict, repo.listEntries());
  const retriever = new HybridRetriever(store, embedder, { synonymDict: merged });
  const assembler = new ContextAssembler();
  const app = buildMemoryApi({
    store,
    retriever,
    assembler,
    synonymUserRepo: withRepo ? repo : undefined,
    synonymYamlDict: withRepo ? yamlDict : undefined,
  });
  return { app, db, store, retriever, repo };
}

describe("synonyms CRUD 라우트", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  test("POST /api/synonyms → 201 + entry(syn_user_ 접두 / source user)", async () => {
    const res = await h.app.request("/api/synonyms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ term: "고양이", synonym: "냥이", lang: "ko" }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      entry: { id: string; term: string; synonym: string; lang: string; source: string };
    };
    expect(json.entry.id.startsWith("syn_user_")).toBe(true);
    expect(json.entry.term).toBe("고양이");
    expect(json.entry.synonym).toBe("냥이");
    expect(json.entry.lang).toBe("ko");
    expect(json.entry.source).toBe("user");
  });

  test("POST term/synonym 누락 = 400", async () => {
    const noTerm = await h.app.request("/api/synonyms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ synonym: "냥이" }),
    });
    expect(noTerm.status).toBe(400);

    const noSyn = await h.app.request("/api/synonyms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ term: "고양이" }),
    });
    expect(noSyn.status).toBe(400);
  });

  test("GET /api/synonyms 가 yaml(읽기전용) + user(삭제용 id) 출처 구분 목록", async () => {
    // yaml 원본에 한 쌍, user 추가로 한 쌍.
    const h2 = makeHarness(new Map([["강아지", ["멍멍이"]]]));
    await h2.app.request("/api/synonyms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ term: "고양이", synonym: "냥이" }),
    });

    const res = await h2.app.request("/api/synonyms");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      entries: Array<{
        id: string | null;
        term: string;
        synonym: string;
        source: string;
      }>;
    };

    const yamlEntry = json.entries.find((e) => e.term === "강아지");
    expect(yamlEntry).toBeDefined();
    expect(yamlEntry!.source).toBe("yaml");
    expect(yamlEntry!.id).toBeNull();

    const userEntry = json.entries.find((e) => e.term === "고양이");
    expect(userEntry).toBeDefined();
    expect(userEntry!.source).toBe("user");
    expect(userEntry!.id!.startsWith("syn_user_")).toBe(true);

    h2.db.close();
  });

  test("DELETE /api/synonyms/:id → 200 + 목록에서 사라짐", async () => {
    const postRes = await h.app.request("/api/synonyms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ term: "삭제대상", synonym: "지움" }),
    });
    const { entry } = (await postRes.json()) as { entry: { id: string } };

    const delRes = await h.app.request(`/api/synonyms/${entry.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    const delJson = (await delRes.json()) as { deleted: string };
    expect(delJson.deleted).toBe(entry.id);

    const listRes = await h.app.request("/api/synonyms");
    const { entries } = (await listRes.json()) as { entries: Array<{ term: string }> };
    expect(entries.find((e) => e.term === "삭제대상")).toBeUndefined();
  });

  test("CRUD 후 retriever 사전이 실제로 갱신된다(같은 인스턴스 reload — fts 채널)", async () => {
    // 글 내용엔 동의어 "냥이"만 — 원본 용어 "고양이" 글자는 없다.
    const nyangId = await h.store.addNode({ content: "오늘 냥이가 창밖을 봤다" });
    await h.store.addNode({ content: "자동차를 새로 샀다" });

    // 추가 전: "고양이" 검색은 글자 불일치라 그 글에 fts 출처가 안 붙는다.
    const before = await h.retriever.retrieve("고양이");
    const beforeHit = before.find((r) => r.node.id === nyangId);
    if (beforeHit) {
      expect(beforeHit.sources).not.toContain("fts");
    }

    // POST 로 동의어 추가 → 라우트가 재병합 + reloadSynonymDict.
    const postRes = await h.app.request("/api/synonyms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ term: "고양이", synonym: "냥이" }),
    });
    const { entry } = (await postRes.json()) as { entry: { id: string } };

    // 추가 후: fts query 가 "고양이 냥이" 로 확장돼 그 글이 fts 채널로 잡힌다.
    const after = await h.retriever.retrieve("고양이");
    const afterHit = after.find((r) => r.node.id === nyangId);
    expect(afterHit).toBeDefined();
    expect(afterHit!.sources).toContain("fts");

    // DELETE 로 쌍 삭제 → 재병합 + reload → 다시 fts 로 안 잡힌다.
    await h.app.request(`/api/synonyms/${entry.id}`, { method: "DELETE" });
    const afterDelete = await h.retriever.retrieve("고양이");
    const deletedHit = afterDelete.find((r) => r.node.id === nyangId);
    if (deletedHit) {
      expect(deletedHit.sources).not.toContain("fts");
    }
  });
});

describe("synonyms CRUD 라우트 — 비활성(repo/yaml 미주입)", () => {
  test("POST/GET/DELETE 모두 503(정직한 비활성)", async () => {
    const h = makeHarness(new Map(), false);

    const post = await h.app.request("/api/synonyms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ term: "고양이", synonym: "냥이" }),
    });
    expect(post.status).toBe(503);

    const get = await h.app.request("/api/synonyms");
    expect(get.status).toBe(503);

    const del = await h.app.request("/api/synonyms/syn_user_x", { method: "DELETE" });
    expect(del.status).toBe(503);

    h.db.close();
  });
});
