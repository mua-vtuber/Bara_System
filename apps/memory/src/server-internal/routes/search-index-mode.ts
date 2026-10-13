/**
 * routes/search-index-mode.ts — 2단계 검색의 1회차 색인 회신(T21 / spec C).
 *
 * `responseMode: "index"` 는 본문 전체 대신 *어떤 기억이 있는지 목록만* 회신한다.
 * 호출 AI 는 이 목록에서 필요한 id 를 고른 뒤 `get_memory` 로 본문을 받아 간다
 * (2회 왕복). 1회차의 지연·토큰을 함께 줄이는 것이 이 모듈의 존재 이유다.
 *
 * ## 절단은 항상 포인터 동반 (spec C)
 *
 * index 회신의 `oneLine` 은 *절단된 조각*이다. AI 가 그것을 본문 전체로 오인하면
 * 저장된 내용을 잘못 인용한다 — 그래서 회신에 `POINTER_SENTENCE` 를 항상 싣는다.
 * 문구는 이 모듈이 단일 출처로 고정하고(테스트가 고정) 호출부가 따로 만들지 않는다.
 *
 * ## 토큰 상한이 계약으로 닫힌다
 *
 * 회신 총량 = `indexModeLimit`(최대 100) × 건당 상한. 건당 상한의 지배항은
 * `oneLine` 의 `ONE_LINE_MAX_CHARS`(120자) 하나뿐이고 나머지 칸(id·memoryType·
 * date·score·entities)은 짧은 고정폭이다. 그래서 최악의 경우도
 *   100건 × (120자 + 고정칸 ~60자) ≈ 18,000자 (한국어 기준 대략 9~18K 토큰)
 * 위에서 닫힌다 — 본문 길이에 비례해 무한정 커지던 full 모드와 다르다.
 *
 * ## LLM 0 · 질의는 회신당 배치 (D-D)
 *
 * `oneLine` 은 요약 생성이 아니라 *이미 손에 있는 값의 선택·절단*이다. 청크요약이
 * 있으면 그것을, 없으면 본문 첫 문장을 순수 문자열 연산으로 자른다. LLM 호출 0.
 *
 * D-D 가 금지하는 것은 *결과당* 질의(N+1)이고, 회신당 배치 질의는 허용 형태다.
 * 그래서 엔티티 이름과 자식→부모 치환은 결과 수와 무관한 고정 횟수 배치로 받는다
 * (`buildIndexItems` 주석에 내역). 개념 *펼침*(이웃 1단계까지 도는
 * getNodeConceptExpansion)·인접 청크·관계요약·엔티티 채널 임베딩은 index 모드에서
 * 아예 돌지 않는다 — 그 생략이 index 모드가 빠른 이유다.
 *
 * ## 목록의 id 는 반드시 조회 가능한 기억이어야 한다
 *
 * 포인터 문구가 "이 id 로 본문을 받아 가라"고 약속하므로, 자식 청크 id 를 그대로
 * 실으면 그 약속이 깨진다. full 모드의 `dedupChildToParent` 와 같은 규칙으로 자식을
 * 부모 원본으로 치환하고 중복을 합친다(`resolveIndexTargets`).
 */

import type { RetrievalResult } from "../../memory/retriever.ts";
import type { SqliteMemoryStore } from "../../db/store.ts";
import { listOpenConflicts, listOriginMarks } from "../../memory/open-conflicts.ts";
import type { AncillaryVisibility } from "./search-ancillary-visibility.ts";

/**
 * 회신 응답 양식(`responseMode`). `"full"` 이 default 이고 미지정·무효값은 전부
 * `"full"` 로 떨어진다 — 이 칸을 모르는 기존 호출자의 응답이 도입 전과 byte 동일하다.
 */
export type SearchResponseMode = "full" | "index";

/**
 * `oneLine` 한 건의 하드 글자 상한(spec C — "예: 120자 절단"). 이 상수가 index 회신
 * 총 토큰의 지배항이라 계약으로 고정한다(위 헤더 토큰 산법). 늘리면 회신 상한이
 * 그대로 비례해 올라가므로 spec 재확인 없이 바꾸지 말 것.
 *
 * 절단 시 말줄임표(…)는 상한 *안* 에 포함한다 — 상한을 넘기지 않는 것이 계약이다.
 */
export const ONE_LINE_MAX_CHARS = 120;

/** 절단이 실제로 일어났을 때 붙는 표시. 상한 안에 포함된다. */
export const TRUNCATION_SUFFIX = "…";

/**
 * index 회신에 항상 실리는 포인터 문구(spec C 계약 문구 — 문안 고정).
 *
 * `oneLine` 이 절단분이라는 사실과, 본문 전체를 어디서 받는지를 한 문장으로 말한다.
 * 호출부가 문구를 조립하지 않고 이 상수를 그대로 쓴다 — 두 곳에서 각자 쓰면 한쪽만
 * 바뀌어 AI 가 받는 안내가 갈린다.
 */
export const POINTER_SENTENCE =
  "oneLine is a truncated preview, not the stored text. " +
  "Retrieve full text via `get_memory` with ids from this list.";

/** index 모드 회신 한 건. spec C 가 고정한 6칸 — 본문(content)은 없다. */
export interface SearchIndexItem {
  id: number;
  memoryType: string;
  /** 청크요약 또는 본문 첫 문장을 ONE_LINE_MAX_CHARS 로 자른 미리보기. */
  oneLine: string;
  /**
   * 이 기억에 붙은 개념·엔티티 표시 이름(ko_name 우선). 회신 1건당 배치 질의 1회로
   * 모아 채운다(getNodeConceptNamesByIds). 빈 배열은 "붙은 개념이 0개"라는 진짜
   * 상태다 — 조회를 생략해서 비는 것이 아니다.
   */
  entities: string[];
  /** COALESCE(eventAt, createdAt) 의 날짜 부분(YYYY-MM-DD) — T11 표식과 같은 규칙. */
  date: string;
  score: number;
  /**
   * WP-B1-10(supervisor 지시) — 아직 해소되지 않은 충돌 상대 id 목록. 옛 고정 6칸 계약을
   * 깨지 않도록 선택 칸이며, 실제로 열린 충돌이 있는 항목에만 실린다(빈 배열 대신 칸 자체를
   * 생략 — "6칸만" 계약을 그대로 지키는 기존 소비자에게 회귀가 없다). recall_context 가
   * 내부적으로 index 모드를 쓰고, instructions 가 AI 에게 index 먼저 보라고 안내하므로 이
   * 표면이 충돌을 놓치면 안 된다.
   */
  conflicts?: number[];
  /**
   * WP-B1-10R(supervisor 지시) — 원문(auto_capture 등)에 그 원문에서 추출된 자식의 열린
   * 충돌·대체된 주장을 함께 싣는다(사용자 결정 2026-09-29 1안). conflicts 와 같은 선택
   * 칸 방식 — 자식이 없거나 두 표시 모두 없으면 칸 자체를 생략한다.
   */
  originMarks?: { openConflicts: number[]; supersededClaims: Array<{ childId: number; replacementId: number }> };
}

/**
 * 첫 문장/첫 줄을 뽑는다. 순수 문자열 연산 — LLM 0.
 *
 * 문장 끝 판정은 마침표·물음표·느낌표(한국어 본문에도 그대로 쓰이는 부호) 뒤에
 * 공백이나 문자열 끝이 오는 자리다. 줄바꿈이 먼저 오면 그 줄이 첫 문장이다 —
 * 목록·제목처럼 문장 부호 없이 줄로 끊는 글이 흔하기 때문이다.
 *
 * 문장 끝을 못 찾으면 본문 전체를 후보로 돌려준다(자르기는 호출자 몫). 빈 문자열은
 * 빈 문자열 그대로 — 없는 문장을 지어내지 않는다.
 */
export function firstSentence(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) return "";

  // 줄바꿈이 문장 부호보다 먼저 나오면 그 줄이 첫 문장이다.
  const newlineAt = trimmed.search(/\r?\n/);
  // 마침표류 + (공백 | 끝). 부호 자체는 문장에 포함하므로 매치 끝이 아니라
  // 부호 위치 + 1 을 경계로 쓴다.
  const punctuation = /[.!?。？！](\s|$)/.exec(trimmed);
  const punctuationAt = punctuation ? punctuation.index + 1 : -1;

  const candidates = [newlineAt, punctuationAt].filter((i) => i > 0);
  if (candidates.length === 0) return trimmed;
  return trimmed.slice(0, Math.min(...candidates)).trim();
}

/**
 * 글자 상한으로 자른다. 상한 이하면 그대로(말줄임표 없음), 넘으면 상한 *안* 에서
 * 자르고 말줄임표를 붙인다 — 결과 길이가 상한을 절대 넘지 않는 것이 계약이다.
 */
export function truncateToCap(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

/**
 * `oneLine` 산출 — 청크요약 우선, 없으면 본문 첫 문장(spec C 우선순위 두 갈래).
 *
 * 요약이 있으면 사람이 읽으라고 만든 한 문장이라 첫 문장 절단보다 낫다. 요약도
 * 상한을 탄다 — 요약 길이는 생성기가 정하므로 상한을 안 걸면 토큰 산법이 열린다.
 *
 * 요약·본문이 둘 다 비면 빈 문자열이다. 가짜 문구로 채우지 않는다 — 내용이 없는
 * 기억은 목록에서도 비어 보이는 것이 정직하다.
 */
export function buildOneLine(
  content: string,
  chunkSummaryText: string | null,
): string {
  const source =
    chunkSummaryText !== null && chunkSummaryText.trim().length > 0
      ? chunkSummaryText.trim()
      : firstSentence(content);
  return truncateToCap(source, ONE_LINE_MAX_CHARS);
}

/** COALESCE(eventAt, createdAt) 의 날짜 부분(T11 표식과 같은 규칙·같은 slice). */
export function resolveIndexDate(node: RetrievalResult["node"]): string {
  const raw = node.eventAt ?? node.createdAt;
  return raw.slice(0, 10);
}

/** 자식→부모 치환 대상 종류(full 모드 dedupChildToParent 와 같은 두 종류). */
const CHILD_SOURCE_TYPES = new Set(["image_caption", "llm_extract"]);

/**
 * index 목록에 실릴 노드를 확정한다 — 자식 청크를 부모 원본으로 치환하고 중복을 합친다
 * (T21 수정 1회차 / Medium 2).
 *
 * **왜 필요한가**: 포인터 문구가 "이 목록의 id 로 `get_memory` 를 부르면 본문을 받는다"
 * 고 약속한다. 그런데 image_caption·llm_extract 같은 *자식* 노드 id 가 목록에 그대로
 * 실리면 그 약속이 깨진다 — 그 id 로 조회하면 저장된 기억이 아니라 파편(캡션 한 줄·
 * 추출 조각)이 온다. 같은 부모의 자식 둘이 나란히 실려 같은 기억이 두 번 보이는 일도
 * 생긴다. full 모드는 `dedupChildToParent`(search-post-process.ts)가 이 둘을 막는데,
 * index 모드가 그 단계를 건너뛰면서 구멍이 났다.
 *
 * **비용**: 자식이 결과에 하나도 없으면 질의 0회(대부분의 검색). 자식이 있으면
 * 종류당 배치 1회(부모 풀이) + 부모 본문 배치 1회 — 결과 수와 무관하게 최대 3회다.
 * 결과당 질의(D-D 금지 대상)는 여기 없다.
 *
 * **판정 규칙은 full 모드와 같다**: 부모를 못 찾은 고아 자식은 자식 그대로 남기고
 * (가짜 부모 0), 같은 부모가 여러 경로로 들면 첫 등장 자리에 합치고 점수는 둘 중
 * 높은 값을 승계한다(순서는 안 뒤집힌다). 부모가 이번 응답의 조회 규칙에서 허용되지
 * 않으면(WP-B1-03 — ancillary.substitutesParent) 치환하지 않고 자식을 그대로 둔다.
 */
async function resolveIndexTargets(
  store: SqliteMemoryStore,
  results: RetrievalResult[],
  ancillary: AncillaryVisibility,
): Promise<Array<{ node: RetrievalResult["node"]; score: number }>> {
  // 1. 자식 id 를 종류별로 모은다 — 없으면 아래 배치 조회가 전부 빈 Map(질의 0회).
  const captionIds: number[] = [];
  const extractIds: number[] = [];
  for (const r of results) {
    if (r.node.sourceType === "image_caption") captionIds.push(r.node.id);
    else if (r.node.sourceType === "llm_extract") extractIds.push(r.node.id);
  }

  // 2. 부모 id 풀이 — 종류당 배치 1회(빈 배열이면 질의 진입조차 안 한다). 허용된 부모만
  //    치환 후보로 남긴다(캡션·추출 자식 id 는 종류가 달라 겹치지 않는다).
  const substituteParentOf = new Map<number, number>();
  for (const parents of [
    store.getImageAssetParentsOfCaptions(captionIds),
    store.getRawParentsOfExtracts(extractIds),
  ]) {
    for (const [childId, parentId] of parents) {
      if (ancillary.substitutesParent(childId, parentId)) substituteParentOf.set(childId, parentId);
    }
  }

  // 3. 부모 본문을 배치 1회로 받는다 — 치환된 항목의 oneLine·date·memoryType 이
  //    부모 기준이어야 목록과 get_memory 회신이 같은 기억을 가리킨다.
  const parentIds = [...new Set(substituteParentOf.values())];
  const parentNodes = await store.getNodesByIds(parentIds);
  const parentById = new Map(parentNodes.map((n) => [n.id, n]));

  // 4. 치환 + dedup. 첫 등장 자리를 지키고 점수는 최고값 승계(full 모드와 같은 규칙).
  const out: Array<{ node: RetrievalResult["node"]; score: number }> = [];
  const slotByNodeId = new Map<number, number>();
  for (const r of results) {
    let node = r.node;
    if (CHILD_SOURCE_TYPES.has(r.node.sourceType)) {
      const parentId = substituteParentOf.get(r.node.id);
      const parent = parentId === undefined ? undefined : parentById.get(parentId);
      // 부모를 못 찾았거나 허용되지 않으면 자식 그대로 둔다(가짜 부모를 만들지 않는다).
      if (parent) node = parent;
    }

    const slot = slotByNodeId.get(node.id);
    if (slot === undefined) {
      slotByNodeId.set(node.id, out.length);
      out.push({ node, score: r.score });
    } else if (r.score > out[slot]!.score) {
      // 같은 기억 재등장 — 항목을 늘리지 않고 점수만 높은 쪽으로.
      out[slot]!.score = r.score;
    }
  }
  return out;
}

/**
 * 하한선까지 통과한 결과를 index 항목으로 성형한다.
 *
 * **무거운 후처리는 여전히 건너뛴다**(spec C / D-D): 개념 *펼침*(이웃 1단계까지 도는
 * getNodeConceptExpansion)·인접 청크·revision 플래그·관계요약·컨텍스트 조립이 이
 * 통로에는 없다.
 *
 * **DB 접촉은 회신 1건당 고정 횟수다**(수정 1회차 — D-D 는 *결과당* 질의를 금지하고
 * 회신당 배치는 허용한다):
 *   - 자식→부모 치환: 자식이 있을 때만 최대 3회(캡션 부모·추출 부모·부모 본문).
 *   - 엔티티 이름: 배치 1회(getNodeConceptNamesByIds). 목록 항목 자신에 붙은 개념이라
 *     출처 판정 대상이 아니다(WP-B1-03 — 직접 개념은 유지).
 *   - 청크요약: 항목당 1회 — `oneLine` 우선순위가 요구하는 조회이고,
 *     `parent_chunk_id` 인덱스 seek 이다(idx_chunk_summaries_chunk). full 모드의
 *     applySummaries 도 같은 호출을 하므로 index 가 더 쓰는 비용이 아니다.
 *   - 청크요약 출처 판정(WP-B1-03): 요약 있는 항목이 있을 때만 자식 조회 배치 1회. 청크와
 *     그 llm_extract 자식이 모두 허용일 때만 요약을 oneLine 에 쓰고, 아니면 본문 첫 문장.
 *
 * 순서는 입력 순서 그대로다 — 하한선까지 확정된 순위를 성형이 뒤집지 않는다(dedup 으로
 * 항목이 줄 수는 있어도 남은 것의 앞뒤는 안 바뀐다).
 */
export async function buildIndexItems(
  store: SqliteMemoryStore,
  results: RetrievalResult[],
  ancillary: AncillaryVisibility,
): Promise<SearchIndexItem[]> {
  const targets = await resolveIndexTargets(store, results, ancillary);

  // 엔티티 이름 — 표시 대상 id 전체를 한 질의로(치환 *뒤* 라 부모 기준 이름이 실린다).
  const entitiesByNodeId = store.getNodeConceptNamesByIds(
    targets.map((t) => t.node.id),
  );

  // 요약 우선순위가 요구하는 조회 — 없으면 null 이고 본문 첫 문장으로 떨어진다.
  const summaries = targets.map((t) => store.getChunkSummary(t.node.id));
  const admittedSummaries = ancillary.admitChunkSummaries(
    targets.filter((_, i) => summaries[i] !== null).map((t) => t.node.id),
  );

  // WP-B1-10(supervisor 지시) — 표시 대상 전체를 한 번의 일괄 질의로 조회해 N+1을 피한다.
  const targetIds = targets.map((t) => t.node.id);
  const openConflicts = listOpenConflicts(store.getRawDb(), targetIds);
  // WP-B1-10R — 원문 표시 대상에 자식 계보 표시를 함께 싣는다(같은 일괄 질의 원칙).
  const originMarks = listOriginMarks(store.getRawDb(), targetIds);

  return targets.map((t, i) => {
    const summary = summaries[i] ?? null;
    const shownSummary = summary !== null && admittedSummaries.has(t.node.id) ? summary.summaryText : null;
    const conflicts = openConflicts.get(t.node.id);
    const marks = originMarks.get(t.node.id);
    return {
      id: t.node.id,
      memoryType: t.node.memoryType,
      oneLine: buildOneLine(t.node.content, shownSummary),
      // 개념이 안 붙은 글은 Map 에 키가 없어 빈 배열 — 진짜로 없는 상태다
      // (조회를 생략해서 비는 것이 아니라, 붙은 개념이 0개라서 빈다).
      entities: entitiesByNodeId.get(t.node.id) ?? [],
      date: resolveIndexDate(t.node),
      score: t.score,
      // 옛 고정 6칸 계약을 지키기 위해 열린 충돌이 있을 때만 칸을 싣는다(없으면 칸 자체 생략).
      ...(conflicts && conflicts.length > 0 ? { conflicts } : {}),
      ...(marks ? { originMarks: marks } : {}),
    };
  });
}

/**
 * body.responseMode 방어 파싱 — `"index"` 문자열일 때만 index, 그 외 전부 full.
 *
 * project·polarity 칸과 같은 방어 패턴이다(무효값은 조용히 미적용). 미지정·오타·
 * 비문자열이 전부 full 로 떨어져야 이 칸을 모르는 호출자의 응답이 byte 동일하다.
 */
export function parseResponseMode(raw: unknown): SearchResponseMode {
  return raw === "index" ? "index" : "full";
}
