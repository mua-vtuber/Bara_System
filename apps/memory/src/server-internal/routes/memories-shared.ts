/**
 * routes/memories-shared.ts — /memories 계열 라우트 공용 헬퍼.
 *
 * routes/memories.ts 를 책임 경계로 분할하며 옮겨 온 모듈이다(P3 G5-a —
 * docs/decisions/2026-07-03-structure-cleanup-spec.md). body 칸 정규화·편집 가능
 * 여부 상수·태그 보존 본문 조립·편집 후 재배선(rewire)을 담는다. 라우트 등록은
 * memories.ts 파사드가 하위 등록기(crud/edit/append/delete/from-text)를 순서대로 부른다.
 *
 * SA-0 — REST 쓰기의 신뢰 경계(자유 metadata 의 서버 관리 칸 거부, 토큰 권한별 작성자
 * 결정)도 여기 둔다. 저장 라우트 셋(POST /memories·append·from-text)이 같은 규칙을 쓴다.
 */

import type { Context } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { err } from "../http-helpers.ts";
import { MCP_ADAPTER_ID_VAR, MCP_TOKEN_SCOPE_VAR } from "../auth-gate.ts";
import { findServerOwnedMetadataKey, PreparedExtractionMismatchError } from "../save-input.ts";
import { rechunkEditedOrigin } from "../save-input-plain.ts";
import { autoLinkMentions } from "../../memory/auto-mention.ts";
import { normalizeEditableBody } from "../../memory/claim-text.ts";
import { messageSourceInputProblem, type InputSourceInput } from "../../memory/node-sources/source-ref.ts";
import { wireHashtagConceptsSafe } from "../../memory/hashtag-wiring.ts";
import { wireEntityPlacementSafe } from "../../memory/entity-placement-wiring.ts";
import { wireHashtagEntitiesSafe } from "../../memory/hashtag-entity-wiring.ts";

// 편집 본문 정규화의 단일 출처는 memory/claim-text.ts 다(저장소 계층도 쓴다). 라우트 호출처는
// 이 모듈에서 가져오던 경로 그대로 쓴다.
export { normalizeEditableBody };

export const UNEDITABLE_SOURCE_TYPES = new Set(["document", "image_asset"]);
const PLAIN_TAG_RE = /^[\p{L}\d_]{1,64}$/u;

/**
 * WP-B1-08 — 잠금 밖에서 준비한 즉시 추출 결과를 잠금 안에서 쓸 수 없게 된 경우(요청 도중 같은
 * 본문 기억이 사라짐 등). 아무것도 저장하지 않았으므로 409 + code 로 다시 보내라고 알린다.
 * 해당 오류가 아니면 null.
 */
export function preparedExtractionConflictResponse(c: Context, e: unknown): Response | null {
  if (!(e instanceof PreparedExtractionMismatchError)) return null;
  return c.json({ code: e.code, error: e.message }, 409);
}

export function optionalTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function objectBody(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * REST 자유 metadata 읽기 (SA-0). 객체가 아니면 빈 객체로 읽는다(기존 동작). 서버 관리 칸
 * (sharedMemory·extracted·extractedTo)이 있으면 조용히 버리지 않고 400 으로 거부한다 —
 * 가시성·백필 판정이 믿는 서버 기록이라 클라이언트가 채우면 개정 번호·상태·계보를
 * 위조할 수 있다. 근거는 evidence 칸으로만 받는다.
 */
export function parseClientMetadata(c: Context, value: unknown): Record<string, unknown> | Response {
  const metadata = objectBody(value);
  const serverOwnedKey = findServerOwnedMetadataKey(metadata);
  if (serverOwnedKey === undefined) return metadata;
  return c.json({
    code: "INVALID_INPUT",
    error: `metadata.${serverOwnedKey} 칸은 서버가 관리합니다 — 근거는 evidence로 보내세요`,
  }, 400);
}

/**
 * 저장 입력이 만들 message 출처 키의 칸(messageId·첨부 id·플랫폼)에 키 구분자 `:` 가 있으면 400 (WP-B1-20U 설계 17.18
 * 설계 7). 판정은 source-ref.ts messageSourceInputProblem 한 곳이다 — 저장 라우트 셋(POST /memories·append·from-text)이 같은
 * 문구를 낸다. message 출처가 아니거나 칸이 맞으면 null.
 */
export function sourceKeyDelimiterResponse(c: Context, input: InputSourceInput): Response | null {
  const problem = messageSourceInputProblem(input);
  return problem === null ? null : err(c, 400, problem);
}

/** 신고 값이 비어 있지 않은가 — undefined·null·빈 문자열은 신고하지 않은 것으로 본다. */
function isClaimed(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function forbiddenClaim(c: Context, field: string): Response {
  return c.json({ code: "FORBIDDEN", error: `제한 토큰은 ${field}를 지정할 수 없습니다` }, 403);
}

export interface RestWriter {
  /** 기록할 행위자 이름(노드 author·수정 이력 editor). */
  writer: string;
  /** 제한 토큰(full 이 아닌 scope)이라 행위자가 토큰 adapterId 로 고정됐는가. */
  restricted: boolean;
}

export interface RestWriterOptions {
  /** 거부 사유에 넣을 body 칸 이름. 기본 "author". */
  field?: string;
  /** 근거(evidence)가 있는 저장 — full 토큰도 신고 대신 토큰 adapterId 를 쓴다. */
  pinToToken?: boolean;
}

/**
 * REST 쓰기 행위자 결정 (SA-0). MCP 가 행위자를 토큰에서 고정하듯, 같은 토큰으로 REST 를
 * 불러도 다른 작성자를 사칭하지 못하게 한다.
 *
 * - 인증 게이트가 신원을 싣지 않은 요청(게이트 없이 조립한 앱): 호출자 신고를 그대로 쓴다.
 *   운영 조립(index.ts)은 보호 경로의 무토큰 요청을 게이트가 401 로 막아 여기 오지 않는다.
 * - full(scope 칸 없는 옛 토큰은 SseTokenStore.getTokenScope 가 full 로 읽는다): 신고 허용 —
 *   Discord 봇처럼 다른 사람의 글을 중계하는 관리 어댑터. pinToToken 이면 토큰 adapterId
 *   (근거가 있는 인증 저장은 검증된 토큰으로 작성자를 기록하는 SHARED_MEMORY.md 계약).
 * - 그 밖의 scope(mcp-standard 등 제한 토큰): 행위자 = 토큰 adapterId. 다른 값을 신고하면 403.
 *
 * 게이트가 adapterId 만 싣고 scope 를 빠뜨렸다면 배선 결함이라 500 으로 드러낸다.
 */
export function resolveRestWriter(
  c: Context,
  claimed: unknown,
  options: RestWriterOptions = {},
): RestWriter | Response {
  const adapterId = c.get(MCP_ADAPTER_ID_VAR);
  const claimedWriter = typeof claimed === "string" ? claimed : "";
  if (adapterId === undefined) return { writer: claimedWriter, restricted: false };
  const scope = c.get(MCP_TOKEN_SCOPE_VAR);
  if (scope === undefined) {
    return err(c, 500, `인증 게이트가 토큰 ${adapterId}의 권한(scope)을 전달하지 않았습니다`);
  }
  if (scope === "full") {
    return { writer: options.pinToToken === true ? adapterId : claimedWriter, restricted: false };
  }
  if (isClaimed(claimed) && claimed !== adapterId) {
    return forbiddenClaim(c, options.field ?? "author");
  }
  return { writer: adapterId, restricted: true };
}

export interface RestAttribution {
  /** 노드 author 칸. */
  author: string;
  /** 작성자 영구 ID(metadata.user_id). 사람 노드 authored_by 연결 판단에 쓴다. */
  userId: string;
}

/**
 * REST 저장 작성자 정보 (SA-0). 작성자 이름은 resolveRestWriter 규칙을 따른다. 작성자 영구
 * ID(metadata.user_id)는 사람 노드 authored_by 연결과 별칭 추가에 쓰이므로 같은 규칙을
 * 받는다 — 제한 토큰은 사람을 대신해 쓰지 않으므로(MCP 저장이 AI 클라이언트를 사람 노드에
 * 연결하지 않는 것과 같다) user_id 를 보내면 403 이다. full·게이트 없는 조립은 기존대로
 * metadata.user_id 를 쓴다.
 */
export function resolveRestAttribution(
  c: Context,
  claimed: { author: unknown; metadata: Record<string, unknown> },
  options: Pick<RestWriterOptions, "pinToToken"> = {},
): RestAttribution | Response {
  const writer = resolveRestWriter(c, claimed.author, options);
  if (writer instanceof Response) return writer;
  const userId = claimed.metadata.user_id;
  if (writer.restricted) {
    if (isClaimed(userId)) return forbiddenClaim(c, "metadata.user_id");
    return { author: writer.writer, userId: "" };
  }
  return { author: writer.writer, userId: typeof userId === "string" ? userId : "" };
}

export function contentWithPreservedTags(content: string, tags: readonly string[]): string {
  const clean = normalizeEditableBody(content);
  if (tags.length === 0) return clean;
  if (clean.length === 0) return tags.join(" ");
  return `${clean}\n\n${tags.join(" ")}`;
}

export function normalizePlainTagInput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const withoutHash = trimmed.startsWith("#") ? trimmed.slice(1).trim() : trimmed;
  if (!PLAIN_TAG_RE.test(withoutHash)) return null;
  return withoutHash.toLowerCase();
}

/**
 * 편집·태그 추가로 본문이 바뀐 노드의 해시태그·엔티티·mention 배선을 다시 잇는다.
 * 옛 memories.ts 의 registerMemoriesRoutes 안 내부 함수를 그대로 옮겼다 — store 는
 * 등록 시점 고정 의존, deps.autoCleanupTrigger·deps.getSettings 는 호출 시점 동적
 * lookup(구조분해 금지).
 *
 * SL-2 — 마지막에 원문의 청크를 현재 본문에 맞춘다(rechunkEditedOrigin). 호출자는 편집과
 * 같은 쓰기 잠금 안에서 부른다(REST 편집 라우트 전체와 MCP 수정 도구가 잠금을 쥔다). 편집은
 * 이미 커밋됐으므로 재청크 실패는 500 으로 되돌리지 않고 warnings 에 구체 사유로 싣는다.
 * 재청크는 한 트랜잭션이라 실패하면 아무 청크도 남지 않고, 원문은 청크 없이 추출 대기로 남는다.
 * 백필(스케줄러·POST /cleanup)은 그런 긴 원문을 통째로 추출하지 않고 잠금 안에서 재청크한다(WP-B1-31).
 */
export async function rewireEditedNodeContent(
  store: MemoryApiDeps["store"],
  deps: MemoryApiDeps,
  id: number,
  content: string,
): Promise<string[]> {
  const warnings: string[] = [];
  await wireHashtagConceptsSafe(
    store,
    id,
    content,
    deps.autoCleanupTrigger,
    "edit-memory",
  );
  await wireHashtagEntitiesSafe(
    store,
    id,
    content,
    deps.autoCleanupTrigger,
    "edit-memory",
    new Date(),
    "hashtag",
  );
  await wireEntityPlacementSafe(
    store,
    id,
    content,
    deps.autoCleanupTrigger,
    "edit-memory",
    null,
    "hashtag",
  );
  try {
    await autoLinkMentions(store, { id, content });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`mention wiring failed: ${msg}`);
  }
  try {
    const chunking = deps.getSettings?.().chunking;
    await rechunkEditedOrigin(
      store,
      id,
      chunking
        ? { tokenCap: chunking.tokenCap, minChunkTokens: chunking.minChunkTokens }
        : undefined,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[edit-memory] 기억 ${id} 재청크 실패 (${msg}) — 편집은 반영됨, 다음 백필(주기 실행 또는 POST /cleanup) 때 다시 재청크`);
    warnings.push(`rechunk failed: ${msg}`);
  }
  return warnings;
}

/**
 * 본문이 바뀐 편집 직후 충돌 재검사 — deps.conflictChecker.recheckAfterEdit 위임.
 *
 * 저장 경로(extractor)만 충돌을 보던 구멍의 편집 측 보완: 편집으로 새로 충돌 band 에
 * 든 상대가 있으면 contradicts 엣지가 생기고 편집한 기억이 disputed 가 된다. 기존
 * 엣지(contradicts·supersedes)는 편집이 충돌을 풀어도 지우지 않는다. 벡터는
 * editNodeContent 가 이미 계산해 vec_nodes 에 넣은 것을 getVectorById 로 재사용
 * — 재임베딩 0회. 호출자는 본문 무변경 early-return *뒤*에서만 부른다(무변경
 * 편집 = 충돌 작업 0). 태그 추가 라우트(POST /memories/:id/tags)는 부르지
 * 않는다 — 태그는 글의 주장 내용을 바꾸지 않으므로 충돌 관계도 안 바뀐다.
 *
 * deps.conflictChecker 는 호출 시점 동적 lookup(구조분해 금지) — 미주입이면
 * 재검사 없이 빈 배열(extractor 미주입과 같은 옵션 기능 관례). 실패는 편집이
 * 이미 커밋된 뒤라 500 으로 되돌리지 않고 mention wiring 선례대로 응답
 * warnings 에 구체 사유로 노출한다.
 */
export async function recheckEditedNodeConflicts(
  store: MemoryApiDeps["store"],
  deps: MemoryApiDeps,
  id: number,
): Promise<string[]> {
  const checker = deps.conflictChecker;
  if (!checker) return [];

  const warnings: string[] = [];
  try {
    const node = await store.getNode(id);
    if (!node) {
      throw new Error(`memory ${id} not found after edit`);
    }
    const vector = await store.getVectorById(id);
    if (!vector) {
      throw new Error(`vec_nodes row missing for memory ${id}`);
    }
    await checker.recheckAfterEdit({
      nodeId: id,
      content: node.content,
      author: node.author,
      memoryType: node.memoryType,
      newVector: vector,
      projectId: node.projectId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`conflict recheck failed: ${msg}`);
  }
  return warnings;
}
