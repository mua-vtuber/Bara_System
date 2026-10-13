/**
 * metadata-apply.ts — Phase 7 갈래 1: 추출 후 한 atomic 의 *명시* 메타를
 * 실제 그래프·칸에 적용한다("명시 = 자동").
 *
 * Task 3 추출기가 atomic 마다 place / person / eventDateText 를 출력하면,
 * 이 글루가 셋을 받아:
 *  - 장소  → store.setPlace(nodeId, value, "system") — 출처 가드(direct 보호)를 거쳐
 *           concept(장소)→concept(value) 위계만 만든다(활용 단계2 ③·C-1 수정). 추출
 *           장소는 1급 places 행으로 승격하지 않는다(거짓 엔티티 방지) — 직접 입력
 *           direct 가 이미 있으면 거부돼 안 덮는다(spec §5.1).
 *  - 사람  → 기존 사람 신원이 정확히 1명으로 조회될 때만
 *           node_person_edges relation='mentions' 연결
 *           (작성자 authored_by 와 *구분* — 여기는 문장에 언급된 사람)
 *  - 날짜  → event-date.ts extractEventDate 로 ISO 환산 → store.setEventAt
 *
 * 좁은 store 인터페이스(MetadataApplyStore)만 받아 단위 검증을 쉽게 한다.
 *
 * graceful-degradation 정합:
 *  - 메타가 전부 없으면 store 호출 0 (no-op — 정직한 빈 결과).
 *  - 한 항목 적용이 실패해도 노드 저장·다른 메타는 진행한다. 단 실패는
 *    console.warn 으로 *식별자(nodeId·항목)* 를 남기고 진행 — 빈 값으로
 *    위장하거나 조용히 삼키지 않는다(silent swallow 금지).
 *
 * 중복 장소("땡병원" vs "땡 병원")는 기존 0.95 개념 합치기 게이트
 * (mergeConceptAlias)에 맡긴다 — 여기서 별도 중복 처리를 하지 않는다.
 *
 * person 신원 계약: 의미추출 후처리는 사람을 생성하지 않는다. 기존 사람 목록에서
 * 본명/별칭이 정확히 1명으로 닫힐 때만 mentions 엣지를 추가한다. 후보 없음,
 * 후보 여럿, 캐릭터/마스코트/봇처럼 정황 판단이 필요한 경우는 비워 두고
 * 데이터 정리 AI 의 person_link 단계가 기존 personId 중에서만 제안/연결한다.
 */

import { extractEventDate } from "./event-date.ts";
import type { FieldSource } from "./field-provenance.ts";
import type { SetPlaceResult } from "./place-provenance-flow.ts";
import type { Person, PersonRelation } from "./types.ts";
import type { ExtractedItem } from "./extractor.ts";
import {
  SELF_REFERENCE_PERSON_NAMES,
  normalizePersonNameForPolicy,
  type ExtractionFieldLocks,
} from "./extraction-context.ts";

// ── 모듈 상수 (하드코딩 금지 — 한곳에 격리) ──────────────────────────────────

/**
 * 장소 메타를 담는 분류 카테고리 이름. 추출(system)·추론(inferred) 장소가 concept 위계
 * (concept(장소)→concept(value))로 합류할 때 store.addClassificationTag 의 category 인자
 * 단일 출처다. setPlaceFlow 의 system/inferred 갈래가 이 값을 재사용해 같은 카테고리로
 * 합류시킨다(값을 흩어 적지 않는다·C-1 수정 후 복원).
 */
export const PLACE_CLASSIFICATION_CATEGORY = "장소";

/**
 * 문장에 *언급된* 사람을 잇는 엣지 relation. 작성자(authored_by)와 *구분*된다.
 * PersonRelation = "mentions" | "authored_by" 중 mentions.
 */
export const MENTION_PERSON_RELATION: PersonRelation = "mentions";

/**
 * 옛 언급 사람 신원의 external_refs 네임스페이스.
 * 후처리는 더 이상 이 값으로 사람을 생성하지 않는다.
 */
export const MENTION_PERSON_SOURCE = "mention";

// ── 좁은 store 인터페이스 ────────────────────────────────────────────────────

/**
 * 이 글루가 쓰는 store 메서드만 노출. SqliteMemoryStore 가 전부 구현한다.
 * (mock 클래스를 위한 인터페이스가 아니라 의존면을 좁히는 용도 — 테스트는
 *  실 SqliteMemoryStore 를 그대로 넘긴다.)
 */
export interface MetadataApplyStore {
  setPlace(
    nodeId: number,
    value: string,
    source: FieldSource,
  ): Promise<SetPlaceResult>;
  findUniquePersonByNameOrAlias(name: string): Promise<{
    person: Person | null;
    ambiguous: boolean;
  }>;
  addNodePersonEdge(
    nodeId: number,
    personId: string,
    relation: PersonRelation,
    provenance: "llm_extract",
    sourceNodeId: number,
  ): Promise<boolean>;
  setEventAt(
    nodeId: number,
    eventAt: string,
    source: FieldSource,
  ): Promise<boolean>;
}

export interface ApplyMetadataArgs {
  /** 방금 저장된 atomic 노드 id. */
  nodeId: number;
  /** 추출된 atomic — place / person / eventDateText / content 사용. */
  item: ExtractedItem;
  /** 등록 기준점(노드 생성 시각). 날짜 환산은 이 now 기준 — 주입 필수. */
  now: Date;
  /** 해시태그/직접 입력으로 확정돼 LLM 이 덮거나 경쟁하면 안 되는 필드. */
  locks?: ExtractionFieldLocks;
  /** person 으로 저장하면 안 되는 이름 후보(자기지시어, 명시 alias 등). */
  blockedPersonNames?: readonly string[];
  /** 해시태그/직접 입력으로 이미 확정된 사람 이름. 중복 mention 생성을 막는다. */
  explicitPersonNames?: readonly string[];
}

export interface ApplyMetadataResult {
  /** 장소 분류 태그가 적용됐는지. */
  placeApplied: boolean;
  /** 연결된 사람 신원 id 목록(실패·빈 이름은 제외). */
  personIds: string[];
  /** 적용된 event_at ISO(없으면 null). */
  eventAtApplied: string | null;
}

// ── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * 한 atomic 의 명시 메타(장소·언급 사람·이벤트 날짜)를 적용한다.
 *
 * 세 분기는 서로 독립이고 각자 try/catch 로 격리된다 — 한 분기 실패가 다른
 * 분기나 노드 저장을 막지 않는다. 실패는 console.warn 으로 nodeId·항목을
 * 남기고 진행한다(silent swallow 금지).
 */
export async function applyExtractedMetadata(
  store: MetadataApplyStore,
  args: ApplyMetadataArgs,
): Promise<ApplyMetadataResult> {
  const { nodeId, item, now, locks } = args;
  const result: ApplyMetadataResult = {
    placeApplied: false,
    personIds: [],
    eventAtApplied: null,
  };

  // ── 1. 장소 → setPlace(system·출처 가드) ──────────────────────────────────
  // 추출기가 뽑은 명시 place 라 출처는 system(event_at 이 setEventAt(…, "system")
  // 인 정합 — 규칙 추출 성격). setPlace 의 system 갈래는 concept(장소)→concept(value)
  // 위계만 만든다(1급 places 행은 안 만듦·거짓 엔티티 방지·C-1). 직접 입력(direct)이
  // 이미 있으면 source-conflict 로 거부돼 wrote=false — 덮어쓰기 0·정직하게 남긴다
  // (빈 값 위장·silent 아님).
  const place = item.place?.trim();
  if (place && !locks?.place && isLikelyExplicitPlaceMention(item.content, place)) {
    try {
      const res = await store.setPlace(nodeId, place, "system");
      result.placeApplied = res.wrote;
      if (!res.wrote) {
        console.warn(
          `[metadata-apply] place 추출값 skip(이미 더 높은 출처) nodeId=${nodeId} place=${JSON.stringify(place)}`,
        );
      }
    } catch (err) {
      console.warn(
        `[metadata-apply] place 적용 실패 nodeId=${nodeId} place=${JSON.stringify(place)}: ${errMessage(err)}`,
      );
    }
  } else if (place && !locks?.place) {
    console.warn(
      `[metadata-apply] place 추출값 skip(본문 내 장소 표지 없음) nodeId=${nodeId} place=${JSON.stringify(place)}`,
    );
  }

  // ── 2. 언급된 사람 → 기존 사람 정확 매칭일 때만 mentions 엣지 ─────────────
  const blockedPersons = personBlockSet(args);
  if (!locks?.person) {
    for (const rawName of item.person ?? []) {
      const name = typeof rawName === "string" ? rawName.trim() : "";
      if (!name || blockedPersons.has(normalizePersonNameForPolicy(name))) {
        continue;
      }
      try {
        const lookup = await store.findUniquePersonByNameOrAlias(name);
        if (!lookup.person || lookup.ambiguous) {
          if (lookup.ambiguous) {
            console.warn(
              `[metadata-apply] person 연결 skip(후보 모호) nodeId=${nodeId} person=${JSON.stringify(name)}`,
            );
          }
          continue;
        }
        await store.addNodePersonEdge(
          nodeId,
          lookup.person.personId,
          MENTION_PERSON_RELATION,
          "llm_extract",
          nodeId,
        );
        if (!result.personIds.includes(lookup.person.personId)) {
          result.personIds.push(lookup.person.personId);
        }
      } catch (err) {
        console.warn(
          `[metadata-apply] person 적용 실패 nodeId=${nodeId} person=${JSON.stringify(name)}: ${errMessage(err)}`,
        );
      }
    }
  }

  // ── 3. 이벤트 날짜 → 정규식 1단 ISO 환산 → event_at ────────────────────────
  // 본문 포함 가드: 모델이 준 eventDateText 는 그 문자열이 content 에 *실제로
  // 포함돼 있을 때만* 신뢰한다. 작은 추출 모델이 시간어 없는 글에도 "오늘 날짜"
  // 를 토막으로 지어내거나(환각) 이미 ISO 로 환산해 넣는 일이 잦은데, 그런 토막은
  // content 에 없으므로 버리고 content 전체를 정규식 1단으로 훑는다(본문에 진짜
  // 날짜 "5월 12일" 이 있으면 잡고, 지어낸 토막은 형식 무관 걸러진다).
  // null 은 "닫힌 날짜 없음" 정직한 결과라 setEventAt 호출 안 함(빈 값 위조 아님).
  const rawFragment = item.eventDateText?.trim();
  const trustFragment = !!rawFragment && item.content.includes(rawFragment);
  const dateSrc = trustFragment ? rawFragment! : item.content;
  if (dateSrc && !locks?.eventDate) {
    try {
      const iso = extractEventDate(dateSrc, now);
      if (iso !== null) {
        await store.setEventAt(nodeId, iso, "system");
        result.eventAtApplied = iso;
      }
    } catch (err) {
      console.warn(
        `[metadata-apply] event_at 적용 실패 nodeId=${nodeId} src=${JSON.stringify(dateSrc.slice(0, 80))}: ${errMessage(err)}`,
      );
    }
  }

  return result;
}

function personBlockSet(args: ApplyMetadataArgs): Set<string> {
  const blocked = new Set<string>();
  for (const name of SELF_REFERENCE_PERSON_NAMES) {
    blocked.add(normalizePersonNameForPolicy(name));
  }
  for (const name of args.blockedPersonNames ?? []) {
    blocked.add(normalizePersonNameForPolicy(name));
  }
  for (const name of args.explicitPersonNames ?? []) {
    blocked.add(normalizePersonNameForPolicy(name));
  }
  blocked.delete("");
  return blocked;
}

function isLikelyExplicitPlaceMention(content: string, place: string): boolean {
  const normalizedContent = normalizeInlineText(content);
  const normalizedPlace = normalizeInlineText(place);
  if (!normalizedContent || !normalizedPlace) return false;

  for (const index of findAllIndexes(normalizedContent, normalizedPlace)) {
    const after = normalizedContent.slice(index + normalizedPlace.length);
    const before = normalizedContent.slice(0, index);
    if (hasLocationMarkerAfter(after) || hasLocationLabelBefore(before)) {
      return true;
    }
  }
  return false;
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function findAllIndexes(haystack: string, needle: string): number[] {
  const indexes: number[] = [];
  let from = 0;
  while (from < haystack.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    indexes.push(index);
    from = index + Math.max(needle.length, 1);
  }
  return indexes;
}

function hasLocationMarkerAfter(afterPlace: string): boolean {
  const text = afterPlace.trimStart();
  return /^(에서|에(?!게)|으로|로|까지|부터|근처|주변|앞|뒤|안|밖|내|쪽)(?:\b|[\s,.)]|[가-힣])/.test(
    text,
  );
}

function hasLocationLabelBefore(beforePlace: string): boolean {
  return /(?:장소|위치)\s*[:：은는]?\s*$/.test(beforePlace);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
