/**
 * memory/compute-aggregate.ts — 집계기 (활용 단계5 T3 / plan D4).
 *
 * 후보 node_id Set 을 받아 집계 종류별로 집계한다(목록·개수·시간순·누적). 노드
 * 실체화는 store.getNodesByIds 로 하되, 그 메서드가 `WHERE id IN (...)` 단일 조회라
 * *입력 순서를 보존하지 않으므로*(node-repository.ts) 집계기가 *명시 정렬* 책임을
 * 진다. LLM 0·결정적.
 *
 * 종류별(D4):
 *   - list     = getNodesByIds + created_at DESC(최신 우선·getProjectMemberNodes 선례)
 *   - count    = Set.size(노드 실체화 불요)
 *   - timeline = getNodesByIds + COALESCE(event_at, created_at) ASC(사건 시간순)
 *   - log      = getNodesByIds + COALESCE(event_at, created_at) ASC(진행 누적순) —
 *                정렬은 timeline 과 같고 메타(orderedBy)만 다르다(D4).
 *
 * event_at 없는 노드는 created_at 으로 정렬한다(정직한 근사 — 누락 마스킹 아님).
 */
import type { MemoryNode } from "./types.ts";
import type { SqliteMemoryStore } from "../db/store.ts";
import type { ComputeIntent, ComputeKind } from "./compute-intent.ts";
import {
  computeNumericAggregate,
  type AvgDivisorOpts,
} from "./compute-numeric-aggregate.ts";

/** 정렬 기준 표기(응답·디버그·표시). */
export type ComputeOrder = "created_desc" | "event_asc" | "none";

/** 집계 결과 — 종류·개수·정렬된 노드 목록 + 정렬 기준. */
export interface ComputeResult {
  /** 집계 종류(intent.kind 그대로). */
  kind: ComputeKind;
  /** 후보 개수(모든 종류 공통 — count 종류는 이 값이 핵심). */
  count: number;
  /**
   * 정렬된 노드 목록. count 종류는 빈 배열(개수만 필요)·나머지는 명시 정렬 노드.
   */
  items: MemoryNode[];
  /** 어떤 기준으로 정렬됐는지(count 는 'none'). */
  orderedBy: ComputeOrder;
  /**
   * 단계6b sum/avg 전용 — 합계(sum) 또는 평균(avg) 결과값. list/count/timeline/log
   * 는 undefined(byte 동일·회귀 0). 숫자형 칸 부재 시 0 이 아니라 numericFieldPresent
   * false 로 구분(0 위장 금지·Mock Policy).
   */
  value?: number;
  /** 단계6b — 숫자형 칸이 좁혀진 글에 한 건이라도 채워졌는지. false = 수치 데이터 없음(0 위장 아님). */
  numericFieldPresent?: boolean;
  /**
   * 단계6b sum/avg 전용 — 숫자로 읽힌 건수(count 는 총 글 수라 둘이 다르다). 전부 못
   * 읽으면 count>0·readCount=0 → UI 가 "읽을 수 있는 값 없음"을 이 값으로 판단(C1).
   * list/count/timeline/log 는 undefined → 직렬화에서 빠짐·byte 동일.
   */
  readCount?: number;
  /** 단계6b — 숫자로 못 읽어 제외한 건수(자유 입력 비숫자값). >0 이면 정직 표시. */
  excludedCount?: number;
  /** 단계6b avg 전용 — 평균 분모 실수치(분모 A=글 개수 / 분모 B=기간 단위 수). */
  avgDivisor?: number;
  /** 단계6b avg 전용 — 분모 종류('count'=글당 / 'day'·'week'·'month'·'year'=시간단위당). */
  avgDivisorKind?: "count" | "day" | "week" | "month" | "year";
}

/** COALESCE(event_at, created_at) — 사건 시각 우선, 미상이면 등록 시각(정직한 근사). */
function eventKey(node: MemoryNode): string {
  return node.eventAt ?? node.createdAt;
}

/** created_at 내림차순(최신 우선). 동률은 id 내림차순(getProjectMemberNodes 선례). */
function byCreatedDesc(a: MemoryNode, b: MemoryNode): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return b.id - a.id;
}

/** COALESCE(event_at, created_at) 오름차순(시간순). 동률은 id 오름차순. */
function byEventAsc(a: MemoryNode, b: MemoryNode): number {
  const ka = eventKey(a);
  const kb = eventKey(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.id - b.id;
}

/**
 * 후보 node_id 를 집계 종류별로 집계한다(D4). 결정적·LLM 0.
 *
 * count 는 노드 실체화 없이 Set.size 만 본다(값쌈). 나머지는 getNodesByIds 로
 * 실체화한 뒤 종류별 명시 정렬을 건다 — getNodesByIds 가 입력 순서를 안 지키므로
 * 정렬은 이 집계기 책임이다(D4 핵심). 후보 0개면 count=0·빈 목록(정직한 빈 상태).
 *
 * @param intent  집계 의도(kind 로 분기).
 * @param nodeIds 집계 대상 후보 node_id(resolveComputeCandidates 산출).
 * @param store   노드 실체화 통로(facade·getNodesByIds).
 */
export async function computeAggregate(
  intent: ComputeIntent,
  nodeIds: Set<number>,
  store: SqliteMemoryStore,
  numeric?: { field: string; avgDivisor?: AvgDivisorOpts },
): Promise<ComputeResult> {
  const ids = [...nodeIds];

  // sum·avg — 숫자형 칸 합산/평균(T2 위임). field 는 라우트가 보증(부재면 400 컷).
  if (intent.kind === "sum" || intent.kind === "avg") {
    if (!numeric) {
      // 라우트가 field 검증을 했으므로 여기 도달은 호출 계약 위반 — loud throw(silent 0 금지).
      throw new Error(`computeAggregate: ${intent.kind} 는 numeric.field 가 필요하다`);
    }
    const r = await computeNumericAggregate(
      store,
      nodeIds,
      numeric.field,
      intent.kind,
      numeric.avgDivisor,
    );
    return {
      kind: intent.kind,
      count: r.count,
      items: [],
      orderedBy: "none",
      value: r.value,
      numericFieldPresent: r.numericFieldPresent,
      readCount: r.readCount,
      excludedCount: r.excludedCount,
      avgDivisor: r.avgDivisor,
      avgDivisorKind: r.avgDivisorKind,
    };
  }

  // count — 개수만. 노드 실체화 불요(값쌈).
  if (intent.kind === "count") {
    return { kind: "count", count: ids.length, items: [], orderedBy: "none" };
  }

  // 나머지 — 노드 실체화 후 명시 정렬(getNodesByIds 순서 미보존 보정).
  const nodes = await store.getNodesByIds(ids);

  if (intent.kind === "list") {
    nodes.sort(byCreatedDesc);
    return {
      kind: "list",
      count: nodes.length,
      items: nodes,
      orderedBy: "created_desc",
    };
  }

  // timeline·log — COALESCE(event_at, created_at) ASC 같은 정렬, 메타만 다름(D4).
  nodes.sort(byEventAsc);
  return {
    kind: intent.kind,
    count: nodes.length,
    items: nodes,
    orderedBy: "event_asc",
  };
}
