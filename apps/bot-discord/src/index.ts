/**
 * Discord bot entry point.
 *
 * 부팅 = 두 단계로 분리:
 *
 * 단계 1 — HTTP 통로 가동 (settings 유무 무관)
 *   settings.json 부재여도 Hono HTTP 서버(:3100)를 가동한다.
 *   /health, /settings/schema, /settings GET/PUT, /actions/* 모두 응답 가능.
 *   콘솔: "[bot-discord] HTTP 통로 가동 (settings 부재 — 메모리 대시보드에서 토큰을 입력해주세요)"
 *
 * 단계 2 — Discord 연결 (settings 정합 시 자동)
 *   discordToken / ownerId 가 settings 에 들어가 있고 형식이 유효할 때 Discord
 *   client 생성 + login. reload-bus emit 시 단계 2 재진입 (destroy + login).
 *   콘솔: "[bot-discord] HTTP 통로 가동 + settings 정상 — 단계 2 진입"
 *
 * 옛 S16 fatal throw (settings.json 부재 시 프로세스 종료) 정책을 격하.
 * 부재는 "첫 셋업 진행 중" 상태 — 프로세스는 HTTP 통로로 대기.
 * 정합 실패 시 콘솔에 어느 필드가 왜 실패했는지 명시 + 단계 1 가동 유지.
 *
 * 부트스트랩 env 예외 1개 (W5.1 이전 완료):
 *   BOT_SETTINGS_PATH — settings 파일 위치 자체라 settings 안에 둘 수 없음.
 *   나머지 4개 (DISCORD_APPLICATION_ID / DISCORD_GUILD_ID /
 *   DISCORD_MEMO_CHANNEL_ID / DISCORD_AUTO_EXTRACT) 는
 *   settings-schema 로 이전 완료 — env 로 받지 않음.
 *   MEMORY_API_URL 은 어댑터 계약(단일 배포 경로 spec 6.3 ③) 환경변수로 다시
 *   받는다 — 비어 있지 않으면 settings.memoryApiUrl 보다 우선 (config.ts).
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type PartialMessage,
  type TextBasedChannel,
} from "discord.js";
import { loadBotConfig, resolveMemoryApiUrl, type BotConfig } from "./config.ts";
import { MemoryApiClient } from "../../memory/src/api-client.ts";
import { buildBaseMetadata, resolveDisplayName } from "./attribution.ts";
import {
  ingestAttachment,
  type AttachmentMetaLike,
} from "./attachment-ingest.ts";
import { handleInteraction } from "./commands.ts";
import {
  BOT_HTTP_ENDPOINT,
  BOT_HTTP_HOST,
  BOT_HTTP_PORT,
  createHttpServer,
} from "./http-server.ts";
import { loadOrCreateAdminToken } from "./admin-token-store.ts";
import { ReloadBus } from "./reload-bus.ts";
import { checkStage2Readiness } from "./settings-store.ts";
import { SseConsumer } from "./sse-consumer.ts";
import {
  BOT_ADAPTER_ENROLLMENT,
  createAdapterApprovalTokenIssuer,
  describeMemoryApiAuthFailure,
  startSseWithRetry,
  type SseBootstrapAbort,
} from "./sse-bootstrap.ts";
import {
  handleProposalButton,
  sendProposalNotification,
} from "./proposal-notify.ts";
import { logMessageEditSync, syncEditedDiscordMessage } from "./message-sync.ts";
import { logMessageDeleteSync } from "./asset-cleanup-log.ts";
import { pollScheduleReminders } from "./schedule-reminders.ts";
import { ScheduleReminderLedger } from "./schedule-reminder-store.ts";
import { createFirstPollGate } from "./first-poll-gate.ts";

function tag(): string {
  return `[bot-discord ${new Date().toISOString().slice(11, 19)}]`;
}

/**
 * client 에 매달린 SSE 부트스트랩·consumer·정리 알림 폴링 타이머를 한 번에 멈춘다
 * (있으면). client destroy 직전에 불러 (a) 아직 토큰 발급을 재시도 중인 부트스트랩
 * 루프를 취소하고 (b) 이미 연결된 consumer 의 재연결 루프·진행 중 요청을 끊고
 * (c) 정리 활동 알림 폴링 타이머를 멈춘다. 옛 세션의 구독·재시도·폴링이 새 세션과
 * 겹치지 않게 한다.
 *
 * 부트스트랩 취소가 (a) 인 이유: 토큰 발급이 계속 실패하는 동안(consumer 가 아직
 * 생성되지 않은 동안) reload-bus 로 단계 2 가 재진입하면, 취소 신호 없이는 옛 루프가
 * 좀비로 남아 새 루프와 동시에 재시도한다. client 에 신호를 매달면 단계 2 진입마다
 * new Client 라 옛/새 루프가 자연히 분리된다.
 *
 * 폴링 타이머가 (c) 인 이유: setInterval 핸들을 보관하지 않으면 옛 client 가 destroy
 * 돼도 타이머가 살아남아 죽은 client(c.users.fetch)를 계속 붙잡고 돈다. 토큰을 바꿔
 * 재접속할 때마다 좀비 타이머가 하나씩 쌓인다. 핸들을 client 에 매달아 destroy 전에
 * clearInterval 로 멈춘다.
 */
function stopSseForClient(client: Client): void {
  type SseClient = Client & {
    _sseConsumer?: SseConsumer;
    _sseBootstrapAbort?: SseBootstrapAbort;
    _evolverPollTimer?: ReturnType<typeof setInterval>;
    _scheduleReminderTimer?: ReturnType<typeof setInterval>;
  };
  const c = client as SseClient;
  // (a) 부트스트랩 재시도 루프 취소 신호 — 아직 연결 전이어도 즉시 멈춘다.
  if (c._sseBootstrapAbort) {
    c._sseBootstrapAbort.cancelled = true;
    c._sseBootstrapAbort = undefined;
  }
  // (b) 이미 연결된 consumer stop — 재연결 루프·진행 중 요청을 끊는다.
  if (c._sseConsumer) {
    c._sseConsumer.stop();
    c._sseConsumer = undefined;
  }
  // (c) 정리 활동 알림 폴링 타이머 정리 — 죽은 client 를 붙잡는 좀비 타이머를 멈춘다.
  if (c._evolverPollTimer) {
    clearInterval(c._evolverPollTimer);
    c._evolverPollTimer = undefined;
  }
  if (c._scheduleReminderTimer) {
    clearInterval(c._scheduleReminderTimer);
    c._scheduleReminderTimer = undefined;
  }
}

/**
 * 단계 2 진입 — Discord client 생성 + 이벤트 핸들러 등록 + login.
 * 단계 2 진입 가능 여부는 호출 전 이미 checkStage2Readiness 통과한 상태.
 *
 * apiClient 는 let 으로 선언한다. ClientReady 직후 봇 토큰을 발급받아
 * 인증된 클라이언트로 교체하기 위해 registerDiscordEventHandlers 에 참조를
 * 클로저로 넘긴다 — 교체 후에는 모든 이후 API 호출이 토큰을 싣는다.
 */
async function enterStage2(config: BotConfig, adminToken: string): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });
  // 토큰 없이 시작 — ClientReady 직후 /adapter-enroll 승인 큐에 등록하고,
  // 사용자가 설정 > 어댑터 관리에서 승인하면 인증된 클라이언트로 교체한다.
  let apiClient = new MemoryApiClient(config.memoryApiUrl);
  registerDiscordEventHandlers(client, config, {
    getClient: () => apiClient,
    setClient: (c) => { apiClient = c; },
  }, adminToken);
  await client.login(config.token);
  return client;
}

/** `registerDiscordEventHandlers` 에 넘기는 apiClient 접근자. */
interface ApiClientRef {
  /** 현재 apiClient 를 읽는다. */
  getClient: () => MemoryApiClient;
  /** ClientReady 직후 인증된 클라이언트로 교체한다. */
  setClient: (c: MemoryApiClient) => void;
}

/**
 * 단계 2 이벤트 핸들러 일괄 등록.
 * client.once(ClientReady) + MessageCreate + MessageDelete + InteractionCreate.
 *
 * apiClient 는 직접 받지 않고 `ref.getClient()` / `ref.setClient()` 로 간접 접근한다.
 * ClientReady 에서 봇 토큰을 발급받아 `ref.setClient(새 클라이언트)` 로 교체하면
 * 이후 MessageCreate·MessageDelete·InteractionCreate 핸들러가 자연히 인증된
 * 클라이언트를 사용하게 된다.
 */
function registerDiscordEventHandlers(
  client: Client,
  config: BotConfig,
  ref: ApiClientRef,
  adminToken: string,
): void {
  client.once(Events.ClientReady, async (c) => {
    console.log(`${tag()} 단계 2 준비 완료 — logged in as ${c.user.tag} (id ${c.user.id})`);

    // ── 봇 토큰 승인 요청 + 인증된 클라이언트 교체 ──────────────────────────
    //
    // 새 보안 흐름은 봇이 직접 토큰을 즉시 발급받지 않는다. 첫 연결 시
    // /adapter-enroll 로 승인 요청을 만들고, 설정 페이지의 "어댑터 관리"에서 사용자가
    // 승인하면 pickupSecret 으로 토큰을 회수한다. 같은 issue 함수가 requestId 를
    // 보관하므로 재시도 중 pending 요청이 계속 불어나지 않는다.
    const issueBotToken = createAdapterApprovalTokenIssuer({
      client: () => ref.getClient(),
      ...BOT_ADAPTER_ENROLLMENT,
      endpoint: BOT_HTTP_ENDPOINT,
      // 봇 로컬 관리 토큰을 코어에 등록(P1-통합 I1) — 코어→봇 프록시 hop 이 이 값을
      // Authorization: Bearer 로 부착해 봇 admin-gate 를 통과한다. 재enroll(D6 자동
      // 승인)마다 최신 값이 코어 메타로 갱신돼 관리 토큰 재생성 후 stale 을 복구한다.
      adminToken,
      log: (m) => console.log(`${tag()} [adapter-token] ${m}`),
      // D5 — 저장된 어댑터 토큰의 유효성을 확인할 때 인증된 클라이언트를 만든다.
      // 무효(401)면 폐기 후 재enroll, 권한 부족(403)이면 토큰 유지한 채 재시도(WP-B1-15).
      authedClientFactory: (token) =>
        new MemoryApiClient(config.memoryApiUrl, { token }),
    });
    // 첫 즉시 폴링 관문 — 이 시점의 ref.getClient() 는 아직 인증 전 클라이언트라,
    // 폴러가 곧바로 첫 폴링을 쏘면 보호 경로에서 401 로 실패해 부팅마다 에러 로그가
    // 남는다. 각 폴러는 첫 1회 폴링을 defer 로 등록하고, 아래 issueAndInstallBotToken
    // 이 ref.setClient 직후 release 해 인증된 클라이언트로 실행한다(first-poll-gate.ts).
    const firstPollGate = createFirstPollGate();
    const issueAndInstallBotToken = async (): Promise<{ token: string }> => {
      const result = await issueBotToken();
      ref.setClient(new MemoryApiClient(config.memoryApiUrl, { token: result.token }));
      console.log(`${tag()} 봇 토큰 승인 완료 — 이후 API 호출에 Authorization 헤더가 붙는다`);
      firstPollGate.release();
      return result;
    };

    // 메모 채널 확인
    try {
      const channel = await c.channels.fetch(config.memoChannelId);
      if (!channel) {
        console.warn(
          `${tag()} memo channel ${config.memoChannelId} 확인 불가 — 봇이 해당 길드에 초대됐는지 확인`,
        );
      } else {
        const name =
          "name" in channel && typeof (channel as { name?: unknown }).name === "string"
            ? ((channel as { name: string }).name)
            : "(no-name)";
        const guildName =
          "guild" in channel && (channel as { guild?: { name?: string } }).guild
            ? ((channel as { guild: { name: string } }).guild.name)
            : "(dm or unknown)";
        console.log(`${tag()} memo channel resolved: #${name} in "${guildName}"`);
      }
    } catch (err) {
      console.warn(
        `${tag()} memo channel ${config.memoChannelId} 확인 실패: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 가입 길드 목록
    const guilds = [...c.guilds.cache.values()];
    if (guilds.length === 0) {
      console.warn(
        `${tag()} 봇이 어떤 길드에도 초대되지 않음. 초대 URL: https://discord.com/api/oauth2/authorize?client_id=${c.user.id}&permissions=274877942784&scope=bot%20applications.commands`,
      );
    } else {
      console.log(`${tag()} guilds: ${guilds.map((g) => `${g.name} (${g.id})`).join(", ")}`);
    }

    console.log(`${tag()} ready — listening for messages and interactions.`);

    // evolver 알림 폴링
    if (config.notifyEvolverDiscord) {
      let lastSeenRanAt: string | null = null;

      const pollEvolver = async () => {
        try {
          const activity = await ref.getClient().getEvolverActivity(1);
          if (activity.length === 0) return;
          const latest = activity[0];
          if (latest.ranAt === lastSeenRanAt) return;
          lastSeenRanAt = latest.ranAt;

          if (
            latest.clusterEdgesAdded === 0 &&
            latest.nodesArchived === 0 &&
            latest.nodesPurged === 0
          ) {
            return;
          }

          const parts: string[] = [
            `🧹 정리: 클러스터 +${latest.clusterEdgesAdded}`,
            `휴지통 +${latest.nodesArchived}`,
            `영구 삭제 +${latest.nodesPurged}`,
          ];
          if (latest.soonToPurgeCount > 0) {
            parts.push(`이번 주 영구 삭제 예정 ${latest.soonToPurgeCount}개`);
          }
          const summary = parts.join(" / ");

          const ownerUser = await c.users.fetch(config.ownerUserId);
          await ownerUser.send(summary);
          console.log(`${tag()} [evolver-notify] sent DM: ${summary}`);
        } catch (e) {
          console.error(
            `${tag()} [evolver-notify] poll failed: ${describeMemoryApiAuthFailure(e)}`,
          );
        }
      };

      // 첫 폴링은 봇 토큰 설치 직후 실행 — 인증 전 401 실패 방지(firstPollGate).
      firstPollGate.defer(() => {
        void pollEvolver();
      });
      // 폴링 타이머 핸들을 client 에 매단다 — reload-bus 재진입·destroy 시
      // stopSseForClient 가 이 핸들을 clearInterval 로 멈춘다. 핸들을 보관하지
      // 않으면 옛 client 가 destroy 돼도 타이머는 살아남아 죽은 client 를 계속
      // 붙잡고 도는 좀비가 된다(토큰 교체마다 하나씩 누적). SSE 신호와 동일 패턴.
      const evolverPollTimer = setInterval(
        pollEvolver,
        config.evolverPollIntervalMin * 60_000,
      );
      (c as Client & { _evolverPollTimer?: ReturnType<typeof setInterval> })
        ._evolverPollTimer = evolverPollTimer;
      console.log(
        `${tag()} [evolver-notify] enabled — polling every ${config.evolverPollIntervalMin}m`,
      );
    }

    // 일정 알림 폴링 — 정책과 중복 방지 장부는 Discord 어댑터가 소유한다.
    if (config.scheduleRemindersEnabled) {
      let ownerUserForSchedule: Awaited<ReturnType<typeof c.users.fetch>> | null = null;
      try {
        ownerUserForSchedule = await c.users.fetch(config.ownerUserId);
      } catch (err) {
        console.warn(
          `${tag()} [schedule-reminder] owner(${config.ownerUserId}) fetch 실패 — 일정 알림 폴링을 시작하지 못한다: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (ownerUserForSchedule) {
        const ledger = new ScheduleReminderLedger();
        const pollSchedules = async () => {
          try {
            const result = await pollScheduleReminders({
              client: ref.getClient(),
              ledger,
              sendDm: async (message) => {
                await ownerUserForSchedule.send(message);
              },
              dateOnlyTime: config.scheduleReminderDateOnlyTime,
              dueWindowMinutes: config.scheduleReminderPollIntervalMin,
            });
            if (result.sent > 0) {
              console.log(
                `${tag()} [schedule-reminder] sent ${result.sent}/${result.due} due reminders`,
              );
            }
          } catch (e) {
            console.error(
              `${tag()} [schedule-reminder] poll failed: ${describeMemoryApiAuthFailure(e)}`,
            );
          }
        };

        // 첫 폴링은 봇 토큰 설치 직후 실행 — /api/date-occurrences 는 보호 경로라
        // 인증 전에 쏘면 401 로 실패했다(firstPollGate).
        firstPollGate.defer(() => {
          void pollSchedules();
        });
        const scheduleReminderTimer = setInterval(
          pollSchedules,
          config.scheduleReminderPollIntervalMin * 60_000,
        );
        (c as Client & { _scheduleReminderTimer?: ReturnType<typeof setInterval> })
          ._scheduleReminderTimer = scheduleReminderTimer;
        console.log(
          `${tag()} [schedule-reminder] enabled — polling every ${config.scheduleReminderPollIntervalMin}m`,
        );
      }
    }

    // ── 정리 제안 SSE 구독 (Phase 7 2차 Task 7 + 부트스트랩 재시도 수정) ──────
    //
    // 메모리 /events/stream 에 줄을 한 번 열어 cleanup_proposals_ready 를 받으면
    // owner DM 으로 알림 + [수락][거절][보류] 버튼을 보낸다. 끊기면 자동 재연결 +
    // Last-Event-ID 이어받기(놓침 0). 토큰은 /adapter-enroll 승인 큐를 통과한 뒤
    // pickupSecret 으로 회수해 Authorization 헤더로 제시한다 — 토큰 값은 로그에 안 남긴다.
    //
    // ownerUser fetch 는 여기서 한 번 시도한다 — Discord 소관이라 memory-api 가
    // 늦게 깨는 문제와 무관하다. 실패하면 SSE 구독을 시작할 수 없으니 별개 경고만
    // 남기고 끝낸다(재시도 대상 아님). 토큰 발급+첫 연결의 재시도는 그 다음
    // startSseWithRetry 가 backoff 로 무한히 맡는다 — memory-api 가 ~21초 늦게
    // 깨어도 봇이 스스로 붙는다(옛 일회성 try/catch 가 만든 영구 누락 버그 수정).
    let ownerUserForSse: Awaited<ReturnType<typeof c.users.fetch>> | null = null;
    try {
      ownerUserForSse = await c.users.fetch(config.ownerUserId);
    } catch (err) {
      console.warn(
        `${tag()} [sse] owner(${config.ownerUserId}) fetch 실패 — 정리 제안 구독을 시작하지 못한다: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const ownerUser = ownerUserForSse;
    // 부트스트랩 취소 신호를 client 에 매단다 — reload-bus 재진입·destroy 시
    // stopSseForClient 가 이 신호를 올려 옛 재시도 루프를 끊는다(좀비 방지).
    const abort: SseBootstrapAbort = { cancelled: false };
    (c as Client & { _sseBootstrapAbort?: SseBootstrapAbort })._sseBootstrapAbort =
      abort;

    // fire-and-forget — ClientReady 가 SSE/승인 부트스트랩으로 막히면 안 된다.
    // ownerUser fetch 가 실패했어도 토큰 승인/클라이언트 교체는 계속 진행한다. 그 경우
    // cleanup_proposals_ready 이벤트만 DM 없이 조용히 건너뛴다.
    void startSseWithRetry({
      issueToken: issueAndInstallBotToken,
      memoryApiUrl: config.memoryApiUrl,
      sseReconnectDelayMs: config.sseReconnectDelayMs,
      onEvent: async (event) => {
        if (event.type !== "cleanup_proposals_ready") return;
        if (!ownerUser) return;
        await sendProposalNotification({
          apiClient: ref.getClient(),
          ownerUser,
          onError: (e) =>
            console.error(`${tag()} [proposal-notify] DM 실패: ${describeMemoryApiAuthFailure(e)}`),
          log: (m) => console.log(`${tag()} [proposal-notify] ${m}`),
        });
      },
      onConsumerError: (e) =>
        console.warn(`${tag()} [sse] 연결 문제 (재연결 시도): ${e.message}`),
      abort,
      log: (m) => console.log(`${tag()} [sse] ${m}`),
      warn: (m) => console.warn(`${tag()} [sse] ${m}`),
    }).then((result) => {
      if (result.consumer && !abort.cancelled) {
        (c as Client & { _sseConsumer?: SseConsumer })._sseConsumer =
          result.consumer;
      } else if (result.consumer && abort.cancelled) {
        result.consumer.stop();
      }
    });
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;

    const isMemoChannel = message.channelId === config.memoChannelId;
    const isOwnerDm = message.channel.isDMBased();
    const isOwner = message.author.id === config.ownerUserId;
    const hasContent = message.content.trim().length > 0;
    const hasAttachments = message.attachments.size > 0;
    const looksLikeCommand = message.content.startsWith("/");

    const where = isOwnerDm ? "DM" : `#${(message.channel as TextBasedChannel & { name?: string }).name ?? "unknown"} (id ${message.channelId})`;

    if (!isOwner) {
      console.log(
        `${tag()} ignored — author ${message.author.tag} (id ${message.author.id}) is not the configured owner (${config.ownerUserId}). where=${where}`,
      );
      return;
    }
    if (!isMemoChannel && !isOwnerDm) {
      console.log(
        `${tag()} ignored — channel ${message.channelId} is not the memo channel (${config.memoChannelId}) and not a DM. where=${where}`,
      );
      return;
    }
    // 글도 첨부도 없으면 무시 — 첨부-only 메시지(글 없음)는 여기서 걸러지지 않고
    // 아래 첨부 처리로 진행(Phase 14b T5 — 옛 attachments silent drop 폐기).
    if (!hasContent && !hasAttachments) {
      console.log(`${tag()} ignored — empty content (embeds only?). where=${where}`);
      return;
    }
    if (hasContent && looksLikeCommand) {
      console.log(`${tag()} ignored — looks like a raw slash command typed as text. where=${where}`);
      return;
    }

    const displayName = resolveDisplayName(message.author, message.member);
    const source = isOwnerDm ? "discord-dm" : "discord-channel";
    const baseMetadata = buildBaseMetadata({
      author: message.author,
      member: message.member,
      source,
      messageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId ?? null,
    });

    // 합산 react 신호 — 글·첨부 한 건이라도 실패하면 ⚠️, 모두 성공이면 ✅.
    let anyFailed = false;
    let anyHandled = false;

    // ── 글 통로 (Phase 5.7.2 single-path — 흐름 불변) ───────────────────────
    // 봇은 글을 `POST /memories` 한 통로만 호출. mode='immediate' / 'backfill'
    // 분기는 메모리 코어 권위 (settings.llm.extractor.mode). 옛 ✨ react +
    // inline 분해 결과 보고 흐름은 Phase 7.4 정착 시점에 자연 부활 예정.
    if (hasContent) {
      anyHandled = true;
      try {
        const { id } = await ref.getClient().ingest({
          content: message.content,
          metadata: baseMetadata,
          author: displayName,
          platform: "discord",
        });
        console.log(`${tag()} ingested message ${message.id} (${where}) → memory #${id}`);
      } catch (err) {
        anyFailed = true;
        console.error(`${tag()} ingest FAILED for message ${message.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── 첨부 통로 (Phase 14b T5 + Phase 11a T7 — 결정 3: 각 첨부 별도 POST /ingest) ─
    // 14a/11a 코어가 받는 형식(텍스트·MD·PDF·docx + 이미지 5 종)만 보낸다. 못 받는
    // 형식(받지 않는 이미지·오디오 등)은 silent drop 하지 않고 콘솔로 정직하게 알린다.
    // WP-B1-20U 설계 17.8 — 메시지 출처(첨부 id 는 첨부마다)를 실어 메시지 삭제가 첨부 기억도 지운다.
    if (hasAttachments) {
      const attribution = { author: displayName, userId: message.author.id };
      const sourceMessage = { platform: "discord", messageId: message.id, channelId: message.channelId, guildId: message.guildId ?? null };
      for (const attachment of message.attachments.values()) {
        anyHandled = true;
        const { id, name, contentType, url, size } = attachment;
        const meta: AttachmentMetaLike = { id, name, contentType, url, size };
        const outcome = await ingestAttachment(ref.getClient(), meta, source, attribution, sourceMessage);
        if (outcome.status === "ingested") {
          console.log(
            `${tag()} ingested attachment "${outcome.name}" (message ${message.id}, ${where}) → document ${outcome.documentId}`,
          );
        } else if (outcome.status === "ingested-image") {
          // 11a T7 — 이미지 자산 보관(documents·청크 흐름 X / 노드 한 한). 자산 sha 앞 12 +
          // 가로×세로 + 움직임/경고 합류 표시. 콘솔로 정직한 보고(silent 무시 금지).
          const img = outcome.image;
          const extras: string[] = [`${img.width}×${img.height}`];
          if (img.isAnimated) extras.push("움직이는 이미지");
          if (img.warnings.length > 0) extras.push(`경고: ${img.warnings.join(" / ")}`);
          console.log(
            `${tag()} ingested image attachment "${outcome.name}" (message ${message.id}, ${where}) → 자산 sha ${img.assetSha256.slice(0, 12)}… node ${img.nodeId} (${extras.join(", ")})`,
          );
        } else if (outcome.status === "rejected") {
          // 못 받는 형식 — 실패(⚠️)와 구분해 정직하게 알린다(저장 시도조차 안 함).
          anyFailed = true;
          console.warn(`${tag()} attachment 거부: ${outcome.reason}`);
        } else {
          anyFailed = true;
          console.error(
            `${tag()} attachment "${outcome.name}" 실패 (message ${message.id}): ${outcome.reason}`,
          );
        }
      }
    }

    // ── 합산 react ──────────────────────────────────────────────────────────
    if (anyHandled) {
      try {
        await message.react(anyFailed ? "⚠️" : "✅");
      } catch {
        // reaction failure is non-fatal
      }
    }
  });

  client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
    let message: Message | PartialMessage = newMessage;
    const maybePartial = message as unknown as PartialMessage & {
      partial?: boolean;
      fetch?: () => Promise<Message>;
    };
    if (maybePartial.partial === true && typeof maybePartial.fetch === "function") {
      try {
        message = await maybePartial.fetch();
      } catch (err) {
        console.warn(
          `${tag()} message update fetch failed for ${message.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }

    try {
      const result = await syncEditedDiscordMessage(
        message,
        config,
        ref.getClient(),
      );
      // WP-B1-20U 설계 17.9 — 지운 첨부 기억 수와, 코어가 지우지 못한 첨부 파일(assetCleanup.failed) 경고.
      if (result.status === "synced") logMessageEditSync(tag(), message.id, result);
    } catch (err) {
      console.error(
        `${tag()} editBySource FAILED for message ${message.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  client.on(Events.MessageDelete, async (message: Message | PartialMessage) => {
    if (!message.id) return;

    const isOwnerMessage =
      !message.author || message.author.id === config.ownerUserId;
    if (!isOwnerMessage) {
      console.log(
        `${tag()} message ${message.id} deleted (author ${message.author?.id} != owner) — skip sync`,
      );
      return;
    }

    try {
      const result = await ref.getClient().deleteBySource({
        messageId: message.id,
        platform: "discord",
      });
      // WP-B1-20U 설계 17.17 — 지운 기억 수와, 코어가 지우지 못한 첨부 파일(assetCleanup.failed) 경고.
      logMessageDeleteSync(tag(), message.id, result);
    } catch (err) {
      console.error(
        `${tag()} deleteBySource FAILED for message ${message.id}: ${describeMemoryApiAuthFailure(err)}`,
      );
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    // 정리 제안 [수락][거절][보류] 버튼 — proposal 네임스페이스만 가로챈다.
    // 보류는 봇 로컬로 메시지만 치우고(서버 호출 0), 수락/거절은 메모리 API 호출.
    if (interaction.isButton()) {
      const handled = await handleProposalButton(interaction, ref.getClient());
      if (!handled) {
        console.log(`${tag()} button interaction not handled (customId=${interaction.customId})`);
      }
      return;
    }
    if (!interaction.isChatInputCommand()) {
      console.log(`${tag()} interaction received but not a chat-input command (type=${interaction.type})`);
      return;
    }
    console.log(
      `${tag()} slash command /${interaction.commandName} from ${interaction.user.tag} (id ${interaction.user.id})`,
    );
    await handleInteraction(interaction, {
      client: ref.getClient(),
      ownerUserId: config.ownerUserId,
    });
  });
}

function explainFatal(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("disallowed intents") || msg.includes("Used disallowed intents")) {
    console.error(`${tag()} FATAL: Discord rejected the bot's Privileged Intents.`);
    console.error(`${tag()} → Open https://discord.com/developers/applications`);
    console.error(`${tag()} → Pick your application → Bot → "Privileged Gateway Intents"`);
    console.error(`${tag()} → Enable "MESSAGE CONTENT INTENT" and Save.`);
    return;
  }
  if (msg.includes("TOKEN_INVALID") || msg.toLowerCase().includes("invalid token")) {
    console.error(`${tag()} FATAL: Discord rejected the bot token.`);
    console.error(`${tag()} → 메모리 대시보드 → '디스코드 봇' 탭 → discordToken 다시 입력 후 봇 재시작`);
    console.error(`${tag()} → If unsure, re-issue the token in the Developer Portal.`);
    return;
  }
  console.error(`${tag()} FATAL: ${msg}`);
}

async function main() {
  console.log(`${tag()} starting...`);

  // ── 단계 1 — HTTP 통로 가동 ──────────────────────────────────────────────
  //
  // settings.json 부재여도 HTTP 서버를 먼저 가동. 대시보드가 이 통로를 통해
  // settings 폼을 채울 수 있어야 첫 셋업 deadlock을 풀 수 있음.
  const reloadBus = new ReloadBus();

  // settings.json 경로 결정 (BOT_SETTINGS_PATH 부트스트랩 예외 반영).
  // http-server 생성 전에 경로를 고정해 reload-bus 구독자와 동일 경로 사용.
  const settingsPath = process.env.BOT_SETTINGS_PATH?.trim() || undefined;

  // ── 로컬 관리 토큰 준비 (D2) ──────────────────────────────────────────────
  //
  // 봇 :3100 상태변경·민감읽기 경로를 지키는 토큰. 부팅 시 probe 해 없으면
  // 생성(0600 파일 영속). 토큰 값은 로그에 남기지 않는다(존재 여부만 알린다).
  let adminToken: string;
  try {
    adminToken = loadOrCreateAdminToken().token;
    console.log(
      `${tag()} [admin-token] 로컬 관리 토큰 준비 완료 — 상태변경 경로는 Bearer 토큰을 요구한다`,
    );
  } catch (err) {
    // 토큰을 못 만들면 상태변경 경로를 지킬 수 없다 — loud fail. 무인증으로
    // 여느니 부팅을 멈추는 게 안전하다(silent fallback 금지).
    console.error(
      `${tag()} [admin-token] 로컬 관리 토큰 준비 실패 — 봇을 무인증으로 열 수 없어 종료: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // 현재 단계 2 세션 — 없으면 단계 2 미진입.
  let stage2Client: Client | null = null;

  // concurrent emit 중복 진입 차단 — reload-bus 가 연속으로 emit 해도
  // enterStage2 는 한 번에 하나만 진행한다.
  let isStage2Entering = false;

  const httpApp = createHttpServer({
    reloadBus,
    settingsPath,
    // getDiscordClient: 단계 2 재진입 후 새 client 를 동적으로 참조.
    // stage2Client 변수를 클로저로 감싸 요청 시점마다 최신 값 반환.
    getDiscordClient: () => stage2Client ?? undefined,
    // adminToken: 상태변경·민감읽기 경로가 이 토큰을 Bearer 로 요구한다(D2).
    // 클로저로 넘겨 게이트가 요청 시점마다 최신 값을 참조하게 한다.
    adminToken: () => adminToken,
  });

  // HTTP 서버 가동 시도 — 포트 점유 등 실패해도 단계 2 는 계속 시도 (단 대시보드 접근 불가).
  try {
    const httpServer = Bun.serve({
      hostname: BOT_HTTP_HOST,
      port: BOT_HTTP_PORT,
      fetch: httpApp.fetch,
    });
    console.log(
      `${tag()} settings HTTP: http://${httpServer.hostname}:${httpServer.port} (127.0.0.1 한정)`,
    );
    // spec 4.1 / AC 1 — 단계 1 가동 완료 메시지.
    // 이 시점에서 단계 2 진입 여부는 아직 모름 — tryEnterStage2("부팅") 가 이후 단계 2 분기 메시지 추가.
    console.log(`${tag()} [bot-discord] HTTP 통로 가동 (settings 부재 — 메모리 대시보드에서 토큰을 입력해주세요)`);
  } catch (err) {
    console.warn(
      `${tag()} settings HTTP 가동 실패: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.warn(
      `${tag()} 메모리 대시보드 봇 탭이 비활성 상태로 표시된다.`,
    );
  }

  // ── 단계 2 진입 시도 함수 ─────────────────────────────────────────────────
  //
  // settings 정합 검사 → 통과 시 loadBotConfig → Discord client 생성 + login.
  // 이미 단계 2 세션이 있으면 destroy 후 재진입.
  async function tryEnterStage2(reason: string): Promise<void> {
    if (isStage2Entering) {
      console.log(`${tag()} tryEnterStage2 이미 진행 중 — 중복 emit 무시 (${reason})`);
      return;
    }
    isStage2Entering = true;
    try {
      await _tryEnterStage2Inner(reason);
    } finally {
      isStage2Entering = false;
    }
  }

  async function _tryEnterStage2Inner(reason: string): Promise<void> {
    const readiness = checkStage2Readiness(settingsPath);

    if (!readiness.ready) {
      if (readiness.settingsAbsent) {
        // 단계 1 메시지는 HTTP 서버 listen 직후에 이미 출력됨 — 중복 출력 회피.
        // settings 파일이 나타나면 reload-bus emit 시 단계 2 진입 재시도.
        console.log(`${tag()} settings 파일 부재 — 단계 1 (HTTP 통로) 대기 중.`);
      } else {
        console.warn(`${tag()} 단계 2 거부 (${reason}) — settings 정합 실패:`);
        for (const r of readiness.reasons) {
          console.warn(`${tag()}   - ${r}`);
        }
        console.warn(`${tag()} 단계 1 (HTTP 통로) 가동 유지.`);
      }

      // 단계 2 세션이 이미 있다면 종료
      if (stage2Client) {
        console.log(`${tag()} 단계 2 세션 종료 (settings 정합 실패로 격하)`);
        stopSseForClient(stage2Client);
        try {
          await stage2Client.destroy();
        } catch (err) {
          console.warn(
            `${tag()} 단계 2 세션 종료 실패 (무시): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        stage2Client = null;
      }
      return;
    }

    // settings 정합 — BotConfig 로드
    let config: BotConfig;
    try {
      config = loadBotConfig(settingsPath);
    } catch (err) {
      console.warn(
        `${tag()} 단계 2 거부 (${reason}) — loadBotConfig 실패: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.warn(`${tag()} 단계 1 (HTTP 통로) 가동 유지.`);
      return;
    }

    // 기존 단계 2 세션 종료
    if (stage2Client) {
      console.log(`${tag()} reload-bus: 기존 단계 2 세션 종료 후 재진입`);
      stopSseForClient(stage2Client);
      try {
        await stage2Client.destroy();
      } catch (err) {
        console.warn(
          `${tag()} reload-bus: 기존 세션 destroy 실패 (무시): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      stage2Client = null;
    }

    // 새 단계 2 세션 시작
    console.log(`${tag()} HTTP 통로 가동 + settings 정상 — 단계 2 진입`);
    try {
      // adminToken(main 클로저)을 enterStage2 로 넘긴다 — ClientReady 의 봇 토큰
      // issuer 가 이 값을 코어에 등록해 코어→봇 프록시 hop 부착에 쓴다(P1-통합 I1).
      stage2Client = await enterStage2(config, adminToken);
    } catch (err) {
      explainFatal(err);
      console.warn(`${tag()} 단계 2 로그인 실패 — 단계 1 (HTTP 통로) 가동 유지.`);
      stage2Client = null;
    }
  }

  // ── S16 — settings 갱신 hot-reload 구독 ─────────────────────────────────
  //
  // PUT /settings 직후 reload-bus 가 emit → 단계 2 재진입 시도.
  // settings 정합이면 destroy + 새 토큰으로 login. 정합 실패면 단계 2 종료 + 단계 1 유지.
  reloadBus.subscribe(() => {
    void tryEnterStage2("reload-bus emit");
  });

  // ── 첫 단계 2 진입 시도 ───────────────────────────────────────────────────
  await tryEnterStage2("부팅");

  // 단계 2 미진입이면 memory-api preflight 는 생략 (연결 시도 시 사용자 혼란 방지).
  // 단계 2 진입한 경우 pre-flight 체크.
  if (stage2Client) {
    // loadBotConfig 와 같은 결정 — MEMORY_API_URL 환경변수 → settings → 기본값.
    const { getBotSettings } = await import("./settings-store.ts");
    const bootSettings = getBotSettings(settingsPath);
    const memoryUrl = resolveMemoryApiUrl(bootSettings.memoryApiUrl);
    try {
      const health = await fetch(`${memoryUrl}/health`);
      if (health.ok) {
        console.log(`${tag()} memory-api health: OK`);
      } else {
        console.warn(
          `${tag()} memory-api health returned ${health.status}. 봇이 시작됐지만 ingest 호출이 실패할 수 있음.`,
        );
      }
    } catch (err) {
      console.warn(
        `${tag()} memory-api unreachable at ${memoryUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.warn(
        `${tag()} Start memory-api first (start-memory-api.bat) or the bot can't save anything.`,
      );
    }
  }
}

main().catch((err) => {
  explainFatal(err);
  process.exit(1);
});
