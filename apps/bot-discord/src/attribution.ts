/**
 * Attribution 3차원 helper — spec section 4.5 정합.
 *
 * 메모리에 박히는 세 필드:
 *   - `author`         = display name (변할 수 있는, 사람이 읽는 별명)
 *   - `metadata.user_id` = 영구 식별자 (Discord user_id 등, 닉 바뀌어도 동일)
 *   - `metadata.source`  = 어댑터 식별자 (예: "discord-channel", "discord-dm")
 *
 * 옛 패턴 ("author = user_id") 은 닉네임 변경 시 옛 메모와 매칭 끊김 →
 * spec "이름은 흐르고 정체성은 노드에 영구" 정신 어긋남.
 *
 * 본 모듈은 Discord 메시지/Interaction 에서 위 세 값을 일관되게 뽑는다.
 * mock 없이 순수 함수만 노출 — fixture 데이터로 단위 검증 가능.
 */

/**
 * Discord 메시지 author 와 GuildMember (선택) 의 최소 인터페이스.
 * discord.js 의 Message 객체가 자연스럽게 만족 — 타입 정밀하게 import
 * 안 하고 슬림 형태로 받아 helper 가 테스트 가능.
 */
export interface DiscordAuthorLike {
  id: string;
  username: string;
  globalName?: string | null;
}

export interface DiscordMemberLike {
  displayName?: string | null;
}

/**
 * display name 우선순위:
 *   1. GuildMember.displayName (서버별 닉네임 — 채널 컨텍스트에서 가장 정확)
 *   2. User.globalName (Discord 새 시스템 글로벌 display name, 2023+)
 *   3. User.username (legacy username, 항상 존재)
 *
 * 빈 문자열 / null 도 다음 단계로 fallback.
 */
export function resolveDisplayName(
  author: DiscordAuthorLike,
  member?: DiscordMemberLike | null,
): string {
  const memberName = member?.displayName?.trim();
  if (memberName) return memberName;
  const global = author.globalName?.trim();
  if (global) return global;
  return author.username;
}

export interface BuildBaseMetadataArgs {
  author: DiscordAuthorLike;
  member?: DiscordMemberLike | null;
  /** 메시지의 source. DM 이면 "discord-dm", 채널이면 "discord-channel" 등. */
  source: string;
  /** Discord 메시지 ID — 삭제 시 자동 청소용. 일부 경로(slash command)는 없음. */
  messageId?: string;
  channelId?: string | null;
  guildId?: string | null;
}

/**
 * 메모리 노드 metadata 에 박을 base. Attribution 3차원의 두 번째 (user_id) +
 * 세 번째 (source) 포함 + Discord 컨텍스트 (messageId / channelId / guildId).
 *
 * 자식 노드 (extractor 가 본문 분해해서 생성하는 atomic 메모리들) 도
 * extractor.buildChildMetadata 가 spread 로 통과시키므로 user_id 가
 * 자동 전파됨.
 */
export function buildBaseMetadata(
  args: BuildBaseMetadataArgs,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    source: args.source,
    user_id: args.author.id,
  };
  if (args.messageId) metadata.messageId = args.messageId;
  if (args.channelId !== undefined) metadata.channelId = args.channelId ?? null;
  if (args.guildId !== undefined) metadata.guildId = args.guildId ?? null;
  return metadata;
}
