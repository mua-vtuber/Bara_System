import type { BotConfig } from "./config.ts";
import type {
  EditBySourceArgs,
  EditBySourceAttachmentRemoval,
  EditBySourceResult,
} from "../../memory/src/api-client-types.ts";
import { assetCleanupFailureLines } from "./asset-cleanup-log.ts";

export interface EditableDiscordMessageLike {
  id: string;
  /**
   * discord.js 부분 메시지(캐시에 없던 메시지)면 true. 부분 메시지는 첨부 목록을 모르므로 보내지 않는다 — 빈 목록을
   * 보내면 그 메시지의 첨부 기억이 모두 지워진다(WP-B1-20U 설계 17.9). index.ts 가 fetch 로 채운 뒤에만 넘긴다.
   */
  partial?: boolean;
  content?: string | null;
  /** 메시지의 첨부(discord.js Collection, 값의 id 가 첨부 id). 수정 뒤 남은 첨부 전부다. */
  attachments: ReadonlyMap<string, { id: string }>;
  channelId: string;
  guildId?: string | null;
  author?: {
    id: string;
    bot?: boolean;
    tag?: string;
  } | null;
  channel: {
    isDMBased(): boolean;
  };
}

export interface EditBySourceClient {
  editBySource(args: EditBySourceArgs): Promise<EditBySourceResult>;
}

export type MessageEditSyncResult =
  | { status: "ignored"; reason: string }
  | {
      status: "synced";
      changed: boolean;
      matchedCount: number;
      editedCount: number;
      editedIds: number[];
      skippedIds: number[];
      attachmentRemoval: EditBySourceAttachmentRemoval;
    };

/**
 * 주인이 메모 채널·DM 에서 고친 메시지를 코어에 동기화한다. 글(있으면)과 수정 뒤 남은 첨부 id 전부를 함께 보낸다 —
 * 코어가 목록에서 빠진 첨부의 기억을 메시지 삭제와 같은 규칙으로 지운다(WP-B1-20U 설계 17.9). 글이 빈 메시지(첨부만)는
 * content 없이 보낸다.
 */
export async function syncEditedDiscordMessage(
  message: EditableDiscordMessageLike,
  config: BotConfig,
  client: EditBySourceClient,
): Promise<MessageEditSyncResult> {
  if (message.partial === true) {
    return { status: "ignored", reason: "partial message (attachment list unknown)" };
  }
  if (message.author?.bot) {
    return { status: "ignored", reason: "bot author" };
  }
  if (!message.author) {
    return { status: "ignored", reason: "missing author" };
  }
  if (message.author.id !== config.ownerUserId) {
    return { status: "ignored", reason: "non-owner author" };
  }

  const isMemoChannel = message.channelId === config.memoChannelId;
  const isOwnerDm = message.channel.isDMBased();
  if (!isMemoChannel && !isOwnerDm) {
    return { status: "ignored", reason: "outside memo channel" };
  }

  const content = message.content?.trim() ?? "";
  if (content.startsWith("/")) {
    return { status: "ignored", reason: "raw slash command" };
  }

  const request = {
    messageId: message.id,
    platform: "discord",
    attachmentIds: [...message.attachments.values()].map((attachment) => attachment.id),
    reason: "discord message edit",
    editor: message.author.id,
    source: "discord",
  };
  const result = await client.editBySource(content.length > 0 ? { ...request, content } : request);

  return {
    status: "synced",
    changed: result.changed,
    matchedCount: result.matchedCount,
    editedCount: result.editedCount,
    editedIds: result.editedIds,
    skippedIds: result.skippedIds,
    attachmentRemoval: result.attachmentRemoval,
  };
}

/**
 * 수정 동기화 결과 로그 — 맞춘·고친·건너뛴 기억 수, 뺀 첨부 수와 그 때문에 지운 기억 수, 코어가 지우지 못한 첨부
 * 파일마다 경고(메시지 삭제의 logMessageDeleteSync 와 같은 경고 줄). index.ts 가 800줄 상한을 넘어 여기 둔다.
 */
export function logMessageEditSync(
  prefix: string,
  messageId: string,
  result: Extract<MessageEditSyncResult, { status: "synced" }>,
): void {
  const removal = result.attachmentRemoval;
  const removedMemories = removal.deletedIds.length + removal.derivedDeletedIds.length + removal.archivePurgedIds.length;
  console.log(
    `${prefix} synced edit: message ${messageId} → matched ${result.matchedCount}, edited ${result.editedCount}, ` +
      `skipped ${result.skippedIds.length}, removed attachments ${removal.removedAttachmentKeys.length} ` +
      `(memory rows ${removedMemories})`,
  );
  for (const line of assetCleanupFailureLines(`message ${messageId} edit`, removal.assetCleanup)) {
    console.warn(`${prefix} ${line}`);
  }
}
