/**
 * routes/search-timing.ts — /search 한 번마다 남기는 `[search-timing]` 로그 한 줄의 형식
 * (speed-step1 spec 5.2). 순수 함수만 둔다: 시간을 재는 일은 search-service.ts /
 * search-retrieval.ts 가 하고, 여기는 잰 값을 줄 글로 바꾸기만 한다.
 *
 * 값이 없는 칸(돌지 않은 단계·캐시에서 꺼낸 검색의 retriever 단계)은 0 이 아니라 `-`.
 * 질의 글은 줄에 넣지 않는다(길이만) — 기억 내용을 로그로 흘리지 않기 위해서다.
 */

import type { RetrieveStageTimings } from "../../memory/stage-timer.ts";
import type { RerankStats } from "../../memory/reranker.ts";

/** 로그 줄 머리말. 시험과 운영 로그 검색이 같은 글을 쓴다. */
export const SEARCH_TIMING_LOG_PREFIX = "[search-timing]";

/** retrieval 한 pass 의 흔적. 캐시에서 꺼냈으면 timings 는 null(캐시에는 시간을 저장하지 않는다). */
export interface SearchRetrievalPassTrace {
  pass: "strict" | "relaxed";
  cacheHit: boolean;
  ms: number;
  timings: RetrieveStageTimings | null;
}

/** 갈래마다 다른 뒤쪽 단계. index 갈래는 enrich 이후를 통째로 건너뛴다. */
export type SearchTimingTail =
  | { kind: "index"; indexMs: number }
  | {
      kind: "full";
      enrichMs: number;
      postMs: number;
      /** 새 종류가 없어 건너뛰었으면 null. */
      entity: { ms: number; embedMs: number | null } | null;
      /** 컨텍스트 예산 0 이라 조립하지 않았으면 null. */
      assembleMs: number | null;
    };

export interface SearchTimingRecord {
  totalMs: number;
  floorOn: boolean;
  queryChars: number;
  resultCount: number;
  retrievalMs: number;
  passes: SearchRetrievalPassTrace[];
  ancillaryMs: number;
  /** 리랭커가 꺼져 있으면 null. */
  rerank: { ms: number; stats: RerankStats } | null;
  floorMs: number;
  tail: SearchTimingTail;
}

const NO_VALUE = "-";

function ms(value: number | null): string {
  return value === null ? NO_VALUE : `${Math.round(value)}ms`;
}

function plain(value: number | null): string {
  return value === null ? NO_VALUE : String(value);
}

function yesNo(value: boolean | null): string {
  if (value === null) return NO_VALUE;
  return value ? "yes" : "no";
}

function formatPass(trace: SearchRetrievalPassTrace): string {
  const t = trace.timings;
  const fields = [
    trace.pass,
    `cache=${trace.cacheHit ? "hit" : "miss"}`,
    `prep=${ms(t?.prepMs ?? null)}`,
    `embed=${ms(t?.embedMs ?? null)}(hit=${yesNo(t?.embedCacheHit ?? null)})`,
    `plan=${ms(t?.planMs ?? null)}`,
    `vecfts=${ms(t?.vectorFtsMs ?? null)}`,
    `concept=${ms(t?.conceptMs ?? null)}`,
    `image=${ms(t?.imageVecMs ?? null)}`,
    `project=${ms(t?.projectMs ?? null)}`,
    `person=${ms(t?.personMs ?? null)}`,
    `graph=${ms(t?.graphMs ?? null)}`,
    `score=${ms(t?.scoreMs ?? null)}`,
    `touch=${ms(t?.touchMs ?? null)}`,
  ];
  return `[${fields.join(" ")}]`;
}

function formatRerank(rerank: SearchTimingRecord["rerank"]): string {
  if (!rerank) return `rerank=${NO_VALUE}[off]`;
  const s = rerank.stats;
  return (
    `rerank=${ms(rerank.ms)}[scored=${s.scored ? "yes" : "no"} pairs=${s.pairs} ` +
    `seqLen=${plain(s.seqLen)} tokenize=${ms(s.tokenizeMs)} infer=${ms(s.inferMs)}]`
  );
}

function formatTail(tail: SearchTimingTail): string {
  if (tail.kind === "index") return `index=${ms(tail.indexMs)}`;
  const entity = tail.entity
    ? `entity=${ms(tail.entity.ms)}[embed=${ms(tail.entity.embedMs)}]`
    : `entity=${NO_VALUE}[skipped]`;
  return `enrich=${ms(tail.enrichMs)} post=${ms(tail.postMs)} ${entity} assemble=${ms(tail.assembleMs)}`;
}

/** 레코드를 줄바꿈 없는 로그 한 줄로 바꾼다. */
export function formatSearchTimingLine(record: SearchTimingRecord): string {
  const head =
    `${SEARCH_TIMING_LOG_PREFIX} total=${ms(record.totalMs)} mode=${record.tail.kind} ` +
    `floor=${record.floorOn ? "on" : "off"} queryChars=${record.queryChars} results=${record.resultCount}`;
  const passes = record.passes.map(formatPass).join(" ");
  return [
    head,
    `retrieval=${ms(record.retrievalMs)}${passes}`,
    `ancillary=${ms(record.ancillaryMs)}`,
    formatRerank(record.rerank),
    `floor=${ms(record.floorMs)}`,
    formatTail(record.tail),
  ].join(" ");
}
