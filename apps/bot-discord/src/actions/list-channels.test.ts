/**
 * list-channels 액션 — 양성/음성 검증 (Phase 5.5.6 / S15).
 *
 * 실 Discord client 부팅 없이 검증. fixture 객체로 guilds.cache 모양만 흉내.
 * CLAUDE.md 의 mock 인터페이스 금지 정신 = 데이터 fixture 만 활용.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import {
  handleListChannels,
  type ChannelListClient,
  type ChannelOption,
} from "./list-channels.ts";

function makeApp(opts: { discordClient?: ChannelListClient } = {}) {
  const app = new Hono();
  app.get("/actions/list-channels", (c) =>
    handleListChannels(c, { discordClient: opts.discordClient }),
  );
  return app;
}

function fixtureClient(
  guilds: Array<{
    id: string;
    name: string;
    channels: Array<{
      id: string;
      name?: string | null;
      isTextBased?: () => boolean;
      type?: number;
    }>;
  }>,
): ChannelListClient {
  return {
    guilds: {
      cache: {
        values: () =>
          guilds.map((g) => ({
            id: g.id,
            name: g.name,
            channels: {
              cache: {
                values: () => g.channels,
              },
            },
          })),
      },
    },
  };
}

describe("GET /actions/list-channels — 양성", () => {
  test("한 길드 = 채널 목록 평탄화", async () => {
    const client = fixtureClient([
      {
        id: "g1",
        name: "내서버",
        channels: [
          { id: "c1", name: "일반", isTextBased: () => true },
          { id: "c2", name: "잡담", isTextBased: () => true },
        ],
      },
    ]);
    const app = makeApp({ discordClient: client });
    const res = await app.request("/actions/list-channels");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChannelOption[];
    expect(body).toEqual([
      { id: "c1", name: "[내서버] #일반" },
      { id: "c2", name: "[내서버] #잡담" },
    ]);
  });

  test("여러 길드 = 평탄화 + 길드명 prefix", async () => {
    const client = fixtureClient([
      {
        id: "g1",
        name: "A",
        channels: [{ id: "c1", name: "x", isTextBased: () => true }],
      },
      {
        id: "g2",
        name: "B",
        channels: [{ id: "c2", name: "y", isTextBased: () => true }],
      },
    ]);
    const app = makeApp({ discordClient: client });
    const res = await app.request("/actions/list-channels");
    const body = (await res.json()) as ChannelOption[];
    expect(body.length).toBe(2);
    expect(body[0]).toEqual({ id: "c1", name: "[A] #x" });
    expect(body[1]).toEqual({ id: "c2", name: "[B] #y" });
  });

  test("isTextBased=false 채널은 걸러진다", async () => {
    const client = fixtureClient([
      {
        id: "g1",
        name: "S",
        channels: [
          { id: "c1", name: "voice", isTextBased: () => false },
          { id: "c2", name: "text", isTextBased: () => true },
        ],
      },
    ]);
    const app = makeApp({ discordClient: client });
    const res = await app.request("/actions/list-channels");
    const body = (await res.json()) as ChannelOption[];
    expect(body.length).toBe(1);
    expect(body[0].id).toBe("c2");
  });

  test("name 누락 채널 = '(no-name)' 으로 대체", async () => {
    const client = fixtureClient([
      {
        id: "g1",
        name: "S",
        channels: [{ id: "c1", name: null, isTextBased: () => true }],
      },
    ]);
    const app = makeApp({ discordClient: client });
    const res = await app.request("/actions/list-channels");
    const body = (await res.json()) as ChannelOption[];
    expect(body[0].name).toBe("[S] #(no-name)");
  });

  test("길드 0개 = 빈 배열", async () => {
    const client = fixtureClient([]);
    const app = makeApp({ discordClient: client });
    const res = await app.request("/actions/list-channels");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChannelOption[];
    expect(body).toEqual([]);
  });
});

describe("GET /actions/list-channels — 음성", () => {
  test("client 미주입 = 503 + 단계 2 미진입 명시 에러", async () => {
    const app = makeApp();
    const res = await app.request("/actions/list-channels");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toContain("단계 2 미진입");
    expect(body.detail).toContain("settings 정합");
  });

  test("guilds.cache throw = 500", async () => {
    const breaker: ChannelListClient = {
      guilds: {
        cache: {
          values: () => {
            throw new Error("cache fault");
          },
        },
      },
    };
    const app = makeApp({ discordClient: breaker });
    const res = await app.request("/actions/list-channels");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain("cache fault");
  });
});
