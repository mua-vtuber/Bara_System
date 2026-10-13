/**
 * 슬래시 커맨드 일회성 등록 스크립트 (Phase 5.5.7 / W5.1).
 *
 * `commands.ts` 가 바뀔 때마다 `bun run register` 로 실행한다. Discord 는
 * 커맨드 정의를 서버 측에서 캐시하므로 이름·옵션·설명이 바뀌면 재실행 필요.
 *
 * settings.json 에서 applicationId / guildId 를 읽는다.
 *   - applicationId 부재 → 슬래시 등록 건너뜀 + 콘솔 명시 경고 (silent skip 금지)
 *   - guildId 부재 → 글로벌 등록 (반영까지 최대 1시간 소요)
 *   - guildId 있음 → 길드 한정 등록 (즉시 반영)
 *
 * 부트스트랩 env 예외: BOT_SETTINGS_PATH 만 허용.
 */

import { REST, Routes } from "discord.js";
import { loadBotConfig } from "./config.ts";
import { getCommandData } from "./commands.ts";

async function main() {
  const settingsPath = process.env.BOT_SETTINGS_PATH?.trim() || undefined;
  const config = loadBotConfig(settingsPath);

  // applicationId 부재 = 슬래시 등록 불가 — silent skip 금지.
  if (!config.applicationId || config.applicationId.trim().length === 0) {
    console.warn(
      "[bot-discord] 슬래시 커맨드 등록 건너뜀 — settings.applicationId 또는 settings.guildId 부재",
    );
    console.warn(
      "[bot-discord] 메모리 대시보드 → 디스코드 봇 탭 → Application id 를 입력한 뒤 `bun run register` 를 다시 실행하라.",
    );
    return;
  }

  const rest = new REST({ version: "10" }).setToken(config.token);
  const commands = getCommandData();

  const route = config.guildId
    ? Routes.applicationGuildCommands(config.applicationId, config.guildId)
    : Routes.applicationCommands(config.applicationId);

  console.log(
    `[bot-discord] 슬래시 커맨드 ${commands.length} 개 업로드 → ${config.guildId ? `길드 ${config.guildId}` : "글로벌"}...`,
  );

  await rest.put(route, { body: commands });
  console.log("[bot-discord] 슬래시 커맨드 등록 완료.");
}

main().catch((err) => {
  console.error("[bot-discord] 슬래시 커맨드 등록 실패:", err);
  process.exit(1);
});
