export const DASHBOARD_SOURCE: "dashboard:manual";
export const DASHBOARD_ATTRIBUTION: { author: string; userId: string };
export const SUPPORTED_IMAGE_MIMES_CLIENT: Set<string>;

export interface TextContentPayload {
  type: "text";
  data: string;
  mimeType?: string;
  originalName?: string;
}

export interface AutoContentPayload {
  type: "auto";
  data: string;
  mimeType: string;
  originalName: string;
}

export interface IngestPayloadBase {
  source: string;
  attribution: { author: string; userId: string };
  hashtags?: string[];
  options?: IngestPayloadOptions;
}

export interface IngestPayloadOptions {
  attachToNodeId: number;
}

export interface TextIngestPayload extends IngestPayloadBase {
  content: TextContentPayload;
}

export interface FileIngestPayload extends IngestPayloadBase {
  content: AutoContentPayload;
}

export interface FilePayloadInput {
  base64: string;
  mimeType: string;
  originalName: string;
}

export interface TextFilePayloadInput {
  text: string;
  mimeType: string;
  originalName: string;
}

export interface FileKind {
  kind: "text" | "binary";
  mimeType: string;
}

export interface DetectionInfo {
  kind?: string;
  extractedCharCount?: number;
  pageCount?: number;
  scannedPdf?: boolean;
  tableCount?: number;
  embeddedImageCount?: number;
  [key: string]: unknown;
}

export interface ExtractionStatusInfo {
  extracted?: unknown;
  bumped?: unknown;
  pendingChunks?: unknown;
  [key: string]: unknown;
}

export interface ImageResultInfo {
  assetSha256?: unknown;
  thumbSha256?: unknown;
  nodeId?: unknown;
  width?: unknown;
  height?: unknown;
  isAnimated?: unknown;
  warnings?: unknown;
  mime?: unknown;
  [key: string]: unknown;
}

export function extractHashtags(text: unknown): string[];
export function buildTextPayload(text: string): TextIngestPayload;
export function buildFilePayload(
  file: FilePayloadInput,
  hashtags?: string[],
  attachToNodeId?: number | null,
): FileIngestPayload;
export function buildTextFilePayload(
  file: TextFilePayloadInput,
  hashtags?: string[],
  attachToNodeId?: number | null,
): TextIngestPayload;
export function classifyFileKind(name: string, mimeType: string): FileKind;
export function describeDetection(detection: unknown): string[];
export function describeExtractionStatus(body: unknown): string[];
export function describeImageResult(img: unknown): string[];
export function isImageMimeClient(mime: unknown): boolean;
export function isValidNumericInput(raw: unknown): boolean;
export function mountIngestForm(ctx: unknown): void;
