/**
 * lens-draft-infer-prompt.ts — 렌즈 소비 단계의 프롬프트 조립 + infer fn + 응답 파싱.
 *
 * lens-draft-cycle.ts 에서 프롬프트·파싱·토큰 추정 부분을 떼어낸 모듈(파일 크기 상한 정합
 * — 사이클 오케스트레이션과 프롬프트 계약의 책임 분리, person-link-infer-prompt.ts 선례).
 * 사이클은 후보 검출·원장·커버리지·사전 필터·제안 insert 를 맡고, 이 모듈은 LLM 에 보낼
 * 프롬프트 문자열과 응답 JSON 파싱·microbatch 추정만 맡는다.
 *
 * 프롬프트 계약(features 문서 구조화 초안 예시 + spec 6.C-2 불변식):
 *   - 각 엔티티에 대해 렌즈가 광고한 columns·labels·relations·metadata 키만 채운다.
 *   - 빈 칸만 채우고(fill-only), 없거나 애매하면 빈 값으로 둔다.
 *   - 관계 대상·사람은 기존 id 만(문자열 이름 금지), 새 사람·엔티티 생성 금지.
 *   - 렌즈 밖 키를 만들면 서버 사전 필터(validateDraftShape)가 거부한다.
 */

import type { CleanupLlmExecutor } from "./cleanup-llm-executor.ts";
import {
  runOutcomeToNonOk,
  type StageInferResult,
} from "./stage-execution.ts";
import { estimateTextTokens } from "./input-estimate.ts";
import {
  CLEANUP_STAGE_TEMPERATURE,
  cleanupStageLlmLimitsOf,
} from "./stage-constants.ts";
import { isRecord } from "./lens-apply-plan.ts";
import type {
  LensDraftDecision,
  LensDraftEntityContext,
  LensDraftInferFn,
  LensDraftInferInput,
} from "./lens-draft-cycle.ts";

const LENS_DRAFT_STAGE_LIMITS = cleanupStageLlmLimitsOf("lens_draft");
const INFER_TEMPERATURE = CLEANUP_STAGE_TEMPERATURE;
const INFER_MAX_OUTPUT_TOKENS = LENS_DRAFT_STAGE_LIMITS.maxOutputTokens;
const INFER_MAX_OUTPUT_TOKENS_CAP = LENS_DRAFT_STAGE_LIMITS.maxOutputTokensCap;

const LENS_DRAFT_SYSTEM_PROMPT = [
  "너는 메모의 엔티티 구조화를 정리하는 데이터 정리 AI다.",
  "각 엔티티의 렌즈(채울 수 있는 columns·labels·relations·metadata 키)와 근거 원문을 보고, 빈 칸에 들어갈 값을 채운다.",
  "렌즈에 없는 키는 절대 만들지 않는다. 광고된 키만 채운다.",
  "이미 채워진 칸은 건드리지 않는다(빈 칸만).",
  "관계 대상과 사람은 새로 만들 수 없다 — 기존 id 객체만 쓴다(문자열 이름 금지).",
  "새 사람·새 엔티티를 등록하지 않는다. 마스코트·캐릭터·봇·앱은 사람 관계칸에 넣지 않는다.",
  "근거가 없거나 애매한 칸은 빈 값으로 둔다(지어내지 않는다).",
  "",
  "회신은 JSON 배열만. 각 원소:",
  '{"typeName":"엔티티 종류","entityId":"기존 entityId","values":{"columns":{},"labels":{},"relations":{},"metadata":{}}}',
].join("\n");

/**
 * CleanupLlmExecutor 를 받아 LensDraftInferFn 을 만든다. cleanup 슬롯 LLM(강한 모델)은
 * 실행층 안에 있고, 이 함수는 프롬프트만 조립해 executor.run() 에 넘긴다 — 재시도·잘림
 * 재호출·usage 누적·예산은 실행층이 맡는다. 파싱 실패는 throw 가 아니라 deterministic
 * 결과로 회신한다(글루가 입력 엔티티 전건을 결정적 실패로 원장에 기록 — silent 위장 금지).
 */
export function createLensDraftInferFn(
  executor: CleanupLlmExecutor,
): LensDraftInferFn {
  return async (input): Promise<StageInferResult<LensDraftDecision[]>> => {
    const outcome = await executor.run({
      messages: [
        { role: "system", content: LENS_DRAFT_SYSTEM_PROMPT },
        { role: "user", content: renderLensDraftPrompt(input) },
      ],
      maxOutputTokens: INFER_MAX_OUTPUT_TOKENS,
      maxOutputTokensCap: INFER_MAX_OUTPUT_TOKENS_CAP,
      temperature: INFER_TEMPERATURE,
    });
    if (outcome.kind !== "ok") return runOutcomeToNonOk<LensDraftDecision[]>(outcome);
    try {
      return { kind: "ok", parsed: parseLensDraftResponse(outcome.text) };
    } catch (e) {
      return {
        kind: "deterministic",
        reason: `lens_draft 응답 파싱 실패: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  };
}

function renderLensDraftPrompt(input: LensDraftInferInput): string {
  return input.entities.map(renderEntityBlock).join("\n\n");
}

/** 한 엔티티의 프롬프트 블록(렌즈 계약 + 현 상태 + 근거 원문). 추정도 이 블록 기준. */
function renderEntityBlock(ctx: LensDraftEntityContext): string {
  const columns = ctx.lens.columns
    .map((c) => `${c.key}(${c.dataType})`)
    .join(", ");
  const labels = ctx.lens.attributeKeys.join(", ") || "-";
  const relations = ctx.lens.relations
    .map((r) => `${r.key}→${r.targetTypes.join("|")}`)
    .join(", ") || "-";
  const metadata = ctx.lens.metadataKeys.join(", ") || "-";
  const filled =
    Object.keys(ctx.filledColumns).length > 0
      ? Object.entries(ctx.filledColumns)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")
      : "-";
  const empty = ctx.emptyColumnKeys.join(", ") || "-";
  const evidence =
    ctx.evidence.length > 0
      ? ctx.evidence.map((e) => `  - node ${e.nodeId}: "${e.content}"`).join("\n")
      : "  - (근거 노드 없음)";
  return [
    `## entity ${ctx.entityId} (종류=${ctx.typeName}, 이름=${ctx.name})`,
    `채울 수 있는 columns: ${columns || "-"}`,
    `채울 수 있는 labels: ${labels}`,
    `채울 수 있는 relations: ${relations}`,
    `채울 수 있는 metadata: ${metadata}`,
    `이미 채워진 칸: ${filled}`,
    `아직 빈 칸: ${empty}`,
    `근거 원문:`,
    evidence,
  ].join("\n");
}

/**
 * microbatch 공유 오버헤드(추정 토큰) — system 프롬프트는 배치마다 다시 실린다. lens_draft
 * 는 person_link 와 달리 공유 명단이 없어(엔티티별 렌즈가 블록 안에 실림) 고정 몫이 system
 * 프롬프트뿐이다.
 */
export function lensDraftFixedOverheadTokens(): number {
  return estimateTextTokens(LENS_DRAFT_SYSTEM_PROMPT);
}

/** 한 엔티티가 microbatch 에서 차지하는 추정 입력 토큰(그 엔티티 프롬프트 블록 기준). */
export function estimateLensDraftCandidateTokens(
  ctx: LensDraftEntityContext,
): number {
  return estimateTextTokens(renderEntityBlock(ctx));
}

/**
 * LLM 응답에서 JSON 배열을 뽑아 LensDraftDecision[] 로 파싱한다. 배열을 못 찾거나 파싱에
 * 실패하면 throw(글루가 deterministic 실패로 원장에 기록 — silent 0건 위장 금지). 각
 * 원소는 typeName·entityId(문자열) + values(columns·labels·relations·metadata 객체)를
 * 요구한다. 값 형식·렌즈 밖 키 검증은 여기서 안 하고 사이클의 사전 필터(validateDraftShape)
 * 가 맡는다 — 이 파서는 *모양* 만 맞추고 의미 검증은 적용 측 단일 출처에 위임한다.
 */
export function parseLensDraftResponse(raw: string): LensDraftDecision[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end < start) {
    throw new Error(
      `LLM 응답에서 JSON 배열을 못 찾음 (앞 80자: ${JSON.stringify(raw.slice(0, 80))})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    throw new Error(
      `LLM 응답 JSON 파싱 실패: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("LLM 응답이 배열이 아님");
  }
  const out: LensDraftDecision[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    const typeName = typeof item.typeName === "string" ? item.typeName.trim() : "";
    const entityId = typeof item.entityId === "string" ? item.entityId.trim() : "";
    if (!typeName || !entityId) continue;
    out.push({
      typeName,
      entityId,
      values: normalizeValues(item.values),
    });
  }
  return out;
}

/**
 * values 필드를 columns·labels·relations·metadata 네 객체로 정규화한다. 누락·비객체 칸은
 * 빈 객체로(모양만 맞춤 — 렌즈 밖 키 거부는 사전 필터가 맡는다). 이 정규화는 지어내지
 * 않는다: 없는 값을 채우는 게 아니라, 파서가 늘 네 칸 있는 값 묶음을 돌려주게 해 하류
 * (validateDraftShape·isEmptyDraft)가 옵셔널 체이닝 없이 읽게 한다.
 */
function normalizeValues(raw: unknown): LensDraftDecision["values"] {
  const record = isRecord(raw) ? raw : {};
  return {
    columns: isRecord(record.columns) ? record.columns : {},
    labels: isRecord(record.labels) ? record.labels : {},
    relations: isRecord(record.relations) ? record.relations : {},
    metadata: isRecord(record.metadata) ? record.metadata : {},
  };
}
