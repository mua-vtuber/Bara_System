import { join } from "node:path";
import { existsSync } from "node:fs";
import { buildDashboardLink, resolveDashboardLinkOptions } from "../../memory/src/tools/dashboard-link.ts";
import type { SetupMode, SetupPaths } from "./paths.ts";
import { resolveSetupPaths } from "./paths.ts";
import { detectOllama, detectOpenAiCompatible } from "./probes.ts";
import {
  writeSettingsAndMigrateDb,
  writeSetupState,
  type AiSetupSelection,
} from "./settings-writer.ts";

export interface SetupEngineOptions {
  mode: SetupMode;
  repoRoot: string;
  dryRun?: boolean;
  yes?: boolean;
  jsonEvents?: boolean;
  ai?: AiSetupSelection;
}

export interface SetupCommandPlan {
  label: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface SetupEngineResult {
  mode: SetupMode;
  paths: SetupPaths;
  commands: SetupCommandPlan[];
  warnings: string[];
  dashboardUrl: string;
  schemaVersion?: number;
  /**
   * WP-B2-06R — 이번 실행이 llm 슬롯을 기존 값 그대로 뒤(kept)냐 새 선택으로
   * 바꿨는지(changed). dry-run 은 실제로 쓰지 않으므로 undefined.
   */
  llmOutcome?: "kept" | "changed";
}

export const MINIMUM_TEXT_MODEL = "qwen3:4b-instruct";
export const MINIMUM_VISION_MODEL = "qwen3-vl:4b-instruct";

function emit(jsonEvents: boolean, type: string, payload: Record<string, unknown>): void {
  if (jsonEvents) {
    console.log(JSON.stringify({ type, ...payload }));
    return;
  }
  const message = typeof payload.message === "string" ? payload.message : type;
  console.log(message);
}

function ollamaInstallCommand(mode: SetupMode): SetupCommandPlan {
  if (mode === "desktop-windows") {
    return {
      label: "install-ollama-windows",
      command: [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "irm https://ollama.com/install.ps1 | iex",
      ],
    };
  }
  return {
    label: "install-ollama-linux",
    command: ["sh", "-c", "curl -fsSL https://ollama.com/install.sh | sh"],
  };
}

function baseCommandPlan(
  repoRoot: string,
  paths: SetupPaths,
): SetupCommandPlan[] {
  const assetEnv = paths.env;
  return [
    {
      label: "dashboard-build",
      command: ["bun", "run", "build:dashboard"],
      cwd: join(repoRoot, "apps", "memory"),
    },
    {
      label: "fetch-kiwi-model",
      command: ["bun", "run", "apps/memory/scripts/fetch-kiwi-model.ts"],
      cwd: repoRoot,
      env: assetEnv,
    },
    {
      label: "prefetch-core-models",
      command: ["bun", "run", "apps/memory/scripts/prefetch-core-models.ts"],
      cwd: repoRoot,
      env: assetEnv,
    },
  ];
}

function formatCommand(plan: SetupCommandPlan): string {
  const envText = plan.env
    ? Object.entries(plan.env)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")
    : "";
  const commandText = plan.command.join(" ");
  return envText.length > 0 ? `${envText} ${commandText}` : commandText;
}

function runCommand(plan: SetupCommandPlan): void {
  // The current setup CLI is already running under Bun. Reuse that executable
  // instead of assuming a separate `bun` command is present on PATH.
  const command = plan.command[0] === "bun"
    ? [process.execPath, ...plan.command.slice(1)]
    : plan.command;
  const proc = Bun.spawnSync(command, {
    cwd: plan.cwd,
    env: plan.env ? { ...process.env, ...plan.env } : process.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`${plan.label} 실패 (exit ${proc.exitCode})`);
  }
}

export async function runSetupEngine(
  opts: SetupEngineOptions,
): Promise<SetupEngineResult> {
  const paths = resolveSetupPaths({ mode: opts.mode, repoRoot: opts.repoRoot });
  const ai = opts.ai ?? {
    useAi: true,
    localProvider: "ollama",
    extractorModel: MINIMUM_TEXT_MODEL,
    visionModel: MINIMUM_VISION_MODEL,
    cleanupEnabled: false,
  };
  const warnings: string[] = [];
  const commands = baseCommandPlan(opts.repoRoot, paths);

  emit(opts.jsonEvents ?? false, "setup.start", {
    message: `[setup] mode=${opts.mode}`,
    mode: opts.mode,
  });

  if (ai.useAi && ai.localProvider === "ollama") {
    const ollama = await detectOllama();
    if (!ollama.ok) {
      warnings.push(
        "Ollama가 감지되지 않았습니다. 동의 시 공식 설치 명령을 실행하고, 실패하면 https://ollama.com/download 를 안내하세요.",
      );
      commands.push(ollamaInstallCommand(opts.mode));
    }
    commands.push(
      { label: "ollama-pull-text", command: ["ollama", "pull", MINIMUM_TEXT_MODEL] },
      { label: "ollama-pull-vision", command: ["ollama", "pull", MINIMUM_VISION_MODEL] },
    );
  }

  if (ai.useAi && ai.localProvider === "lmstudio") {
    const lmstudio = await detectOpenAiCompatible();
    if (!lmstudio.ok) {
      warnings.push(
        "LM Studio OpenAI-compatible 서버(http://127.0.0.1:1234/v1)가 감지되지 않았습니다. settings 는 이 주소를 가리키도록 기록됩니다.",
      );
      warnings.push(
        "LM Studio 를 설치(https://lmstudio.ai/download)하고 Developer 서버를 포트 1234 로 켠 뒤 setup 을 다시 실행하거나 서비스를 재시작하세요. 서버 확인: /v1/models — https://lmstudio.ai/docs/developer/openai-compat",
      );
    }
  }

  let schemaVersion: number | undefined;
  let dashboardUrl: string | undefined;
  let llmOutcome: "kept" | "changed" | undefined;
  if (opts.dryRun) {
    emit(opts.jsonEvents ?? false, "setup.dryRun", {
      message: "[setup] dry-run: 파일 쓰기와 명령 실행을 건너뜁니다.",
      commands,
    });
    if (!opts.jsonEvents) {
      for (const command of commands) {
        console.log(
          `[setup] plan ${command.label}: ${formatCommand(command)}` +
            (command.cwd ? ` (cwd=${command.cwd})` : ""),
        );
      }
    }
  } else {
    const state = {
      status: "preparing",
      completedAt: null as string | null,
      mode: opts.mode,
      env: paths.env,
      dbPath: paths.dbPath,
      settingsPath: paths.settingsPath,
      llm: {
        status: ai.useAi ? "configured" : "disabled",
        provider: ai.localProvider,
      },
    };
    writeSetupState(paths, state);
    let failedStep = "settings-and-database";
    try {
      if (ai.useAi && ai.localProvider === "ollama" && !opts.yes) {
        failedStep = "provider-consent";
        emit(opts.jsonEvents ?? false, "setup.progress", { message: "Ollama 설치·모델 준비 동의가 필요합니다.", step: failedStep });
        const modeFlag = opts.mode === "desktop-windows" ? "--desktop" : "--local";
        throw new Error(`Ollama 설치·모델 다운로드에 동의하지 않아 준비를 완료하지 않았습니다. 동의하면 저장소 루트에서 bun run setup -- ${modeFlag} --ollama --yes 를 실행하세요. AI 없이 쓰려면 --no-ai 로 다시 준비하세요.`);
      }
      emit(opts.jsonEvents ?? false, "setup.progress", { message: `[setup] ${failedStep}`, step: failedStep });
      const result = writeSettingsAndMigrateDb(paths, ai);
      schemaVersion = result.schemaVersion;
      llmOutcome = result.llmOutcome;
      state.dbPath = result.settings.db.path;
      // WP-B2-06R — tell the person which AI answers this run kept vs. changed,
      // in both the plain-text and jsonEvents surfaces.
      emit(opts.jsonEvents ?? false, "setup.llm", {
        message:
          llmOutcome === "kept"
            ? "AI 설정: 기존 값을 그대로 유지했습니다(이번 실행에서 새로 고른 값 없음)."
            : "AI 설정: 이번 실행에서 고른 값으로 바꿨습니다.",
        llmOutcome,
      });
      for (const command of commands) {
        failedStep = command.label;
        emit(opts.jsonEvents ?? false, "setup.progress", { message: `[setup] ${command.label}`, step: command.label });
        runCommand(command);
      }
      failedStep = "dashboard-capability";
      dashboardUrl = buildDashboardLink(resolveDashboardLinkOptions(paths.memoryAppDir, { ...process.env, ...paths.env }));
      // Files alone do not imply completion: publish this marker only after every required command.
      writeSetupState(paths, { ...state, status: "complete", completedAt: new Date().toISOString(), schemaVersion });
    } catch (error) {
      writeSetupState(paths, { ...state, status: "failed", failedStep });
      throw error;
    }
  }

  const linkOptions = existsSync(paths.settingsPath)
    ? resolveDashboardLinkOptions(paths.memoryAppDir, { ...process.env, ...paths.env })
    : { url: "http://127.0.0.1:3001/", tokensFile: paths.env.SSE_TOKEN_PATH };
  dashboardUrl ??= linkOptions.url;

  emit(opts.jsonEvents ?? false, opts.dryRun ? "setup.plan" : "setup.complete", {
    message: `[setup] ${opts.dryRun ? "계획 확인 완료" : "준비 완료"}. 대시보드는 서버 준비 후 인증 링크로 열어 주세요.`,
    dashboardBaseUrl: linkOptions.url,
    warnings,
  });

  return {
    mode: opts.mode,
    paths,
    commands,
    warnings,
    dashboardUrl,
    schemaVersion,
    llmOutcome,
  };
}
