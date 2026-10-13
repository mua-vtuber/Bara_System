import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openMemoryDatabase } from "../../memory/src/db/migrations.ts";
import { embeddingDimensionOf } from "../../memory/src/embedding/factory.ts";
import {
  getMemorySettings,
  putMemorySettings,
  type MemorySettings,
  type MemorySettingsPartial,
} from "../../memory/src/settings/memory-settings.ts";
import type { SetupPaths } from "./paths.ts";

export interface AiSetupSelection {
  useAi: boolean;
  localProvider: "ollama" | "lmstudio" | "none";
  extractorModel?: string;
  visionModel?: string;
  cleanupEnabled?: boolean;
  /**
   * WP-B2-06R — true 면 이 선택이 사용자(또는 운영자)가 이번 실행에서 실제로
   * 고른 값이다(대화형 답변, `--ollama`/`--lmstudio`/`--no-ai` 명시 플래그, 런처
   * 프로필 버튼). false/undefined 는 옵션 없는 `--yes`(기본값 수락)처럼 이번
   * 실행에서 아무것도 직접 고르지 않은 경우 — 이때는 기존 llm 설정을 그대로
   * 보존해야 하므로 buildSetupSettingsPartial/writeSettingsAndMigrateDb 가 이
   * 필드로 "덮어써도 되는 선택인지"를 가른다.
   */
  explicit?: boolean;
}

export interface WriteSetupResult {
  settings: MemorySettings;
  schemaVersion: number;
  /**
   * WP-B2-06R — 이번 실행에서 llm 슬롯을 실제로 새 선택으로 바꿨는지, 아니면
   * 기존 값을 그대로 보존했는지. 최초 설치(기존 settings 파일이 없음)는 항상
   * "changed"로 본다 — 보존할 이전 값 자체가 없으므로.
   */
  llmOutcome: "kept" | "changed";
}

function ensureDirs(paths: SetupPaths): void {
  for (const dir of [
    paths.dataDir,
    dirname(paths.settingsPath),
    dirname(paths.secretsPath),
    paths.assetDir,
    paths.hfCacheDir,
    paths.kiwiModelDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

function withSetupEnv<T>(paths: SetupPaths, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(paths.env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function llmPartial(selection: AiSetupSelection): MemorySettingsPartial["llm"] {
  if (!selection.useAi || selection.localProvider === "none") {
    return {
      extractor: { enabled: false },
      cleanup: { enabled: false },
      vision: { enabled: false },
    };
  }

  if (selection.localProvider === "lmstudio") {
    return {
      extractor: {
        enabled: true,
        provider: "openai_compatible",
        openaiBaseUrl: "http://127.0.0.1:1234/v1",
        openaiModel: selection.extractorModel ?? "qwen3:4b-instruct",
      },
      cleanup: {
        enabled: selection.cleanupEnabled ?? false,
        provider: "openai_compatible",
        openaiBaseUrl: "http://127.0.0.1:1234/v1",
        openaiModel: "",
      },
      vision: {
        enabled: false,
        provider: "openai_compatible",
        openaiBaseUrl: "http://127.0.0.1:1234/v1",
        openaiModel: selection.visionModel ?? "qwen3-vl:4b-instruct",
      },
    };
  }

  return {
    extractor: {
      enabled: true,
      provider: "ollama",
      ollamaUrl: "http://127.0.0.1:11434",
      ollamaModel: selection.extractorModel ?? "qwen3:4b-instruct",
    },
    cleanup: {
      enabled: selection.cleanupEnabled ?? false,
      provider: "ollama",
      ollamaUrl: "http://127.0.0.1:11434",
      ollamaModel: "",
    },
    vision: {
      enabled: false,
      provider: "ollama",
      ollamaUrl: "http://127.0.0.1:11434",
      ollamaModel: selection.visionModel ?? "qwen3-vl:4b-instruct",
    },
  };
}

export function buildSetupSettingsPartial(
  paths: SetupPaths,
  selection: AiSetupSelection,
): MemorySettingsPartial {
  return {
    db: {
      path: paths.dbPath,
      host: "127.0.0.1",
      port: 3001,
    },
    ui: {
      startPage: "dashboard",
    },
    llm: llmPartial(selection),
    assets: {
      dir: paths.assetDir,
    },
    backup: {
      dir:
        paths.mode === "desktop-windows"
          ? join(paths.dataDir, "backups")
          : "data/backups",
    },
  };
}

export function writeSetupState(
  paths: SetupPaths,
  state: Record<string, unknown>,
): void {
  mkdirSync(dirname(paths.setupStatePath), { recursive: true });
  const temporary = `${paths.setupStatePath}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2));
  renameSync(temporary, paths.setupStatePath);
}

/**
 * WP-B2-06R — 이전 llm 슬롯과 이번 선택이 만드는 llm partial 이 실제로 다른지
 * 비교한다. secrets 는 이 함수가 보기 전에 이미 llmPartial() 결과에 안 실려
 * 있으므로(API 키는 secrets.json 소관) 여기서는 provider·주소·모델·on-off 만
 * 비교하면 된다 — JSON 직렬화 비교로 충분(두 값 모두 이 모듈이 만든 평면
 * 객체라 키 순서·부가 필드 문제가 없음).
 */
function llmSlotsDiffer(
  previous: MemorySettings["llm"],
  proposed: MemorySettingsPartial["llm"],
): boolean {
  if (!proposed) return false;
  for (const slotKey of ["extractor", "cleanup", "vision"] as const) {
    const proposedSlot = proposed[slotKey];
    if (!proposedSlot) continue;
    const previousSlot = previous[slotKey] as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(proposedSlot)) {
      if (previousSlot[key] !== value) return true;
    }
  }
  return false;
}

export function writeSettingsAndMigrateDb(
  paths: SetupPaths,
  selection: AiSetupSelection,
): WriteSetupResult {
  return withSetupEnv(paths, () => {
    ensureDirs(paths);
    const partial = buildSetupSettingsPartial(paths, selection);
    let llmOutcome: "kept" | "changed" = "changed";
    // A retry repairs preparation without moving an existing user's database.
    if (existsSync(paths.settingsPath)) {
      const previous = getMemorySettings(paths.settingsPath, paths.secretsPath);
      partial.db = previous.db;
      partial.ui = previous.ui;
      partial.assets = previous.assets;
      partial.backup = previous.backup;
      // launch.ts and Bara Launcher send local/desktop users back through setup whenever
      // the completion marker is not current. None of those reruns imply the user actually chose a new AI
      // answer in *this* run — only an explicit choice (interactive answer, --ollama/
      // --lmstudio/--no-ai, or a launcher profile button) does, tracked via
      // `selection.explicit`. A rerun that carries no explicit choice (bare --yes)
      // always preserves the configured llm slot, in every mode —
      // the dashboard LLM settings screen remains the normal channel for changing it.
      if (!selection.explicit) {
        partial.llm = previous.llm;
        llmOutcome = "kept";
      } else {
        llmOutcome = llmSlotsDiffer(previous.llm, partial.llm) ? "changed" : "kept";
      }
    }
    putMemorySettings(partial, paths.settingsPath, paths.secretsPath);
    // 기록된 settings 의 임베딩 모델에서 차원을 단일 출처(embedding/factory.ts)로
    // 변환해 DB 글 벡터 차원을 서버 부팅(server.ts)과 같은 경로로 일관 구성한다.
    const settings = getMemorySettings(paths.settingsPath, paths.secretsPath);
    const dbPath = process.env.MEMORY_DB_PATH?.trim() || settings.db.path;
    const resolvedDbPath = dbPath === ":memory:" ? dbPath : resolve(paths.memoryAppDir, dbPath);
    if (resolvedDbPath !== ":memory:") mkdirSync(dirname(resolvedDbPath), { recursive: true });
    const db = openMemoryDatabase(resolvedDbPath, {
      embeddingDim: embeddingDimensionOf(settings.db.embeddingModel),
    });
    const row = db
      .prepare("SELECT MAX(version) AS v FROM schema_version")
      .get() as { v: number };
    db.close();
    return { settings, schemaVersion: row.v, llmOutcome };
  });
}
