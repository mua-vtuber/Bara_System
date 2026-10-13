/**
 * search.ancillary-visibility.int.test.ts — 검색 부가 출력 출처 판정(WP-B1-03 / SL-1·SA-4·SL-12).
 *
 * 실 SQLite(:memory:) + 실 bge-m3 + 실 검색 파이프라인. 같은 저장소를 REST POST /search
 * (buildMemoryApi)와 MCP search_memory(인증 게이트 + Bun.serve + SDK 클라이언트) 두 통로로
 * 불러, 부가 출력을 항목마다 실제 출처로 판정하는지 양방향으로 단언한다:
 *   - 응답과 무관한 비활성 노드가 있어도 부가 출력은 그대로다(옛 전역 restricted 판정 회귀 방지).
 *   - 출처가 제외된 항목만 빠지고 omittedAncillary 에 그 종류만 적힌다. 뺀 내용은 응답 어디에도
 *     나오지 않는다.
 * mock 0 — 행은 요약·엔티티·개념 배선이 실제로 쓰는 store 쓰기 함수로 만든다(데이터 fixture).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { retrieveEntities } from "../../memory/retrieve-entities-channel.ts";
import { retractSharedMemory } from "../../memory/shared-memory-mutations.ts";
import { SseTokenStore } from "../../federation/sse-tokens.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import { registerMcpRoutes } from "../../mcp/server.ts";
import { buildMemoryApi } from "../../server.ts";
import { createAuthGate } from "../auth-gate.ts";
import type { MemoryApiDeps } from "../types.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

interface Harness {
  db: Database;
  store: SqliteMemoryStore;
  rest: Hono;
  server: ReturnType<typeof Bun.serve>;
  client: Client;
  dir: string;
}
let h: Harness;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "bara-ancillary-"));
  const db = openMemoryDatabase(":memory:", { embeddingDim: embedder.dimension });
  const store = new SqliteMemoryStore(db, embedder);
  const deps: MemoryApiDeps = {
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(),
  };
  const tokens = new SseTokenStore(join(dir, "tokens.json"));
  const mcp = new Hono({ strict: false });
  mcp.use("*", createAuthGate({
    sseTokens: tokens,
    remoteAddrOf: () => "127.0.0.1",
    getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
  }));
  registerMcpRoutes(mcp, deps);
  const server = Bun.serve({ port: 0, fetch: mcp.fetch, idleTimeout: 60 });
  const client = new Client({ name: "ancillary-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tokens.issueToken("ancillary-test")}` } },
  }));
  h = { db, store, rest: buildMemoryApi(deps), server, client, dir };
});
afterEach(async () => {
  await h.client.close();
  h.server.stop(true);
  h.db.close();
  rmSync(h.dir, { recursive: true, force: true });
});

interface SearchItem {
  id: number;
  oneLine?: string;
  concepts?: {
    direct: Array<{ concept: { conceptId: string } }>;
    neighbors: Array<{ concept: { conceptId: string }; viaConceptId: string }>;
  };
  neighbors?: Array<{ id: number }>;
  captions?: { user: string | null; auto: string | null };
  chunkSummary?: { summaryText: string } | null;
  relationSummaries?: Array<{ summaryId: string }>;
}
interface SearchOutput {
  results: SearchItem[];
  omittedAncillary?: string[];
  entityHits?: Array<{ id: string }>;
}

/** 같은 body 를 REST /search(하한선 없음)와 MCP search_memory(AI 경로 하한선)로 보낸다. */
async function searchBoth(body: Record<string, unknown>): Promise<Array<[string, SearchOutput]>> {
  const res = await h.rest.request("/search", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  const tool = await h.client.callTool({ name: "search_memory", arguments: body });
  expect(tool.isError).not.toBe(true);
  const mcpText = (tool.content as Array<{ text: string }>)[0]!.text;
  return [["rest", (await res.json()) as SearchOutput], ["mcp", JSON.parse(mcpText) as SearchOutput]];
}

function item(output: SearchOutput, id: number): SearchItem {
  const found = output.results.find((result) => result.id === id);
  if (found === undefined) throw new Error(`result ${id} missing from ${JSON.stringify(output.results.map((r) => r.id))}`);
  return found;
}

const neighborConceptIds = (entry: SearchItem) => (entry.concepts?.neighbors ?? []).map((n) => n.concept.conceptId).sort();

let assetSeq = 0;
/** documents 행 + document 노드 — ingest 가 만드는 모양(관계요약 근거 문서의 출처 노드). */
async function addDocument(title: string, projectId: string | null, extra: Record<string, unknown> = {}) {
  const sha = `sha_ancillary_${++assetSeq}`;
  h.db.prepare(`INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, first_imported_at)
    VALUES (?, 'text', ?, 1, ?)`).run(sha, `/assets/${sha}.md`, Date.now());
  const documentId = h.store.createDocument({ assetSha256: sha, title, documentType: "text" });
  const nodeId = await h.store.addNode({
    content: title, sourceType: "document", project_id: projectId, metadata: { documentId, title, ...extra },
  });
  return { documentId, nodeId };
}

/** 문서 청크 노드 + parent_of 계보(ingest 와 같은 metadata.parentId·chunkIndex). */
async function addChunks(doc: { documentId: string; nodeId: number }, texts: string[], projectId: string | null) {
  const ids: number[] = [];
  for (const [chunkIndex, content] of texts.entries()) {
    const id = await h.store.addNode({
      content, sourceType: "document_chunk", project_id: projectId, metadata: { parentId: doc.documentId, chunkIndex },
    });
    await h.store.addEdge({ sourceId: id, targetId: doc.nodeId, relation: "parent_of", provenance: "system", sourceNodeId: id, weight: 1 });
    ids.push(id);
  }
  h.store.setChunkCount(doc.documentId, texts.length);
  return ids;
}

/** 원본에서 추출한 llm_extract 자식 + merged_into 계보. */
async function addExtract(parentId: number, content: string, projectId: string | null): Promise<number> {
  const id = await h.store.addNode({ content, sourceType: "llm_extract", project_id: projectId });
  await h.store.addEdge({ sourceId: id, targetId: parentId, relation: "merged_into", provenance: "system", sourceNodeId: id, weight: 1 });
  return id;
}

async function retract(nodeId: number): Promise<void> {
  await retractSharedMemory(h.store, { nodeId, expectedRevision: 0, requestId: `retract-${nodeId}`, actor: "ancillary-test" });
}

const EXPIRED = { sharedMemory: { validUntil: "2020-01-01T00:00:00Z" } };

describe("응답과 무관한 비활성 노드는 부가 출력을 끄지 않는다(완료 기준 1·5)", () => {
  test("다른 프로젝트의 무관한 retracted 노드 전후로 부모 치환·이웃·요약·개념·캡션·entityHits 가 같다", async () => {
    const doc = await addDocument("알파 운영 문서", "alpha");
    const [c0, c1, c2] = await addChunks(doc, [
      "알파 운영 첫 단락은 서버 점검 순서를 적는다.",
      "알파 운영 둘째 단락은 장애 알림을 운영 채널로 보낸다고 정한다.",
      "알파 운영 셋째 단락은 복구 담당자를 교대로 정한다.",
    ], "alpha");
    // 청크요약의 입력 원자 기억(요약 판정이 보는 llm_extract 자식).
    await addExtract(c1!, "장애 알림은 운영 채널로 보낸다", "alpha");
    await h.store.insertChunkSummary({
      summaryId: "cs_alpha", parentChunkId: c1!, parentDocumentId: doc.documentId,
      summaryText: "장애 알림 경로 요약", generatedBy: "llm",
    });
    const alert = await h.store.findOrCreateConcept("장애알림개념");
    const channel = await h.store.findOrCreateConcept("운영채널개념");
    await h.store.addNodeConceptEdge(c1!, alert, "tag", "hashtag", c1!);
    await h.store.insertRelationSummary({
      summaryId: "rs_alpha", fromConceptId: alert, toConceptId: channel, relationName: "전달",
      summaryText: "장애 알림은 운영 채널로 전달된다", confidence: 0.8, generatedBy: "llm", sourceDocumentId: doc.documentId,
    });
    await h.store.addConceptEdge({
      sourceConceptId: alert, targetConceptId: channel, relation: "llm_relation", provenance: "llm_extract", sourceNodeId: null, weight: 0.8,
    });
    const raw = await h.store.addNode({ content: "알파 배포는 운영팀이 맡기로 정했다", sourceType: "auto_capture", project_id: "alpha" });
    const extract = await addExtract(raw, "배포 담당은 운영팀", "alpha");
    const person = await h.store.findOrCreatePersonByName("알파담당자");
    await h.store.addPersonAttributeConcept(person.personId, alert, "hashtag", raw);
    const image = await h.store.addNode({ content: "알파 서버실 사진", sourceType: "image_asset", project_id: "alpha", metadata: { asset_sha256: "d".repeat(64) } });
    await h.store.addImageCaption({ parentNodeId: image, assetSha256: "d".repeat(64), caption: "랙 세 개가 놓인 서버실", captionRole: "auto" });
    h.store.entityTypeRegistryDb.addEntityType({ typeName: "rack_unit", koName: "랙장비", idPrefix: "rck_" });
    const rack = await h.store.entitiesRepo.findOrCreateEntity("rack_unit", "알파 메인 랙");
    await h.store.entitiesRepo.applyEmbedding(rack.id);
    const rackLeaf = await h.store.findOrCreateConcept("알파 메인 랙", { isClassificationValue: true });
    h.store.addEntityConceptEdge("rack_unit", rack.id, rackLeaf, "identity", "hashtag", raw);

    const queries: Array<Record<string, unknown>> = [
      { query: "알파 운영 둘째 단락은 장애 알림을 운영 채널로 보낸다고 정한다.", limit: 20, withSummaries: true },
      { query: "배포 담당은 운영팀", limit: 20 },
      { query: "랙 세 개가 놓인 서버실", limit: 20 },
      { query: "알파 메인 랙", limit: 20 },
      { query: "알파 운영 둘째 단락은 장애 알림을 운영 채널로 보낸다고 정한다.", limit: 20, responseMode: "index" },
      { query: "배포 담당은 운영팀", limit: 20, responseMode: "index" },
    ];
    const view = (output: SearchOutput) => ({
      omitted: output.omittedAncillary ?? [],
      entityHits: (output.entityHits ?? []).map((e) => e.id).sort(),
      items: [...output.results].sort((a, b) => a.id - b.id).map((entry) => ({
        id: entry.id,
        oneLine: entry.oneLine ?? null,
        neighbors: (entry.neighbors ?? []).map((n) => n.id),
        concepts: neighborConceptIds(entry),
        captions: entry.captions ?? null,
        chunkSummary: entry.chunkSummary?.summaryText ?? null,
        relationSummaries: (entry.relationSummaries ?? []).map((r) => r.summaryId),
      })),
    });
    const before: unknown[] = [];
    for (const body of queries) for (const [, output] of await searchBoth(body)) before.push(view(output));

    // 기준선이 비어 있지 않다 — 이 DB 에서 각 부가 출력이 실제로 실린다.
    for (const [, output] of await searchBoth(queries[0]!)) {
      expect(output.omittedAncillary).toBeUndefined();
      const center = item(output, c1!);
      expect((center.neighbors ?? []).map((n) => n.id).sort((a, b) => a - b)).toEqual([c0!, c2!].sort((a, b) => a - b));
      expect(center.chunkSummary?.summaryText).toBe("장애 알림 경로 요약");
      expect((center.relationSummaries ?? []).map((r) => r.summaryId)).toEqual(["rs_alpha"]);
      expect(neighborConceptIds(center)).toEqual([channel, person.personId].sort());
    }
    for (const [, output] of await searchBoth(queries[1]!)) {
      expect(output.results.map((r) => r.id)).toContain(raw);
      expect(output.results.map((r) => r.id)).not.toContain(extract);
    }
    for (const [, output] of await searchBoth(queries[2]!)) expect(item(output, image).captions?.auto).toBe("랙 세 개가 놓인 서버실");
    for (const [, output] of await searchBoth(queries[3]!)) expect((output.entityHits ?? []).map((e) => e.id)).toContain(rack.id);
    for (const [, output] of await searchBoth(queries[4]!)) expect(item(output, c1!).oneLine).toBe("장애 알림 경로 요약");
    for (const [, output] of await searchBoth(queries[5]!)) expect(output.results.map((r) => r.id)).toContain(raw);

    const unrelated = await h.store.addNode({ content: "제타 프로젝트의 오래된 회의 메모", project_id: "zeta" });
    await retract(unrelated);
    const after: unknown[] = [];
    for (const body of queries) for (const [, output] of await searchBoth(body)) after.push(view(output));
    expect(after).toEqual(before);
    for (const entry of after) expect((entry as { omitted: string[] }).omitted).toEqual([]);
  });
});

describe("출처가 제외된 항목만 빠진다(완료 기준 2·3·4·5)", () => {
  test("결과 청크의 이웃 청크 하나가 retracted → 그 이웃만 빠지고 omittedAncillary 는 neighborContext 뿐", async () => {
    const doc = await addDocument("회고 문서", null);
    const texts = [
      "회고 첫 단락은 목표를 적는다.",
      "회고 둘째 단락은 일정 지연 원인을 적는다.",
      "회고 셋째 단락은 인력 배치 변경을 결정했다.",
      "회고 넷째 단락은 비밀 협상 조건을 적는다.",
      "회고 다섯째 단락은 다음 분기 계획을 적는다.",
    ];
    const chunks = await addChunks(doc, texts, null);
    const body = { query: texts[2]!, limit: 5 };
    for (const [channel, output] of await searchBoth(body)) {
      expect({ channel, omitted: output.omittedAncillary }).toEqual({ channel, omitted: undefined });
      expect((item(output, chunks[2]!).neighbors ?? []).map((n) => n.id)).toContain(chunks[3]!);
    }
    await retract(chunks[3]!);
    for (const [channel, output] of await searchBoth(body)) {
      const neighbors = (item(output, chunks[2]!).neighbors ?? []).map((n) => n.id);
      expect({ channel, neighbors: neighbors.sort((a, b) => a - b) })
        .toEqual({ channel, neighbors: [chunks[0]!, chunks[1]!, chunks[4]!] });
      expect({ channel, omitted: output.omittedAncillary }).toEqual({ channel, omitted: ["neighborContext"] });
      expect(JSON.stringify(output)).not.toContain("비밀 협상 조건");
    }
  });

  test("scope A 검색에서 B 문서의 관계요약은 빠지고 A 문서의 관계요약은 남는다", async () => {
    const docA = await addDocument("에이 프로젝트 문서", "A");
    const docB = await addDocument("비 프로젝트 문서", "B");
    const result = await h.store.addNode({ content: "에이 프로젝트 출시 준비 회의 기록", project_id: "A" });
    const launch = await h.store.findOrCreateConcept("출시준비개념");
    const partner = await h.store.findOrCreateConcept("협력사개념");
    const rival = await h.store.findOrCreateConcept("경쟁사개념");
    await h.store.addNodeConceptEdge(result, launch, "tag", "hashtag", result);
    const summary = (summaryId: string, to: string, text: string, sourceDocumentId: string) => h.store.insertRelationSummary({
      summaryId, fromConceptId: launch, toConceptId: to, relationName: "관련", summaryText: text, confidence: 0.8, generatedBy: "llm", sourceDocumentId,
    });
    await summary("rs_a", partner, "출시 준비는 협력사와 함께 한다", docA.documentId);
    await summary("rs_b", rival, "비 프로젝트 기밀 경쟁 전략", docB.documentId);
    const body = { query: "에이 프로젝트 출시 준비 회의 기록", limit: 5, withSummaries: true };
    for (const [channel, output] of await searchBoth(body)) {
      expect({ channel, summaries: (item(output, result).relationSummaries ?? []).map((r) => r.summaryId).sort() })
        .toEqual({ channel, summaries: ["rs_a", "rs_b"] });
      expect({ channel, omitted: output.omittedAncillary }).toEqual({ channel, omitted: undefined });
    }
    for (const [channel, output] of await searchBoth({ ...body, scope: { projectId: "A" } })) {
      expect({ channel, summaries: (item(output, result).relationSummaries ?? []).map((r) => r.summaryId) })
        .toEqual({ channel, summaries: ["rs_a"] });
      expect({ channel, omitted: output.omittedAncillary }).toEqual({ channel, omitted: ["summaries"] });
      expect(JSON.stringify(output)).not.toContain("기밀 경쟁 전략");
    }
  });

  test("철회된 기억에서만 만들어진 엔티티는 빠지고, 출처 없는 엔티티는 scope 없는 검색에서만 실린다", async () => {
    h.store.entityTypeRegistryDb.addEntityType({ typeName: "probe", koName: "탐사선", idPrefix: "prb_" });
    const makeEntity = async (name: string, sourceNodeId: number | null) => {
      const entity = await h.store.entitiesRepo.findOrCreateEntity("probe", name);
      await h.store.entitiesRepo.applyEmbedding(entity.id);
      if (sourceNodeId !== null) {
        const leaf = await h.store.findOrCreateConcept(name, { isClassificationValue: true });
        h.store.addEntityConceptEdge("probe", entity.id, leaf, "identity", "hashtag", sourceNodeId);
      }
      return entity.id;
    };
    const retractedSource = await h.store.addNode({ content: "은하 탐사선 알파 발사 기록", project_id: "A" });
    const liveSource = await h.store.addNode({ content: "은하 탐사선 베타 발사 기록", project_id: "A" });
    const fromRetracted = await makeEntity("은하 탐사선 알파", retractedSource);
    const fromLive = await makeEntity("은하 탐사선 베타", liveSource);
    const unsourced = await makeEntity("은하 탐사선 감마", null);
    const body = { query: "은하 탐사선", limit: 10 };
    const hits = (output: SearchOutput) => (output.entityHits ?? []).map((e) => e.id);
    for (const [channel, output] of await searchBoth(body)) {
      expect({ channel, hits: hits(output).filter((id) => [fromRetracted, fromLive, unsourced].includes(id)).sort() })
        .toEqual({ channel, hits: [fromRetracted, fromLive, unsourced].sort() });
      expect({ channel, omitted: output.omittedAncillary }).toEqual({ channel, omitted: undefined });
    }
    await retract(retractedSource);
    for (const [channel, output] of await searchBoth(body)) {
      expect({ channel, hits: hits(output).filter((id) => [fromRetracted, fromLive, unsourced].includes(id)).sort() })
        .toEqual({ channel, hits: [fromLive, unsourced].sort() });
      expect({ channel, omitted: output.omittedAncillary }).toEqual({ channel, omitted: ["entityHits"] });
      expect(JSON.stringify(output)).not.toContain(fromRetracted);
    }
    for (const [channel, output] of await searchBoth({ ...body, scope: { projectId: "A" } })) {
      expect({ channel, hits: hits(output).filter((id) => [fromRetracted, fromLive, unsourced].includes(id)) })
        .toEqual({ channel, hits: [fromLive] });
      expect({ channel, omitted: output.omittedAncillary }).toEqual({ channel, omitted: ["entityHits"] });
    }
  });

  test("부모 치환 — 허용된 부모만 치환하고 다른 scope 의 부모는 자식 그대로(full·index)", async () => {
    const parent = await h.store.addNode({ content: "비 프로젝트 원본 기밀 로드맵", sourceType: "auto_capture", project_id: "B" });
    const child = await addExtract(parent, "공개 가능한 로드맵 요약 문장", "A");
    for (const responseMode of ["full", "index"]) {
      const body = { query: "공개 가능한 로드맵 요약 문장", limit: 5, responseMode };
      for (const [channel, output] of await searchBoth(body)) {
        expect({ channel, responseMode, ids: output.results.map((r) => r.id) }).toEqual({ channel, responseMode, ids: [parent] });
        expect({ channel, omitted: output.omittedAncillary }).toEqual({ channel, omitted: undefined });
      }
      for (const [channel, output] of await searchBoth({ ...body, scope: { projectId: "A" } })) {
        expect({ channel, responseMode, ids: output.results.map((r) => r.id) }).toEqual({ channel, responseMode, ids: [child] });
        expect({ channel, omitted: output.omittedAncillary }).toEqual({ channel, omitted: ["parentSubstitution"] });
        expect(JSON.stringify(output)).not.toContain("기밀 로드맵");
      }
    }
  });

  test("청크요약 — llm_extract 자식 하나가 retracted 면 요약을 싣지 않는다(full·index)", async () => {
    const doc = await addDocument("점검 문서", null);
    const [chunk] = await addChunks(doc, ["점검 문서의 단락은 백업 확인 절차를 설명한다."], null);
    await addExtract(chunk!, "백업은 매일 확인한다", null);
    const retractedAtom = await addExtract(chunk!, "백업 암호는 금고에 둔다", null);
    await h.store.insertChunkSummary({
      summaryId: "cs_backup", parentChunkId: chunk!, parentDocumentId: doc.documentId,
      summaryText: "백업 확인과 암호 보관 요약", generatedBy: "llm",
    });
    const full = { query: "점검 문서의 단락은 백업 확인 절차를 설명한다.", limit: 5, withSummaries: true };
    const index = { ...full, responseMode: "index" };
    for (const [channel, output] of await searchBoth(full)) {
      expect({ channel, summary: item(output, chunk!).chunkSummary?.summaryText }).toEqual({ channel, summary: "백업 확인과 암호 보관 요약" });
    }
    for (const [channel, output] of await searchBoth(index)) {
      expect({ channel, oneLine: item(output, chunk!).oneLine }).toEqual({ channel, oneLine: "백업 확인과 암호 보관 요약" });
    }
    await retract(retractedAtom);
    for (const [channel, output] of await searchBoth(full)) {
      expect({ channel, summary: item(output, chunk!).chunkSummary }).toEqual({ channel, summary: null });
      expect({ channel, omitted: output.omittedAncillary }).toEqual({ channel, omitted: ["summaries"] });
      expect(JSON.stringify(output)).not.toContain("암호 보관");
    }
    for (const [channel, output] of await searchBoth(index)) {
      expect({ channel, oneLine: item(output, chunk!).oneLine }).toEqual({ channel, oneLine: "점검 문서의 단락은 백업 확인 절차를 설명한다." });
      expect({ channel, omitted: output.omittedAncillary }).toEqual({ channel, omitted: ["summaries"] });
      expect(JSON.stringify(output)).not.toContain("암호 보관");
    }
  });

  test("이미지 캡션 — 더 최신 캡션이 제외되면 허용된 이전 캡션을 싣고 기록한다", async () => {
    const sha = "e".repeat(64);
    const image = await h.store.addNode({ content: "창고 선반 사진 기록", sourceType: "image_asset", metadata: { asset_sha256: sha } });
    await h.store.addImageCaption({ parentNodeId: image, assetSha256: sha, caption: "빈 선반이 줄지어 있다", captionRole: "auto" });
    const newer = await h.store.addImageCaption({ parentNodeId: image, assetSha256: sha, caption: "선반 위 금고 번호표", captionRole: "auto" });
    const body = { query: "창고 선반 사진 기록", limit: 5 };
    for (const [channel, output] of await searchBoth(body)) {
      expect({ channel, auto: item(output, image).captions?.auto }).toEqual({ channel, auto: "선반 위 금고 번호표" });
    }
    await retract(newer);
    for (const [channel, output] of await searchBoth(body)) {
      expect({ channel, auto: item(output, image).captions?.auto }).toEqual({ channel, auto: "빈 선반이 줄지어 있다" });
      expect({ channel, omitted: output.omittedAncillary }).toEqual({ channel, omitted: ["imageCaptions"] });
      expect(JSON.stringify(output)).not.toContain("금고 번호표");
    }
  });
});

describe("개념 확장 — 이웃은 concept_edges 출처 부류로 거른다(부류마다 고정)", () => {
  test("출처 노드·문서 근거·어휘 부류와 출처 없는 엣지를 각각 판정한다", async () => {
    const result = await h.store.addNode({ content: "관측소 개념 확장 검증 기록", project_id: "A" });
    const hub = await h.store.findOrCreateConcept("관측소허브개념");
    await h.store.addNodeConceptEdge(result, hub, "tag", "hashtag", result);
    // 출처 노드 부류(hashtag) — 원본 노드가 이번 응답에서 허용일 때만.
    const liveSource = await h.store.addNode({ content: "관측소 담당자 배정 메모", project_id: "A" });
    const goneSource = await h.store.addNode({ content: "관측소 퇴사자 메모", project_id: "A" });
    const crossSource = await h.store.addNode({ content: "다른 팀 관측 협조 메모", project_id: "B" });
    const livePerson = await h.store.findOrCreatePersonByName("현직관측원");
    const gonePerson = await h.store.findOrCreatePersonByName("퇴직관측원");
    const crossPerson = await h.store.findOrCreatePersonByName("협조관측원");
    await h.store.addPersonAttributeConcept(livePerson.personId, hub, "hashtag", liveSource);
    await h.store.addPersonAttributeConcept(gonePerson.personId, hub, "hashtag", goneSource);
    await h.store.addPersonAttributeConcept(crossPerson.personId, hub, "hashtag", crossSource);
    // 문서 근거 부류(llm_extract llm_relation) — 같은 방향 쌍의 관계요약 문서 노드가 허용일 때만.
    const liveDoc = await addDocument("관측소 현행 문서", "A");
    const expiredDoc = await addDocument("관측소 만료 문서", "A", EXPIRED);
    const relation = async (name: string, documentId: string | null) => {
      const target = await h.store.findOrCreateConcept(name);
      await h.store.addConceptEdge({ sourceConceptId: hub, targetConceptId: target, relation: "llm_relation", provenance: "llm_extract", sourceNodeId: null, weight: 0.7 });
      if (documentId !== null) {
        await h.store.insertRelationSummary({
          summaryId: `rs_${name}`, fromConceptId: hub, toConceptId: target, relationName: "관련",
          summaryText: `${name} 관계`, confidence: 0.7, generatedBy: "llm", sourceDocumentId: documentId,
        });
      }
      return target;
    };
    const documented = await relation("현행관계개념", liveDoc.documentId);
    await relation("만료관계개념", expiredDoc.documentId);
    await relation("근거없는관계개념", null);
    // 어휘 부류(user_input, 출처 노드 없음) — 항상 유지(scope 검색에서도).
    const labeledPerson = await h.store.findOrCreatePersonByName("라벨관측원");
    await h.store.addPersonAttributeConcept(labeledPerson.personId, hub, "user_input", null);
    // 표에 없는 provenance(손상 행) — 출처를 증명할 수 없어 뺀다.
    const damaged = await h.store.findOrCreateConcept("손상엣지개념");
    h.db.query(`INSERT INTO concept_edges (source_concept_id, target_concept_id, relation, provenance, source_node_id, weight)
      VALUES (?, ?, 'llm_relation', 'unlisted_origin', NULL, 0.7)`).run(hub, damaged);

    const body = { query: "관측소 개념 확장 검증 기록", limit: 10 };
    const shown = [livePerson.personId, gonePerson.personId, crossPerson.personId, documented, labeledPerson.personId].sort();
    for (const [channel, output] of await searchBoth(body)) {
      expect({ channel, neighbors: neighborConceptIds(item(output, result)) }).toEqual({ channel, neighbors: shown });
      expect({ channel, omitted: output.omittedAncillary }).toEqual({ channel, omitted: ["conceptExpansion"] });
      for (const name of ["만료관계개념", "근거없는관계개념", "손상엣지개념"]) expect(JSON.stringify(output)).not.toContain(name);
    }
    await retract(goneSource);
    const afterRetract = [livePerson.personId, crossPerson.personId, documented, labeledPerson.personId].sort();
    for (const [channel, output] of await searchBoth(body)) {
      expect({ channel, neighbors: neighborConceptIds(item(output, result)) }).toEqual({ channel, neighbors: afterRetract });
      expect({ channel, omitted: output.omittedAncillary }).toEqual({ channel, omitted: ["conceptExpansion"] });
      expect(JSON.stringify(output)).not.toContain("퇴직관측원");
    }
    // scope A 검색 — B 프로젝트 원본에서 온 이웃은 빠지고, 어휘 관계와 A 문서 근거는 남는다.
    for (const [channel, output] of await searchBoth({ ...body, scope: { projectId: "A" } })) {
      expect({ channel, neighbors: neighborConceptIds(item(output, result)) })
        .toEqual({ channel, neighbors: [livePerson.personId, documented, labeledPerson.personId].sort() });
      expect({ channel, omitted: output.omittedAncillary }).toEqual({ channel, omitted: ["conceptExpansion"] });
      expect(JSON.stringify(output)).not.toContain("협조관측원");
    }
  });

  test("부모로 바뀌어 보이지 않는 자식의 개념 펼침은 뺀 항목으로 기록하지 않는다", async () => {
    const parent = await h.store.addNode({ content: "측량 계획 원본 글", sourceType: "auto_capture" });
    const child = await addExtract(parent, "측량 장비는 삼각대를 쓴다", null);
    const tool = await h.store.findOrCreateConcept("측량장비개념");
    await h.store.addNodeConceptEdge(child, tool, "mention", "llm_extract", child);
    const hiddenSource = await h.store.addNode({ content: "측량 외주 계약 메모" });
    const contractor = await h.store.findOrCreatePersonByName("외주측량사");
    await h.store.addPersonAttributeConcept(contractor.personId, tool, "hashtag", hiddenSource);
    await retract(hiddenSource);
    const body = { query: "측량 장비는 삼각대를 쓴다", limit: 5 };
    for (const [channel, output] of await searchBoth(body)) {
      // 자식은 부모로 치환되어 자식의 개념 펼침은 응답에 없다 — 뺀 항목도 없다.
      expect({ channel, ids: output.results.map((r) => r.id).filter((id) => id === parent || id === child) })
        .toEqual({ channel, ids: [parent] });
      expect({ channel, omitted: output.omittedAncillary }).toEqual({ channel, omitted: undefined });
      expect(JSON.stringify(output)).not.toContain("외주측량사");
    }
  });

  test("같은 이웃이 허용 엣지와 제외 엣지로 닿으면 허용 엣지로만 보이고 빠진 것으로 기록한다", async () => {
    const result = await h.store.addNode({ content: "이중 경로 개념 검증 기록" });
    const first = await h.store.findOrCreateConcept("첫경로개념");
    const second = await h.store.findOrCreateConcept("둘째경로개념");
    await h.store.addNodeConceptEdge(result, first, "tag", "hashtag", result);
    await h.store.addNodeConceptEdge(result, second, "tag", "hashtag", result);
    const shared = await h.store.findOrCreatePersonByName("공유이웃사람");
    const strongSource = await h.store.addNode({ content: "강한 연결 원본 메모" });
    const weakSource = await h.store.addNode({ content: "약한 연결 원본 메모" });
    await h.store.addPersonAttributeConcept(shared.personId, first, "hashtag", strongSource);
    await h.store.addPersonAttributeConcept(shared.personId, second, "hashtag", weakSource);
    h.db.query("UPDATE concept_edges SET weight = 0.4 WHERE source_concept_id = ? AND target_concept_id = ?").run(shared.personId, second);
    const body = { query: "이중 경로 개념 검증 기록", limit: 5 };
    const via = (output: SearchOutput) => item(output, result).concepts!.neighbors
      .filter((n) => n.concept.conceptId === shared.personId).map((n) => n.viaConceptId);
    for (const [channel, output] of await searchBoth(body)) {
      expect({ channel, via: via(output), omitted: output.omittedAncillary }).toEqual({ channel, via: [first], omitted: undefined });
    }
    await retract(strongSource);
    for (const [channel, output] of await searchBoth(body)) {
      expect({ channel, via: via(output), omitted: output.omittedAncillary }).toEqual({ channel, via: [second], omitted: ["conceptExpansion"] });
    }
  });
});

describe("retrieveEntities admit — 판정에 걸린 엔티티 자리는 다음 순위가 채운다", () => {
  test("상위 엔티티를 빼면 다음 순위가 자리를 채우고, 판정은 채울 자리까지만 묻는다", async () => {
    h.store.entityTypeRegistryDb.addEntityType({ typeName: "beacon", koName: "표지", idPrefix: "bcn_" });
    for (const name of ["등대 표지 하나", "등대 표지 둘", "등대 표지 셋", "등대 표지 넷"]) {
      const entity = await h.store.entitiesRepo.findOrCreateEntity("beacon", name);
      await h.store.entitiesRepo.applyEmbedding(entity.id);
    }
    const repo = h.store.entitiesRepo;
    const queryVec = Array.from(await embedder.embed("등대 표지"));
    // 후보 풀은 limit 로 정해진다 — 같은 limit 3 의 판정 없는 회신이 기준 순위다.
    const baseline = (await retrieveEntities(repo, "등대 표지", queryVec, 3)).map((hit) => hit.id);
    expect(baseline).toHaveLength(3);

    const askedAll: string[] = [];
    const admitAll = await retrieveEntities(repo, "등대 표지", queryVec, 3, (entityId) => {
      askedAll.push(entityId);
      return true;
    });
    // 전부 허용이면 판정 없는 회신과 같고, 판정은 채운 자리 수만큼만 불렸다.
    expect(admitAll.map((hit) => hit.id)).toEqual(baseline);
    expect(askedAll).toEqual(baseline);

    const askedFirstOut: string[] = [];
    const firstOut = (await retrieveEntities(repo, "등대 표지", queryVec, 3, (entityId) => {
      askedFirstOut.push(entityId);
      return entityId !== baseline[0];
    })).map((hit) => hit.id);
    // 1위가 빠진 자리를 2·3위가 앞당겨 채운다(풀에 4번째가 있으면 그 뒤를 잇는다).
    expect(firstOut.slice(0, 2)).toEqual([baseline[1]!, baseline[2]!]);
    expect(firstOut).not.toContain(baseline[0]!);
    expect(askedFirstOut.slice(0, 3)).toEqual(baseline);
  });
});
