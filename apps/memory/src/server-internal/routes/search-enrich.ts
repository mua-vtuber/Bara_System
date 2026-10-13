/**
 * routes/search-enrich.ts — 검색 결과 표시용 조립(buildEnriched) + OCR 미완 문서 거름.
 *
 * routes/search.ts 를 책임 경계로 분할하며 옮겨 온 모듈이다(P3 G5-a —
 * docs/decisions/2026-07-03-structure-cleanup-spec.md). 한 노드를 SearchEnrichedResult
 * 로 조립하는 단일 출처와, OCR 미완(스캔 PDF 등) 문서·청크를 결과에서 거르는 헬퍼를
 * 담는다. RRF 코어(rrf.ts / search-tuning.ts / retriever.ts)는 호출조차 하지 않는다.
 */

import type { MemoryNode } from "../../memory/types.ts";
import type { RetrievalResult } from "../../memory/retriever.ts";
import type { SqliteMemoryStore } from "../../db/store.ts";
import type {
  SearchEnrichedResult,
  SearchDocumentRef,
} from "../types.ts";
import type { AncillaryVisibility } from "./search-ancillary-visibility.ts";

const OCR_INCOMPLETE_STATUSES = new Set([
  "needs_ocr",
  "password_required",
  "parse_failed",
  "ocr_failed",
]);

/**
 * 한 노드를 검색 응답용 SearchEnrichedResult 로 조립한다(11b T7 image_asset 표시 통로).
 *
 * 두 호출처가 같은 양식을 공유한다:
 *   1. RRF 결과 노드 각각(registerSearchRoutes 의 results.map — score/sources/components
 *      는 RetrievalResult 에서).
 *   2. 11e G2-2 캡션 치환(dedupChildToParent — 캡션이 가리키는 부모 image_asset 노드를
 *      캡션의 score/sources/components 를 승계해 조립).
 *
 * sourceType='image_asset' 일 때만 assetSha256/captions/taggedWith 를 채우고 그 외는 빈 칸.
 * neighbors/documentRef 는 default(빈 배열 / null) — image_caption·image_asset 은
 * document_chunk 가 아니라 neighbor-chunks 후처리 대상이 아니다.
 *
 * 정리A — 종류 코드명(displayKind)은 호출처가 한 쿼리(getNodeKinds) bulk 결과 Map 에서
 * displayKindName 으로 바꿔 넘긴다. buildEnriched 안에서 노드마다 getNodeKind 를 부르던
 * N+1 을 없앤다(결과 수 최대 50 만큼 쿼리가 늘던 것을 한 번으로 모은다). 종류 링크 없는
 * 노드는 null 을 받아 kind 칸이 null 로 남는다(가짜 0·빈 문자열 금지).
 *
 * WP-B1-03 — 개념 펼침과 이미지 캡션은 다른 노드에서 오는 부가 출력이라 응답의 판정기
 * (ancillary)가 항목 출처로 거른다. taggedWith 는 이 이미지 자신의 분류라 그대로 싣는다.
 */
export async function buildEnriched(
  store: SqliteMemoryStore,
  node: MemoryNode,
  score: number,
  sources: string[],
  components: Record<string, number>,
  displayKind: string | null,
  ancillary: AncillaryVisibility,
): Promise<SearchEnrichedResult> {
  const isImageAsset = node.sourceType === "image_asset";
  const sha = node.metadata?.asset_sha256;
  const assetSha256 =
    isImageAsset && typeof sha === "string" && sha.length > 0 ? sha : null;
  return {
    id: node.id,
    content: node.content,
    memoryType: node.memoryType,
    importance: node.importance,
    confidence: node.confidence,
    score,
    sources, // 'concept' 가 개념 채널 매칭 시 자연 등장(1.1a T5)
    components,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    lastAccessedAt: node.lastAccessedAt,
    eventAt: node.eventAt,
    eventUntil: node.eventUntil,
    kind: displayKind,
    concepts: await ancillary.expandConcepts(node.id), // 1.1a 펼침(이웃은 엣지 출처로 판정)
    neighbors: [] as SearchEnrichedResult["neighbors"], // 14b T3 default(후처리가 채움)
    documentRef: null as SearchDocumentRef | null, // 14b T3 default
    sourceType: node.sourceType, // 11b T7 — 렌더 분기 키
    assetSha256, // 11b T7 — image_asset 한정(그 외 null)
    captions: isImageAsset
      ? ancillary.pickImageCaptions(node.id, store.getImageCaptionCandidates(node.id))
      : { user: null, auto: null }, // 11b T7 — 허용된 가장 최신 캡션(캡션 노드 출처 판정)
    taggedWith: isImageAsset
      ? store.getImageTaggedWith(node.id)
      : [], // 11b T7 — role='classification' 한정(일반 노드 무해)
    revision: { superseded: false, supersedes: false }, // Phase 7 ④ default(후처리가 batch 로 채움)
    chunkSummary: null, // Phase 7 둘째 단계 Task 8 default(withSummaries 후처리가 채움)
    relationSummaries: [], // Phase 7 둘째 단계 Task 8 default(withSummaries 후처리가 채움)
    conflicts: [], // WP-B1-10 default(applyRevisionFlags 옆 후처리가 batch 로 채움)
  };
}

function documentIdForSearchNode(node: MemoryNode): string | null {
  if (node.sourceType === "document") {
    const documentId = node.metadata.documentId;
    return typeof documentId === "string" && documentId.length > 0
      ? documentId
      : null;
  }
  if (node.sourceType === "document_chunk") {
    const parentId = node.metadata.parentId;
    return typeof parentId === "string" && parentId.length > 0 ? parentId : null;
  }
  return null;
}

function isOcrIncompleteSearchNode(
  store: SqliteMemoryStore,
  node: MemoryNode,
): boolean {
  const documentId = documentIdForSearchNode(node);
  if (!documentId) return false;
  const doc = store.getDocument(documentId);
  const parse = doc?.sourceMetadata.parse;
  if (!parse || typeof parse !== "object") return false;
  const status = (parse as Record<string, unknown>).status;
  return typeof status === "string" && OCR_INCOMPLETE_STATUSES.has(status);
}

export function filterOcrIncompleteResults(
  store: SqliteMemoryStore,
  results: RetrievalResult[],
): RetrievalResult[] {
  return results.filter((result) => !isOcrIncompleteSearchNode(store, result.node));
}
