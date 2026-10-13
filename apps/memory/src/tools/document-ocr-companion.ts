/**
 * document-ocr-companion.ts — PC/local OCR command companion.
 *
 * A1 memory core never runs OCR models here. This tool pulls one leased document,
 * downloads the original asset, runs a local command, then posts Markdown back.
 */

import { mkdirSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import {
  MemoryApiError,
  MemoryApiClient,
  type DocumentOcrCandidate,
  type DocumentOcrRuntimeConfig,
  type DocumentParseStatus,
} from "../api-client.ts";

const DEFAULT_BASE_URL = "http://127.0.0.1:3001";
const DEFAULT_POLL_SECONDS = 30;
const DEFAULT_LEASE_SECONDS = 30 * 60;
const DEFAULT_PROVIDER_NAME = "document-ocr-companion";

const OCR_COMMAND_GUIDANCE =
  'OCR 명령이 필요합니다. -- <command> ... 로 넘기거나 BARA_OCR_COMMAND_JSON JSON 배열을 설정하세요. 예: BARA_OCR_COMMAND_JSON=["python","ocr.py","{input}","{output}"]';

const TOKEN_GUIDANCE =
  "BARA_MEMORY_TOKEN 이 필요합니다. `bun run ocr:companion --request-token` 으로 승인 요청을 만들고, 설정 > 어댑터 관리에서 승인한 뒤 `bun run ocr:companion --pickup-token <requestId> <pickupSecret>` 으로 토큰을 받아 PC companion 환경변수에 넣으세요.";

/**
 * 토큰은 유효하지만 이 companion 이 쓰는 경로(claim/apply-result/report-failure)에
 * 필요한 권한이 없을 때(403)의 안내. OCR companion 은 문서 상태 변경·자산 다운로드를
 * 하므로 full 권한이 필요하다(SHARED_MEMORY.md 클라이언트별 권한 표). 401 과 조치
 * 방법이 다르므로(토큰 재발급이 아니라 권한 변경) 별도 문구를 둔다(WP-B1-15).
 */
const SCOPE_GUIDANCE =
  "토큰은 유효하지만 권한이 부족합니다(403). 대시보드 설정 > 어댑터 관리에서 ocr-companion 권한을 full 로 변경하세요.";

export type TokenAction =
  | { type: "none" }
  | { type: "request" }
  | { type: "pickup"; requestId: string; pickupSecret: string };

export interface DocumentOcrCompanionConfig {
  baseUrl: string;
  token?: string;
  workerId: string;
  once: boolean;
  pollSeconds: number;
  leaseSeconds: number;
  tmpDir: string;
  providerName: string;
  ocrCommand: string[];
  tokenAction: TokenAction;
  useServerConfig?: boolean;
  allowRemoteCommand?: boolean;
  resourceProfile?: "low_power" | "balanced" | "gpu";
  claimStatuses?: readonly DocumentParseStatus[];
}

export interface DocumentOcrCompanionOnceResult {
  claimed: boolean;
  documentId?: string;
  failed?: boolean;
}

function requireValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} 값이 필요합니다`);
  }
  return value;
}

function parsePositiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} 는 1 이상 정수여야 합니다`);
  }
  return n;
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function defaultWorkerId(env: Record<string, string | undefined>): string {
  return envValue(env, "BARA_OCR_WORKER_ID") ?? `${hostname()}-${process.pid}`;
}

function parseOcrCommandJson(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`BARA_OCR_COMMAND_JSON 파싱 실패: ${detail}`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((value) => typeof value === "string" && value.length > 0)
  ) {
    throw new Error("BARA_OCR_COMMAND_JSON 은 비어 있지 않은 문자열 배열이어야 합니다");
  }
  return parsed;
}

function commandFromEnv(env: Record<string, string | undefined>): string[] {
  const raw = envValue(env, "BARA_OCR_COMMAND_JSON");
  return raw && raw.trim().length > 0 ? parseOcrCommandJson(raw) : [];
}

function parseBooleanEnv(
  env: Record<string, string | undefined>,
  name: string,
): boolean {
  const value = envValue(env, name);
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function parseCompanionArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): DocumentOcrCompanionConfig {
  const sep = argv.indexOf("--");
  const optionArgs = sep === -1 ? argv : argv.slice(0, sep);
  const cliCommand = sep === -1 ? [] : argv.slice(sep + 1);
  const isTokenActionRequested =
    optionArgs.includes("--request-token") || optionArgs.includes("--pickup-token");
  const ocrCommand =
    cliCommand.length > 0
      ? cliCommand
      : isTokenActionRequested
        ? []
        : commandFromEnv(env);

  const config: DocumentOcrCompanionConfig = {
    baseUrl:
      envValue(env, "BARA_MEMORY_URL") ??
      envValue(env, "MEMORY_API_URL") ??
      DEFAULT_BASE_URL,
    token: envValue(env, "BARA_MEMORY_TOKEN"),
    workerId: defaultWorkerId(env),
    once: false,
    pollSeconds: Number(envValue(env, "BARA_OCR_POLL_SECONDS") ?? DEFAULT_POLL_SECONDS),
    leaseSeconds: Number(envValue(env, "BARA_OCR_LEASE_SECONDS") ?? DEFAULT_LEASE_SECONDS),
    tmpDir: envValue(env, "BARA_OCR_TMP_DIR") ?? tmpdir(),
    providerName: envValue(env, "BARA_OCR_PROVIDER_NAME") ?? DEFAULT_PROVIDER_NAME,
    ocrCommand,
    tokenAction: { type: "none" },
    useServerConfig: parseBooleanEnv(env, "BARA_OCR_USE_SERVER_CONFIG"),
    allowRemoteCommand: parseBooleanEnv(env, "BARA_OCR_ALLOW_REMOTE_COMMAND"),
    resourceProfile: "balanced",
  };

  for (let i = 0; i < optionArgs.length; i++) {
    const arg = optionArgs[i]!;
    switch (arg) {
      case "--base-url":
        config.baseUrl = requireValue(optionArgs, i, arg);
        i += 1;
        break;
      case "--token":
        config.token = requireValue(optionArgs, i, arg);
        i += 1;
        break;
      case "--worker-id":
        config.workerId = requireValue(optionArgs, i, arg);
        i += 1;
        break;
      case "--once":
        config.once = true;
        break;
      case "--poll-seconds":
        config.pollSeconds = parsePositiveInt(requireValue(optionArgs, i, arg), arg);
        i += 1;
        break;
      case "--lease-seconds":
        config.leaseSeconds = parsePositiveInt(requireValue(optionArgs, i, arg), arg);
        i += 1;
        break;
      case "--tmp-dir":
        config.tmpDir = requireValue(optionArgs, i, arg);
        i += 1;
        break;
      case "--provider-name":
        config.providerName = requireValue(optionArgs, i, arg);
        i += 1;
        break;
      case "--use-server-config":
        config.useServerConfig = true;
        break;
      case "--allow-remote-command":
        config.allowRemoteCommand = true;
        break;
      case "--request-token":
        config.tokenAction = { type: "request" };
        break;
      case "--pickup-token": {
        const requestId = requireValue(optionArgs, i, arg);
        const pickupSecret = requireValue(optionArgs, i + 1, arg);
        config.tokenAction = { type: "pickup", requestId, pickupSecret };
        i += 2;
        break;
      }
      default:
        throw new Error(`알 수 없는 옵션: ${arg}`);
    }
  }

  if (!config.workerId.trim()) throw new Error("--worker-id 는 비어 있을 수 없습니다");
  if (!Number.isInteger(config.pollSeconds) || config.pollSeconds < 1) {
    throw new Error("--poll-seconds 는 1 이상 정수여야 합니다");
  }
  if (!Number.isInteger(config.leaseSeconds) || config.leaseSeconds < 1) {
    throw new Error("--lease-seconds 는 1 이상 정수여야 합니다");
  }
  if (
    config.tokenAction.type === "none" &&
    config.ocrCommand.length === 0 &&
    !config.useServerConfig
  ) {
    throw new Error(OCR_COMMAND_GUIDANCE);
  }
  return config;
}

function requireToken(config: DocumentOcrCompanionConfig): void {
  if (!config.token || config.token.trim().length === 0) {
    throw new Error(TOKEN_GUIDANCE);
  }
}

function commandFromServerConfig(
  runtime: DocumentOcrRuntimeConfig,
): string[] {
  if (
    runtime.mode !== "pc_companion" ||
    runtime.pcCompanion.commandSource !== "server" ||
    runtime.pcCompanion.commandJson.trim().length === 0
  ) {
    return [];
  }
  return parseOcrCommandJson(runtime.pcCompanion.commandJson);
}

async function applyServerRuntimeConfig(
  client: MemoryApiClient,
  config: DocumentOcrCompanionConfig,
): Promise<DocumentOcrCompanionConfig> {
  if (!config.useServerConfig) return config;
  const runtime = await client.getDocumentOcrRuntimeConfig();
  const next: DocumentOcrCompanionConfig = { ...config };
  next.resourceProfile = runtime.resourceProfile;
  next.pollSeconds = runtime.pcCompanion.pollSeconds;
  next.leaseSeconds = runtime.schedule.leaseSeconds;
  next.claimStatuses = runtime.pcCompanion.allowedStatuses;
  if (runtime.pcCompanion.workerId.trim().length > 0 && config.workerId.startsWith(`${hostname()}-`)) {
    next.workerId = runtime.pcCompanion.workerId;
  }
  if (next.ocrCommand.length === 0) {
    const remoteCommand = commandFromServerConfig(runtime);
    if (remoteCommand.length > 0) {
      if (!next.allowRemoteCommand) {
        throw new Error(
          "서버 설정에 OCR commandJson 이 있지만 PC companion 이 원격 명령 실행을 허용하지 않았습니다. PC에서 BARA_OCR_ALLOW_REMOTE_COMMAND=1 또는 --allow-remote-command 를 명시하거나, BARA_OCR_COMMAND_JSON/-- <command> 로 로컬 명령을 설정하세요.",
        );
      }
      next.ocrCommand = remoteCommand;
    }
  }
  return next;
}

export function formatCompanionError(err: unknown): string {
  if (err instanceof MemoryApiError) {
    if (err.status === 401) {
      return `memory-api 인증 실패(401). ${TOKEN_GUIDANCE}`;
    }
    if (err.status === 403) {
      return `memory-api 권한 부족(403). ${SCOPE_GUIDANCE}`;
    }
    return `memory-api 요청 실패(${err.status}). ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "document";
}

function extensionForCandidate(candidate: DocumentOcrCandidate): string {
  const fromName = extname(candidate.originalName ?? "");
  if (/^\.[A-Za-z0-9]{1,12}$/.test(fromName)) return fromName.slice(1).toLowerCase();
  switch (candidate.assetMimeType) {
    case "application/pdf":
      return "pdf";
    case "text/markdown":
      return "md";
    case "text/plain":
      return "txt";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return "docx";
    default:
      return "bin";
  }
}

function replacePlaceholders(
  args: readonly string[],
  replacements: Record<string, string>,
): string[] {
  return args.map((arg) =>
    arg.replace(/\{input\}|\{output\}|\{documentId\}/g, (key) => replacements[key] ?? key),
  );
}

function envWith(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return { ...env, ...overrides };
}

async function runCommand(args: string[], env: Record<string, string>): Promise<void> {
  const proc = Bun.spawn(args, {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout ? new Response(proc.stdout).text() : Promise.resolve("");
  const stderr = proc.stderr ? new Response(proc.stderr).text() : Promise.resolve("");
  const exitCode = await proc.exited;
  const [out, err] = await Promise.all([stdout, stderr]);
  if (exitCode !== 0) {
    const detail = (err || out).trim().slice(0, 1000);
    throw new Error(`OCR command exited with ${exitCode}${detail ? `: ${detail}` : ""}`);
  }
}

async function writeDownloadedAsset(
  client: MemoryApiClient,
  candidate: DocumentOcrCandidate,
  dir: string,
): Promise<{ inputPath: string; outputPath: string }> {
  mkdirSync(dir, { recursive: true });
  const ext = extensionForCandidate(candidate);
  const stem = safeStem(`${candidate.documentId}-${basename(candidate.originalName ?? "asset")}`);
  const inputPath = join(dir, `${stem}-${candidate.originalAssetSha256.slice(0, 12)}.${ext}`);
  const outputPath = join(dir, `${stem}-${candidate.originalAssetSha256.slice(0, 12)}.ocr.md`);
  const asset = await client.downloadAsset(candidate.originalAssetSha256);
  await Bun.write(inputPath, asset.arrayBuffer);
  return { inputPath, outputPath };
}

function assetDownloadFailureMessage(err: unknown, sha256: string): string {
  const detail = formatCompanionError(err);
  return `원본 자산 다운로드 실패(${sha256}). /assets/${sha256} 접근, BARA_MEMORY_TOKEN, memory-api URL 을 확인하세요. ${detail}`;
}

async function processJob(
  client: MemoryApiClient,
  candidate: DocumentOcrCandidate,
  config: DocumentOcrCompanionConfig,
): Promise<void> {
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  try {
    let markdown: string;
    try {
      let paths: { inputPath: string; outputPath: string };
      try {
        paths = await writeDownloadedAsset(client, candidate, config.tmpDir);
      } catch (err) {
        throw new Error(assetDownloadFailureMessage(err, candidate.originalAssetSha256));
      }
      inputPath = paths.inputPath;
      outputPath = paths.outputPath;
      const command = replacePlaceholders(config.ocrCommand, {
        "{input}": inputPath,
        "{output}": outputPath,
        "{documentId}": candidate.documentId,
      });
      await runCommand(
        command,
        envWith({
          BARA_INPUT_PATH: inputPath,
          BARA_OUTPUT_MARKDOWN_PATH: outputPath,
          BARA_DOCUMENT_ID: candidate.documentId,
          BARA_ASSET_SHA256: candidate.originalAssetSha256,
          BARA_OCR_RESOURCE_PROFILE: config.resourceProfile ?? "balanced",
        }),
      );
      markdown = await Bun.file(outputPath).text();
      if (markdown.trim().length === 0) {
        throw new Error(
          "OCR command produced empty Markdown. 출력 Markdown 이 비어 있습니다. OCR 명령이 {output} 또는 BARA_OUTPUT_MARKDOWN_PATH 파일에 내용을 써야 합니다.",
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await client.reportDocumentOcrFailure(candidate.documentId, {
        errorMessage: message,
        source: "companion",
        providerName: config.providerName,
        workerId: config.workerId,
      });
      throw err;
    }

    await client.applyDocumentOcrResult(candidate.documentId, {
      markdown,
      source: "companion",
      providerName: config.providerName,
      workerId: config.workerId,
    });
  } finally {
    if (inputPath) rmSync(inputPath, { force: true });
    if (outputPath) rmSync(outputPath, { force: true });
  }
}

export async function runDocumentOcrCompanionOnce(
  config: DocumentOcrCompanionConfig,
): Promise<DocumentOcrCompanionOnceResult> {
  requireToken(config);
  const client = new MemoryApiClient(config.baseUrl, { token: config.token });
  const effectiveConfig = await applyServerRuntimeConfig(client, config);
  if (effectiveConfig.ocrCommand.length === 0) {
    throw new Error(OCR_COMMAND_GUIDANCE);
  }
  let job: DocumentOcrCandidate | null;
  try {
    job = await client.claimDocumentOcrJob({
      workerId: effectiveConfig.workerId,
      leaseSeconds: effectiveConfig.leaseSeconds,
      ...(effectiveConfig.claimStatuses
        ? { statuses: effectiveConfig.claimStatuses }
        : {}),
    });
  } catch (err) {
    throw new Error(formatCompanionError(err));
  }
  if (!job) return { claimed: false };

  try {
    await processJob(client, job, effectiveConfig);
    return { claimed: true, documentId: job.documentId };
  } catch {
    return { claimed: true, documentId: job.documentId, failed: true };
  }
}

export async function requestDocumentOcrCompanionTokenApproval(
  config: Pick<DocumentOcrCompanionConfig, "baseUrl">,
): Promise<{ adapterId: string; requestId: string; pickupSecret: string }> {
  const client = new MemoryApiClient(config.baseUrl);
  const enrolled = await client.enrollAdapterToken({
    adapterId: "ocr-companion",
    displayName: "OCR companion",
    description: "Local document OCR companion",
    // 이 companion 이 실제로 쓰는 권한(WP-B1-15). 대시보드 승인 화면 표시용일 뿐
    // 권한을 직접 주지 않는다 — 관리자가 승인할 때 최종 고른다.
    requestedScope: "full",
  });
  return {
    adapterId: enrolled.adapterId,
    requestId: enrolled.requestId,
    pickupSecret: enrolled.pickupSecret,
  };
}

export async function pickupDocumentOcrCompanionToken(
  config: Pick<DocumentOcrCompanionConfig, "baseUrl"> & {
    requestId: string;
    pickupSecret: string;
  },
): Promise<{ adapterId: string; token: string }> {
  const client = new MemoryApiClient(config.baseUrl);
  const picked = await client.pickupAdapterToken(config.requestId, config.pickupSecret);
  if (picked.status !== "approved") {
    throw new Error(
      `OCR companion 토큰 승인 대기 중입니다. 설정 > 어댑터 관리에서 ${picked.adapterId} 요청을 승인하세요.`,
    );
  }
  return { adapterId: picked.adapterId, token: picked.token };
}

export async function runDocumentOcrCompanion(
  config: DocumentOcrCompanionConfig,
): Promise<void> {
  if (config.tokenAction.type === "request") {
    const requested = await requestDocumentOcrCompanionTokenApproval(config);
    console.log(`requestId=${requested.requestId}`);
    console.log(`pickupSecret=${requested.pickupSecret}`);
    return;
  }
  if (config.tokenAction.type === "pickup") {
    const issued = await pickupDocumentOcrCompanionToken({
      baseUrl: config.baseUrl,
      requestId: config.tokenAction.requestId,
      pickupSecret: config.tokenAction.pickupSecret,
    });
    console.log(issued.token);
    return;
  }
  while (true) {
    const result = await runDocumentOcrCompanionOnce(config);
    if (config.once) return;
    await sleep(result.claimed ? 0 : config.pollSeconds * 1000);
  }
}

if (import.meta.main) {
  runDocumentOcrCompanion(parseCompanionArgs(Bun.argv.slice(2))).catch((err: unknown) => {
    const message = formatCompanionError(err);
    console.error(`[document-ocr-companion] ${message}`);
    process.exit(1);
  });
}
