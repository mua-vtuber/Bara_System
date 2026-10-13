import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { SetupMode } from "./paths.ts";
import { runSetupEngine } from "./engine.ts";
import type { AiSetupSelection } from "./settings-writer.ts";
import { resolve } from "node:path";

interface CliArgs {
  mode?: SetupMode;
  aiProvider?: "ollama" | "lmstudio" | "none";
  dryRun: boolean;
  yes: boolean;
  jsonEvents: boolean;
}

/** The old `--server` mode installed the abolished direct units (`bara-memory`, `bara-deploy.timer`, ...).
 * Every server is now installed and updated the pet way, so the flag stops with the replacement named. */
export const SERVER_MODE_REMOVED_MESSAGE =
  "'--server' 설치 방식은 없앴습니다(옛 직접 설치 유닛 bara-memory·bara-deploy.timer 를 켜던 방식). " +
  "원격 서버는 펫의 \"내 외부 서버\" 설치로 준비하고, 소유자 운영 서버 반영은 저장소 루트에서 'bun run deploy:a1' 을 실행하세요. " +
  "이 컴퓨터에서 직접 준비하려면 --local(WSL/Linux) 또는 --desktop(Windows)을 쓰세요.";

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dryRun: false,
    yes: false,
    jsonEvents: false,
  };
  for (const arg of argv) {
    if (arg === "--server") throw new Error(SERVER_MODE_REMOVED_MESSAGE);
    else if (arg === "--local") args.mode = "local";
    else if (arg === "--desktop") args.mode = "desktop-windows";
    else if (arg === "--ollama") args.aiProvider = "ollama";
    else if (arg === "--lmstudio") args.aiProvider = "lmstudio";
    else if (arg === "--no-ai") args.aiProvider = "none";
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--yes" || arg === "-y") args.yes = true;
    else if (arg === "--json-events") args.jsonEvents = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Bara setup",
          "  bun run setup -- --local [--ollama|--lmstudio|--no-ai] [--yes] (WSL/Linux, systemd 없음)",
          "  bun run setup -- --desktop [--ollama|--lmstudio|--no-ai] [--yes]",
          "  flags: --yes, --dry-run, --json-events",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return args;
}

function defaultAiSelection(
  provider: "ollama" | "lmstudio" | "none",
): AiSetupSelection {
  // WP-B2-06R — reaching this function means the caller passed --ollama/
  // --lmstudio/--no-ai explicitly, so the choice is explicit regardless of mode.
  if (provider === "none") {
    return { useAi: false, localProvider: "none", explicit: true };
  }
  return {
    useAi: true,
    localProvider: provider,
    extractorModel: "qwen3:4b-instruct",
    visionModel: "qwen3-vl:4b-instruct",
    cleanupEnabled: false,
    explicit: true,
  };
}

async function askAiSelection(args: CliArgs): Promise<AiSetupSelection> {
  if (args.aiProvider) {
    return defaultAiSelection(args.aiProvider);
  }
  if (args.yes || args.dryRun) {
    // WP-B2-06R — bare --yes/--dry-run picks no provider itself; it accepts a
    // default only for a first install. On a rerun with existing settings,
    // writeSettingsAndMigrateDb must preserve the configured llm slot instead
    // of silently reapplying this default, so `explicit` stays unset here.
    return {
      useAi: true,
      localProvider: "ollama",
      extractorModel: "qwen3:4b-instruct",
      visionModel: "qwen3-vl:4b-instruct",
      cleanupEnabled: false,
    };
  }

  const rl = createInterface({ input, output });
  try {
    const useAiAnswer = (
      await rl.question("AI 기능을 사용할까요? [Y/n] ")
    ).trim().toLowerCase();
    const useAi = useAiAnswer === "" || useAiAnswer === "y" || useAiAnswer === "yes";
    // WP-B2-06R — an interactive TTY answer is always an explicit choice, even
    // when the person just presses Enter to accept the shown default: they saw
    // the question and answered it in this run.
    if (!useAi) return { useAi: false, localProvider: "none", explicit: true };

    const providerAnswer = (
      await rl.question("로컬 AI provider: 1) Ollama  2) LM Studio [1] ")
    ).trim();
    const localProvider = providerAnswer === "2" ? "lmstudio" : "ollama";
    console.log(
      "최소 권장 모델: 글 qwen3:4b-instruct, 이미지 qwen3-vl:4b-instruct. 더 좋은 모델을 돌릴 여건이면 바꿔도 됩니다.",
    );
    console.log(
      "추가 AI(데이터 정리)는 32B 이상 또는 API 권장입니다. Claude Code/Codex 같은 별도 터미널 프로그램은 Bara가 직접 실행하지 않습니다.",
    );
    return {
      useAi: true,
      localProvider,
      extractorModel: "qwen3:4b-instruct",
      visionModel: "qwen3-vl:4b-instruct",
      cleanupEnabled: false,
      explicit: true,
    };
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode =
    args.mode ?? (process.platform === "win32" ? "desktop-windows" : "local");
  const ai = await askAiSelection(args);
  if (ai.useAi && ai.localProvider === "ollama" && !args.yes && !args.dryRun && input.isTTY) {
    const rl = createInterface({ input, output });
    try {
      args.yes = isInstallationConsent(await rl.question("Ollama 설치(필요한 경우)와 선택한 모델 다운로드를 실행할까요? [y/N] "));
    } finally { rl.close(); }
  }
  const result = await runSetupEngine({
    mode,
    repoRoot: resolve(import.meta.dir, "../../.."),
    dryRun: args.dryRun,
    yes: args.yes,
    jsonEvents: args.jsonEvents,
    ai,
  });

  if (!args.jsonEvents) {
    // WP-B2-06R — runSetupEngine already emitted this as a setup.llm progress
    // line; print it again here as the final, easy-to-spot summary line.
    if (result.llmOutcome === "kept") {
      console.log("AI 설정: 기존 값을 그대로 유지했습니다(이번 실행에서 새로 고른 값 없음).");
    } else if (result.llmOutcome === "changed") {
      console.log("AI 설정: 이번 실행에서 고른 값으로 바꿨습니다.");
    }
    console.log(args.dryRun ? "실제 설정·모델 준비는 실행하지 않았습니다. 첫 실행은 저장소 루트에서:" : "설정과 모델 준비가 끝났습니다. 첫 실행은 저장소 루트에서:");
    console.log(`cd apps/memory && bun run ../setup/src/launch.ts ${mode === "desktop-windows" ? "--desktop" : "--local"}`);
    console.log("--link 는 준비 상태 확인 후 인증 링크를 터미널에 표시합니다. 링크를 공유하지 마세요.");
    if (result.warnings.length > 0) {
      console.log("주의:");
      for (const warning of result.warnings) console.log(`- ${warning}`);
    }
  }
}

export function isInstallationConsent(answer: string): boolean {
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

if (import.meta.main) main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
