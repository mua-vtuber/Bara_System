/**
 * memory/node-sources/source-ref.ts — 기억 노드 출처 목록(memory_node_sources)의 출처 종류·키·입력 판정.
 *
 * 기억 노드마다 서버가 관리하는 "이 내용을 저장한 출처" 목록을 둔다(WP-B1-20T 설계 3절). 이 파일은
 * 그 목록 한 행이 무엇을 뜻하는지(종류), 한 노드 안에서 행을 가르는 키를 어떻게 만드는지, 저장 입력
 * 하나가 어떤 출처인지를 한 곳에서 정한다. 표에 쓰고 읽는 코드는 db/store-internal/node-source-repository.ts.
 *
 * 출처 종류:
 *   - message:      외부 메시지(Discord 등)가 저장한 내용. 메시지 삭제·수정 동기화의 대상. 글 행 키
 *                   `msg:<platform>:<messageId>`, 그 메시지의 첨부(파일·이미지)는 첨부마다 키
 *                   `msg:<platform>:<messageId>:att:<attachmentId>`(WP-B1-20U 설계 17.8). 메시지 삭제는 kind·external_id
 *                   조회로 글 행과 첨부 행을 함께 찾고, 글 수정(PATCH by-source)의 "이 메시지 행"은 글 행뿐이다.
 *                   message 키의 칸(platform·messageId·attachmentId)에는 구분자 `:` 가 들 수 없다(WP-B1-20U 설계 17.18 설계 7) —
 *                   들면 서로 다른 (메시지, 첨부) 쌍이 한 키로 섞인다. 경계가 messageSourceInputProblem·sourceKeyPartProblem 으로
 *                   400 을 내고, 빠진 경계는 sourceKeyOf 가 throw 한다. direct_save·restore 키는 대상이 아니다.
 *   - direct_save:  메시지 id 없는 직접 저장(대시보드·REST·MCP·Pet·봇 명령·문서·이미지). (채널, 작성자)마다 한 행.
 *                   키 `save:<channel>:<actor>`.
 *   - restore:      사용자가 휴지통에서 되살림(명시적 보존 의사). 키 `restore:<actor>`.
 *   - archived_lineage (보관표 전용): 휴지통으로 간 파생 노드가 어느 계보 부모에서 왔는지. 키 `lineage:<parentId>`.
 *
 * 기준 스키마(01-memory-nodes.sql)의 kind CHECK 목록은 SQL 리터럴로 적는다. 목록이 바뀌면 v48+ 마이그레이션으로
 * 표를 다시 만들고, baseline-schema.memory-nodes.test.ts 가 CHECK 목록과 아래 상수를 대조한다.
 */

import type { Provenance } from "../provenance-vocabulary.ts";
import { readSourceMessageId, SOURCE_MESSAGE_ID_KEY } from "../source-message.ts";

/** 살아 있는 노드의 출처 종류(memory_node_sources.kind CHECK 와 같은 목록). */
export const NODE_SOURCE_KINDS = ["message", "direct_save", "restore"] as const;

export type NodeSourceKind = (typeof NODE_SOURCE_KINDS)[number];

/** 보관표 전용 종류 — 휴지통으로 간 파생 노드의 계보 부모 기록. 되살릴 때 출처로 돌아가지 않는다. */
export const ARCHIVED_LINEAGE_KIND = "archived_lineage";

/** 보관 출처 표(memory_node_sources_archive.kind)가 받는 종류. */
export type ArchivedNodeSourceKind = NodeSourceKind | typeof ARCHIVED_LINEAGE_KIND;

/** 출처 키의 칸을 가르는 구분자. message 키의 칸 값에는 들 수 없다. */
export const SOURCE_KEY_DELIMITER = ":";

const MESSAGE_KEY_PREFIX = "msg";
const ATTACHMENT_KEY_INFIX = "att";
const DIRECT_SAVE_KEY_PREFIX = "save";
const RESTORE_KEY_PREFIX = "restore";
const ARCHIVED_LINEAGE_KEY_PREFIX = "lineage";

/**
 * 표시·감사용 부가 정보(detail_json). 판정에는 쓰지 않는다. attachmentId 는 첨부 행의 표시 칸이자, 행을 참조로
 * 되돌릴 때 키를 다시 만드는 재료다(키 문자열을 쪼개 읽지 않는다).
 */
export interface NodeSourceDetail {
  channelId?: string | null;
  guildId?: string | null;
  attachmentId?: string;
  channel?: string;
  actor?: string;
  reason?: string;
}

/**
 * 저장 입력이 함께 보낸 외부 메시지(WP-B1-20U 설계 17.8) — POST /ingest 의 sourceMessage. 첨부(파일·이미지)면
 * attachmentId 가 있어 출처 행 키가 첨부마다 갈린다.
 */
export interface InputSourceMessage {
  platform: string;
  messageId: string;
  channelId?: string | null;
  guildId?: string | null;
  attachmentId?: string;
}

export interface NodeSourceRef {
  kind: NodeSourceKind;
  /** 한 노드 안에서 유일한 정규 키. sourceKeyOf 로만 만든다. */
  key: string;
  /** message 만. 소문자·trim, 모르면 null. */
  platform: string | null;
  /** message: messageId. 그 밖은 참고용 외부 id(없으면 null). */
  externalId: string | null;
  detail: NodeSourceDetail;
}

/** 노드 저장·흡수 한 번의 출처. */
export type NodeProvenance =
  | { kind: "source"; source: NodeSourceRef }
  | {
      kind: "derived";
      /** 계보 부모. null 은 부모 없는 파생(테스트·평가 도구 전용 — 운영 코드는 부모나 source 를 준다). */
      parentId: number | null;
      relation: "merged_into" | "parent_of";
      edgeProvenance: Provenance;
      /** 이번 파생의 원문. 이 노드로는 흡수하지 않는다(자기 주장 규칙이 따로 처리). */
      extractionOriginId?: number;
    };

/** sourceKeyOf 가 키를 만드는 재료. 종류마다 키에 들어가는 칸이 다르다. */
export type SourceKeyParts =
  | { kind: "message"; platform: string | null; messageId: string; attachmentId?: string }
  | { kind: "direct_save"; channel: string; actor: string }
  | { kind: "restore"; actor: string };

/** 구분자를 받을 수 없는 message 키의 칸. 문구의 칸 이름이다. */
export type SourceKeyField = "messageId" | "attachmentId" | "platform";

/**
 * message 키의 한 칸 값에 구분자가 있으면 400·도구 오류·throw 가 모두 쓰는 문구, 없거나 값이 없으면 null.
 * 문구는 칸 이름만 다르다: `messageId must not contain ":" (source key delimiter)`.
 */
export function sourceKeyPartProblem(field: SourceKeyField, value: string | null | undefined): string | null {
  if (value === null || value === undefined || !value.includes(SOURCE_KEY_DELIMITER)) return null;
  return `${field} must not contain "${SOURCE_KEY_DELIMITER}" (source key delimiter)`;
}

/** message 키를 이루는 세 칸을 messageId → attachmentId → platform 순서로 보아 처음 걸린 문구. */
function messageKeyPartsProblem(parts: { messageId: string; attachmentId?: string; platform: string | null }): string | null {
  return (
    sourceKeyPartProblem("messageId", parts.messageId) ??
    sourceKeyPartProblem("attachmentId", parts.attachmentId) ??
    sourceKeyPartProblem("platform", parts.platform)
  );
}

/**
 * 출처 행의 정규 키. 같은 노드에 같은 키가 두 번 들어가지 않는다(표의 기본 키). message 는 attachmentId 가 있으면
 * 첨부 키(`msg:<platform>:<messageId>:att:<attachmentId>`), 없으면 글 행 키다. message 의 칸에 구분자가 있으면
 * sourceKeyPartProblem 과 같은 문구로 throw 한다(경계가 먼저 400 으로 막아야 하는 값 — 빠진 경계는 500).
 */
export function sourceKeyOf(parts: SourceKeyParts): string {
  switch (parts.kind) {
    case "message": {
      const problem = messageKeyPartsProblem(parts);
      if (problem !== null) throw new Error(problem);
      const textKey = `${MESSAGE_KEY_PREFIX}:${parts.platform ?? ""}:${parts.messageId}`;
      return parts.attachmentId === undefined ? textKey : `${textKey}:${ATTACHMENT_KEY_INFIX}:${parts.attachmentId}`;
    }
    case "direct_save":
      return `${DIRECT_SAVE_KEY_PREFIX}:${parts.channel}:${parts.actor}`;
    case "restore":
      return `${RESTORE_KEY_PREFIX}:${parts.actor}`;
  }
}

/** 보관표 archived_lineage 행의 키. */
export function archivedLineageKeyOf(parentId: number): string {
  return `${ARCHIVED_LINEAGE_KEY_PREFIX}:${parentId}`;
}

/**
 * 플랫폼 이름 정규화 — 앞뒤 공백을 자르고 소문자로. 문자열이 아니거나 비면 null(모름).
 * 저장 행과 조회 인자가 같은 규칙을 거쳐야 "Discord" 와 "discord" 가 같은 플랫폼으로 맞는다.
 */
export function normalizePlatform(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  return normalized === "" ? null : normalized;
}

/** 문자열의 첫 구분자 앞부분을 정규화한 플랫폼. 구분자가 없으면 문자열 전체. */
function platformPrefix(raw: unknown, separator: RegExp): string | null {
  if (typeof raw !== "string") return null;
  const [head] = raw.trim().split(separator, 1);
  return normalizePlatform(head);
}

/**
 * 메시지 출처의 플랫폼(설계 3.3). 순서대로 처음 알 수 있는 값:
 *   1) metadata.platform(비지 않은 문자열)
 *   2) metadata.source 의 첫 `-` 앞(예: "discord-channel" → "discord")
 *   3) 입력 source(args.source)의 첫 `:`·`-` 앞
 * 모두 없으면 null. 옛 일치 규칙(metadata.platform === platform, source === platform,
 * source 가 `platform-` 로 시작)과 같은 플랫폼을 낸다.
 */
export function messagePlatformOf(input: {
  source?: string;
  metadata?: Record<string, unknown>;
}): string | null {
  return (
    normalizePlatform(input.metadata?.platform) ??
    platformPrefix(input.metadata?.source, /-/) ??
    platformPrefix(input.source, /[:-]/)
  );
}

/** metadata 의 채널·서버 id 표시(문자열·숫자)를 문자열로. 없거나 다른 모양이면 null. */
function readMarkerId(metadata: Record<string, unknown> | undefined, key: "channelId" | "guildId"): string | null {
  const raw = metadata?.[key];
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return String(raw);
  return null;
}

/**
 * 메시지 출처 참조 — message 행의 참조는 모두 이 함수가 만든다(WP-B1-20U 설계 17.8). 플랫폼은 정규화하고, 키는
 * attachmentId 가 있으면 첨부 키, 없으면 글 행 키다. detail 의 attachmentId 는 첨부일 때만 둔다.
 */
export function messageSourceRef(parts: {
  platform: string | null;
  messageId: string;
  channelId: string | null;
  guildId: string | null;
  attachmentId?: string;
  channel: string;
  actor: string;
}): NodeSourceRef {
  const platform = normalizePlatform(parts.platform);
  const detail: NodeSourceDetail = { channelId: parts.channelId, guildId: parts.guildId };
  if (parts.attachmentId !== undefined) detail.attachmentId = parts.attachmentId;
  detail.channel = parts.channel;
  detail.actor = parts.actor;
  return {
    kind: "message",
    key: sourceKeyOf({ kind: "message", platform, messageId: parts.messageId, attachmentId: parts.attachmentId }),
    platform,
    externalId: parts.messageId,
    detail,
  };
}

/**
 * 입력이 실어 온 외부 메시지의 metadata 표시 칸(messageId·channelId·guildId). 메시지 삭제가 노드를 남길 때
 * 이 칸들을 거둔다(source-message.ts SOURCE_MESSAGE_MARKER_KEYS). 모르는 채널·서버 id 는 null.
 */
export function sourceMessageMarkers(message: InputSourceMessage): Record<string, unknown> {
  return { [SOURCE_MESSAGE_ID_KEY]: message.messageId, channelId: message.channelId ?? null, guildId: message.guildId ?? null };
}

/** 저장 입력 하나(args.source, author, metadata, sourceMessage) — describeInputSource 와 messageSourceInputProblem 의 입력. */
export interface InputSourceInput {
  source: string;
  author?: string;
  metadata?: Record<string, unknown>;
  sourceMessage?: InputSourceMessage | null;
}

/** 입력이 message 출처일 때 키·표시를 이루는 값(플랫폼은 정규화 전). */
interface PickedMessageSource {
  platform: string | null;
  messageId: string;
  channelId: string | null;
  guildId: string | null;
  attachmentId?: string;
}

/**
 * 입력이 message 출처인가 — 순서대로: 1) sourceMessage(POST /ingest 첨부·글이 실어 온 외부 메시지, 첨부면 attachmentId),
 * 2) metadata 의 messageId(글 행, 플랫폼은 messagePlatformOf). 둘 다 없으면 null(직접 저장). 출처 판정과 경계 검사가 같은
 * 값을 보도록 describeInputSource 와 messageSourceInputProblem 이 함께 쓴다.
 */
function pickMessageSource(input: Partial<InputSourceInput>): PickedMessageSource | null {
  if (input.sourceMessage) {
    const { platform, messageId, channelId, guildId, attachmentId } = input.sourceMessage;
    return { platform, messageId, channelId: channelId ?? null, guildId: guildId ?? null, attachmentId };
  }
  const messageId = readSourceMessageId(input.metadata);
  if (messageId === null) return null;
  return {
    platform: messagePlatformOf(input),
    messageId,
    channelId: readMarkerId(input.metadata, "channelId"),
    guildId: readMarkerId(input.metadata, "guildId"),
  };
}

/**
 * 저장 입력의 직접 저장 출처(args.source, author, metadata, sourceMessage). 순서대로:
 *   1) sourceMessage(POST /ingest 첨부·글이 실어 온 외부 메시지)가 있으면 그 message 출처(첨부면 첨부 키).
 *   2) metadata 에 messageId 가 있으면 message 출처(글 행 키, 플랫폼은 messagePlatformOf).
 *   3) 없으면 (channel = source, actor = author) 의 direct_save.
 * author 가 없으면 actor 는 빈 문자열.
 */
export function describeInputSource(input: InputSourceInput): NodeSourceRef {
  const actor = input.author ?? "";
  const picked = pickMessageSource(input);
  if (picked !== null) return messageSourceRef({ ...picked, channel: input.source, actor });
  return {
    kind: "direct_save",
    key: sourceKeyOf({ kind: "direct_save", channel: input.source, actor }),
    platform: null,
    externalId: null,
    detail: { channel: input.source, actor },
  };
}

/**
 * 저장 입력이 만들 message 키의 칸(messageId·첨부 id·플랫폼 — describeInputSource 가 고르는 값과 같다)에 구분자가 있으면
 * 400·도구 오류의 문구, 없거나 message 출처가 아니면(직접 저장) null. 저장 경계가 describeInputSource 를 부르기 전에 쓴다.
 * 칸을 모르는 경계(POST /ingest 는 sourceMessage 만)는 source 를 비운다.
 */
export function messageSourceInputProblem(input: Partial<InputSourceInput>): string | null {
  const picked = pickMessageSource(input);
  if (picked === null) return null;
  return messageKeyPartsProblem({ ...picked, platform: normalizePlatform(picked.platform) });
}

/** 휴지통 복원이 더하는 출처 — 되살린 사람의 명시적 보존 의사. */
export function restoreSourceRef(actor: string): NodeSourceRef {
  return {
    kind: "restore",
    key: sourceKeyOf({ kind: "restore", actor }),
    platform: null,
    externalId: null,
    detail: { actor },
  };
}
