/**
 * Discord message edit sync — adapter-side policy.
 *
 * The bot decides which Discord edits are relevant; memory-api only receives
 * a generic by-source edit request.
 *
 * The client is the real MemoryApiClient talking to a loopback Bun.serve that records the PATCH
 * requests it receives and answers with plain data. No hand-made client object. What the core does
 * with the request (edits, splits, attachment removal) is covered against a real core by
 * message-sync.integration.test.ts; this file pins what the bot sends and when it stays silent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { MemoryApiClient } from "../../memory/src/api-client.ts";
import type { EditBySourceResult } from "../../memory/src/api-client-types.ts";
import { syncEditedDiscordMessage } from "./message-sync.ts";
import type { BotConfig } from "./config.ts";

const CONFIG: BotConfig = {
  token: "tok",
  applicationId: "app",
  ownerUserId: "owner-1",
  memoChannelId: "memo-1",
  memoryApiUrl: "http://127.0.0.1:3001",
  notifyEvolverDiscord: false,
  evolverPollIntervalMin: 60,
  sseReconnectDelayMs: 3000,
  scheduleRemindersEnabled: false,
  scheduleReminderPollIntervalMin: 5,
  scheduleReminderDateOnlyTime: "09:00",
};

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    content: "일정 변경 #일정:치과 #날짜:2026-07-11 10:00",
    channelId: "memo-1",
    guildId: "guild-1",
    author: { id: "owner-1", bot: false, tag: "owner#0001" },
    channel: { isDMBased: () => false },
    attachments: new Map([["att-1", { id: "att-1" }]]),
    ...overrides,
  };
}

/** The answer the loopback server gives to every edit request (plain data shaped like a real core response). */
const EDIT_RESULT: EditBySourceResult = {
  changed: true,
  messageId: "msg-1",
  platform: "discord",
  matchedCount: 1,
  editedCount: 1,
  editedIds: [10],
  skippedIds: [],
  revisions: [],
  warnings: [],
  splits: [],
  attachmentRemoval: {
    removedAttachmentKeys: [], deletedIds: [], derivedDeletedIds: [], keptIds: [], archivePurgedIds: [],
    assetCleanup: { documentIds: [], removedSha256s: [], missingSha256s: [], failed: [] },
  },
};

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

let server: Server<undefined>;
let client: MemoryApiClient;
/** Every request the loopback server received, in order. */
let requests: RecordedRequest[];

beforeEach(() => {
  requests = [];
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      requests.push({ method: req.method, path: new URL(req.url).pathname, body: await req.json() });
      return Response.json(EDIT_RESULT);
    },
  });
  client = new MemoryApiClient(`http://127.0.0.1:${server.port}`);
});

afterEach(() => {
  server.stop(true);
});

describe("syncEditedDiscordMessage", () => {
  test("owner memo-channel edit calls memory editBySource", async () => {
    const result = await syncEditedDiscordMessage(
      message(),
      CONFIG,
      client,
    );

    expect(result.status).toBe("synced");
    expect(requests).toEqual([
      {
        method: "PATCH",
        path: "/memories/by-source",
        body: {
          messageId: "msg-1",
          platform: "discord",
          content: "일정 변경 #일정:치과 #날짜:2026-07-11 10:00",
          attachmentIds: ["att-1"],
          reason: "discord message edit",
          editor: "owner-1",
          source: "discord",
        },
      },
    ]);
  });

  test("owner DM edit is accepted", async () => {
    const result = await syncEditedDiscordMessage(
      message({
        channelId: "dm-1",
        guildId: null,
        channel: { isDMBased: () => true },
      }),
      CONFIG,
      client,
    );

    expect(result.status).toBe("synced");
    expect(requests).toHaveLength(1);
  });

  // 글이 빈 메시지(첨부만)는 이제 무시하지 않고 content 없이 동기화한다 — message-sync.integration.test.ts 가 실제
  // 코어로 확인한다(WP-B1-20U 설계 17.9). 부분 메시지 무시도 그 파일이 확인한다.
  test("non-owner, wrong channel, and raw slash text are ignored", async () => {
    const cases = [
      message({ author: { id: "other", bot: false, tag: "other#0001" } }),
      message({ channelId: "elsewhere" }),
      message({ content: "/search 치과" }),
    ];

    for (const m of cases) {
      const result = await syncEditedDiscordMessage(m, CONFIG, client);
      expect(result.status).toBe("ignored");
      expect(requests).toEqual([]);
    }
  });
});
