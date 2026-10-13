/**
 * source-ref.test.ts — 출처 종류·키·입력 판정(WP-B1-20T 설계 3.3·3.5, WP-B1-20U 설계 17.8 첨부 키). 순수 함수에
 * 데이터를 넣어 본다.
 */
import { describe, expect, test } from "bun:test";
import {
  ARCHIVED_LINEAGE_KIND,
  archivedLineageKeyOf,
  describeInputSource,
  messagePlatformOf,
  messageSourceInputProblem,
  messageSourceRef,
  NODE_SOURCE_KINDS,
  normalizePlatform,
  restoreSourceRef,
  SOURCE_KEY_DELIMITER,
  sourceKeyOf,
  sourceKeyPartProblem,
  sourceMessageMarkers,
} from "./source-ref.ts";

describe("sourceKeyOf — 종류마다 정해진 키 모양", () => {
  test("message / direct_save / restore / archived_lineage", () => {
    expect(sourceKeyOf({ kind: "message", platform: "discord", messageId: "123" })).toBe("msg:discord:123");
    expect(sourceKeyOf({ kind: "message", platform: null, messageId: "123" })).toBe("msg::123");
    expect(sourceKeyOf({ kind: "direct_save", channel: "dashboard:manual", actor: "owner" })).toBe(
      "save:dashboard:manual:owner",
    );
    expect(sourceKeyOf({ kind: "direct_save", channel: "mcp", actor: "" })).toBe("save:mcp:");
    expect(sourceKeyOf({ kind: "restore", actor: "owner" })).toBe("restore:owner");
    expect(archivedLineageKeyOf(42)).toBe("lineage:42");
  });

  test("첨부 키는 글 행 키 뒤에 :att:<attachmentId> — 첫 배포 때 굳는 형식(설계 17.8)", () => {
    expect(sourceKeyOf({ kind: "message", platform: "discord", messageId: "123", attachmentId: "456" }))
      .toBe("msg:discord:123:att:456");
    expect(sourceKeyOf({ kind: "message", platform: null, messageId: "123", attachmentId: "456" })).toBe("msg::123:att:456");
    // attachmentId 를 주지 않으면(undefined) 글 행 키 그대로.
    expect(sourceKeyOf({ kind: "message", platform: "discord", messageId: "123", attachmentId: undefined }))
      .toBe("msg:discord:123");
  });

  test("종류 목록은 새 데이터에 있는 세 종류와 보관표 전용 한 종류뿐이다(설계 16절)", () => {
    expect([...NODE_SOURCE_KINDS]).toEqual(["message", "direct_save", "restore"]);
    expect(ARCHIVED_LINEAGE_KIND).toBe("archived_lineage");
  });
});

describe("normalizePlatform", () => {
  test("앞뒤 공백을 자르고 소문자로, 비었거나 문자열이 아니면 null", () => {
    expect(normalizePlatform("  Discord ")).toBe("discord");
    expect(normalizePlatform("telegram")).toBe("telegram");
    expect(normalizePlatform("   ")).toBeNull();
    expect(normalizePlatform("")).toBeNull();
    expect(normalizePlatform(null)).toBeNull();
    expect(normalizePlatform(7)).toBeNull();
  });
});

describe("messagePlatformOf — metadata.platform → metadata.source 의 첫 '-' 앞 → 입력 source 의 첫 ':'·'-' 앞", () => {
  test("metadata.platform 이 가장 먼저", () => {
    expect(messagePlatformOf({ source: "slack:bot", metadata: { platform: " Discord", source: "telegram-x" } })).toBe(
      "discord",
    );
  });

  test("metadata.platform 이 비었거나 문자열이 아니면 metadata.source 의 첫 '-' 앞", () => {
    expect(messagePlatformOf({ metadata: { platform: "  ", source: "discord-channel" } })).toBe("discord");
    expect(messagePlatformOf({ metadata: { platform: 3, source: "Discord-Slash-Append" } })).toBe("discord");
    // '-' 가 없으면 source 전체(옛 규칙 source === platform).
    expect(messagePlatformOf({ metadata: { source: "discord" } })).toBe("discord");
  });

  test("metadata 에 단서가 없으면 입력 source 의 첫 ':'·'-' 앞", () => {
    expect(messagePlatformOf({ source: "telegram:bot", metadata: {} })).toBe("telegram");
    expect(messagePlatformOf({ source: "slack-events" })).toBe("slack");
    expect(messagePlatformOf({ source: "api", metadata: { source: "  " } })).toBe("api");
  });

  test("어디에도 없으면 null", () => {
    expect(messagePlatformOf({})).toBeNull();
    expect(messagePlatformOf({ source: "", metadata: { source: "-x" } })).toBeNull();
    expect(messagePlatformOf({ source: ":x", metadata: {} })).toBeNull();
  });
});

describe("describeInputSource", () => {
  test("messageId 가 있으면 message — 플랫폼 정규화, 채널·서버 id·통로·작성자는 detail", () => {
    const ref = describeInputSource({
      source: "discord",
      author: "user-1",
      metadata: { messageId: "m-9", source: "discord-channel", channelId: "c-1", guildId: 55, user_id: "u" },
    });
    expect(ref).toEqual({
      kind: "message",
      key: "msg:discord:m-9",
      platform: "discord",
      externalId: "m-9",
      detail: { channelId: "c-1", guildId: "55", channel: "discord", actor: "user-1" },
    });
  });

  test("숫자 messageId 는 같은 문자열로, 플랫폼 단서가 없으면 NULL 플랫폼 키", () => {
    const ref = describeInputSource({ source: "", metadata: { messageId: 123 } });
    expect(ref.kind).toBe("message");
    expect(ref.key).toBe("msg::123");
    expect(ref.platform).toBeNull();
    expect(ref.externalId).toBe("123");
    expect(ref.detail).toEqual({ channelId: null, guildId: null, channel: "", actor: "" });
  });

  test("messageId 가 없으면 (통로, 작성자) 의 direct_save", () => {
    expect(describeInputSource({ source: "dashboard:manual", author: "owner", metadata: { source: "dashboard" } }))
      .toEqual({
        kind: "direct_save",
        key: "save:dashboard:manual:owner",
        platform: null,
        externalId: null,
        detail: { channel: "dashboard:manual", actor: "owner" },
      });
    // 작성자가 없으면 빈 문자열.
    expect(describeInputSource({ source: "mcp" }).key).toBe("save:mcp:");
  });
});

describe("messageSourceRef · sourceMessage(설계 17.8)", () => {
  test("첨부면 첨부 키와 detail.attachmentId, 플랫폼은 정규화", () => {
    expect(messageSourceRef({
      platform: " Discord ", messageId: "m-1", channelId: "c-1", guildId: null, attachmentId: "a-1",
      channel: "discord-channel", actor: "owner",
    })).toEqual({
      kind: "message",
      key: "msg:discord:m-1:att:a-1",
      platform: "discord",
      externalId: "m-1",
      detail: { channelId: "c-1", guildId: null, attachmentId: "a-1", channel: "discord-channel", actor: "owner" },
    });
  });

  test("첨부 id 가 없으면 글 행 키이고 detail 에 attachmentId 칸이 없다", () => {
    const ref = messageSourceRef({
      platform: "discord", messageId: "m-1", channelId: null, guildId: null, channel: "discord", actor: "owner",
    });
    expect(ref.key).toBe("msg:discord:m-1");
    expect(Object.keys(ref.detail)).toEqual(["channelId", "guildId", "channel", "actor"]);
  });

  test("describeInputSource 는 sourceMessage 를 metadata messageId 보다 먼저 쓴다 — 통로·작성자는 detail", () => {
    const ref = describeInputSource({
      source: "discord-channel",
      author: "owner",
      metadata: { messageId: "other", source: "telegram-x" },
      sourceMessage: { platform: "discord", messageId: "m-2", attachmentId: "a-2" },
    });
    expect(ref).toEqual({
      kind: "message",
      key: "msg:discord:m-2:att:a-2",
      platform: "discord",
      externalId: "m-2",
      detail: { channelId: null, guildId: null, attachmentId: "a-2", channel: "discord-channel", actor: "owner" },
    });
    // sourceMessage 가 null 이면 지금처럼 metadata 판정.
    expect(describeInputSource({ source: "discord", metadata: { messageId: "m-3" }, sourceMessage: null }).key)
      .toBe("msg:discord:m-3");
  });

  test("sourceMessageMarkers — metadata 표시 칸(messageId·channelId·guildId), 모르는 id 는 null", () => {
    expect(sourceMessageMarkers({ platform: "discord", messageId: "m-1", channelId: "c-1", attachmentId: "a-1" }))
      .toEqual({ messageId: "m-1", channelId: "c-1", guildId: null });
  });
});

describe("키 구분자 검사 — sourceKeyPartProblem · messageSourceInputProblem · sourceKeyOf(설계 17.18 설계 7)", () => {
  const problem = (field: string) => `${field} must not contain ":" (source key delimiter)`;

  test("구분자는 ':' 이고, 칸 검사는 칸 이름만 바뀌는 같은 문구를 낸다", () => {
    expect(SOURCE_KEY_DELIMITER).toBe(":");
    expect(sourceKeyPartProblem("messageId", "m1:att:a1")).toBe(problem("messageId"));
    expect(sourceKeyPartProblem("attachmentId", ":")).toBe(problem("attachmentId"));
    expect(sourceKeyPartProblem("platform", "dis:cord")).toBe(problem("platform"));
  });

  test("구분자가 없거나 값이 없으면(null·undefined) 문제 없음", () => {
    expect(sourceKeyPartProblem("messageId", "m-1")).toBeNull();
    expect(sourceKeyPartProblem("messageId", "")).toBeNull();
    expect(sourceKeyPartProblem("attachmentId", undefined)).toBeNull();
    expect(sourceKeyPartProblem("platform", null)).toBeNull();
  });

  test("messageSourceInputProblem 은 describeInputSource 와 같은 순서로 고른 값을 본다 — sourceMessage 가 metadata 보다 먼저", () => {
    // sourceMessage 가 있으면 metadata 의 ':' 는 보지 않는다(describeInputSource 도 metadata 를 쓰지 않는다).
    expect(messageSourceInputProblem({
      source: "discord", metadata: { messageId: "x:y" }, sourceMessage: { platform: "discord", messageId: "m-1", attachmentId: "a-1" },
    })).toBeNull();
    expect(messageSourceInputProblem({
      source: "discord", metadata: { messageId: "ok" }, sourceMessage: { platform: "discord", messageId: "m:1" },
    })).toBe(problem("messageId"));
    // 칸을 모르는 경계(POST /ingest)는 source 를 비운다.
    expect(messageSourceInputProblem({ sourceMessage: { platform: "discord", messageId: "m-1", attachmentId: "a:1" } }))
      .toBe(problem("attachmentId"));
    expect(messageSourceInputProblem({ sourceMessage: { platform: "dis:cord", messageId: "m-1" } })).toBe(problem("platform"));
  });

  test("metadata messageId 갈래: 숫자 id 도 문자열로 보고, 플랫폼은 messagePlatformOf 순서(metadata.platform → metadata.source 의 첫 '-' 앞 → source)", () => {
    expect(messageSourceInputProblem({ source: "discord", metadata: { messageId: "a:b" } })).toBe(problem("messageId"));
    expect(messageSourceInputProblem({ source: "discord", metadata: { messageId: 12, platform: " Dis:cord " } })).toBe(problem("platform"));
    expect(messageSourceInputProblem({ source: "discord", metadata: { messageId: "m1", source: "dis:cord-channel" } })).toBe(problem("platform"));
    // 입력 source 는 첫 ':'·'-' 앞만 플랫폼이라 ':' 가 플랫폼에 들어올 수 없다.
    expect(messageSourceInputProblem({ source: "dashboard:manual", metadata: { messageId: "m1" } })).toBeNull();
    expect(messageSourceInputProblem({ source: "discord", metadata: { messageId: 12 } })).toBeNull();
  });

  test("messageId 가 없는 직접 저장은 ':' 가 든 채널·작성자·메타데이터 source 라도 문제 없음", () => {
    expect(messageSourceInputProblem({ source: "dash:board", author: "own:er", metadata: { source: "a:b", platform: "c:d" } })).toBeNull();
    expect(messageSourceInputProblem({ source: "dash:board" })).toBeNull();
  });

  test("sourceKeyOf 는 message 키의 세 칸에 ':' 가 있으면 같은 문구로 throw, 같은 순서(messageId → attachmentId → platform)", () => {
    expect(() => sourceKeyOf({ kind: "message", platform: "discord", messageId: "m:1" })).toThrow(problem("messageId"));
    expect(() => sourceKeyOf({ kind: "message", platform: "discord", messageId: "m1", attachmentId: "a:1" })).toThrow(problem("attachmentId"));
    expect(() => sourceKeyOf({ kind: "message", platform: "dis:cord", messageId: "m1" })).toThrow(problem("platform"));
    expect(() => sourceKeyOf({ kind: "message", platform: "dis:cord", messageId: "m:1", attachmentId: "a:1" })).toThrow(problem("messageId"));
    // 입력을 받는 쪽 진입점(출처 참조 만들기)도 같은 throw.
    expect(() => messageSourceRef({
      platform: "discord", messageId: "m1:att:a1", channelId: null, guildId: null, channel: "discord", actor: "owner",
    })).toThrow(problem("messageId"));
  });

  test("direct_save · restore 키는 ':' 가 있어도 만든다", () => {
    expect(sourceKeyOf({ kind: "direct_save", channel: "dash:board", actor: "own:er" })).toBe("save:dash:board:own:er");
    expect(sourceKeyOf({ kind: "restore", actor: "own:er" })).toBe("restore:own:er");
  });
});

describe("restoreSourceRef", () => {
  test("restore:<actor> 행", () => {
    expect(restoreSourceRef("owner")).toEqual({
      kind: "restore",
      key: "restore:owner",
      platform: null,
      externalId: null,
      detail: { actor: "owner" },
    });
  });
});
