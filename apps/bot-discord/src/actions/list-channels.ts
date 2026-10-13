/**
 * GET /actions/list-channels — 채널 목록 액션 (Phase 5.5.6 / S15)
 *
 * 봇이 현 가동 중인 discord.js Client 의 guilds 캐시를 읽어 가입 길드의
 * 텍스트 채널 목록을 `[{ id, name }, ...]` 으로 응답. 대시보드 다이나믹 enum
 * 드롭다운이 이 응답을 옵션으로 채운다 (spec section 5.5).
 *
 * 단계 2 미진입(Discord client 미주입) 시 503 으로 응답한다. 봇이 Discord 에
 * 아직 로그인 안 한 상태에서 액션을 누르면 왜 안 뜨는지 즉시 알 수 있도록 의도.
 *
 * 응답 분기:
 *   - 단계 2 미진입 (Discord client 미주입) = 503 + { error: "단계 2 미진입 — settings 정합 후 시도 가능", detail }
 *   - Discord API 호출 실패 = 500 + { ok: false, message }
 *   - 정상 = 200 + 채널 배열 `[{ id: "123", name: "[서버명] #채널명" }, ...]`
 *
 * 권위: docs/decisions/2026-05-18-app-federation-spec.md section 5.4 / 5.5
 */

import type { Context } from "hono";

/** 채널 목록 핸들러가 client 에서 필요한 최소 모양. */
export interface ChannelListClient {
  guilds: {
    cache: {
      values(): Iterable<{
        id: string;
        name: string;
        channels: {
          cache: {
            values(): Iterable<{
              id: string;
              name?: string | null;
              isTextBased?: () => boolean;
              type?: number;
            }>;
          };
        };
      }>;
    };
  };
}

export interface ListChannelsDeps {
  /** 현 가동 중인 discord.js Client (index.ts 가 주입). */
  discordClient?: ChannelListClient;
}

export interface ChannelOption {
  id: string;
  name: string;
}

/**
 * 채널 목록 핸들러 — 가입 길드 채널 전체를 평탄화해 옵션 배열로 반환.
 *
 * 한 모듈이 여러 길드에 가입한 경우 길드명을 prefix 로 박아 본인이 어디
 * 채널인지 한눈에 알 수 있게 한다 (예: "[내서버] #일반").
 */
export function handleListChannels(
  c: Context,
  deps: ListChannelsDeps = {},
): Response {
  const client = deps.discordClient;
  if (!client) {
    return c.json(
      {
        error: "단계 2 미진입 — settings 정합 후 시도 가능",
        detail: "봇이 아직 Discord 에 연결되지 않음. settings 정합(discordToken + ownerId) 후 자동으로 연결된다.",
      },
      503,
    );
  }

  try {
    const options: ChannelOption[] = [];
    for (const guild of client.guilds.cache.values()) {
      const guildName = guild.name;
      for (const channel of guild.channels.cache.values()) {
        // 텍스트 가능 채널만 — 음성/카테고리 노이즈 차단.
        // isTextBased 메서드가 없는 fixture 도 통과시키려 옵셔널.
        const textOk = channel.isTextBased ? channel.isTextBased() : true;
        if (!textOk) continue;
        const rawName =
          typeof channel.name === "string" && channel.name.length > 0
            ? channel.name
            : "(no-name)";
        options.push({
          id: channel.id,
          name: `[${guildName}] #${rawName}`,
        });
      }
    }
    return c.json(options);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return c.json(
      { ok: false, message: `채널 목록 조회 실패: ${reason}` },
      500,
    );
  }
}
