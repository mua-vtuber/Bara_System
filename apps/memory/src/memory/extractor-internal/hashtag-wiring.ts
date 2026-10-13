/**
 * hashtag-wiring.ts — 본문 처리 맨 앞 단계 hashtag wiring(extractor.ts 에서 분리·G5-a).
 *
 * extractor.ts 가 1213줄로 800줄 하드 상한을 넘겨 책임 경계로 하위 모듈에 코드를 옮겼다
 * (동작 0 변화 — 코드 이동만). 이 모듈은 `#태그` 토큰 분리 + 본문 노드 저장 + 태그 개념
 * upsert + tag 엣지 연결(applyHashtagWiring)과 그 결과 구조체(HashtagWiringResult)를 담는다
 * — 2026-05-20 W2 spec section 5.
 */

import type { Embedder } from "../../embedding/types.ts";
import type { SqliteMemoryStore } from "../../db/store.ts";
import { autoLinkMentions } from "../auto-mention.ts";
import type { AutoCleanupTriggerHandle } from "../auto-cleanup-trigger.ts";
import { describeInputSource } from "../node-sources/source-ref.ts";
import { linkAuthorPerson } from "../person-link.ts";
import { parseTags } from "../tag-extractor.ts";
import { normalizeProjectId } from "../project-scope.ts";

/**
 * W2 hashtag wiring 의 결과 구조체. extractAndStore 진입부에서 받아 LLM 흐름과
 * edge 연결 단계에서 모두 사용한다.
 *
 * - `bodyNodeId`: cleanContent (또는 raw fallback) 를 담은 본문 노드 id.
 *   태그가 없거나 cleanContent + raw 둘 다 비면 null.
 * - `tagConceptIds`: upsert 된 태그 개념 conceptId 목록(cpt_). 입력 순서 정렬.
 * - `cleanContent`: `#태그` 토큰을 제거한 본문 (LLM 에 흘려보낼 텍스트).
 * - `llmInputText`: LLM 에 실제 전달할 텍스트. cleanContent 가 비면 원 raw 유지.
 */
export interface HashtagWiringResult {
  bodyNodeId: number | null;
  tagConceptIds: string[];
  cleanContent: string;
  llmInputText: string;
}

/**
 * LLM 이 받을 본문 — `#태그` 를 뺀 본문, 태그만 있으면 원문. DB 를 보지 않는 순수 판정이라
 * 추출 준비(prepareExtraction, 잠금 밖)와 applyHashtagWiring 이 같은 규칙을 쓴다.
 */
export function hashtagLlmInputText(rawText: string): string {
  const { tags, cleanContent } = parseTags(rawText);
  return tags.length > 0 && cleanContent.length > 0 ? cleanContent : rawText;
}

/**
 * 본문 처리 흐름 *맨 앞* 단계: `#태그` 토큰 분리 + 본문 노드 저장 + 태그 개념
 * 노드 upsert + node_concept_edges(tag) 연결(콜론 없는 나열은 위계 미생성).
 *
 * spec 2026-05-20 W2 — 어떤 어댑터 (Discord/Telegram/...) 든 LLM extractor
 * 진입 직전에 한 번 거치게 해서 그래프 일관성을 코어 단에서 확보.
 *
 * 흐름:
 *   1. parseTags(rawText) → { tags, cleanContent }
 *   2. tags 0개면 변동 0 — bodyNodeId=null, tagConceptIds=[], llmInputText=원 raw.
 *      기존 LLM extractor 흐름이 그대로 받음.
 *   3. tags ≥1 이면 본문 노드 생성 (cleanContent, 비면 raw 보존). 빈 본문은 skip.
 *   4. 각 태그를 findOrCreateTagConcept 로 idempotent upsert → conceptId(string).
 *   5. 본문 노드 → 각 태그 개념: addNodeConceptEdge role='tag'.
 *   6. 콜론 없는 나열은 위계(parent_of)를 만들지 않는다 — 위계는 콜론 선언
 *      (`#작품:만화`)에서만 생긴다(spec §4.1 I1).
 *
 * silent fallback 금지: 빈 cleanContent + 빈 raw 면 본문 노드 생성 skip
 * (강제 빈 노드 만들지 않음). 태그만 입력된 경우는 태그 개념 노드만 등록.
 *
 * 본문 노드는 사용자 원문의 직접 저장이다 — 입력 칸(platform·author·metadata)의 직접 저장 출처
 * (describeInputSource, messageId 가 있으면 메시지 출처)를 새 노드든 같은 본문 노드에 흡수되든 그
 * 노드에 남긴다(WP-B1-20T).
 */
export async function applyHashtagWiring(
  store: SqliteMemoryStore,
  rawText: string,
  options: {
    author?: string;
    platform?: string;
    metadata?: Record<string, unknown>;
    embedder?: Embedder;
    projectId?: string | null;
    /**
     * Phase 5.7.3 W3 — 본문 노드 + 태그 개념 노드 신규 작성 시 송출할
     * 데이터 변동 trigger. 미지정 시 no-op (옛 흐름 호환). hashtag 단계는
     * `addNode` 가 송출하는 'raw-memory-added' 와 별 reason ('hashtag-
     * concept-added') 을 보내서 호출 지점 분류를 명확히 한다.
     */
    trigger?: AutoCleanupTriggerHandle;
  } = {},
): Promise<HashtagWiringResult> {
  const { tags, cleanContent } = parseTags(rawText);
  const projectId = normalizeProjectId(options.projectId);

  if (tags.length === 0) {
    return {
      bodyNodeId: null,
      tagConceptIds: [],
      cleanContent,
      llmInputText: rawText,
    };
  }

  // 본문 노드 content — cleanContent 우선, 비면 raw 보존 (사용자 입력 손실 금지).
  const bodyContent = cleanContent.length > 0 ? cleanContent : rawText;
  const trimmedBody = bodyContent.trim();

  let bodyNodeId: number | null = null;
  if (trimmedBody.length > 0) {
    // embedder 가 주어지면 미리 계산해서 addNode 에 넘김 — 한 번 더 계산 회피.
    const embedding = options.embedder
      ? await options.embedder.embed(bodyContent)
      : undefined;
    bodyNodeId = await store.addNode({
      content: bodyContent,
      memoryType: "fact",
      sourceType: "auto_capture",
      importance: 0.5,
      confidence: 1.0, // 사용자 원문 — 최고 신뢰
      platform: options.platform ?? "",
      author: options.author ?? "",
      metadata: {
        ...(options.metadata ?? {}),
        source: "tag_body",
        tags,
      },
      project_id: projectId,
      ...(embedding ? { embedding } : {}),
      provenance: {
        kind: "source",
        source: describeInputSource({
          source: options.platform ?? "",
          author: options.author,
          metadata: options.metadata,
        }),
      },
    });
    // 본문 노드도 일반 메모리처럼 개념 자동 mentions + 작성자 사람 개념 연결.
    // 태그 자체는 cleanContent 에서 제거됐으니 tagged_with 와 중복 X.
    await autoLinkMentions(store, { id: bodyNodeId, content: bodyContent });
    await linkAuthorPerson(store, {
      nodeId: bodyNodeId,
      author: options.author,
      platform: options.platform,
      metadata: options.metadata,
    });
    // Phase 5.7.3 W3 — hashtag 본문 노드 신규 작성 신호. trigger 미주입
    // 시 no-op. store.addNode 의 'raw-memory-added' 와 같은 throttle
    // 윈도우 안에서 흡수된다.
    options.trigger?.emit("hashtag-concept-added");
  }

  const tagConceptIds: string[] = [];
  for (const tag of tags) {
    tagConceptIds.push(await store.findOrCreateTagConcept(tag));
  }

  if (bodyNodeId !== null) {
    for (const conceptId of tagConceptIds) {
      await store.addNodeConceptEdge(bodyNodeId, conceptId, "tag", "hashtag", bodyNodeId);
    }
  }

  // 콜론 없는 나열은 위계(parent_of)를 만들지 않는다(spec §4.1 I1). 이 통로는
  // 운영 비경로지만(모든 입력이 skipHashtagWiring:true 로 호출) default 가 false 라
  // 옛 순서 위계가 잠복 회귀하지 않도록 함께 제거한다(spec §3.6 / D9).

  // LLM 에는 cleanContent 만 전달 — cleanContent 비면 raw 로 fallback
  // (사용자가 `#만화` 만 던진 경우엔 LLM 흐름 자체가 빈 입력 처리로 0 items).
  const llmInputText = hashtagLlmInputText(rawText);

  return { bodyNodeId, tagConceptIds, cleanContent, llmInputText };
}
