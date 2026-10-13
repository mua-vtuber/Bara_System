/**
 * App Federation Discovery (Phase 5.5 / spec section 6.1)
 *
 * `apps/*` 디렉토리들을 스캔 → 각 디렉토리의 `app.manifest.json` 을 찾아
 * 파싱 + 검증 → 통과한 매니페스트만 레지스트리에 등록.
 *
 * 부팅 시 1회 호출 (매니페스트 hot-reload 없음 — spec section 12 정신).
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { AppManifest } from "./manifest-schema";
import {
  validateManifest,
  type ManifestValidationError,
} from "./manifest-validator";
import type { FederationRegistry } from "./registry";

export interface DiscoveryReport {
  registered: AppManifest[];
  rejected: Array<{
    sourceDir: string;
    reason: "parse-error" | "validation-error" | "duplicate-id" | "read-error";
    errors?: ManifestValidationError[];
    message?: string;
  }>;
}

export interface DiscoveryOptions {
  /** 본 모듈 자체 (id="memory") 매니페스트를 스캔 결과에서 제외할 때 true. */
  excludeSelf?: boolean;
  /** 본 모듈 자체의 id — 디폴트 `"memory"`. */
  selfId?: string;
}

export const MANIFEST_FILE = "app.manifest.json";
/** Environment naming the adapters folder of a pet-managed server (docs/decisions/2026-10-08-single-deploy-path-plan.md Task 10).
 * The pet's server unit sets it; apps/pet/src/service/install/adapter-registry.ts names the same variable. */
export const ADAPTERS_DIR_ENV = "BARA_ADAPTERS_DIR";
/** Each adapter's running release, a link `deploy:a1` moves on every update. */
export const ADAPTER_RELEASE_LINK = "current";

/** Null when unset or blank (no adapters folder: behavior as before). A relative value would depend on the release
 * folder the server runs from, so it stops the start naming the variable. */
export function adaptersDirFromEnv(env: Record<string, string | undefined>): string | null {
  const value = env[ADAPTERS_DIR_ENV]?.trim();
  if (!value) return null;
  if (!isAbsolute(value)) throw new Error(`${ADAPTERS_DIR_ENV} 는 절대 경로여야 한다: ${value}`);
  return value;
}

/** Parse, validate, skip self, register: the part every discovery shares. */
function acceptManifest(dir: string, raw: string, registry: FederationRegistry, report: DiscoveryReport, excludeSelf: boolean, selfId: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    report.rejected.push({ sourceDir: dir, reason: "parse-error", message: err instanceof Error ? err.message : String(err) });
    return;
  }
  const result = validateManifest(parsed);
  if (!result.ok) { report.rejected.push({ sourceDir: dir, reason: "validation-error", errors: result.errors }); return; }
  if (excludeSelf && result.manifest.id === selfId) return;
  try {
    registry.register(result.manifest, dir);
    report.registered.push(result.manifest);
  } catch (err) {
    report.rejected.push({ sourceDir: dir, reason: "duplicate-id", message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * `appsRoot` 하위 디렉토리들을 스캔, 각 디렉토리의 `app.manifest.json` 을
 * 검증한 뒤 통과한 매니페스트를 레지스트리에 등록한다.
 */
export async function discoverApps(
  appsRoot: string,
  registry: FederationRegistry,
  options: DiscoveryOptions = {},
): Promise<DiscoveryReport> {
  const { excludeSelf = true, selfId = "memory" } = options;
  const report: DiscoveryReport = { registered: [], rejected: [] };

  let entries: string[];
  try {
    entries = await readdir(appsRoot);
  } catch (err) {
    // appsRoot 디렉토리가 없으면 조용히 빈 결과 반환 (어댑터 0 상태와 정합).
    return report;
  }

  for (const name of entries) {
    const dir = join(appsRoot, name);
    let dirStat;
    try {
      dirStat = await stat(dir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;

    const manifestPath = join(dir, MANIFEST_FILE);
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf-8");
    } catch {
      // 매니페스트 없음 = 본 디렉토리는 어댑터 아님 (조용히 건너뜀).
      continue;
    }

    acceptManifest(dir, raw, registry, report, excludeSelf, selfId);
  }

  return report;
}

/**
 * Adapters a pet-managed server runs: `<adaptersDir>/<name>/current/app.manifest.json`.
 * - The adapters folder missing (ENOENT) is a server no adapter was deployed to yet (`deploy:a1 --adapter` creates the
 *   folder with the first one): no adapters. That is the only absence read as empty.
 * - Any other failure to read the folder throws, so the server never starts with its adapters silently missing.
 * - An adapter whose current manifest does not exist (first install still running, or no dashboard manifest) is skipped;
 *   one that exists but cannot be read is reported as `read-error`.
 */
export async function discoverAdapterReleases(adaptersDir: string, registry: FederationRegistry,
  options: DiscoveryOptions = {}): Promise<DiscoveryReport> {
  const { excludeSelf = true, selfId = "memory" } = options;
  const report: DiscoveryReport = { registered: [], rejected: [] };
  let entries: Dirent[];
  try { entries = await readdir(adaptersDir, { withFileTypes: true }); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return report;
    throw new Error(`${ADAPTERS_DIR_ENV} 폴더를 읽지 못했다: ${adaptersDir} — ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(adaptersDir, entry.name, ADAPTER_RELEASE_LINK);
    let raw: string;
    try { raw = await readFile(join(dir, MANIFEST_FILE), "utf-8"); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      report.rejected.push({ sourceDir: dir, reason: "read-error", message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    acceptManifest(dir, raw, registry, report, excludeSelf, selfId);
  }
  return report;
}

/** Boot-time discovery: `apps/*` always, the adapters folder too when `BARA_ADAPTERS_DIR` names one; one log block per
 * source. A wrong adapters folder throws here, so the start stops before any route is served. */
export async function discoverAndLogFederation(appsRoot: string, registry: FederationRegistry,
  env: Record<string, string | undefined>): Promise<void> {
  const adaptersDir = adaptersDirFromEnv(env);
  const reports = [await discoverApps(appsRoot, registry),
    ...(adaptersDir === null ? [] : [await discoverAdapterReleases(adaptersDir, registry)])];
  for (const report of reports) {
    console.log(`[federation] discovered ${report.registered.length} app(s), rejected ${report.rejected.length}`);
    for (const m of report.registered) console.log(`[federation]   - ${m.id} (${m.name}) @ ${m.endpoint}`);
    for (const r of report.rejected) {
      console.warn(`[federation]   ! rejected ${r.sourceDir} (${r.reason})${r.message ? `: ${r.message}` : ""}`);
      for (const e of r.errors ?? []) console.warn(`[federation]       - ${e.path}: ${e.message}`);
    }
  }
}
