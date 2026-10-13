/**
 * ingest-document-legacy-merge.test.ts — 옛 버전이 잘못 합쳐 둔 문서 기록을 정직하게 다루는가(업그레이드한 설치).
 *
 * 옛 버전은 글자 없는 문서(스캔 PDF)의 대기 본문을 파일 이름 한 줄로 채웠다. 그래서 이미 저장된 DB 에는
 *   (가) 이름만 같은 다른 스캔본 둘이 한 노드를 나눠 쓰는 기록,
 *   (나) 스캔 문서가 같은 글("report.pdf")의 평범한 기억에 흡수된 기록
 * 이 남아 있을 수 있다. 이런 기록은 "같은 파일" 이 아니므로 absorbed 가 아니라 legacy_merged 로 판정하고, OCR 후보에서
 * 빼되(붙일 노드가 없음) 상태로 따로 세며, 다시 올리면 자기 노드를 받는다(지금 대기 본문은 세 줄이라 옛 본문과 다름).
 *
 * 옛 상태는 옛 흐름과 같은 실제 저장소 통로로 만든다 — store.recordDocumentAssets(기록·자산) + ingestDocument(노드,
 * 본문 = 파일 이름 한 줄). 실제 SQLite(:memory:) + 실제 bge-m3 + 실제 AssetStore + 실제 Hono 라우트 + 실제 PDF fixture.
 * mock 0. 각 시험 끝에 첨부 파일 불변식을 본다.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssetStore, assetSha256 } from "../../assets/asset-store.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { OCR_AUTOMATIC_PARSE_STATUSES, OCR_CANDIDATE_PARSE_STATUSES } from "../../memory/document-parse-status.ts";
import { ingestDocument } from "../../memory/ingest-document.ts";
import { buildMemoryApi } from "../../server.ts";
import { getMemorySettings } from "../../settings/memory-settings.ts";
import { assetInvariantViolations } from "../../test-utils/asset-invariant.ts";

const SOURCE = "dashboard:manual";
const USER_ID = "u-legacy-merge";
const SCANNED = readFileSync(join(import.meta.dir, "..", "document-ocr", "__fixtures__", "scanned-2page.pdf"));

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

interface Harness {
  app: Hono;
  db: Database;
  dir: string;
  store: SqliteMemoryStore;
  assetStore: AssetStore;
}
const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) {
    expect(assetInvariantViolations(h.db, h.dir)).toEqual([]);
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "bara-legacy-merge-"));
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const assetStore = new AssetStore(dir);
  const settings = getMemorySettings("/nonexistent-legacy-merge-test", "/nonexistent-legacy-merge-test.secrets.json");
  const app = buildMemoryApi({
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(), assetStore,
    getSettings: () => settings,
  });
  const h = { app, db, dir, store, assetStore };
  harnesses.push(h);
  return h;
}

function variant(tag: string): Uint8Array {
  return Buffer.concat([SCANNED, Buffer.from(`\n%${tag}\n`)]);
}

/**
 * 옛 흐름 그대로 스캔 PDF 를 저장한다 — 기록·자산은 recordDocumentAssets, 노드 본문은 파일 이름 한 줄.
 * parse 를 주면 그 parse 칸(null 이면 칸 없음 — parse 상태 도입 전 저장분)으로 기록한다.
 */
async function legacyIngestScanned(
  h: Harness,
  bytes: Uint8Array,
  name: string,
  parse?: Record<string, unknown> | null,
) {
  const sha = assetSha256(bytes);
  const parseField = parse === null
    ? {}
    : { parse: parse ?? { status: "needs_ocr", method: "tier1", originalAssetSha256: sha, canonicalAssetSha256: sha, warnings: [] } };
  const recorded = await h.store.recordDocumentAssets({
    writer: h.assetStore,
    files: [{ sha256: sha, byteSize: bytes.byteLength, bytes, ext: "pdf", assetType: "text", mimeType: "application/pdf", originalName: name }],
    document: {
      assetSha256: sha,
      title: name,
      documentType: "free",
      sourceMetadata: { source: SOURCE, classification: {}, ...parseField },
    },
    ledger: { source: SOURCE, author: "테스터", userId: USER_ID, originalName: name },
  });
  const graph = await ingestDocument(h.store, {
    documentId: recorded.documentId,
    assetSha256: sha,
    title: name,
    rawContent: name, // 옛 대기 본문 — 파일 이름 한 줄
    documentType: "free",
    chunks: [],
    author: "테스터",
    platform: SOURCE,
    documentMetadata: { user_id: USER_ID, source: SOURCE },
  });
  return { documentId: recorded.documentId, nodeId: graph.documentNodeId, absorbed: graph.documentAbsorbed };
}

/** 글자가 있는 문서(text_succeeded)를 같은 저장소 통로로 저장한다 — 본문 = 그 글. */
async function recordTextDocument(h: Harness, text: string, name: string) {
  const bytes = new TextEncoder().encode(text);
  const sha = assetSha256(bytes);
  const recorded = await h.store.recordDocumentAssets({
    writer: h.assetStore,
    files: [{ sha256: sha, byteSize: bytes.byteLength, bytes, ext: "txt", assetType: "text", mimeType: "text/plain", originalName: name }],
    document: {
      assetSha256: sha,
      title: name,
      documentType: "free",
      sourceMetadata: {
        source: SOURCE,
        classification: {},
        parse: { status: "text_succeeded", method: "tier1", originalAssetSha256: sha, canonicalAssetSha256: sha, warnings: [] },
      },
    },
    ledger: { source: SOURCE, author: "테스터", userId: USER_ID, originalName: name },
  });
  const graph = await ingestDocument(h.store, {
    documentId: recorded.documentId, assetSha256: sha, title: name, rawContent: text, documentType: "free", chunks: [],
    author: "테스터", platform: SOURCE, documentMetadata: { user_id: USER_ID, source: SOURCE },
  });
  return { documentId: recorded.documentId, nodeId: graph.documentNodeId, absorbed: graph.documentAbsorbed };
}

async function ingestFile(h: Harness, bytes: Uint8Array, name: string, mimeType = "application/pdf") {
  const res = await h.app.request("/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: SOURCE,
      content: { type: "auto", data: Buffer.from(bytes).toString("base64"), mimeType, originalName: name },
      attribution: { author: "테스터", userId: USER_ID },
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { documentId: string; nodeIds: number[]; absorbedInto: number | null };
}

function ocrCandidateIds(h: Harness): string[] {
  return h.store.listDocumentsByParseStatuses(OCR_CANDIDATE_PARSE_STATUSES, 100).map((d) => d.documentId).sort();
}

interface StatusBody {
  document: {
    nodeId?: number;
    extraction?: unknown;
    absorbedInto?: { notice: string };
    legacyMerged?: { nodeId: number; documentId: string | null; inTrash: boolean; notice: string };
  };
}

async function statusOf(h: Harness, documentId: string): Promise<StatusBody> {
  const res = await h.app.request(`/api/documents/${documentId}/status`);
  expect(res.status).toBe(200);
  return (await res.json()) as StatusBody;
}

async function applyOcr(h: Harness, documentId: string, markdown: string) {
  return h.app.request(`/api/documents/${encodeURIComponent(documentId)}/ocr-result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown, source: "manual" }),
  });
}

describe("옛 버전의 잘못된 합침 — legacy_merged", () => {
  test("(가) 이름만 같은 다른 스캔본 — 같은 파일로 보지 않고, 후보에서 빼되 따로 세고, 정직하게 알린다", async () => {
    const h = makeHarness();
    const first = await legacyIngestScanned(h, variant("a"), "same.pdf");
    const second = await legacyIngestScanned(h, variant("b"), "same.pdf");
    expect(first.absorbed).toBe(false);
    expect(second.absorbed).toBe(true); // 옛 본문은 이름 한 줄이라 바이트가 달라도 합쳐졌다
    expect(second.nodeId).toBe(first.nodeId);

    expect(h.store.getDocumentRecordPlacement(first.documentId)).toEqual({ kind: "own", nodeId: first.nodeId });
    expect(h.store.getDocumentRecordPlacement(second.documentId)).toEqual({
      kind: "legacy_merged", ownerNodeId: first.nodeId, ownerDocumentId: first.documentId, ownerInTrash: false,
    });
    expect(ocrCandidateIds(h)).toEqual([first.documentId]);
    expect(h.store.countNotOwnedRecordsByParseStatuses(OCR_AUTOMATIC_PARSE_STATUSES)).toEqual({ absorbed: 0, legacyMerged: 1 });

    const status = await statusOf(h, second.documentId);
    expect(status.document.absorbedInto).toBeUndefined();
    expect(status.document.nodeId).toBeUndefined(); // 자기 노드가 아니다 — 남의 노드·숫자를 보이지 않는다
    expect(status.document.extraction).toBeUndefined();
    expect(status.document.legacyMerged).toMatchObject({ nodeId: first.nodeId, documentId: first.documentId, inTrash: false });
    expect(status.document.legacyMerged!.notice).toContain("예전 버전이 이름만 같은 이 기록을");
    expect(status.document.legacyMerged!.notice).toContain("이 파일 자신의 내용은 읽힌 적이 없습니다");
    expect(status.document.legacyMerged!.notice).toContain("같은 파일을 다시 올리면 따로 저장되어");
    expect(status.document.legacyMerged!.notice).not.toContain("결과를 함께");

    const refused = await applyOcr(h, second.documentId, "# 붙이면 안 됨");
    expect(refused.status).toBe(409);
    const error = ((await refused.json()) as { error: string }).error;
    expect(error).toContain("붙일 문서 노드가 없습니다");
    expect(error).not.toContain("글자 인식은 그 문서");
  });

  test("(나) 같은 글의 평범한 기억에 흡수된 스캔 문서 — legacy_merged, 기억이라고 알린다", async () => {
    const h = makeHarness();
    const memoryId = await h.store.addNode({ content: "report.pdf" });
    const doc = await legacyIngestScanned(h, variant("memory"), "report.pdf");
    expect(doc.absorbed).toBe(true);
    expect(doc.nodeId).toBe(memoryId);
    expect(h.store.getDocumentRecordPlacement(doc.documentId)).toEqual({
      kind: "legacy_merged", ownerNodeId: memoryId, ownerDocumentId: null, ownerInTrash: false,
    });
    expect(ocrCandidateIds(h)).toEqual([]);
    expect(h.store.countNotOwnedRecordsByParseStatuses(OCR_AUTOMATIC_PARSE_STATUSES)).toEqual({ absorbed: 0, legacyMerged: 1 });
    const status = await statusOf(h, doc.documentId);
    expect(status.document.legacyMerged!.notice).toContain(`글이 파일 이름과 같은 기억(노드 ${memoryId})에 잘못 합쳐 두었습니다`);
    expect(status.document.legacyMerged!.notice).not.toContain("이름만 같은");
    expect((await applyOcr(h, doc.documentId, "# 안 됨")).status).toBe(409);
  });

  test("주인 노드가 휴지통에 있어도 legacy_merged — 휴지통 표시와 함께, 후보에서 빠진 채 따로 센다", async () => {
    const h = makeHarness();
    const first = await legacyIngestScanned(h, variant("a"), "same.pdf");
    const second = await legacyIngestScanned(h, variant("b"), "same.pdf");
    await h.store.trashNodes([first.nodeId], "cascade");
    expect(h.store.getDocumentRecordPlacement(second.documentId)).toEqual({
      kind: "legacy_merged", ownerNodeId: first.nodeId, ownerDocumentId: first.documentId, ownerInTrash: true,
    });
    expect(h.store.countNotOwnedRecordsByParseStatuses(OCR_AUTOMATIC_PARSE_STATUSES)).toEqual({ absorbed: 0, legacyMerged: 1 });
    const status = await statusOf(h, second.documentId);
    expect(status.document.legacyMerged).toMatchObject({ inTrash: true });
    expect(status.document.legacyMerged!.notice).toContain("휴지통");
    expect(status.document.legacyMerged!.notice).toContain("다시 올리면");
  });

  test("parse 칸에 originalAssetSha256 이 없으면 기록의 asset_sha256 으로 견준다 — 같은 바이트는 absorbed, 다른 바이트는 legacy_merged", async () => {
    const h = makeHarness();
    const bytes = variant("no-original");
    const noOriginal = { status: "needs_ocr", method: "tier1", warnings: [] };
    const owner = await legacyIngestScanned(h, bytes, "same.pdf", noOriginal);
    const sameBytes = await legacyIngestScanned(h, bytes, "same.pdf", noOriginal);
    const otherBytes = await legacyIngestScanned(h, variant("no-original-other"), "same.pdf", noOriginal);
    expect(sameBytes.nodeId).toBe(owner.nodeId);
    expect(otherBytes.nodeId).toBe(owner.nodeId);
    expect(h.store.getDocumentRecordPlacement(sameBytes.documentId)).toMatchObject({ kind: "absorbed", ownerDocumentId: owner.documentId });
    expect(h.store.getDocumentRecordPlacement(otherBytes.documentId)).toMatchObject({ kind: "legacy_merged", ownerDocumentId: owner.documentId });
  });

  test("옛 버전에서도 이름·바이트가 같았던 기록은 같은 파일 — absorbed 그대로", async () => {
    const h = makeHarness();
    const first = await legacyIngestScanned(h, variant("same"), "same.pdf");
    const second = await legacyIngestScanned(h, variant("same"), "same.pdf");
    expect(h.store.getDocumentRecordPlacement(second.documentId)).toMatchObject({
      kind: "absorbed", ownerNodeId: first.nodeId, ownerDocumentId: first.documentId, ownerParseStatus: "needs_ocr",
    });
    expect(h.store.countNotOwnedRecordsByParseStatuses(OCR_AUTOMATIC_PARSE_STATUSES)).toEqual({ absorbed: 1, legacyMerged: 0 });
  });

  test("글자가 있는 문서가 같은 글의 기억에 합쳐진 것은 의도된 중복 제거 — absorbed 그대로", async () => {
    const h = makeHarness();
    const text = "회의록 본문 LEGACY_TEXT_DEDUPE";
    const memoryId = await h.store.addNode({ content: text });
    const doc = await recordTextDocument(h, text, "minutes.txt");
    expect(doc.absorbed).toBe(true);
    expect(doc.nodeId).toBe(memoryId);
    expect(h.store.getDocumentRecordPlacement(doc.documentId)).toMatchObject({
      kind: "absorbed", ownerNodeId: memoryId, ownerDocumentId: null,
    });
  });
});

describe("parse 상태가 없는 옛 기록(2026-07-01 이전 저장분)", () => {
  test("같은 글의 기억에 합쳐진 상태 없는 기록 — legacy_merged 가 아니라 상태 모름 absorbed, 중립 문구", async () => {
    const h = makeHarness();
    const memoryId = await h.store.addNode({ content: "old-notes.txt" });
    const doc = await legacyIngestScanned(h, new TextEncoder().encode("옛 글 파일의 바이트"), "old-notes.txt", null);
    expect(doc.nodeId).toBe(memoryId);
    expect(h.store.getDocumentRecordPlacement(doc.documentId)).toEqual({
      kind: "absorbed", ownerNodeId: memoryId, ownerDocumentId: null, ownerParseStatus: null, recordStatus: null, ownerInTrash: false,
    });
    const status = await statusOf(h, doc.documentId);
    expect(status.document.legacyMerged).toBeUndefined();
    const notice = status.document.absorbedInto!.notice;
    expect(notice).toContain(`같은 내용의 기억(노드 ${memoryId})에 합쳐져 있습니다`);
    expect(notice).toContain("처리 상태가 기록되지 않았습니다");
    expect(notice).not.toContain("읽힌 적이 없");
    expect(notice).not.toContain("결과를 함께");
    expect(notice).not.toContain("다시 올리");
  });

  test("다른 문서에 합쳐진 상태 없는 기록 — 그 문서를 가리키는 중립 문구", async () => {
    const h = makeHarness();
    const owner = await legacyIngestScanned(h, variant("old-owner"), "old.txt", null);
    const merged = await legacyIngestScanned(h, variant("old-other"), "old.txt", null);
    expect(merged.nodeId).toBe(owner.nodeId);
    expect(h.store.getDocumentRecordPlacement(merged.documentId)).toMatchObject({
      kind: "absorbed", ownerDocumentId: owner.documentId, recordStatus: null,
    });
    const notice = (await statusOf(h, merged.documentId)).document.absorbedInto!.notice;
    expect(notice).toContain(`다른 문서(${owner.documentId}, 노드 ${owner.nodeId})`);
    expect(notice).not.toContain("결과를 함께");
  });
});

describe("다시 올리면 자기 노드를 받는다", () => {
  test("(가) 이름만 같아 합쳐졌던 파일을 다시 올리면 새 대기 본문으로 따로 저장되고 글자 인식을 받는다", async () => {
    const h = makeHarness();
    const bytesB = variant("b");
    const first = await legacyIngestScanned(h, variant("a"), "same.pdf");
    await legacyIngestScanned(h, bytesB, "same.pdf");
    const again = await ingestFile(h, bytesB, "same.pdf");
    expect(again.absorbedInto).toBeNull();
    const ownNode = h.store.findDocumentNodeId(again.documentId);
    expect(ownNode).not.toBeNull();
    expect(ownNode).not.toBe(first.nodeId);
    expect(h.store.getDocumentRecordPlacement(again.documentId)).toEqual({ kind: "own", nodeId: ownNode! });
    expect(ocrCandidateIds(h)).toEqual([first.documentId, again.documentId].sort());
    expect((await applyOcr(h, again.documentId, "# 다시 올린 B 의 글")).status).toBe(200);
    expect((h.db.query("SELECT content FROM knowledge_nodes WHERE id = ?").get(ownNode!) as { content: string }).content)
      .toBe("# 다시 올린 B 의 글");
  });

  test("(나) 기억에 흡수됐던 스캔 문서를 다시 올리면 자기 문서 노드를 받는다", async () => {
    const h = makeHarness();
    const bytes = variant("memory");
    const memoryId = await h.store.addNode({ content: "report.pdf" });
    await legacyIngestScanned(h, bytes, "report.pdf");
    const again = await ingestFile(h, bytes, "report.pdf");
    expect(again.absorbedInto).toBeNull();
    const ownNode = h.store.findDocumentNodeId(again.documentId);
    expect(ownNode).not.toBeNull();
    expect(ownNode).not.toBe(memoryId);
    expect(ocrCandidateIds(h)).toEqual([again.documentId]);
  });
});
