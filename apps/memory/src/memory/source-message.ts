/**
 * memory/source-message.ts — 노드 metadata 의 출처 메시지 표시(외부 메시지 식별자) 읽기·제거.
 *
 * 외부 어댑터(Discord 봇 buildBaseMetadata)는 저장 입력 metadata 에 messageId·channelId·guildId 와
 * source 를 싣는다. 입력의 출처 판정(node-sources/source-ref.ts describeInputSource)이 이 칸에서
 * messageId 를 읽고, 출처 삭제가 노드를 남길 때는 이 표시만 거둔다 — 지워진 메시지를 더는 가리키지
 * 않게. "누가 이 내용을 저장했는가"는 metadata 가 아니라 서버 전용 출처 표(memory_node_sources)가
 * 맡는다(WP-B1-20T).
 */

/** 출처 메시지 식별자 칸. */
export const SOURCE_MESSAGE_ID_KEY = "messageId";

/**
 * 출처 메시지를 가리키는 칸 — 메시지가 지워지면 함께 거둔다. source(어느 통로로 들어왔는가)·user_id·
 * platform 은 본문의 출처 기록이라 남긴다.
 */
export const SOURCE_MESSAGE_MARKER_KEYS = [SOURCE_MESSAGE_ID_KEY, "channelId", "guildId"] as const;

/**
 * metadata 의 messageId 를 문자열로 읽는다. 숫자로 저장된 id(JSON 숫자)도 같은 문자열로 본다 —
 * 입력 출처 판정(describeInputSource)과 출처 삭제의 표시 거두기(deleteBySource)가 같은 정규화를 쓴다.
 * 없거나 다른 모양이면 null.
 */
export function readSourceMessageId(metadata: Record<string, unknown> | undefined): string | null {
  const raw = metadata?.[SOURCE_MESSAGE_ID_KEY];
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return String(raw);
  return null;
}

/** 출처 메시지 표시를 뺀 metadata. 표시가 없으면 같은 객체를 돌려준다. */
export function withoutSourceMessageMarker(metadata: Record<string, unknown>): Record<string, unknown> {
  if (!SOURCE_MESSAGE_MARKER_KEYS.some((key) => key in metadata)) return metadata;
  const rest = { ...metadata };
  for (const key of SOURCE_MESSAGE_MARKER_KEYS) delete rest[key];
  return rest;
}
