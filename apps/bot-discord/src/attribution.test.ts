/**
 * Attribution helper 단위 테스트.
 *
 * mock 객체 없음 (CLAUDE.md 정책) — fixture data 로 순수 함수 검증.
 * Discord.js 구체 타입이 아닌 슬림 interface 만 따져 helper 가 테스트 가능.
 */

import { describe, expect, test } from "bun:test";
import { buildBaseMetadata, resolveDisplayName } from "./attribution.ts";

describe("resolveDisplayName — 우선순위", () => {
  test("GuildMember.displayName 가 가장 우선", () => {
    const result = resolveDisplayName(
      { id: "123", username: "legacy_name", globalName: "Global Name" },
      { displayName: "서버닉" },
    );
    expect(result).toBe("서버닉");
  });

  test("GuildMember 없으면 (DM 케이스) globalName 사용", () => {
    const result = resolveDisplayName({
      id: "123",
      username: "legacy_name",
      globalName: "Global Name",
    });
    expect(result).toBe("Global Name");
  });

  test("globalName 없으면 username 으로 fallback", () => {
    const result = resolveDisplayName({
      id: "123",
      username: "legacy_name",
    });
    expect(result).toBe("legacy_name");
  });

  test("displayName 빈 문자열은 globalName 으로 fallback", () => {
    const result = resolveDisplayName(
      { id: "123", username: "legacy_name", globalName: "Global Name" },
      { displayName: "   " },
    );
    expect(result).toBe("Global Name");
  });

  test("globalName=null 도 안전 — username 으로 fallback", () => {
    const result = resolveDisplayName({
      id: "123",
      username: "legacy_name",
      globalName: null,
    });
    expect(result).toBe("legacy_name");
  });
});

describe("buildBaseMetadata — Attribution 3차원 + Discord 컨텍스트", () => {
  test("DM 케이스 — source=discord-dm + user_id + messageId 만", () => {
    const meta = buildBaseMetadata({
      author: { id: "user_42", username: "alice" },
      source: "discord-dm",
      messageId: "msg_99",
    });
    expect(meta).toEqual({
      source: "discord-dm",
      user_id: "user_42",
      messageId: "msg_99",
    });
  });

  test("채널 메시지 — channelId + guildId 포함", () => {
    const meta = buildBaseMetadata({
      author: { id: "user_42", username: "alice" },
      source: "discord-channel",
      messageId: "msg_99",
      channelId: "ch_1",
      guildId: "guild_x",
    });
    expect(meta).toEqual({
      source: "discord-channel",
      user_id: "user_42",
      messageId: "msg_99",
      channelId: "ch_1",
      guildId: "guild_x",
    });
  });

  test("guildId=null 명시 시 그대로 null (DM 에서 guildId 가 null)", () => {
    const meta = buildBaseMetadata({
      author: { id: "user_42", username: "alice" },
      source: "discord-dm",
      messageId: "msg_99",
      channelId: "ch_dm",
      guildId: null,
    });
    expect(meta.guildId).toBeNull();
    expect(meta.channelId).toBe("ch_dm");
  });

  test("Slash command 케이스 — messageId 없어도 정상", () => {
    const meta = buildBaseMetadata({
      author: { id: "user_42", username: "alice" },
      source: "discord-slash-extract",
      channelId: "ch_1",
      guildId: "guild_x",
    });
    expect(meta).toEqual({
      source: "discord-slash-extract",
      user_id: "user_42",
      channelId: "ch_1",
      guildId: "guild_x",
    });
    expect(meta.messageId).toBeUndefined();
  });

  test("user_id 가 author.id 와 정확히 일치 (영구 식별자)", () => {
    const meta = buildBaseMetadata({
      author: { id: "snowflake_1234567890", username: "alice" },
      source: "discord-channel",
    });
    expect(meta.user_id).toBe("snowflake_1234567890");
  });
});
