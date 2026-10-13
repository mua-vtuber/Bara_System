/**
 * server-internal/routes/compute.ts — POST /compute 라우트 등록기 (활용 단계5 T5 / D5).
 *
 * 계산 경로 입구다. query 로 집계 의도를 감지(detectComputeIntent)하거나 명시 kind
 * 로 종류를 직접 받고, 선택 칸(종류·기간·장소·프로젝트)으로 후보를 좁혀
 * (resolveComputeCandidates) 집계(computeAggregate)한 구조화 JSON 을 회신한다.
 * LLM 0(Q2=A). /search 파일을 한 글자도 안 건드린다 — 찾기 경로 byte 동일 구조적
 * 보장(Q3=A). RRF 코어·점수식 6파일·retriever 를 호출조차 안 한다(별 통로).
 *
 * 응답 모양:
 *   { kind, count, orderedBy, items[] }            — 집계 성공
 *   { error: 'condition required', needsCondition } — 칸 0개(전 노드 폭주 차단·정직)
 *   { error: '...' } (4xx)                          — query 없음·집계 의도 없음
 *
 * Mock Policy: 빈 집계는 실제 0건일 때만 빈 목록(가짜 행 0). 칸 0개는 빈 결과로
 * 위장하지 않고 "조건 필요"를 명시 회신한다. 조회 SQL 실패는 SQLite 구체 에러 전파.
 */

import type { Hono } from "hono";
import type { ComputeBody, MemoryApiDeps } from "../types.ts";
import { isPositiveString, err } from "../http-helpers.ts";
import { eventDateRange } from "../../memory/event-date.ts";
import {
  detectComputeIntent,
  type ComputeIntent,
  type ComputeKind,
} from "../../memory/compute-intent.ts";
import {
  resolveComputeCandidates,
  type ComputeFields,
} from "../../memory/compute-candidates.ts";
import { computeAggregate } from "../../memory/compute-aggregate.ts";
import type { AvgDivisorUnit } from "../../memory/compute-numeric-aggregate.ts";
import type { SqliteMemoryStore } from "../../db/store.ts";

/** 명시 kind 로 받을 수 있는 집계 종류(sum·avg 는 단계6b 합류). */
const COMPUTE_KINDS: readonly ComputeKind[] = [
  "list",
  "count",
  "timeline",
  "log",
  "sum",
  "avg",
];

/** ISO 날짜(YYYY-MM-DD) 양식 — 명시 since/until 방어. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * AVG 분모 B 시간 단위 — 이 중 하나면 분모 B(기간 단위당), 아니면 분모 A(글당).
 * 값은 T2 의 AvgDivisorUnit 단일 출처(compute-numeric-aggregate.ts)에서 파생한다 —
 * as const + satisfies 로 두 곳이 어긋나면 tsc 가 잡는다.
 */
const AVG_UNITS = ["day", "week", "month", "year"] as const satisfies readonly AvgDivisorUnit[];

/** body.avgDivisor 가 유효 단위면 그 값, 'count'·부재·무효면 undefined(분모 A=글당). */
function parseAvgDivisorUnit(raw: unknown): AvgDivisorUnit | undefined {
  return typeof raw === "string" && (AVG_UNITS as readonly string[]).includes(raw)
    ? (raw as AvgDivisorUnit)
    : undefined;
}

/** body.kind 가 유효한 ComputeKind 면 그 값, 아니면 undefined. */
function parseKind(raw: unknown): ComputeKind | undefined {
  return typeof raw === "string" &&
    (COMPUTE_KINDS as readonly string[]).includes(raw)
    ? (raw as ComputeKind)
    : undefined;
}

/**
 * body.filter 에서 종류(분류값) 칸 한 개를 뽑는다. 객체면 첫 유효 문자열 값,
 * 문자열이면 그 값 자체를 종류로 본다. 단계5 종류 칸은 단일 — 여러 값이면 첫째만.
 * 무효·부재면 undefined(종류 칸 미적용).
 */
function parseConceptValue(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    for (const value of Object.values(raw as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  return undefined;
}

/** body.place 가 1자 이상 문자열이면 trim 값, 아니면 undefined. */
function parsePlaceField(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0
    ? raw.trim()
    : undefined;
}

/**
 * 장소 신호를 해석한다(계산 경로 D2). 명시 place 우선, 없으면 query 안에서 저장
 * 장소 leaf 이름(store.listPlaceLeafNames)을 부분일치로 찾아 신호로 쓴다. 가장 긴
 * 이름 우선(listPlaceLeafNames 가 길이 내림차순 회신 → 첫 매칭이 가장 긴 매칭).
 * search.ts 의 resolvePlaceSignal 과 같은 알고리즘이되, 계산 경로는 /search 파일을
 * import 하지 않으려 store facade(listPlaceLeafNames) 만으로 독립 해석한다(D5 미접촉).
 */
function resolveComputePlace(
  explicit: string | undefined,
  query: string,
  store: SqliteMemoryStore,
): string | undefined {
  if (explicit) return explicit;
  // query 가 빈 문자열이면 부분일치 신호로 쓸 수 없다(haystack.includes 가 무의미하므로
  // 그냥 미적용). 명시 place 가 없는 한 장소 신호 없음으로 본다(빈 query 오매칭 차단).
  if (query.trim().length === 0) return undefined;
  const haystack = query.toLowerCase();
  for (const name of store.listPlaceLeafNames()) {
    const trimmed = name.trim();
    if (trimmed.length > 0 && haystack.includes(trimmed)) return name;
  }
  return undefined;
}

/**
 * 명시 since/until(둘 다 유효 ISO)이 우선, 없으면 query 에서 닫힌 시간 표현을
 * eventDateRange(query, now)로 자동 추출한다(search.ts resolveDateRange 와 같은
 * 우선순위·event-date.ts 공유 모듈만 사용). 둘 다 없으면 undefined(날짜 칸 미적용).
 */
function resolveComputeDateRange(
  rawSince: unknown,
  rawUntil: unknown,
  query: string,
  now: Date,
): { since: string; until: string } | undefined {
  if (
    typeof rawSince === "string" &&
    ISO_DATE.test(rawSince) &&
    typeof rawUntil === "string" &&
    ISO_DATE.test(rawUntil)
  ) {
    return { since: rawSince, until: rawUntil };
  }
  const auto = eventDateRange(query, now);
  return auto ?? undefined;
}

/** 한 노드를 집계 응답용 경량 항목으로 매핑(표/목록 렌더 입력). */
function toComputeItem(node: {
  id: number;
  content: string;
  createdAt: string;
  eventAt: string | null;
  projectId: string | null;
}) {
  return {
    id: node.id,
    content: node.content,
    createdAt: node.createdAt,
    eventAt: node.eventAt,
    projectId: node.projectId,
  };
}

export function registerComputeRoutes(app: Hono, deps: MemoryApiDeps): void {
  const { store } = deps;

  // ── POST /compute — 계산 경로(목록·개수·시간순·누적) ──────────────────────
  app.post("/compute", async (c) => {
    let body: ComputeBody;
    try {
      body = await c.req.json<ComputeBody>();
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    if (!isPositiveString(body.query)) {
      return err(c, 400, "query must be a non-empty string");
    }
    const query = body.query;
    const now = new Date();

    // 집계 종류 판정 — 명시 kind 우선(대시보드 위젯이 종류 직접 선택), 없으면 query
    // 의도 감지(detectComputeIntent). sum·avg 는 단계5 제외(Q1=C)라 감지에서 빠진다.
    const explicitKind = parseKind(body.kind);
    let intent: ComputeIntent;
    if (explicitKind) {
      intent = { kind: explicitKind, matched: [explicitKind] };
    } else {
      const detected = detectComputeIntent(query, now);
      if (detected === null) {
        // 집계 의도가 없다 — 찾기 경로(/search)가 맞는 질의다. 계산 경로는 집계
        // 의도가 잡힐 때만 동작한다(별 입구 — 찾기 경로에 영향 0).
        return err(
          c,
          400,
          "no aggregate intent detected — use /search for similarity queries",
        );
      }
      intent = detected;
    }

    // 칸 해석(D2) — 종류·기간·장소. 명시 칸 우선, 날짜·장소는 query 자동 추출 보조.
    const dateRange = resolveComputeDateRange(
      body.since,
      body.until,
      query,
      now,
    );
    const place = resolveComputePlace(parsePlaceField(body.place), query, store);
    const projectId =
      typeof body.project === "string" && body.project.trim().length > 0
        ? body.project.trim()
        : undefined;

    const fields: ComputeFields = {
      conceptValue: parseConceptValue(body.filter),
      since: dateRange?.since,
      until: dateRange?.until,
      place,
      projectId,
    };

    // sum·avg 는 합산할 숫자형 칸(field)이 필수 — 부재면 어느 칸을 합할지 모름(정직 거부).
    let numeric:
      | {
          field: string;
          avgDivisor?: {
            unit: AvgDivisorUnit;
            since: string;
            until: string;
          };
        }
      | undefined;
    if (intent.kind === "sum" || intent.kind === "avg") {
      const field = typeof body.field === "string" ? body.field.trim() : "";
      if (!field) {
        return err(c, 400, "field required for sum/avg");
      }
      const unit =
        intent.kind === "avg" ? parseAvgDivisorUnit(body.avgDivisor) : undefined;
      if (unit) {
        // 분모 B(시간단위당)는 기간이 필수 — 0 위장·분모 A 대체 폴백 없이 명시 거부.
        if (!dateRange) {
          return err(
            c,
            400,
            "period required for time-unit average — specify since/until or a date phrase in query",
          );
        }
        numeric = {
          field,
          avgDivisor: { unit, since: dateRange.since, until: dateRange.until },
        };
      } else {
        numeric = { field }; // 분모 A(글당) 또는 sum.
      }
    }

    // 후보 교집합(D3). 칸 0개면 전 노드 폭주 차단 — "조건 필요"를 정직하게 회신한다.
    const { candidates, needsCondition } = resolveComputeCandidates(
      store,
      fields,
    );
    if (needsCondition) {
      return c.json(
        {
          error: "condition required",
          needsCondition: true,
          kind: intent.kind,
        },
        400,
      );
    }

    // 집계(D4) — 종류별 명시 정렬. 빈 후보면 count 0·빈 목록(정직한 빈 상태).
    const result = await computeAggregate(intent, candidates, store, numeric);

    return c.json({
      query,
      kind: result.kind,
      count: result.count,
      orderedBy: result.orderedBy,
      items: result.items.map(toComputeItem),
      // sum/avg 전용 칸(나머지 종류는 undefined 라 직렬화에서 빠짐 — byte 동일).
      value: result.value,
      numericFieldPresent: result.numericFieldPresent,
      readCount: result.readCount,
      excludedCount: result.excludedCount,
      avgDivisor: result.avgDivisor,
      avgDivisorKind: result.avgDivisorKind,
    });
  });
}
