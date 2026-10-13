/**
 * web/dashboard/graph/shell/search/compute-api.ts
 * 계산 경로 래퍼 — compute-tab 의 opts.concept 를 body.filter:{종류} 로 감싼다(함정 A).
 * index.html api.compute(1245~1262)의 동작을 그대로 옮긴다. 종류 키는 한국어 "종류".
 * /compute 라우트가 filter 객체 첫 값을 종류로 읽으므로(compute.ts parseConceptValue),
 * 이 매핑을 누락하면 종류 필터가 통째로 안 먹혀 모든 글이 집계되는 잘못된 결과가 난다
 * (silent 결함). 누락 방지는 compute-api.test.ts 가 fixture 로 검증한다.
 */
import { apiFetch } from "../../../api-fetch.ts";

/** compute-tab.js buildComputePayloadOpts 가 내보내는 opts 모양(= /compute 전송 입력). */
export interface ComputeOpts {
  query?: string;
  kind?: string; // op(count|sum|avg) — buildComputePayloadOpts 의 opts.kind.
  concept?: string; // 집계 대상 종류 → filter:{ 종류: concept }.
  project?: string;
  since?: string;
  until?: string;
  place?: string;
  field?: string;
  avgDivisor?: string;
}

/**
 * opts → POST /compute body. concept 는 filter:{종류} 로 감싼다(index.html api.compute 정합).
 * query 부재면 빈 문자열로 채운다(index.html `const body = { query }` 와 같은 양식 —
 * 라우트 isPositiveString 검증은 빈 문자열을 400 으로 거르므로 조건 없는 호출을 막는다).
 */
export function buildComputeBody(opts: ComputeOpts): Record<string, unknown> {
  const { query, kind, concept, project, since, until, place, field, avgDivisor } = opts;
  const body: Record<string, unknown> = { query: query ?? "" };
  if (kind) body["kind"] = kind;
  if (concept) body["filter"] = { 종류: concept };
  if (project) body["project"] = project;
  if (since) body["since"] = since;
  if (until) body["until"] = until;
  if (place) body["place"] = place;
  if (field) body["field"] = field;
  if (avgDivisor) body["avgDivisor"] = avgDivisor;
  return body;
}

/**
 * POST /compute. 비2xx 면 throw 한다(빈 위장 0·No-fallback). 2xx 인데 body 를 JSON 으로
 * 파싱하지 못해도 빈 객체로 위장하지 않고 구체 실패로 던진다. 라우트가 JSON body 에
 * error 문구를 담아 400 을 주므로 그 문구를 message 로 올려 호출부가 localizeComputeError
 * 로 한국어로 옮길 수 있게 한다. 응답 가공은 안 한다 — describeComputeResult 가 세 경우를
 * 정직하게 가르는 데 필요한 칸(value·numericFieldPresent·readCount·excludedCount 등)을
 * 그대로 넘긴다.
 */
export async function postCompute(
  apiBase: string,
  opts: ComputeOpts,
): Promise<Record<string, unknown>> {
  const res = await apiFetch(`${apiBase}/compute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildComputeBody(opts)),
  });
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // 비2xx·파싱 실패도 아래에서 구체 실패로 던진다(빈 위장 0).
    body = null;
  }
  if (!res.ok) {
    const detail =
      body && typeof body["error"] === "string"
        ? (body["error"] as string)
        : `${res.status} ${res.statusText}`;
    throw new Error(detail);
  }
  if (body === null) {
    throw new Error(`${res.status} 응답 body 를 JSON 으로 파싱하지 못했습니다.`);
  }
  return body;
}
