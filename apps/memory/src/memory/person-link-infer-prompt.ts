/**
 * person-link-infer-prompt.ts — 사람 연결 단계의 프롬프트 조립 + infer fn + 응답 파싱.
 *
 * person-link-infer-cycle.ts 에서 프롬프트·파싱·토큰 추정 부분을 떼어낸 모듈(파일 크기
 * 800줄 상한 정합 — 사이클 오케스트레이션과 프롬프트 계약의 책임 분리). 사이클은 후보
 * 검출·원장·커버리지·자동연결/제안을 맡고, 이 모듈은 LLM 에 보낼 프롬프트 문자열과 응답
 * JSON 파싱·microbatch 추정만 맡는다. 공개 이름(createOllamaPersonLinkInferFn 등)은
 * person-link-infer-cycle.ts 가 re-export 해 옛 소비처(index.ts) 호환을 보존한다.
 */

import type { CleanupLlmExecutor } from "./cleanup-deep-pass/cleanup-llm-executor.ts";
import {
  runOutcomeToNonOk,
  type StageInferResult,
} from "./cleanup-deep-pass/stage-execution.ts";
import { estimateTextTokens } from "./cleanup-deep-pass/input-estimate.ts";
import {
  CLEANUP_STAGE_TEMPERATURE,
  cleanupStageLlmLimitsOf,
} from "./cleanup-deep-pass/stage-constants.ts";
import type {
  PersonLinkDecision,
  PersonLinkInferFn,
  PersonLinkInferInput,
  PersonLinkNodeContext,
  PersonLinkPersonContext,
} from "./person-link-infer-cycle.ts";

/**
 * LLM 출력 한도(정상 호출·잘림 재호출)·온도·top-K 사전 필터 상한 — stage-constants.ts
 * CLEANUP_STAGE_LLM_LIMITS person_link 항목이 단일 출처(spec 5.B-3, DCL-2 — 설정 승격 0).
 */
const PERSON_LINK_STAGE_LIMITS = cleanupStageLlmLimitsOf("person_link");

const INFER_TEMPERATURE = CLEANUP_STAGE_TEMPERATURE;
const INFER_MAX_OUTPUT_TOKENS = PERSON_LINK_STAGE_LIMITS.maxOutputTokens;
/**
 * person_link 잘림 재호출 출력 상한(spec 5.B-3 person_link maxOutputTokensCap, 상수 맵
 * 단일 출처) — 실행층이 max_tokens 잘림 시 이 값을 상한으로 재호출.
 */
const INFER_MAX_OUTPUT_TOKENS_CAP = PERSON_LINK_STAGE_LIMITS.maxOutputTokensCap;

const PERSON_LINK_SYSTEM_PROMPT = [
  "너는 메모의 사람 연결을 정리하는 데이터 정리 AI다.",
  "너는 새 사람을 만들 수 없다. 아래 people 목록에 있는 personId 중 하나만 선택할 수 있다.",
  "사람인지 캐릭터/마스코트/봇/앱/프로젝트인지 애매하면 연결하지 않는다.",
  "이름, 별칭, 관계, 직업/속성, 본문 맥락을 함께 보고 기존 사람 1명으로 확실할 때만 고른다.",
  "동명이인·후보 여러 명·근거 부족이면 personId 를 null 로 둔다.",
  "",
  "회신은 JSON 배열만. 각 원소:",
  '{"nodeId":숫자,"personId":"기존 personId 또는 null","confidence":0~1,"candidateText":"본문 후보","evidence":"근거 한 줄"}',
].join("\n");

/**
 * CleanupLlmExecutor 를 받아 PersonLinkInferFn 을 만든다. cleanup 슬롯 LLM(강한 모델)은
 * 실행층 안에 있고(Task 4 배선), 이 함수는 프롬프트만 조립해 executor.run() 에 넘긴다 —
 * 재시도·잘림 재호출·usage 누적·예산은 실행층이 맡는다.
 *
 * 회신은 StageInferResult<PersonLinkDecision[]>. 파싱 실패는 throw 가 아니라 deterministic
 * 결과로 회신한다(글루가 입력 노드 전건을 결정적 실패로 원장에 기록 — silent 0건 위장 금지).
 * 이름 createOllamaPersonLinkInferFn 은 옛 소비처 호환으로 유지하나, 실행층은 cleanup 슬롯의
 * 3 provider 어느 것이든 감싼다(ollama 한정 아님).
 */
export function createOllamaPersonLinkInferFn(
  executor: CleanupLlmExecutor,
): PersonLinkInferFn {
  return async (input): Promise<StageInferResult<PersonLinkDecision[]>> => {
    const outcome = await executor.run({
      messages: [
        { role: "system", content: PERSON_LINK_SYSTEM_PROMPT },
        { role: "user", content: renderPersonLinkPrompt(input) },
      ],
      maxOutputTokens: INFER_MAX_OUTPUT_TOKENS,
      maxOutputTokensCap: INFER_MAX_OUTPUT_TOKENS_CAP,
      temperature: INFER_TEMPERATURE,
    });
    if (outcome.kind !== "ok") return runOutcomeToNonOk<PersonLinkDecision[]>(outcome);
    try {
      return { kind: "ok", parsed: parsePersonLinkResponse(outcome.text) };
    } catch (e) {
      return {
        kind: "deterministic",
        reason: `person_link 응답 파싱 실패: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  };
}

function renderPersonLinkPrompt(input: PersonLinkInferInput): string {
  const people = input.people.map(renderPersonLine);
  const nodes = input.nodes.map(renderNodeLine);
  return `people:\n${people.join("\n")}\n\nnodes:\n${nodes.join("\n")}`;
}

/** 사람 한 명의 프롬프트 줄(공유 명단 요소 — 추정 오버헤드도 이 줄 기준). */
function renderPersonLine(p: PersonLinkPersonContext): string {
  const aliases = p.aliases.length > 0 ? p.aliases.join(", ") : "-";
  const attrs =
    p.attributes.length > 0
      ? p.attributes.map((a) => `${a.category ?? "라벨"}:${a.name}`).join(", ")
      : "-";
  return `- ${p.personId}: 이름=${p.displayName}; 별칭=${aliases}; 라벨=${attrs}`;
}

/** 노드 한 개의 프롬프트 줄(배치 원소 비용 — 추정도 이 줄 기준). */
function renderNodeLine(n: PersonLinkNodeContext): string {
  const candidates =
    n.personCandidates.length > 0 ? n.personCandidates.join(", ") : "-";
  const existing =
    n.existingPersonIds.length > 0 ? n.existingPersonIds.join(", ") : "-";
  return `- node ${n.id}: 후보=${candidates}; 기존연결=${existing}; 내용="${n.content}"`;
}

/**
 * microbatch 공유 오버헤드(추정 토큰) — system 프롬프트 + 사람 명단은 배치마다 다시 실린다.
 * "people:"·"nodes:" 프레이밍 몫도 여유로 더해 과소 추정을 피한다(추정은 과대가 안전).
 */
export function personLinkFixedOverheadTokens(
  people: readonly PersonLinkPersonContext[],
): number {
  const peopleBlock = people.map(renderPersonLine).join("\n");
  return (
    estimateTextTokens(PERSON_LINK_SYSTEM_PROMPT) +
    estimateTextTokens(peopleBlock) +
    estimateTextTokens("people:\n\nnodes:\n")
  );
}

/** 한 노드가 microbatch 에서 차지하는 추정 입력 토큰(그 노드 프롬프트 줄 기준). */
export function estimatePersonLinkNodeTokens(node: PersonLinkNodeContext): number {
  return estimateTextTokens(renderNodeLine(node));
}

export function parsePersonLinkResponse(raw: string): PersonLinkDecision[] {
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
  const out: PersonLinkDecision[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.nodeId !== "number" || !Number.isInteger(o.nodeId)) continue;
    const personId =
      typeof o.personId === "string"
        ? o.personId
        : o.personId === null
          ? null
          : "";
    const confidence =
      typeof o.confidence === "number" ? o.confidence : Number.NaN;
    out.push({
      nodeId: o.nodeId,
      personId,
      confidence,
      candidateText: trimOptional(o.candidateText),
      evidence: trimOptional(o.evidence),
      reason: trimOptional(o.reason),
    });
  }
  return out;
}

/** 문자열이면 trim, 빈 문자열·비문자열이면 undefined(선택 칸 정규화). */
export function trimOptional(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
