/**
 * routes/documents-ocr-shared.ts — documents 라우트 공용 타입·파싱·판정·DTO 헬퍼.
 *
 * routes/documents.ts 를 책임 경계로 분할하며 옮겨 온 모듈이다(P3 G5-a —
 * docs/decisions/2026-07-03-structure-cleanup-spec.md). 요청 body 타입, limit/상태
 * 필터/lease 파라미터 파싱, OCR 상태·lease worker 판정, 후보 DTO 조립, OCR 설정
 * 조회·화면 노출용 정리를 담는다. HTTP OCR 호출은 documents-ocr-api.ts, 결과 적용·
 * 실패 기록은 documents-ocr-apply.ts, 라우트 등록은 documents.ts 파사드가 진다.
 */

import { extname } from "node:path";
import type { MemoryApiDeps } from "../types.ts";
import {
  OCR_AUTOMATIC_PARSE_STATUSES,
  OCR_CANDIDATE_PARSE_STATUSES,
  OCR_RESULT_APPLICABLE_PARSE_STATUSES,
  isDocumentParseLeaseActive,
  isDocumentParseStatus,
  readDocumentParseMetadata,
  withDocumentParseLease,
  withoutDocumentParseLease,
  type DocumentParseStatus,
} from "../../memory/document-parse-status.ts";
import { LLM_PROVIDER_SPECS } from "../../llm/provider-registry.ts";
import type { DocumentOcrSettings } from "../../settings/memory-settings.ts";

export interface OcrResultBody {
  markdown?: unknown;
  source?: unknown;
  providerName?: unknown;
  workerId?: unknown;
}

export interface OcrClaimBody {
  workerId?: unknown;
  statuses?: unknown;
  leaseSeconds?: unknown;
}

export interface OcrFailureBody {
  errorMessage?: unknown;
  source?: unknown;
  providerName?: unknown;
  workerId?: unknown;
}

export type DocumentRow = NonNullable<ReturnType<MemoryApiDeps["store"]["getDocument"]>>;

export const DEFAULT_LEASE_SECONDS = 30 * 60;
export const MIN_LEASE_SECONDS = 60;
export const MAX_LEASE_SECONDS = 24 * 60 * 60;

export function parseLimit(raw: string | undefined): number {
  if (!raw) return 100;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return 100;
  return Math.min(n, 500);
}

export function parseStatusFilter(raw: string | undefined): readonly DocumentParseStatus[] {
  if (!raw) return OCR_CANDIDATE_PARSE_STATUSES;
  const statuses = raw
    .split(",")
    .map((item) => item.trim())
    .filter(isDocumentParseStatus);
  return statuses.length > 0 ? statuses : OCR_CANDIDATE_PARSE_STATUSES;
}

export function normalizeOcrSource(value: unknown): "manual" | "companion" {
  return value === "companion" ? "companion" : "manual";
}

export function normalizeProviderName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 120) : undefined;
}

export function normalizeWorkerId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 120) : undefined;
}

export function parseClaimStatuses(value: unknown): readonly DocumentParseStatus[] {
  if (!Array.isArray(value)) return OCR_AUTOMATIC_PARSE_STATUSES;
  const statuses = value.filter(isOcrAutomaticStatus);
  return statuses.length > 0 ? statuses : OCR_AUTOMATIC_PARSE_STATUSES;
}

export function parseLeaseSeconds(value: unknown): number | null {
  if (value === undefined) return DEFAULT_LEASE_SECONDS;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < MIN_LEASE_SECONDS || value > MAX_LEASE_SECONDS) return null;
  return value;
}

export function kstPlusSeconds(now: string, seconds: number): string {
  const iso = `${now.replace(" ", "T")}+09:00`;
  const date = new Date(iso);
  date.setSeconds(date.getSeconds() + seconds);
  return date.toLocaleString("sv-SE", {
    timeZone: "Asia/Seoul",
    hour12: false,
  });
}

export function isOcrCandidateStatus(status: DocumentParseStatus): boolean {
  return (OCR_RESULT_APPLICABLE_PARSE_STATUSES as readonly DocumentParseStatus[]).includes(
    status,
  );
}

export function isOcrAutomaticStatus(status: unknown): status is DocumentParseStatus {
  return (
    isDocumentParseStatus(status) &&
    (OCR_AUTOMATIC_PARSE_STATUSES as readonly DocumentParseStatus[]).includes(status)
  );
}

export function isLeaseWorkerAllowed(
  parse: NonNullable<ReturnType<typeof readDocumentParseMetadata>>,
  now: string,
  workerId: string | undefined,
): boolean {
  if (!isDocumentParseLeaseActive(parse, now)) return true;
  return Boolean(workerId && parse.lease?.workerId === workerId);
}

/**
 * 문서 하나의 작업 임대를 비교 후 쓰기로 잡는다(현재 메타가 읽은 그대로일 때만). claim 라우트와 서버 OCR 실행기가
 * 같이 쓴다. 임대가 살아 있으면 잡지 않는다 — allowSameWorker 면 같은 작업자 ID 의 임대는 다시 잡는다(서버가
 * 재시작돼 자기 옛 임대가 남은 경우). 잡으면 새 source_metadata 를, 못 잡으면 null.
 */
export function claimDocumentOcrLease(
  store: MemoryApiDeps["store"],
  doc: DocumentRow,
  workerId: string,
  leaseSeconds: number,
  now: string,
  options: { allowSameWorker?: boolean } = {},
): Record<string, unknown> | null {
  const parse = readDocumentParseMetadata(doc.sourceMetadata);
  if (!parse) return null;
  if (isDocumentParseLeaseActive(parse, now) && !(options.allowSameWorker && parse.lease?.workerId === workerId)) {
    return null;
  }
  const lease = { workerId, claimedAt: now, leaseUntil: kstPlusSeconds(now, leaseSeconds) };
  const nextSourceMetadata = { ...doc.sourceMetadata, parse: withDocumentParseLease(parse, lease) };
  const claimed = store.updateDocumentSourceMetadataIfCurrent({
    documentId: doc.documentId,
    currentSourceMetadata: doc.sourceMetadata,
    nextSourceMetadata,
  });
  return claimed ? nextSourceMetadata : null;
}

/**
 * 잡아 둔 임대를 연장한다(비교 후 쓰기 — current 는 마지막으로 쓴 메타). 누가 결과를 붙였거나 메타가 바뀌었으면 null.
 * leaseUntil 만 바꾸고 claimedAt 은 그대로 둔다.
 */
export function renewDocumentOcrLease(
  store: MemoryApiDeps["store"],
  documentId: string,
  current: Record<string, unknown>,
  workerId: string,
  leaseSeconds: number,
  now: string,
): Record<string, unknown> | null {
  const parse = readDocumentParseMetadata(current);
  if (!parse || parse.lease?.workerId !== workerId) return null;
  const lease = { ...parse.lease, leaseUntil: kstPlusSeconds(now, leaseSeconds) };
  const next = { ...current, parse: { ...parse, lease } };
  return store.updateDocumentSourceMetadataIfCurrent({ documentId, currentSourceMetadata: current, nextSourceMetadata: next })
    ? next
    : null;
}

/** 잡아 둔 임대를 푼다(비교 후 쓰기). 메타가 이미 바뀌었으면(결과가 붙음 등) 아무것도 안 하고 false. */
export function releaseDocumentOcrLease(
  store: MemoryApiDeps["store"],
  documentId: string,
  current: Record<string, unknown>,
): boolean {
  const parse = readDocumentParseMetadata(current);
  if (!parse) return false;
  return store.updateDocumentSourceMetadataIfCurrent({
    documentId,
    currentSourceMetadata: current,
    nextSourceMetadata: { ...current, parse: withoutDocumentParseLease(parse) },
  });
}

export function documentCandidateDto(deps: MemoryApiDeps, doc: DocumentRow) {
  const parse = readDocumentParseMetadata(doc.sourceMetadata);
  const originalAssetSha256 = parse?.originalAssetSha256 ?? doc.assetSha256;
  const asset = deps.store.getAssetFile(originalAssetSha256);
  return {
    documentId: doc.documentId,
    title: doc.title,
    documentType: doc.documentType,
    chunkCount: doc.chunkCount,
    parse,
    originalAssetSha256,
    assetUrl: `/assets/${originalAssetSha256}`,
    assetMimeType: asset?.mimeType ?? null,
    originalName: asset?.originalName ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** OCR 에 보낼 원본 자산(문서가 처음 들어올 때의 파일). */
export interface OriginalOcrAsset {
  sha256: string;
  bytes: Uint8Array;
  mimeType: string;
  originalName: string;
}

function extOfAssetPath(assetPath: string): string | null {
  const ext = extname(assetPath).replace(/^\./, "").trim();
  return ext.length > 0 ? ext : null;
}

/** 문서의 원본 자산을 읽는다 — 서버 OCR(쪽 그림·파일 업로드)이 같이 쓴다. 없으면 이름 있는 오류. */
export async function readOriginalAssetForDocument(deps: MemoryApiDeps, doc: DocumentRow): Promise<OriginalOcrAsset> {
  if (!deps.assetStore) {
    throw new Error("assetStore 미설정 — OCR 에 보낼 원본 자산을 읽을 수 없음");
  }
  const parse = readDocumentParseMetadata(doc.sourceMetadata);
  const sha256 = parse?.originalAssetSha256 ?? doc.assetSha256;
  const asset = deps.store.getAssetFile(sha256);
  if (!asset) {
    throw new Error(`원본 자산 metadata 없음: ${sha256}`);
  }
  const ext = extOfAssetPath(asset.assetPath);
  if (!ext) {
    throw new Error(`원본 자산 확장자를 알 수 없음: ${sha256}`);
  }
  return {
    sha256,
    bytes: deps.assetStore.read(sha256, ext),
    mimeType: asset.mimeType ?? "application/octet-stream",
    originalName: asset.originalName ?? `${doc.documentId}.${ext}`,
  };
}

/** documentOcrRuntime 미주입 — 라우트는 503 으로 알린다(설정 없이 기본값으로 조용히 돌지 않음). */
export class DocumentOcrRuntimeMissingError extends Error {
  constructor() {
    super("documentOcrRuntime 미주입 — documents.ocr 설정을 읽을 수 없음");
    this.name = "DocumentOcrRuntimeMissingError";
  }
}

/** 살아 있는 OCR 설정(저장 즉시 새 값). 실행기 관리자가 없으면 던진다 — 기본값으로 대신하지 않는다. */
export function documentOcrSettings(deps: MemoryApiDeps): DocumentOcrSettings {
  if (!deps.documentOcrRuntime) throw new DocumentOcrRuntimeMissingError();
  return deps.documentOcrRuntime.currentSettings();
}

/** 고른 API 업체의 모델·주소·키 저장 여부 — 화면·보조 프로그램용(키 값 없음). */
function sanitizeApi(api: DocumentOcrSettings["api"]) {
  if (api.provider === "http_file_api") {
    return {
      provider: api.provider,
      endpointUrl: api.endpointUrl,
      model: api.model,
      responseFormat: api.responseFormat,
      hasApiKey: api.apiKey.trim().length > 0,
    };
  }
  const spec = LLM_PROVIDER_SPECS[api.provider];
  const keyField = spec.apiKeyField;
  return {
    provider: api.provider,
    endpointUrl: spec.baseUrlField === "openaiBaseUrl" ? api.openaiBaseUrl : "",
    model: api[spec.modelField as keyof typeof api] as string,
    responseFormat: api.responseFormat,
    hasApiKey: keyField !== null && (api[keyField as keyof typeof api] as string).trim().length > 0,
  };
}

export function sanitizeOcrRuntimeConfig(settings: DocumentOcrSettings) {
  const allowedStatuses = settings.pcCompanion.allowedStatuses.filter(isOcrAutomaticStatus);
  return {
    mode: settings.mode,
    resourceProfile: settings.resourceProfile,
    maxOutputTokensPerPage: settings.maxOutputTokensPerPage,
    schedule: {
      intervalMin: settings.schedule.intervalMin,
      batchSize: settings.schedule.batchSize,
      leaseSeconds: settings.schedule.leaseSeconds,
      timeoutMs: settings.schedule.timeoutMs,
    },
    local: {
      provider: settings.local.provider,
      ollamaUrl: settings.local.ollamaUrl,
      ollamaModel: settings.local.ollamaModel,
      lmstudioUrl: settings.local.lmstudioUrl,
      lmstudioModel: settings.local.lmstudioModel,
      commandJson: settings.mode === "local" ? settings.local.commandJson : "",
    },
    api: sanitizeApi(settings.api),
    pcCompanion: {
      workerId: settings.pcCompanion.workerId,
      pollSeconds: settings.pcCompanion.pollSeconds,
      commandSource: settings.pcCompanion.commandSource,
      commandJson:
        settings.pcCompanion.commandSource === "server"
          ? settings.pcCompanion.commandJson
          : "",
      // 빈 선택 → 세 상태 전부: 이번 작업 범위 밖의 숨은 대체 동작(spec D18·Q10 — 그대로 둠).
      allowedStatuses:
        allowedStatuses.length > 0 ? allowedStatuses : OCR_AUTOMATIC_PARSE_STATUSES,
    },
  };
}
