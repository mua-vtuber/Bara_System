/**
 * ingest-document-placeholder-identity.test.ts — 글자 없는 문서(스캔 PDF·파싱 실패)의 대기 본문이 원본 파일마다 고유한가.
 *
 * 옛 흐름은 대기 본문을 파일 이름으로만 채워, 이름만 같은 다른 스캔본이 한 노드로 합쳐지고(두 번째 문서는 노드가
 * 없어 검색·글자 인식에서 사라짐) 파일 이름과 같은 글의 기억에도 흡수됐다. 이제 대기 본문 = 파일 이름 + 상태 문구 +
 * 원본 sha256 (document-placeholder-content.ts). 이름과 바이트가 모두 같을 때만 합치고, 합쳐진 기록은 OCR 후보에서
 * 빠지며 상태로 정직하게 알린다. 파일 이름이 본문 첫 줄이라 대기 중에도 글자 색인에 이름이 잡힌다. 옛 버전이 잘못
 * 합쳐 둔 기록은 ingest-document-legacy-merge.test.ts 가 본다.
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 임시 디렉터리의 실제 AssetStore + 실제 Hono 라우트 + 저장소의 실제 PDF fixture
 * + 대역 공급자 서버(서버 OCR 사이클). mock 0. 각 시험 끝에 첨부 파일 불변식을 본다.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
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
import {
  OCR_AUTOMATIC_PARSE_STATUSES,
  OCR_CANDIDATE_PARSE_STATUSES,
  readDocumentParseMetadata,
} from "../../memory/document-parse-status.ts";
import {
  DOCUMENT_PLACEHOLDER_SHA_PREFIX,
  DOCUMENT_PLACEHOLDER_STATUS_TEXT,
  buildDocumentPlaceholderContent,
} from "../../memory/document-placeholder-content.ts";
import { buildMemoryApi } from "../../server.ts";
import { getMemorySettings, type MemorySettings } from "../../settings/memory-settings.ts";
import { assetInvariantViolations } from "../../test-utils/asset-invariant.ts";
import { startProviderStandIn, type ProviderStandIn } from "../../test-utils/provider-stand-in.ts";
import { runDocumentOcrCycle } from "../document-ocr/cycle.ts";
import { DocumentOcrLedger } from "../document-ocr/ledger.ts";
import { createDocumentPageImageSource } from "../document-ocr/page-images.ts";
import { createDocumentOcrReader } from "../document-ocr/page-reader.ts";
import type { MemoryApiDeps } from "../types.ts";
import { toGraphNode } from "./graph-nodes-shared.ts";

const SOURCE = "dashboard:manual";
const ATTRIBUTION = { author: "테스터", userId: "u-placeholder-identity" };
const FIXTURES = join(import.meta.dir, "..", "document-ocr", "__fixtures__");
const SCANNED = readFileSync(join(FIXTURES, "scanned-2page.pdf"));
const CORRUPT = readFileSync(join(FIXTURES, "corrupt.pdf"));

let embedder: Bgem3Embedder;
let standIn: ProviderStandIn;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
  standIn = startProviderStandIn();
});
afterAll(() => standIn.stop());

interface Harness {
  app: Hono;
  db: Database;
  dir: string;
  store: SqliteMemoryStore;
  deps: MemoryApiDeps;
  settings: MemorySettings;
}
const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) {
    // 모든 시험이 끝난 상태에서 첨부 파일 불변식이 서야 한다(설계 17.17·17.18).
    expect(assetInvariantViolations(h.db, h.dir)).toEqual([]);
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "bara-placeholder-identity-"));
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const settings = getMemorySettings("/nonexistent-placeholder-identity-test", "/nonexistent-placeholder-identity-test.secrets.json");
  const deps: MemoryApiDeps = {
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(), assetStore: new AssetStore(dir),
    getSettings: () => settings,
  };
  const h = { app: buildMemoryApi(deps), db, dir, store, deps, settings };
  harnesses.push(h);
  return h;
}

interface IngestBody {
  ok: boolean;
  documentId: string;
  nodeIds: number[];
  absorbedInto: number | null;
  parse: { status: string };
}

async function ingestFile(h: Harness, bytes: Uint8Array, name: string, mimeType = "application/pdf"): Promise<IngestBody> {
  const res = await h.app.request("/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: SOURCE,
      content: { type: "auto", data: Buffer.from(bytes).toString("base64"), mimeType, originalName: name },
      attribution: ATTRIBUTION,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as IngestBody;
}

/** 같은 PDF 뒤에 주석 줄을 붙여 바이트만 다른 파일을 만든다(내용·쪽 수는 같음). */
function variant(base: Uint8Array, tag: string): Uint8Array {
  return Buffer.concat([base, Buffer.from(`\n%${tag}\n`)]);
}

function ownerNodeId(h: Harness, documentId: string): number | null {
  const row = h.db.query("SELECT node_id FROM document_record_owners WHERE document_id = ?").get(documentId) as
    | { node_id: number }
    | null;
  return row?.node_id ?? null;
}

function nodeContent(h: Harness, nodeId: number): string {
  return (h.db.query("SELECT content FROM knowledge_nodes WHERE id = ?").get(nodeId) as { content: string }).content;
}

function documentNodeCount(h: Harness): number {
  return (h.db.query("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE source_type = 'document'").get() as { n: number }).n;
}

function ocrCandidateIds(h: Harness): string[] {
  return h.store.listDocumentsByParseStatuses(OCR_CANDIDATE_PARSE_STATUSES, 100).map((d) => d.documentId).sort();
}

async function applyOcr(h: Harness, documentId: string, markdown: string, source: "manual" | "companion" = "manual", workerId?: string) {
  return h.app.request(`/api/documents/${encodeURIComponent(documentId)}/ocr-result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown, source, ...(workerId ? { workerId } : {}) }),
  });
}

describe("대기 본문 문구", () => {
  test("파일 이름 + 상태 문구 + 원본 sha 세 줄 — 종류마다 문구가 다르고, 정확한 꼴만 대기 본문으로 본다", () => {
    const sha = "a".repeat(64);
    const pending = buildDocumentPlaceholderContent("ocr_pending", "report.pdf", sha);
    const failed = buildDocumentPlaceholderContent("parse_failed", "report.pdf", sha);
    expect(pending).toBe(`report.pdf\n${DOCUMENT_PLACEHOLDER_STATUS_TEXT.ocr_pending}\n${DOCUMENT_PLACEHOLDER_SHA_PREFIX}${sha}`);
    expect(failed).toBe(`report.pdf\n${DOCUMENT_PLACEHOLDER_STATUS_TEXT.parse_failed}\n${DOCUMENT_PLACEHOLDER_SHA_PREFIX}${sha}`);
    expect(failed).not.toBe(pending);
    // 이름 속 줄 끝 문자(유니코드 줄 끝 포함)는 공백으로 — 본문은 어떤 줄 나눔 기준으로도 세 줄이다.
    for (const breaker of ["\n", "\r\n", "\v", "\f", "\u0085", "\u2028", "\u2029"]) {
      const content = buildDocumentPlaceholderContent("ocr_pending", `두 줄${breaker}이름.pdf`, sha);
      expect(content).toBe(`두 줄 이름.pdf\n${DOCUMENT_PLACEHOLDER_STATUS_TEXT.ocr_pending}\n${DOCUMENT_PLACEHOLDER_SHA_PREFIX}${sha}`);
      expect(content.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/).length).toBe(3);
    }
    expect(() => buildDocumentPlaceholderContent("ocr_pending", "report.pdf", "report.pdf")).toThrow("원본 sha256 이 올바르지 않음");
    expect(() => buildDocumentPlaceholderContent("ocr_pending", " \n ", sha)).toThrow("제목이 비어 있음");
  });
});

describe("스캔 PDF — 원본 파일마다 고유한 대기 본문", () => {
  test("이름이 같고 바이트가 다른 스캔본 둘 → 노드 둘, 각자 자기 노드가 주인", async () => {
    const h = makeHarness();
    const bytesA = variant(SCANNED, "a");
    const bytesB = variant(SCANNED, "b");
    const a = await ingestFile(h, bytesA, "same.pdf");
    const b = await ingestFile(h, bytesB, "same.pdf");
    expect(a.parse.status).toBe("needs_ocr");
    expect(b.parse.status).toBe("needs_ocr");
    expect(a.absorbedInto).toBeNull();
    expect(b.absorbedInto).toBeNull();
    const nodeA = h.store.findDocumentNodeId(a.documentId);
    const nodeB = h.store.findDocumentNodeId(b.documentId);
    expect(nodeA).not.toBeNull();
    expect(nodeB).not.toBeNull();
    expect(nodeA).not.toBe(nodeB);
    expect(ownerNodeId(h, a.documentId)).toBe(nodeA);
    expect(ownerNodeId(h, b.documentId)).toBe(nodeB);
    expect(nodeContent(h, nodeA!)).toBe(buildDocumentPlaceholderContent("ocr_pending", "same.pdf", assetSha256(bytesA)));
    expect(nodeContent(h, nodeB!)).toBe(buildDocumentPlaceholderContent("ocr_pending", "same.pdf", assetSha256(bytesB)));
    expect(ocrCandidateIds(h)).toEqual([a.documentId, b.documentId].sort());
    // 파일 이름이 본문 첫 줄 — 본문 앞부분을 쓰는 그래프 이름표도 파일 이름으로 시작한다.
    const node = (await h.store.getNode(nodeA!))!;
    expect(node.metadata.title).toBe("same.pdf");
    expect(h.store.getDocument(a.documentId)!.title).toBe("same.pdf");
    expect(toGraphNode(node).label.startsWith("same.pdf ")).toBe(true);
  });

  test("qa 재현 — 같은 이름 다른 바이트 둘 + 다른 이름 하나 → 문서 노드 셋, 모두 자기 노드를 찾는다", async () => {
    const h = makeHarness();
    const a = await ingestFile(h, SCANNED, "same.pdf");
    const b = await ingestFile(h, variant(SCANNED, "other"), "same.pdf");
    const c = await ingestFile(h, variant(SCANNED, "third"), "different.pdf");
    for (const r of [a, b, c]) {
      expect(r.ok).toBe(true);
      expect(r.absorbedInto).toBeNull();
      expect(h.store.findDocumentNodeId(r.documentId)).not.toBeNull();
    }
    expect(documentNodeCount(h)).toBe(3);
  });

  test("같은 바이트를 다른 이름으로 두 번 → 노드 둘, 각자 따로 글자 인식 결과를 받는다(받아들인 비용)", async () => {
    const h = makeHarness();
    const first = await ingestFile(h, SCANNED, "first.pdf");
    const second = await ingestFile(h, SCANNED, "second.pdf");
    expect(first.absorbedInto).toBeNull();
    expect(second.absorbedInto).toBeNull();
    const nodeFirst = h.store.findDocumentNodeId(first.documentId)!;
    const nodeSecond = h.store.findDocumentNodeId(second.documentId)!;
    expect(nodeFirst).not.toBe(nodeSecond);
    expect(documentNodeCount(h)).toBe(2);
    expect(ocrCandidateIds(h)).toEqual([first.documentId, second.documentId].sort());
    expect((await applyOcr(h, first.documentId, "# 첫 번째 이름의 결과")).status).toBe(200);
    expect((await applyOcr(h, second.documentId, "# 두 번째 이름의 결과")).status).toBe(200);
    expect(nodeContent(h, nodeFirst)).toBe("# 첫 번째 이름의 결과");
    expect(nodeContent(h, nodeSecond)).toBe("# 두 번째 이름의 결과");
  });

  test("같은 이름·같은 바이트로 두 번 → 노드 하나, 두 번째 기록은 합쳐져 후보에서 빠지고 상태로 정직하게 보인다", async () => {
    const h = makeHarness();
    const first = await ingestFile(h, SCANNED, "same.pdf");
    const second = await ingestFile(h, SCANNED, "same.pdf");
    const ownerNode = h.store.findDocumentNodeId(first.documentId)!;
    expect(first.absorbedInto).toBeNull();
    expect(second.absorbedInto).toBe(ownerNode);
    expect(second.nodeIds[0]).toBe(ownerNode);
    expect(documentNodeCount(h)).toBe(1);
    expect(h.store.findDocumentNodeId(second.documentId)).toBeNull();
    expect(ownerNodeId(h, second.documentId)).toBe(ownerNode);
    expect(h.store.getDocumentRecordPlacement(second.documentId)).toEqual({
      kind: "absorbed", ownerNodeId: ownerNode, ownerDocumentId: first.documentId, ownerParseStatus: "needs_ocr", recordStatus: "needs_ocr", ownerInTrash: false,
    });
    expect(h.store.getDocumentRecordPlacement(first.documentId)).toEqual({ kind: "own", nodeId: ownerNode });

    // OCR 후보(서버 OCR·컴패니언 목록·작업 가져가기)에서 빠진다 — 붙일 노드가 없는 기록이 영원히 남지 않게.
    expect(ocrCandidateIds(h)).toEqual([first.documentId]);
    expect(h.store.countNotOwnedRecordsByParseStatuses(OCR_AUTOMATIC_PARSE_STATUSES)).toEqual({ absorbed: 1, legacyMerged: 0 });
    const listed = (await (await h.app.request("/api/documents/ocr-candidates")).json()) as { candidates: Array<{ documentId: string }> };
    expect(listed.candidates.map((c) => c.documentId)).toEqual([first.documentId]);
    const claim1 = await h.app.request("/api/documents/ocr-jobs/claim", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workerId: "pc-a", leaseSeconds: 120 }),
    });
    expect(((await claim1.json()) as { job: { documentId: string } | null }).job?.documentId).toBe(first.documentId);
    const claim2 = await h.app.request("/api/documents/ocr-jobs/claim", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workerId: "pc-b", leaseSeconds: 120 }),
    });
    expect(((await claim2.json()) as { job: unknown }).job).toBeNull();

    // 상태 조회 — "삭제되었거나 휴지통" 이 아니라 같은 파일이라고, 주인 문서의 실제 상태(아직 결과 없음)와 함께 알린다.
    const status = await h.app.request(`/api/documents/${second.documentId}/status`);
    expect(status.status).toBe(200);
    const body = (await status.json()) as {
      document: { nodeId: number; absorbedInto: { nodeId: number; documentId: string | null; inTrash: boolean; notice: string } };
    };
    expect(body.document.nodeId).toBe(ownerNode);
    expect(body.document.absorbedInto).toMatchObject({ nodeId: ownerNode, documentId: first.documentId, inTrash: false });
    expect(body.document.absorbedInto.notice).toContain(first.documentId);
    expect(body.document.absorbedInto.notice).toContain("글자 인식을 마치면 그 결과를 함께 씁니다(아직 결과 없음)");

    // 합쳐진 기록에 결과를 붙이려 하면 붙일 곳을 알리는 409.
    const refused = await applyOcr(h, second.documentId, "# 붙이면 안 됨");
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain(`글자 인식은 그 문서(${first.documentId})에 하세요`);
    // 주인 문서에는 붙는다(작업 가져간 pc-a 로).
    const applied = await applyOcr(h, first.documentId, "# 주인 문서 OCR 결과", "companion", "pc-a");
    expect(applied.status).toBe(200);
    expect(nodeContent(h, ownerNode)).toBe("# 주인 문서 OCR 결과");
    // 주인 문서에 결과가 붙은 뒤에야 "결과를 함께 씁니다" 라고 말한다.
    const after = (await (await h.app.request(`/api/documents/${second.documentId}/status`)).json()) as typeof body;
    expect(after.document.absorbedInto.notice).toContain("그 문서의 결과를 함께 씁니다");
    expect(after.document.absorbedInto.notice).not.toContain("아직 결과 없음");
  });

  test("주인 문서의 글자 인식이 실패하면 — 합쳐진 기록은 결과를 함께 쓴다고 하지 않는다", async () => {
    const h = makeHarness();
    const first = await ingestFile(h, SCANNED, "same.pdf");
    const second = await ingestFile(h, SCANNED, "same.pdf");
    const failed = await h.app.request(`/api/documents/${first.documentId}/ocr-failure`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ errorMessage: "1쪽: 자동 재시도 멈춤", source: "companion" }),
    });
    expect(failed.status).toBe(200);
    const status = (await (await h.app.request(`/api/documents/${second.documentId}/status`)).json()) as {
      document: { absorbedInto: { notice: string } };
    };
    expect(status.document.absorbedInto.notice).toContain("그 문서의 글자 인식이 실패해 아직 함께 쓸 결과가 없습니다");
    expect(status.document.absorbedInto.notice).not.toContain("결과를 함께 씁니다");
  });

  test("공백뿐인 파일 이름 — 실패하지 않고 \"(제목 없음)\" 으로 저장한다", async () => {
    const h = makeHarness();
    const doc = await ingestFile(h, variant(SCANNED, "blank-name"), "   ");
    const nodeId = h.store.findDocumentNodeId(doc.documentId)!;
    expect(h.store.getDocument(doc.documentId)!.title).toBe("(제목 없음)");
    expect(nodeContent(h, nodeId).split("\n")[0]).toBe("(제목 없음)");
    const broken = await ingestFile(h, variant(CORRUPT, "blank-name"), " \t ");
    expect(h.store.getDocument(broken.documentId)!.title).toBe("(파싱 실패 문서)");
  });

  test("주인 노드가 휴지통에 가면 — 주인 기록은 휴지통, 합쳐진 기록은 여전히 합쳐짐(휴지통 표시와 함께)", async () => {
    const h = makeHarness();
    const first = await ingestFile(h, SCANNED, "same.pdf");
    const second = await ingestFile(h, SCANNED, "same.pdf");
    const ownerNode = h.store.findDocumentNodeId(first.documentId)!;
    await h.store.trashNodes([ownerNode], "cascade");
    expect(h.store.getDocumentRecordPlacement(first.documentId)).toEqual({ kind: "trashed", nodeId: ownerNode });
    expect(h.store.getDocumentRecordPlacement(second.documentId)).toEqual({
      kind: "absorbed", ownerNodeId: ownerNode, ownerDocumentId: first.documentId, ownerParseStatus: "needs_ocr", recordStatus: "needs_ocr", ownerInTrash: true,
    });
    expect((await h.app.request(`/api/documents/${first.documentId}/status`)).status).toBe(410);
    const status = await h.app.request(`/api/documents/${second.documentId}/status`);
    expect(status.status).toBe(200);
    const body = (await status.json()) as { document: { absorbedInto: { inTrash: boolean; notice: string } } };
    expect(body.document.absorbedInto.inTrash).toBe(true);
    expect(body.document.absorbedInto.notice).toContain("휴지통");
    expect(ocrCandidateIds(h)).toEqual([first.documentId]);
  });

  test("파일 이름과 같은 글의 기억이 있어도 스캔 문서는 자기 문서 노드를 받는다", async () => {
    const h = makeHarness();
    const memoryId = await h.store.addNode({ content: "report.pdf" });
    const doc = await ingestFile(h, SCANNED, "report.pdf");
    expect(doc.absorbedInto).toBeNull();
    const nodeId = h.store.findDocumentNodeId(doc.documentId);
    expect(nodeId).not.toBeNull();
    expect(nodeId).not.toBe(memoryId);
    expect(ownerNodeId(h, doc.documentId)).toBe(nodeId);
    expect(nodeContent(h, memoryId)).toBe("report.pdf");
  });

  // 글자 색인 수준 확인이다. POST /search 는 글자 인식이 안 끝난 문서를 일부러 결과에서 뺀다
  // (search-enrich.ts filterOcrIncompleteResults) — 그 설계는 이 수정과 무관하게 그대로다.
  test("대기 중에도 파일 이름이 글자 색인에 잡힌다(본문 첫 줄)", async () => {
    const h = makeHarness();
    const doc = await ingestFile(h, SCANNED, "분기보고서초안.pdf");
    const nodeId = h.store.findDocumentNodeId(doc.documentId)!;
    const hits = await h.store.searchByFts("분기보고서초안", 10);
    expect(hits.map((hit) => hit.nodeId)).toContain(nodeId);
  });
});

describe("파싱 실패 — 같은 규칙", () => {
  test("이름이 같고 바이트가 다른 깨진 PDF 둘 → 노드 둘, 파싱 실패 문구", async () => {
    const h = makeHarness();
    const bytesA = variant(CORRUPT, "a");
    const bytesB = variant(CORRUPT, "b");
    const a = await ingestFile(h, bytesA, "broken.pdf");
    const b = await ingestFile(h, bytesB, "broken.pdf");
    expect(a.parse.status).toBe("parse_failed");
    expect(b.parse.status).toBe("parse_failed");
    const nodeA = h.store.findDocumentNodeId(a.documentId);
    const nodeB = h.store.findDocumentNodeId(b.documentId);
    expect(nodeA).not.toBeNull();
    expect(nodeB).not.toBeNull();
    expect(nodeA).not.toBe(nodeB);
    expect(nodeContent(h, nodeA!)).toBe(buildDocumentPlaceholderContent("parse_failed", "broken.pdf", assetSha256(bytesA)));
    expect(nodeContent(h, nodeB!)).toBe(buildDocumentPlaceholderContent("parse_failed", "broken.pdf", assetSha256(bytesB)));
    expect(toGraphNode((await h.store.getNode(nodeB!))!).label.startsWith("broken.pdf ")).toBe(true);
    // 각자 결과를 받는다 — 붙이면 대기 문구가 사라진다.
    expect((await applyOcr(h, a.documentId, "깨진 문서 A 를 사람이 옮겨 적음")).status).toBe(200);
    expect((await applyOcr(h, b.documentId, "깨진 문서 B 를 사람이 옮겨 적음")).status).toBe(200);
    expect(nodeContent(h, nodeA!)).toBe("깨진 문서 A 를 사람이 옮겨 적음");
    expect(nodeContent(h, nodeB!)).toBe("깨진 문서 B 를 사람이 옮겨 적음");
  });
});

describe("회귀 — 글자 있는 문서의 본문 중복 제거는 그대로", () => {
  test("같은 글의 .txt 둘 → 노드 하나 기록 둘, 두 번째는 합쳐졌다고 응답", async () => {
    const h = makeHarness();
    const text = new TextEncoder().encode("회의록 본문 — 같은 글이 담긴 두 파일 PLACEHOLDER_REGRESSION");
    const a = await ingestFile(h, text, "a.txt", "text/plain");
    const b = await ingestFile(h, text, "b.txt", "text/plain");
    expect(a.documentId).not.toBe(b.documentId);
    expect(a.absorbedInto).toBeNull();
    expect(b.absorbedInto).toBe(a.nodeIds[0]!);
    expect(b.nodeIds[0]).toBe(a.nodeIds[0]);
    expect(documentNodeCount(h)).toBe(1);
    expect(ownerNodeId(h, a.documentId)).toBe(a.nodeIds[0]!);
    expect(ownerNodeId(h, b.documentId)).toBe(a.nodeIds[0]!);
  });
});

describe("글자 인식 결과 적용 — 나뉜 문서마다 따로, 대기 문구가 사라진다", () => {
  test("수동 붙이기 — 이름 같은 두 스캔본 각각", async () => {
    const h = makeHarness();
    const a = await ingestFile(h, variant(SCANNED, "a"), "same.pdf");
    const b = await ingestFile(h, variant(SCANNED, "b"), "same.pdf");
    expect((await applyOcr(h, a.documentId, "# A 문서 글")).status).toBe(200);
    expect((await applyOcr(h, b.documentId, "# B 문서 글")).status).toBe(200);
    const nodeA = h.store.findDocumentNodeId(a.documentId)!;
    const nodeB = h.store.findDocumentNodeId(b.documentId)!;
    expect(nodeContent(h, nodeA)).toBe("# A 문서 글");
    expect(nodeContent(h, nodeB)).toBe("# B 문서 글");
    for (const id of [nodeA, nodeB]) {
      expect(nodeContent(h, id)).not.toContain(DOCUMENT_PLACEHOLDER_STATUS_TEXT.ocr_pending);
      expect(nodeContent(h, id)).not.toContain(DOCUMENT_PLACEHOLDER_SHA_PREFIX);
    }
    expect(readDocumentParseMetadata(h.store.getDocument(a.documentId)!.sourceMetadata)?.status).toBe("ocr_succeeded");
    expect(readDocumentParseMetadata(h.store.getDocument(b.documentId)!.sourceMetadata)?.status).toBe("ocr_succeeded");
  });

  test("서버 OCR 사이클 — 두 스캔본을 각자 읽어 적용, 합쳐진 기록은 읽지 않는다", async () => {
    const h = makeHarness();
    const ocr = h.settings.documents.ocr;
    ocr.mode = "api";
    ocr.api.provider = "openai_compatible";
    ocr.api.openaiBaseUrl = `${standIn.origin}/v1`;
    ocr.api.openaiModel = "vlm-test";
    ocr.schedule.timeoutMs = 5000;
    ocr.schedule.leaseSeconds = 120;
    ocr.schedule.batchSize = 5;
    ocr.pageImage.maxEdgePx = 512;
    const a = await ingestFile(h, variant(SCANNED, "a"), "same.pdf");
    const b = await ingestFile(h, variant(SCANNED, "b"), "same.pdf");
    const absorbed = await ingestFile(h, variant(SCANNED, "a"), "same.pdf");
    expect(absorbed.absorbedInto).toBe(h.store.findDocumentNodeId(a.documentId));
    standIn.requests.length = 0;
    let n = 0;
    standIn.reply = () => ({
      body: { choices: [{ message: { content: `쪽 글 ${(n += 1)}` }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    });
    const ledger = new DocumentOcrLedger(h.db);
    const run = (documentId?: string) => runDocumentOcrCycle(
      { api: h.deps, ledger, settings: ocr, pageImages: createDocumentPageImageSource(), createReader: (s) => createDocumentOcrReader(s) },
      documentId ? { documentId } : {},
    );
    const summary = await run();
    expect(summary).toMatchObject({ stoppedBy: "done", documentsApplied: 2, documentsFailed: 0, pageCalls: 4 });
    for (const doc of [a, b]) {
      const nodeId = h.store.findDocumentNodeId(doc.documentId)!;
      expect(readDocumentParseMetadata(h.store.getDocument(doc.documentId)!.sourceMetadata)?.status).toBe("ocr_succeeded");
      expect(nodeContent(h, nodeId)).not.toContain(DOCUMENT_PLACEHOLDER_SHA_PREFIX);
      expect(nodeContent(h, nodeId)).toContain("쪽 글");
    }
    // 합쳐진 기록 하나만 집어 사이클을 돌려도 공급자를 부르지 않는다(사용자 경로의 409 사유는 runtime.test.ts 가 본다).
    const single = await run(absorbed.documentId);
    expect(single).toMatchObject({ stoppedBy: "no_candidates", pageCalls: 0 });
    expect(readDocumentParseMetadata(h.store.getDocument(absorbed.documentId)!.sourceMetadata)?.status).toBe("needs_ocr");
  });
});
