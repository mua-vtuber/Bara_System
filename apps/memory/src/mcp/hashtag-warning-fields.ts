/**
 * mcp/hashtag-warning-fields.ts — MCP 저장 5종 응답의 해시태그 경고 칸 조립
 * (2026-10-21 mcp-usage-and-guidance spec 12.4, P19, 20.3).
 *
 * 순서(저장 도구 한 번 안에서):
 *   1. 저장 전 — applyWriteGuard 를 지난 글과 project 인자로 prepareHashtagCheck. 저장될 프로젝트를 저장 경로와
 *      같은 함수(predictWriteProject → planProjectAttachment)로 미리 본다. 저장 뒤에는 타입 배치가 프로젝트
 *      행을 새로 만들 수 있어 판정이 바뀌기 때문이다(memory/hashtag-chain-check.ts checkProjectAmbiguityBeforeSave).
 *   2. 저장(saveSharedMemoryInput) — 1의 계획을 projectPlanForSave 로 넘겨 잠금 밖 검사가 다시 조회하지 않게 한다.
 *   3. 저장 후 — hashtagWarningFields(사전 확인, 저장 갈래) 를 응답에 펼친다.
 *
 * 분석할 글은 쓰기 관문(applyWriteGuard)을 지난 글이다 — 원문을 그대로 되돌려 보내지 않는다.
 * 경고가 없으면 칸을 아예 싣지 않는다(evidenceOmitted 양식). 분석이 실패해도 저장 결과는 그대로
 * 돌려주고 hashtagWarningsError 로 실패를 드러낸다 — 저장은 이미 끝났으므로 도구 실패로 돌려주면
 * AI 가 다시 저장해 중복 기억이 생긴다(spec P3 와 같은 논리). 경고가 없는 것처럼 꾸미지 않는다.
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import { analyzeHashtagChain, type HashtagWarning } from "../memory/hashtag-chain-check.ts";
import type { HashtagSavedAs } from "../memory/hashtag-chain-messages.ts";
import { predictWriteProject, type WriteProjectPrediction } from "../memory/project-attachment-plan.ts";
import { normalizeProjectId } from "../memory/project-scope.ts";
import type { SharedMemoryWriteOptions } from "../server-internal/shared-memory-write.ts";

/** 한 응답에 싣는 경고 최대 개수 — 넘으면 앞에서부터 이만큼과 hashtagWarningsTruncated. */
export const HASHTAG_WARNINGS_MAX = 20;

export interface HashtagWarningFields {
  hashtagWarnings?: HashtagWarning[];
  hashtagWarningsTruncated?: true;
  hashtagWarningsError?: string;
}

/** 저장 전 확인 결과. 확인이 실패했으면 그 문구를 들고 있다가 저장 뒤 응답에 싣는다. */
export type HashtagPreCheck =
  | { content: string; prediction: WriteProjectPrediction }
  | { content: string; error: string };

function failure(e: unknown): string {
  return `Hashtag check failed: ${e instanceof Error ? e.message : String(e)}`;
}

/** 저장 전에 부른다. 조회 실패는 던지지 않고 결과에 담는다(저장은 막지 않는다). */
export async function prepareHashtagCheck(
  store: SqliteMemoryStore,
  guardedContent: string,
  projectArgument: string | null | undefined,
): Promise<HashtagPreCheck> {
  try {
    const prediction = await predictWriteProject(store, guardedContent, normalizeProjectId(projectArgument ?? null));
    return { content: guardedContent, prediction };
  } catch (e) {
    return { content: guardedContent, error: failure(e) };
  }
}

/** 저장 함수에 넘길 선택 — 사전 확인이 성공했으면 그 계획을 넘겨 잠금 밖 검사가 다시 조회하지 않게 한다. */
export function projectPlanForSave(pre: HashtagPreCheck): SharedMemoryWriteOptions {
  return "error" in pre ? {} : { projectPlan: pre.prediction.plan };
}

/** 저장 뒤 응답에 펼칠 칸. 경고가 없으면 빈 객체. */
export function hashtagWarningFields(pre: HashtagPreCheck, savedAs: HashtagSavedAs): HashtagWarningFields {
  if ("error" in pre) return { hashtagWarningsError: pre.error };
  let warnings: HashtagWarning[];
  try {
    warnings = analyzeHashtagChain(pre.content, {
      savedAs,
      projectPlan: pre.prediction.plan,
      overriddenArgument: pre.prediction.overriddenArgument,
    });
  } catch (e) {
    return { hashtagWarningsError: failure(e) };
  }
  if (warnings.length === 0) return {};
  if (warnings.length <= HASHTAG_WARNINGS_MAX) return { hashtagWarnings: warnings };
  return { hashtagWarnings: warnings.slice(0, HASHTAG_WARNINGS_MAX), hashtagWarningsTruncated: true };
}

/** 실패 응답 details 에 싣는 경고 칸 — 있을 때만. */
export function hashtagWarningDetails(pre: HashtagPreCheck, savedAs: HashtagSavedAs): Record<string, unknown> | undefined {
  const fields = hashtagWarningFields(pre, savedAs);
  return Object.keys(fields).length > 0 ? { ...fields } : undefined;
}
