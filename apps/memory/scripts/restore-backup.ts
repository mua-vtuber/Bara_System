/**
 * restore-backup CLI — 서버 회차 복구 또는 다운로드 ZIP의 새 폴더 복원.
 *
 * 복원 로직은 src/backup/restore.ts 가 소유하고 테스트한다. 이 파일은 인자 파싱 +
 * "서버 정지" 탐침 + 운영자 명시 확인(--yes) + 대상 나열 출력만 담당한다(로직 재사용).
 *
 * 사용:
 *   cd apps/memory
 *   bun run scripts/restore-backup.ts <회차폴더> [--data-dir <dir>] [--port 3001] --yes
 *   펫 방식 서버(관리 배치 db/, config/, tokens/, assets/):
 *   bun run scripts/restore-backup.ts <회차폴더> --managed-data <서버 폴더>/data [--port <n>] --yes
 *   — 경로·포트는 <data>/config/memory-settings.json 에서 읽고, 다른 서버 폴더의 회차는 거부한다.
 *
 * "서버 정지 확인" 의 정직한 한계 (spec D2-d — 확인을 위장하지 않는다):
 *   - 파일 존재 검사로 정지를 위장하지 않는다.
 *   - /health 탐침이 *응답하면* 서버가 살아있다는 증거이므로 거부한다.
 *   - 탐침이 *응답하지 않아도* 그것은 "정지 증명" 이 아니라 탐침의 한계다(포트가
 *     막혔거나 다른 이유일 수 있다). 그래서 응답 없음만으로는 진행하지 않고,
 *     운영자가 직접 정지를 확인한 뒤 --yes 로 명시해야 진행한다.
 *
 * exit code:
 *   0 — 복원 성공
 *   1 — 게이트 미통과(--yes 없음 / 서버 살아있음) 또는 복원 실패(RestoreError 등)
 *   2 — 인자 오류(회차 폴더 미지정)
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getMemorySettings, resolveSettingsFilePaths } from "../src/settings/memory-settings.ts";
import {
  assertManagedRound,
  executeRestore,
  managedTargets,
  planRestore,
  readManagedRestoreSettings,
  RestoreError,
} from "../src/backup/restore.ts";
import type { RestorePlan } from "../src/backup/restore.ts";
import { managedLayout } from "../src/settings/managed-layout.ts";

const HEALTH_PROBE_TIMEOUT_MS = 1500;
/** systemd unit of a pet-installed server (managed layout). */
const MANAGED_SERVICE = "bara-pet-memory.service";

interface ManagedArgs { roundDir: string; managedData: string; port: number | null; yes: boolean }

/**
 * `<round> --managed-data <dir> [--port <n>] --yes`. null when `--managed-data` is not given (the one-folder mode);
 * "invalid" for anything else, including `--data-dir` together with `--managed-data`.
 */
export function parseManagedArgs(argv: string[]): ManagedArgs | null | "invalid" {
  if (!argv.includes("--managed-data")) return null;
  let roundDir: string | null = null;
  let managedData: string | null = null;
  let port: number | null = null;
  let yes = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--yes") yes = true;
    else if (arg === "--managed-data") {
      managedData = argv[++i] ?? null;
      if (managedData === null || managedData.trim() === "") return "invalid";
    } else if (arg === "--port") {
      const value = Number.parseInt(argv[++i] ?? "", 10);
      if (Number.isNaN(value)) return "invalid";
      port = value;
    } else if (arg.startsWith("--")) return "invalid";
    else if (roundDir === null) roundDir = arg;
    else return "invalid";
  }
  return roundDir === null || managedData === null ? "invalid" : { roundDir, managedData, port, yes };
}

/** Restores a server round into the pet-managed layout the managed settings file describes. */
async function mainManaged(args: ManagedArgs): Promise<number> {
  const roundDir = resolve(args.roundDir);
  if (!existsSync(roundDir)) {
    console.error(`[restore] 회차 폴더가 없다: ${roundDir}`);
    return 1;
  }
  if (!args.yes) {
    console.log("[restore] --yes 가 없어 복원을 진행하지 않는다 (현재 파일은 관리 데이터 폴더의 before-restore 폴더로 옮겨 보존한다).");
    console.log("");
    printUsage();
    return 1;
  }
  try {
    let layout;
    try { layout = managedLayout(args.managedData); }
    catch (e) { throw new RestoreError(`--managed-data 는 서버 폴더의 data 절대 경로여야 한다: ${args.managedData} — ${(e as Error).message}`); }
    const settings = readManagedRestoreSettings(layout);
    const port = args.port ?? settings.db.port;
    if (await serverResponds(port)) {
      console.error(`[restore] 서버가 살아있다 (http://127.0.0.1:${port}/health 응답). 먼저 정지하라: sudo systemctl stop ${MANAGED_SERVICE}`);
      return 1;
    }
    console.log(`[restore] /health(포트 ${port}) 응답 없음 — 정지 증명은 아니다. --yes 로 운영자가 정지를 확인했다고 보고 진행한다.`);
    const plan = planRestore(roundDir);
    if (plan.sourceFormat === "download-zip") throw new RestoreError("다운로드 ZIP은 --managed-data 로 복원하지 않는다. --data-dir 로 비어 있는 새 폴더에 복원하라.");
    assertManagedRound(roundDir, plan, settings);
    const result = executeRestore(roundDir, join(dirname(roundDir), "assets-mirror"), managedTargets(layout, settings));
    console.log(`[restore] 완료 — 파일 ${result.files}개, 자산 ${result.assets}개를 ${layout.root} 의 관리 배치로 되돌렸다.`);
    if (result.beforeRestoreDir) console.log(`[restore] 복원 전 파일은 보존 폴더에 있다: ${result.beforeRestoreDir}`);
    console.log(`[restore] 서버를 다시 켠다: sudo systemctl start ${MANAGED_SERVICE}`);
    return 0;
  } catch (e) {
    if (e instanceof RestoreError) {
      console.error(`[restore] 복원 거부 — ${e.message}`);
      return 1;
    }
    throw e;
  }
}

interface CliArgs {
  roundDir: string;
  dataDir: string | null;
  dataDirExplicit: boolean;
  port: number;
  yes: boolean;
}

/**
 * 인자를 파싱한다. 첫 위치 인자 = 회차 폴더(필수). 나머지는 플래그.
 * 회차 폴더가 없으면 null 을 돌려 호출부가 사용법 출력 후 exit 2 하게 한다.
 */
function parseArgs(argv: string[], defaults: { dataDir: string | null; port: number }): CliArgs | null {
  let roundDir: string | null = null;
  let dataDir = defaults.dataDir;
  let dataDirExplicit = false;
  let port = defaults.port;
  let yes = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--yes") {
      yes = true;
    } else if (arg === "--data-dir") {
      const next = argv[i + 1];
      if (next === undefined) return null;
      dataDir = next;
      dataDirExplicit = true;
      i += 1;
    } else if (arg === "--port") {
      const next = argv[i + 1];
      if (next === undefined) return null;
      const parsed = Number.parseInt(next, 10);
      if (Number.isNaN(parsed)) return null;
      port = parsed;
      i += 1;
    } else if (arg.startsWith("--")) {
      console.error(`[restore] 알 수 없는 플래그: ${arg}`);
      return null;
    } else if (roundDir === null) {
      roundDir = arg;
    } else {
      console.error(`[restore] 위치 인자 중복: ${arg}`);
      return null;
    }
  }

  if (roundDir === null) return null;
  return { roundDir, dataDir, dataDirExplicit, port, yes };
}

function printUsage(): void {
  console.log(
    "사용법: bun run scripts/restore-backup.ts <다운로드.zip|회차폴더> [--data-dir <dir>] [--port 3001] --yes",
  );
  console.log(
    `펫 방식 서버: bun run scripts/restore-backup.ts <회차폴더> --managed-data <서버 폴더>/data --yes (먼저 sudo systemctl stop ${MANAGED_SERVICE})`,
  );
  console.log("");
  console.log("복원 절차:");
  console.log("  1) 서버를 먼저 정지한다:  systemctl stop bara-memory");
  console.log("  2) 되돌릴 회차 폴더 경로를 확인한다 (예: data/backups/round-20260703-040000).");
  console.log("  3) 정지를 직접 확인한 뒤 --yes 를 붙여 이 명령을 다시 실행한다.");
  console.log("  4) 복원 후 서버를 재시작하고 /backup/status·검색 1회로 확인한다.");
  console.log("  기본 복원 대상은 MEMORY_DB_PATH 또는 settings.db.path 의 부모 폴더다.");
  console.log("  다운로드 ZIP은 --data-dir 로 비어 있는 새 폴더를 반드시 지정한다 (기존 데이터 덮어쓰기 불가).");
  console.log('  예: bun run scripts/restore-backup.ts "bara-backup.zip" --data-dir "data-restored" --yes');
  console.log("  ZIP에는 DB·설정만 있으며 문서 원본·이미지·API 키·인증 토큰은 없다. 서버 회차는 형제 assets-mirror 폴더도 필요하다.");
}

/**
 * /health 에 탐침한다. 응답이 오면 true(서버 살아있음). 연결 거부·타임아웃 등으로
 * 응답이 없으면 false — 단 false 는 "정지 증명" 이 아니라 탐침 한계다(호출부가 문구로 명시).
 */
async function serverResponds(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

export function effectiveRestoreDbPath(
  settings: { db: { path: string } },
  envMemoryDbPath: string | undefined = process.env.MEMORY_DB_PATH,
): string {
  return envMemoryDbPath?.trim() || settings.db.path;
}

export function defaultRestoreDataDirForDbPath(dbPath: string): string | null {
  const trimmed = dbPath.trim();
  if (trimmed.length === 0 || trimmed === ":memory:") return null;
  return dirname(resolve(trimmed));
}

export function resolveRestoreDataDir(
  args: Pick<CliArgs, "dataDir" | "dataDirExplicit">,
  plan: RestorePlan,
  dbPath: string,
): string {
  if (plan.sourceFormat === "download-zip" && !args.dataDirExplicit) {
    throw new RestoreError("다운로드 ZIP은 --data-dir 로 비어 있는 새 복원 폴더를 지정하라.");
  }
  if (args.dataDirExplicit) {
    if (args.dataDir === null || args.dataDir.trim().length === 0) {
      throw new RestoreError("--data-dir 값이 비어 있다.");
    }
    return resolve(args.dataDir);
  }

  const dataDir = defaultRestoreDataDirForDbPath(dbPath);
  if (dataDir === null) {
    throw new RestoreError(
      `기본 복원 대상 산정 불가 — 파일 DB 경로가 아니다: ${dbPath}. ` +
        "파일 DB 경로를 설정하거나 --data-dir 로 복원 대상을 명시하라.",
    );
  }

  const effectiveDb = resolve(dbPath);
  const inferredSnapshotDest = resolve(join(dataDir, plan.snapshotFile));
  if (inferredSnapshotDest !== effectiveDb) {
    throw new RestoreError(
      `기본 복원 대상 불일치 — 회차 스냅샷(${plan.snapshotFile})을 ${inferredSnapshotDest}에 ` +
        `복원하면 현재 DB(${effectiveDb})와 다르다. 맞는 회차를 고르거나 --data-dir 로 ` +
        "의도한 복원 대상을 명시하라.",
    );
  }

  return dataDir;
}

async function main(): Promise<number> {
  const managed = parseManagedArgs(process.argv.slice(2));
  if (managed === "invalid") {
    printUsage();
    return 2;
  }
  if (managed !== null) return mainManaged(managed);
  const { settingsPath, secretsPath } = resolveSettingsFilePaths(process.env);
  const settings = getMemorySettings(settingsPath, secretsPath);
  const dbPath = effectiveRestoreDbPath(settings);
  // 자산 목적지는 restore.ts 계약상 `<dataDir>/assets/content/` 다. 운영 자산 경로가
  // dataDir 하위 assets 와 다르면 조용히 어긋난 위치로 복원하지 않도록 아래서 경고한다.
  const args = parseArgs(process.argv.slice(2), {
    dataDir: defaultRestoreDataDirForDbPath(dbPath),
    port: settings.db.port,
  });

  if (args === null) {
    printUsage();
    return 2;
  }

  const roundDir = resolve(args.roundDir);
  if (!existsSync(roundDir)) {
    console.error(`[restore] ZIP 또는 회차 폴더가 없다: ${roundDir}`);
    return 1;
  }

  // (1) --yes 명시 확인 게이트. 없으면 절차만 안내하고 멈춘다(파괴적 동작 보호).
  if (!args.yes) {
    console.log("[restore] --yes 가 없어 복원을 진행하지 않는다 (서버 회차 복원 시 현재 DB 는 before-restore 폴더로 옮겨 보존한다).");
    console.log("");
    printUsage();
    return 1;
  }

  // (2) 서버 정지 탐침 — 살아있으면 거부. 응답 없음은 정지 증명이 아니라 탐침 한계.
  if (await serverResponds(args.port)) {
    console.error(
      `[restore] 서버가 살아있다 (http://127.0.0.1:${args.port}/health 응답). ` +
        "먼저 정지하라: systemctl stop bara-memory",
    );
    return 1;
  }
  console.log(
    `[restore] /health(포트 ${args.port}) 응답 없음 — 다만 이는 "정지 증명" 이 아니라 ` +
      "탐침의 한계다(포트가 막혔을 수도 있다). --yes 로 운영자가 정지를 확인했다고 보고 진행한다.",
  );

  // (3) planRestore 로 검증·나열 → executeRestore.
  // 자산 미러는 회차 폴더의 형제다(`<backupDir>/assets-mirror/`, backup-runner 규약).
  // settings.backup.dir 이 아니라 사용자가 준 회차 폴더의 부모에서 유도해야, 어느
  // 경로의 회차를 주든 그 회차와 짝이 맞는 미러를 본다.
  const mirrorDir = join(dirname(roundDir), "assets-mirror");

  let plan: RestorePlan;
  let dataDir: string;
  try {
    plan = planRestore(roundDir);
    dataDir = resolveRestoreDataDir(args, plan, dbPath);
  } catch (e) {
    if (e instanceof RestoreError) {
      console.error(`[restore] 복원 거부 — ${e.message}`);
      return 1;
    }
    throw e;
  }

  // 자산 경로 정합 경고 — 복원은 `<dataDir>/assets/content/` 로 되돌리는데, 서버가
  // 실제 읽는 자산 경로(settings.assets.dir)가 그와 다르면 복원한 자산을 서버가 못
  // 읽는다. 되돌릴 자산이 있을 때만, 두 경로가 어긋날 때만 알린다(silent 오배치 금지).
  const expectedAssetBase = resolve(join(dataDir, "assets"));
  const configuredAssetBase = resolve(settings.assets.dir);
  if (plan.assetsToRestore.length > 0 && configuredAssetBase !== expectedAssetBase) {
    console.warn(
      `[restore] 경고 — 서버 설정 자산 경로(${configuredAssetBase})가 복원 목적지` +
        `(${expectedAssetBase})와 다르다. 복원은 후자로 되돌린다. 서버가 그 자산을 ` +
        "읽으려면 두 경로가 같아야 한다 — --data-dir 로 자산 부모를 맞춰라.",
    );
  }

  console.log("[restore] 복원 대상:");
  console.log(`  사본 종류: ${plan.sourceFormat === "download-zip" ? "다운로드 ZIP (DB·설정만)" : "서버 회차"}`);
  if (plan.sourceFormat === "download-zip") {
    console.log("  문서 원본·이미지·API 키·인증 토큰은 제외되어 있다. 자산 재열기·OCR 재처리에는 별도 원본 복구가 필요하다.");
    console.log("  DB·자산·백업 경로 설정은 새 복원 폴더로 변경하고 나머지 설정은 보존한다.");
  }
  console.log(`  DB 스냅샷: ${plan.snapshotFile} → ${join(dataDir, plan.snapshotFile)}`);
  for (const name of plan.extraFiles) {
    console.log(`  파일:      ${name} → ${join(dataDir, name)}`);
  }
  console.log(`  자산:      ${plan.assetsToRestore.length}개 → ${join(dataDir, "assets", "content")}`);

  let result;
  try {
    result = executeRestore(roundDir, mirrorDir, dataDir);
  } catch (e) {
    if (e instanceof RestoreError) {
      console.error(`[restore] 복원 실패 — ${e.message}`);
      return 1;
    }
    throw e;
  }

  // (4) 완료 요약 + 확인 안내.
  console.log(
    `[restore] 복원 완료 — 파일 ${result.files}개 / 자산 ${result.assets}개 → ${dataDir}`,
  );
  if (result.beforeRestoreDir !== undefined) {
    console.log(`[restore] 기존 파일 보존: ${result.beforeRestoreDir}`);
  }
  if (plan.sourceFormat === "download-zip") {
    console.log(`[restore] 시작할 때 MEMORY_SETTINGS_PATH=${join(dataDir, "memory-settings.json")} 를 선택하라.`);
    console.log(`[restore] MEMORY_DB_PATH=${join(dataDir, "bara.sqlite")} 및 BARA_ASSET_DIR=${join(dataDir, "assets")} 를 명시하라.`);
    console.log("[restore] 변수 해제만으로는 부족하다. Bun이 현재 폴더의 .env에서 운영 경로를 다시 읽을 수 있다.");
    console.log(`[restore] BARA_SECRETS_PATH=${join(dataDir, "secrets.json")} 및 SSE_TOKEN_PATH=${join(dataDir, "sse-tokens.json")} 를 지정하고 키·연결 토큰을 새로 설정하라.`);
    console.log("[restore] ZIP에는 자산이 없다. 텍스트 검색을 먼저 확인하고 문서·이미지 원본은 서버 회차와 assets-mirror에서 별도로 복구하라.");
  }
  console.log(
    "[restore] 서버를 재시작한 뒤 /backup/status 와 검색 1회로 복원 결과를 확인하라 " +
      "(재시작 시 5~15초 정착 윈도우가 있을 수 있다).",
  );
  return 0;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`[restore] 예기치 못한 실패: ${(e as Error).message}`);
      process.exit(1);
    });
}
