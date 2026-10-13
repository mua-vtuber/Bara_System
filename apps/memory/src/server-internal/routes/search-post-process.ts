/**
 * routes/search-post-process.ts — POST /search 의 RRF 합산 *후* 표시 후처리 네 단계.
 *
 * routes/search.ts 를 책임 경계로 분할하며 옮겨 온 모듈이다(P3 G5-a —
 * docs/decisions/2026-07-03-structure-cleanup-spec.md). 인접 청크 묶기·자식→부모
 * 치환 dedup·revision 플래그·요약 채널 네 후처리를 담는다. 전부 enriched(표시용)
 * 칸만 덮어 채우거나 dedup 으로 항목을 합칠 뿐 results 배열·순서·점수·count 산출
 * 로직은 옛 파일 그대로다(불변식). RRF 코어(rrf.ts / scoring.ts / search-tuning.ts /
 * retriever.ts)는 호출조차 하지 않는다. 단계 순서 배선은 search.ts 파사드가 진다.
 */

import type { MemoryNode } from "../../memory/types.ts";
import type { RetrievalResult } from "../../memory/retriever.ts";
import type { SqliteMemoryStore } from "../../db/store.ts";
import type { SearchEnrichedResult } from "../types.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import { readDocumentChunkMetadata } from "../../memory/document-chunk-metadata.ts";
import { gateRelationEdge } from "../../memory/cleanup-deep-pass/summary-gates.ts";
import { explicitDisplayKind } from "../../memory/entity-type-classifier.ts";
import { listOpenConflicts, listOriginMarks } from "../../memory/open-conflicts.ts";
import { buildEnriched } from "./search-enrich.ts";
import type { AncillaryVisibility } from "./search-ancillary-visibility.ts";

/**
 * 인접 청크 enrich 대상 상위 결과 수(14b T3 / 14.5). RRF 결과 상위 N개
 * document_chunk 항목에만 같은 문서 인접 청크 + 문서 ref 를 조립한다 — 응답 크기
 * 가드(전 결과에 인접을 붙이면 페이로드가 비대해지고 getNeighborChunks/getDocument
 * 조회가 결과 수만큼 늘어난다). 사용자가 보는 검색 결과 상단 몇 건에 맥락을 더하는
 * 목적이라 limit 보다 작은 고정 상한이 자연스럽다(결정 2 = default ON / 토글 없음).
 */
const NEIGHBOR_ENRICH_TOP_K = 5;

/**
 * getNeighborChunks 조회 반경(중심 앞뒤 각 NEIGHBOR_RADIUS 개). 실제 표시될
 * 인접 수는 maxContextTokens 한도가 다시 자르므로(neighbor-chunks 의 greedy stop)
 * 반경은 후보 상한일 뿐이다. 앞뒤 합쳐 최대 4개를 후보로 끌어와 토큰 한도가
 * 가까운 청크부터 채택하게 둔다.
 */
const NEIGHBOR_RADIUS = 2;

/**
 * 14b T3 인접 청크 + 문서 ref 후처리 (RRF 합산 *후* / 캐시 밖).
 * 캐시는 *리랭커 이전* RRF 결과만 보관한다 — 인접 청크는 retriever/리랭커 단계
 * 뒤에 오는 라우트 후처리라 캐시에 넣지 않고 매번 조립한다(db_revision 으로
 * 캐시가 stale 되는 상황과 분리 — 인접 청크는 현재 store 상태를 직접 읽는다).
 *
 * 이 단계는 enriched 의 *기존 항목에 neighbors/documentRef 두 칸을 덮어 채울 뿐*
 * results 배열·순서·점수·count 는 건드리지 않는다(불변식). RRF 코어(rrf.ts /
 * search-tuning.ts / retriever.ts)는 호출조차 하지 않는다.
 *
 * maxContextTokens 는 settings.chunking 에서 흘러 들어온다(T2). settings 미주입
 * (buildMemoryApi 직호출 / 테스트)이면 파사드가 DEFAULT_MAX_CONTEXT_TOKENS(2000)
 * 로 degrade 한 값을 넘긴다.
 *
 * WP-B1-03 — 인접 청크는 결과가 아닌 다른 노드라 응답의 판정기(ancillary)가 id 로 거른
 * 뒤 묶는다. 허용되지 않은 인접 청크만 빠지고 나머지 인접은 그대로 붙는다.
 */
export function applyNeighborContext(
  store: SqliteMemoryStore,
  results: RetrievalResult[],
  enriched: SearchEnrichedResult[],
  maxContextTokens: number,
  ancillary: AncillaryVisibility,
): void {
  let enrichedCount = 0;
  for (let i = 0; i < results.length && enrichedCount < NEIGHBOR_ENRICH_TOP_K; i++) {
    const node = results[i]!.node;
    if (node.sourceType !== "document_chunk") continue;

    const parentId = node.metadata.parentId;
    const chunkIndex = node.metadata.chunkIndex;
    // document_chunk 인데 parentId·chunkIndex 가 온전치 않으면 묶을 자료가 없다 —
    // default(빈 neighbors / null documentRef) 그대로 둔다(정직한 빈 상태).
    if (typeof parentId !== "string" || parentId.length === 0) continue;
    if (typeof chunkIndex !== "number" || !Number.isInteger(chunkIndex)) continue;

    enrichedCount++;

    // 같은 문서의 인접 청크 후보(중심 제외) → 허용된 후보만 토큰 한도 안에서 greedy 묶기.
    const neighborCandidates = store.getNeighborChunks(
      parentId,
      chunkIndex,
      NEIGHBOR_RADIUS,
    );
    const assembled = ancillary.assembleNeighbors(
      node.id,
      { content: node.content, parentId, chunkIndex },
      neighborCandidates,
      maxContextTokens,
    );

    // 문서 제목·전체 청크 수는 documents row 에서 채운다. 없으면 null(정직).
    const doc = store.getDocument(parentId);
    const centerChunkMetadata = readDocumentChunkMetadata(node.metadata);
    enriched[i]!.neighbors = assembled.neighbors;
    enriched[i]!.documentRef = {
      parentId,
      centerIndex: chunkIndex,
      title: doc ? doc.title : null,
      totalChunks: doc ? doc.chunkCount : null,
      ...centerChunkMetadata,
    };
  }
}

/**
 * 자식 노드 → 부모 원본 치환 + dedup (enriched 후처리 / 캐시 밖).
 * 자식 종류 노드가 검색에 들면 사용자에게는 자식 글이 아니라 그 부모 원본을 대표로
 * 보여준다(spec §5 / D8 — 같은 글이 검색 결과를 도배하지 않게). 두 자식 종류를 같은
 * 치환·dedup 통로로 합류시킨다:
 *   - image_caption: parent_of 엣지로 부모 image_asset 을 역추적해 치환(11e G2-2 / D4).
 *   - llm_extract:   merged_into 엣지로 부모 원본(auto_capture·document 등)을 역추적해
 *                    치환(입력 통로 통합 Task 4 / Task 3 확정 relation).
 * 같은 부모가 자식 경로와 부모 직접 경로 둘 다로 결과에 들면 한 번만 표시(dedup)하고,
 * 점수는 둘 중 높은 값을 부모가 승계한다(점수 순서 = 첫 등장 슬롯 보존 / dedup 으로
 * 항목이 줄 뿐 순서는 안 뒤집힌다). 고아 자식(부모 엣지 없음·부모가 표시 가능 원본
 * 아님)은 자식 노드 그대로 둔다 — 가짜 부모를 만들지 않는다(No-fallback).
 *
 * 이 단계는 enriched(표시용)만 변환하고 results(RetrievalResult)·RRF 코어·리랭커는
 * 호출조차 하지 않는다(neighbor-chunks 후처리 선례 정합 / 불변식). context 조립은
 * 파사드가 results 를 그대로 쓰므로 이 치환과 무관하다.
 *
 * 부모 노드 조회는 자식이 실제 결과에 들었을 때만 발생하므로 N+1 부담이 작다
 * (limit 최대 50 / 그중 자식 항목 한정). parentNodeById 캐시로 같은 부모 중복 getNode 회피.
 *
 * WP-B1-03 — 부모는 결과가 아닌 다른 노드라, 이번 응답의 조회 규칙에서 허용된 부모로만
 * 치환한다(ancillary.substitutesParent). 허용되지 않은 부모면 자식을 그대로 둔다.
 */
export async function dedupChildToParent(
  store: SqliteMemoryStore,
  enriched: SearchEnrichedResult[],
  ancillary: AncillaryVisibility,
): Promise<SearchEnrichedResult[]> {
  const dedupedResults: SearchEnrichedResult[] = [];
  // 대표 부모 노드 id → dedupedResults 안 슬롯 인덱스. 노드 id 는 종류와 무관하게
  // 전역 유일하므로(rowid) 부모 직접 등장과 자식 치환을 같은 키 공간에 둬 중복을 한
  // 슬롯으로 합친다.
  const slotByParentId = new Map<number, number>();
  const parentNodeById = new Map<number, MemoryNode | null>();
  for (const item of enriched) {
    // 이 항목이 대표하는 부모 노드 id 를 정한다.
    //  - image_asset / 원본 글·문서 노드: 자기 자신 id(dedup 키로만 쓰고 치환 없음).
    //  - image_caption 노드: parent_of 엣지로 역추적한 부모 image_asset id.
    //  - llm_extract 노드: merged_into 엣지로 역추적한 부모 원본 id.
    //  - 고아 자식: undefined — dedup 대상 아님, 자식 그대로 통과.
    let parentId: number | undefined;
    let displayItem: SearchEnrichedResult = item;
    if (
      item.sourceType === "image_asset" ||
      item.sourceType === "auto_capture" ||
      item.sourceType === "document" ||
      item.sourceType === "user_explicit"
    ) {
      // 부모 직접 등장(원본 종류) — 자기 id 로 dedup. 같은 원본이 자식 치환
      // 경로(캡션·atomic 추출)로도 결과에 들면 한 슬롯으로 합친다. 자식 경로만
      // 등장하고 원본이 직접 안 떠도 자식이 같은 키로 dedup 되므로 무해하다.
      parentId = item.id;
    } else if (
      item.sourceType === "image_caption" ||
      item.sourceType === "llm_extract"
    ) {
      const resolved =
        item.sourceType === "image_caption"
          ? store.getImageAssetParentOfCaption(item.id)
          : store.getRawParentOfExtract(item.id);
      // 허용되지 않은 부모(다른 scope·비활성) — 치환하지 않고 자식을 그대로 둔다(기록됨).
      if (resolved !== null && ancillary.substitutesParent(item.id, resolved)) {
        // 부모 노드를 한 번만 조회해 캐시(같은 부모를 둘 이상 자식이 가리킬 때 재사용).
        let parentNode = parentNodeById.get(resolved);
        if (parentNode === undefined) {
          parentNode = await store.getNode(resolved);
          parentNodeById.set(resolved, parentNode);
        }
        if (parentNode) {
          // 부모 원본을 자식의 점수/sources/components 를 승계해 조립(치환). 부모 종류 배지는
          // 부모 본문(parentNode.content)이 콜론으로 명시됐을 때만(explicitDisplayKind)
          // 한국어 표시명으로 바꾼다(2026-06-28 "종류" 허브 버그 수정·spec §4.3 + 2026-07-06
          // 평문 자동 추론 범위 조이기 Task 3·P-2 — 결과 노드 배지와 같은 단일 출처 통로).
          // 부모 노드는 이미 손에 있어 추가 조회 0(explicitDisplayKind 순수 함수 조합).
          // 본문에 종류 신호 없거나 평문 어휘 경계(seed)면 null(가짜 0 금지).
          const parentDisplayKind = explicitDisplayKind(parentNode.content);
          displayItem = await buildEnriched(
            store,
            parentNode,
            item.score,
            item.sources,
            item.components,
            parentDisplayKind,
            ancillary,
          );
          parentId = resolved;
        }
        // parentNode 가 null(데이터 이상) — 자식 그대로 둔다(고아 graceful).
      }
      // resolved null(고아 자식)·허용되지 않은 부모 — parentId 미지정 → 자식 노드 그대로 통과.
    }

    if (parentId === undefined) {
      // dedup 대상 아님(원본 글·문서·고아 자식) — 그대로 추가.
      dedupedResults.push(displayItem);
      continue;
    }

    const existingSlot = slotByParentId.get(parentId);
    if (existingSlot === undefined) {
      // 이 부모 첫 등장 — 슬롯 확보(점수 순서상 첫 등장이 최고 점수 자리).
      slotByParentId.set(parentId, dedupedResults.length);
      dedupedResults.push(displayItem);
    } else {
      // 같은 부모 재등장(자식 경로 + 부모 직접 경로) — 슬롯 안 더한다(dedup).
      // 점수만 둘 중 높은 값으로 승계(순서는 첫 등장 슬롯 고정).
      const slot = dedupedResults[existingSlot]!;
      if (displayItem.score > slot.score) {
        slot.score = displayItem.score;
      }
    }
  }
  return dedupedResults;
}

/**
 * Phase 7 ④ Task 7 revision 양방향 플래그 (enriched 후처리 / 캐시 밖).
 * 검색 결과에 *남는* superseded 노드에 "어느 쪽인지"만 표시한다(숨기지 않음 —
 * SUPERSEDE_PENALTY 0.5 감점은 retriever 단계에서 이미 적용됐다 / 동작 보존).
 *   - superseded: 이 노드가 다른 노드에 덮인 옛 버전(supersedes 엣지 target 측, "바뀜").
 *   - supersedes: 이 노드가 다른 노드를 덮은 새 버전(supersedes 엣지 source 측, "갱신함").
 * 표시되는 최종 노드 id(dedupedResults — 자식→부모 치환·dedup 까지 끝난 결과) 전체를
 * 두 번의 batch 조회로 판별해 N+1 을 피한다. 이 단계는 dedupedResults 각 항목의
 * revision 칸만 덮어 채울 뿐 배열·순서·점수·count 를 건드리지 않는다(불변식).
 * RRF 코어(rrf.ts / search-tuning.ts / retriever.ts)는 호출조차 하지 않는다.
 */
export async function applyRevisionFlags(
  store: SqliteMemoryStore,
  dedupedResults: SearchEnrichedResult[],
): Promise<void> {
  if (dedupedResults.length > 0) {
    const displayedIds = dedupedResults.map((r) => r.id);
    const [supersededIds, supersedingIds] = await Promise.all([
      store.getSupersededNodeIds(displayedIds),
      store.getSupersedingNodeIds(displayedIds),
    ]);
    for (const item of dedupedResults) {
      item.revision = {
        superseded: supersededIds.has(item.id),
        supersedes: supersedingIds.has(item.id),
      };
    }
  }
}

/**
 * WP-B1-10(SL-3 표시) — 표시되는 최종 노드 각각에 아직 해소되지 않은 충돌 상대 id를 붙인다.
 * 한 번의 일괄 질의(listOpenConflicts)로 dedupedResults 전체를 조회해 N+1을 피한다. 표시되는
 * 것은 상대 id뿐이며, 상대가 disputed라도 그 본문은 이 응답에 싣지 않는다(get_memory(id)로
 * 직접 조회해야 본문을 본다 — 기존 계약 그대로).
 */
export function applyOpenConflicts(
  store: SqliteMemoryStore,
  dedupedResults: SearchEnrichedResult[],
): void {
  if (dedupedResults.length === 0) return;
  const db = store.getRawDb();
  const ids = dedupedResults.map((r) => r.id);
  const openConflicts = listOpenConflicts(db, ids);
  // WP-B1-10R — 원문(auto_capture 등)에 그 원문에서 추출된 자식의 열린 충돌·대체된
  // 주장을 함께 싣는다(사용자 결정 2026-09-29 1안). 결과 id 전체를 한 번의 일괄 질의로
  // 조회해 N+1을 피한다 — 자식이 없는 원문·비원문 결과는 이 맵에 키가 없다.
  const originMarks = listOriginMarks(db, ids);
  for (const item of dedupedResults) {
    item.conflicts = openConflicts.get(item.id) ?? [];
    const marks = originMarks.get(item.id);
    if (marks) item.originMarks = marks;
  }
}

/**
 * Phase 7 둘째 단계 Task 8 — 요약 검색 채널 후처리 (RRF 합산 *후* / 캐시 밖).
 * 요약 텍스트를 검색 표시에 합류시킨다 — 14b 인접 청크와 같은 "enriched 칸 덮기"
 * 방식이다. 이 단계는 dedupedResults 각 항목의 chunkSummary·relationSummaries 두
 * 표시 칸만 덮어 채울 뿐 배열·순서·점수·count 를 건드리지 않는다(불변식). RRF
 * 코어(rrf.ts / scoring.ts / search-tuning.ts / retriever.ts)는 호출조차 하지
 * 않는다. 캐시 키에도 withSummaries 를 안 넣었으므로(buildCacheKey 미변경) 같은
 * 검색은 토글 on/off 와 무관하게 같은 캐시를 공유한다.
 *
 * 토글 = body.withSummaries(boolean)면 그 값, 부재면 settings 의
 * searchChannelDefault 를 따른다(settings 미주입 = 테스트 직호출이면 OFF — 검색은
 * 요약 없이도 그대로 작동하는 graceful). 관계 엣지 자체는 Task 2 가 graph-hop 으로
 * 이미 자동 합류했고(retriever 0줄), 여기서는 사람이 읽는 요약 문장만 표시한다.
 *
 * WP-B1-03 — 요약은 결과 노드가 아닌 입력에서 만들어진다. 청크요약은 그 청크와 청크의
 * llm_extract 자식이 모두 허용일 때만, 관계요약은 근거 문서(document 노드)가 허용일
 * 때만 싣는다(ancillary 판정). 허용되지 않은 요약만 빠진다.
 */
export async function applySummaries(
  store: SqliteMemoryStore,
  settings: MemorySettings | undefined,
  withSummariesRaw: unknown,
  dedupedResults: SearchEnrichedResult[],
  ancillary: AncillaryVisibility,
): Promise<void> {
  const summaryDefault =
    settings?.cleanupDeepPass?.summary?.searchChannelDefault ?? false;
  const withSummaries =
    typeof withSummariesRaw === "boolean"
      ? withSummariesRaw
      : summaryDefault;
  if (withSummaries) {
    // 엣지 승격 임계 — 저장 글루(Task 6)가 엣지를 만들 때 쓴 그 임계를 똑같이 읽어
    // gateRelationEdge 로 같은 판정을 재현한다(표시 라벨 ↔ 실제 엣지 일치). settings
    // 미주입(테스트 직호출)이면 0.6 모듈 default 와 같은 plan 선택값을 쓴다.
    const relationThreshold =
      settings?.cleanupDeepPass?.summary?.relationConfidenceThreshold ?? 0.6;
    // 청크요약 — 그 노드가 청크요약을 가진 청크면 한 문장 대표 요약을 표시. 없으면 null
    // 그대로(정직한 빈 상태 / Task 6 getChunkSummary 가 null 회신). 출처 판정은 요약 있는
    // 항목 전체를 한 번에(자식 조회 배치 1회).
    const chunkSummaries = dedupedResults.map((item) => store.getChunkSummary(item.id));
    const admittedChunkSummaries = ancillary.admitChunkSummaries(
      dedupedResults.filter((_, i) => chunkSummaries[i] !== null).map((item) => item.id),
    );
    for (const [i, item] of dedupedResults.entries()) {
      const cs = chunkSummaries[i] ?? null;
      if (cs !== null && admittedChunkSummaries.has(item.id)) {
        item.chunkSummary = {
          summaryText: cs.summaryText,
          generatedBy: cs.generatedBy,
        };
      }
      // 관계요약 — Task 15 정정: 관계 from/to 가 *개념 id* 라, 결과 글 노드를 그 노드에
      // 붙은 개념(node_concept_edges)으로 풀고, 그 개념이 from·to 어느 쪽이든 든 관계요약을
      // 모은다. 한 노드가 여러 개념을 달고 한 관계가 두 개념에 걸칠 수 있으므로 summaryId
      // 로 중복을 거른다. 없으면 빈 배열 그대로(정직한 빈 상태 / 가짜 채움 0). 사람(psn_)
      // 끝 노드 상세 표시는 Task 20 — 이 검색 표시는 글 노드의 개념(cpt_/psn_ 둘 다 매칭은
      // listRelationSummariesForConcept 가 텍스트 매칭으로 자연 처리)을 거친다.
      const concepts = await store.getNodeConcepts(item.id);
      if (concepts.length > 0) {
        const seenSummaryIds = new Set<string>();
        const collected: typeof item.relationSummaries = [];
        for (const { concept } of concepts) {
          for (const r of store.listRelationSummariesForConcept(
            concept.conceptId,
          )) {
            if (seenSummaryIds.has(r.summaryId)) continue;
            seenSummaryIds.add(r.summaryId);
            // 근거 문서가 이번 응답에서 허용되지 않으면 이 관계요약만 뺀다(기록됨).
            if (!ancillary.admitsRelationSummary(item.id, r)) continue;
            collected.push({
              summaryId: r.summaryId,
              fromConceptId: r.fromConceptId,
              toConceptId: r.toConceptId,
              relationName: r.relationName,
              summaryText: r.summaryText,
              confidence: r.confidence,
              edgePresent: gateRelationEdge(r.confidence, relationThreshold),
            });
          }
        }
        if (collected.length > 0) item.relationSummaries = collected;
      }
    }
  }
}
