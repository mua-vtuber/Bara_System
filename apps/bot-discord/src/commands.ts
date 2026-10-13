/**
 * Slash command definitions and their handlers.
 *
 * Commands are kept tiny: most of the work happens in `api-client.ts`
 * (HTTP call, lives in apps/memory) and `formatting.ts` (presentation).
 * Handlers here just extract options, call the client, and reply.
 *
 * Common commands: capture, forget, stats, cleanup (raw → atomic 백필), extract.
 */

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { MemoryApiClient } from "../../memory/src/api-client.ts";
import { buildBaseMetadata, resolveDisplayName } from "./attribution.ts";
import {
  chunkForDiscord,
  formatExtractionResult,
  formatForgetReply,
  formatMemoryDetail,
  formatRecent,
  formatSearchResults,
  formatStats,
} from "./formatting.ts";
import { describeMemoryApiAuthFailure } from "./sse-bootstrap.ts";
import { assetCleanupFailureLines } from "./asset-cleanup-log.ts";

export interface CommandContext {
  client: MemoryApiClient;
  ownerUserId: string;
}

export interface SlashCommand {
  data: ReturnType<typeof buildCommandData>[number];
  handler: (
    interaction: ChatInputCommandInteraction,
    ctx: CommandContext,
  ) => Promise<void>;
}

function buildCommandData() {
  return [
    new SlashCommandBuilder()
      .setName("search")
      .setDescription("저장된 메모리에서 검색")
      .addStringOption((o) =>
        o.setName("query").setDescription("검색어").setRequired(true),
      )
      .addIntegerOption((o) =>
        o
          .setName("limit")
          .setDescription("최대 결과 개수 (기본 10)")
          .setMinValue(1)
          .setMaxValue(50),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("recent")
      .setDescription("최근 저장된 메모리 N개")
      .addIntegerOption((o) =>
        o
          .setName("n")
          .setDescription("개수 (기본 10)")
          .setMinValue(1)
          .setMaxValue(50),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("show")
      .setDescription("특정 메모리 상세 보기")
      .addIntegerOption((o) =>
        o.setName("id").setDescription("메모리 id").setRequired(true).setMinValue(1),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("forget")
      .setDescription("특정 메모리 삭제")
      .addIntegerOption((o) =>
        o.setName("id").setDescription("메모리 id").setRequired(true).setMinValue(1),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("edit")
      .setDescription("특정 메모리 내용을 같은 id로 수정")
      .addIntegerOption((o) =>
        o.setName("id").setDescription("메모리 id").setRequired(true).setMinValue(1),
      )
      .addStringOption((o) =>
        o
          .setName("content")
          .setDescription("새 내용")
          .setRequired(true)
          .setMaxLength(4000),
      )
      .addStringOption((o) =>
        o
          .setName("reason")
          .setDescription("수정 사유")
          .setMaxLength(500),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("append")
      .setDescription("특정 메모리에 새 기록을 연결")
      .addIntegerOption((o) =>
        o.setName("id").setDescription("메모리 id").setRequired(true).setMinValue(1),
      )
      .addStringOption((o) =>
        o
          .setName("content")
          .setDescription("추가할 내용")
          .setRequired(true)
          .setMaxLength(4000),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("stats")
      .setDescription("메모리 통계")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("cleanup")
      .setDescription("raw 메모리 LLM 백필 — 옛 auto_capture 노드를 extractor로 atomic 분해")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("extract")
      .setDescription("LLM으로 텍스트를 여러 atomic 메모리로 분해해 저장")
      .addStringOption((o) =>
        o
          .setName("text")
          .setDescription("분해할 텍스트")
          .setRequired(true),
      )
      .toJSON(),
  ];
}

/** Returns command JSON payloads ready for Discord registration. */
export function getCommandData() {
  return buildCommandData();
}

/** Reply, splitting long bodies into multiple messages. */
async function replyText(
  interaction: ChatInputCommandInteraction,
  text: string,
): Promise<void> {
  const chunks = chunkForDiscord(text);
  const [first, ...rest] = chunks;
  await interaction.reply({ content: first ?? "(empty)" });
  for (const chunk of rest) {
    await interaction.followUp({ content: chunk });
  }
}

export async function handleInteraction(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  // Owner-only gate.
  if (interaction.user.id !== ctx.ownerUserId) {
    await interaction.reply({
      content: "이 봇은 소유자 전용입니다.",
      ephemeral: true,
    });
    return;
  }

  try {
    switch (interaction.commandName) {
      case "search": {
        const query = interaction.options.getString("query", true);
        const limit = interaction.options.getInteger("limit") ?? 10;
        const results = await ctx.client.search(query, limit);
        await replyText(interaction, formatSearchResults(query, results));
        return;
      }
      case "recent": {
        const n = interaction.options.getInteger("n") ?? 10;
        const memories = await ctx.client.recent(n);
        await replyText(interaction, formatRecent(memories));
        return;
      }
      case "show": {
        const id = interaction.options.getInteger("id", true);
        const memory = await ctx.client.show(id);
        if (!memory) {
          await interaction.reply({ content: `메모리 #${id}을(를) 찾을 수 없음.` });
          return;
        }
        await replyText(interaction, formatMemoryDetail(memory));
        return;
      }
      case "forget": {
        const id = interaction.options.getInteger("id", true);
        const result = await ctx.client.forget(id);
        // WP-B1-20U 설계 17.17 — 코어가 지우지 못한 첨부 파일(assetCleanup.failed)마다 경고. 기억 삭제는 끝났고
        // 코어가 서버 시작 때 그 파일을 다시 지운다.
        if (result !== null) {
          for (const line of assetCleanupFailureLines(`/forget memory ${id}`, result.assetCleanup)) {
            console.warn(`[bot-discord] ${line}`);
          }
        }
        await interaction.reply({ content: formatForgetReply(id, result) });
        return;
      }
      case "edit": {
        await interaction.deferReply();
        const id = interaction.options.getInteger("id", true);
        const content = interaction.options.getString("content", true);
        const reason = interaction.options.getString("reason") ?? undefined;
        const member = interaction.inCachedGuild()
          ? { displayName: interaction.member.displayName }
          : null;
        const editor = resolveDisplayName(interaction.user, member);
        const result = await ctx.client.editMemory(id, {
          content,
          reason,
          editor,
          source: "discord",
        });
        const suffix =
          result.warnings.length > 0
            ? `\n주의: ${result.warnings.join(" / ")}`
            : "";
        await interaction.editReply({
          content: result.changed
            ? `메모리 #${id} 수정됨. revision #${result.revision?.id ?? "?"}${suffix}`
            : `메모리 #${id} 내용이 같아서 수정하지 않음.`,
        });
        return;
      }
      case "append": {
        await interaction.deferReply();
        const id = interaction.options.getInteger("id", true);
        const content = interaction.options.getString("content", true);
        const member = interaction.inCachedGuild()
          ? { displayName: interaction.member.displayName }
          : null;
        const displayName = resolveDisplayName(interaction.user, member);
        const metadata = buildBaseMetadata({
          author: interaction.user,
          member,
          source: "discord-slash-append",
          channelId: interaction.channelId ?? null,
          guildId: interaction.guildId ?? null,
        });
        const result = await ctx.client.appendToMemory(id, {
          content,
          author: displayName,
          platform: "discord",
          metadata,
        });
        const suffix =
          result.warnings.length > 0
            ? `\n주의: ${result.warnings.join(" / ")}`
            : "";
        await interaction.editReply({
          content: `메모리 #${id}에 #${result.appendedId} 추가 연결됨.${suffix}`,
        });
        return;
      }
      case "stats": {
        const stats = await ctx.client.stats();
        await replyText(interaction, formatStats(stats));
        return;
      }
      case "cleanup": {
        const r = await ctx.client.cleanup();
        await interaction.reply({
          content: `🧹 (Phase ${r.phase} 예정) ${r.message}`,
        });
        return;
      }
      case "extract": {
        // LLM 호출 → 임베딩 → dedup → 저장 → conflict 체크까지 한 사이클이
        // 보통 5~20초 걸린다. 3초 안에 응답 못 하면 디스코드는 interaction을
        // 만료시키므로 deferReply로 "생각 중..." 상태로 둔다.
        await interaction.deferReply();
        const text = interaction.options.getString("text", true);
        try {
          // Attribution 3차원 (spec 4.5):
          //   author = display name (member.displayName → globalName → username)
          //   metadata.user_id = Discord 영구 ID
          const member = interaction.inCachedGuild()
            ? { displayName: interaction.member.displayName }
            : null;
          const displayName = resolveDisplayName(interaction.user, member);
          const baseMetadata = buildBaseMetadata({
            author: interaction.user,
            member,
            source: "discord-slash-extract",
            channelId: interaction.channelId ?? null,
            guildId: interaction.guildId ?? null,
          });
          const result = await ctx.client.extractFromText({
            text,
            author: displayName,
            platform: "discord",
            metadata: baseMetadata,
            preserveRaw: true,
          });
          const reply = formatExtractionResult(result, { source: "manual" });
          const chunks = chunkForDiscord(reply);
          const [first, ...rest] = chunks;
          await interaction.editReply({ content: first ?? "(empty)" });
          for (const chunk of rest) {
            await interaction.followUp({ content: chunk });
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          // 503 (extractor 미부착) 또는 LLM 호출 실패 모두 사용자에게 친근하게.
          const friendly = message.includes("extractor")
            ? "🛠️ 서버에 LLM 추출기가 부착되지 않았음. memory-api를 LLM_PROVIDER 환경변수와 함께 재기동 필요."
            : `⚠️ 추출 실패: ${message}`;
          await interaction.editReply({ content: friendly });
        }
        return;
      }
      default:
        await interaction.reply({
          content: `알 수 없는 명령: ${interaction.commandName}`,
        });
    }
  } catch (err) {
    // /forget·/stats·/cleanup 등 이 파일의 명령이 401(토큰 무효)과 403(권한 부족 —
    // 대시보드에서 권한을 올려야 함)을 구분해 안내하도록 공용 판별기를 쓴다(WP-B1-15).
    const message = describeMemoryApiAuthFailure(err);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: `⚠️ 오류: ${message}` });
    } else {
      await interaction.reply({ content: `⚠️ 오류: ${message}` });
    }
  }
}
