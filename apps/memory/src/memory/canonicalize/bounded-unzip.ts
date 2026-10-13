/**
 * canonicalize/bounded-unzip.ts — 크기·개수 상한을 지키며 zip 을 푸는 도우미 (zip bomb 방어).
 *
 * 문제: 업로드 상한(maxAssetBytes)은 압축된 크기만 본다. 수십 KB 짜리 zip 이 풀면 수 GB 가
 * 되도록 만들 수 있어(zip bomb), 크기 확인 없이 풀면 서버 메모리·CPU 가 바닥난다.
 *
 * 방어 두 겹:
 * 1. 풀기 전에 zip 목록(central directory)에 적힌 엔트리 수, 엔트리 하나의 풀린 크기,
 *    풀린 크기 합계를 세어 상한을 넘으면 아무것도 풀지 않고 던진다
 *    (backup/download-backup.ts 의 복원 ZIP 검사와 같은 생각).
 * 2. 목록의 크기는 거짓일 수 있다. 압축 엔트리는 node:zlib inflateRawSync 의
 *    maxOutputLength 를 목록에 적힌 크기로 걸어 푼다 — 실제로 더 부풀면 그 크기를 넘는
 *    순간 zlib 이 멈추고 던진다. (fflate.unzipSync 는 적힌 크기만큼 버퍼를 잡지만 버퍼가 찬
 *    뒤에도 끝까지 풀기를 계속해, 크기를 속인 엔트리 하나로 CPU 를 몇 분씩 붙잡을 수 있었다.)
 *    실제 크기가 적힌 크기보다 작아도 손상된 zip 으로 보고 던진다.
 *
 * 다루지 않는 zip(zip64, 암호화 엔트리, deflate·무압축 밖의 압축 방식)은 이름을 밝혀 던진다.
 */
import { inflateRawSync } from "node:zlib";

export interface ZipExtractionLimits {
  /** 허용 엔트리 수. */
  maxEntries: number;
  /** 엔트리 하나의 풀린 크기 상한(바이트). */
  maxEntryUncompressedBytes: number;
  /** 모든 엔트리의 풀린 크기 합계 상한(바이트). */
  maxTotalUncompressedBytes: number;
}

/**
 * 넘은 상한. declaredEntrySize = 엔트리의 실제 풀린 크기가 zip 목록에 적힌 크기를 넘었다
 * (크기를 속인 zip).
 */
export type ZipLimitKind =
  | "maxEntries"
  | "maxEntryUncompressedBytes"
  | "maxTotalUncompressedBytes"
  | "declaredEntrySize";

/** 상한을 넘은 zip. limit 은 넘은 상한 이름, limitValue 는 그 값이다. */
export class ZipLimitExceededError extends Error {
  readonly limit: ZipLimitKind;
  readonly limitValue: number;

  constructor(limit: ZipLimitKind, limitValue: number, message: string) {
    super(message);
    this.name = "ZipLimitExceededError";
    this.limit = limit;
    this.limitValue = limitValue;
  }
}

export type UnzippedEntries = Record<string, Uint8Array>;

// ---- zip 형식 상수 (PKWARE APPNOTE) ----
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MIN_BYTES = 22;
const EOCD_MAX_COMMENT_BYTES = 0xffff;
const EOCD_COMMENT_LENGTH_OFFSET = 20;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_HEADER_BYTES = 30;
const ZIP64_MARKER_U16 = 0xffff;
const ZIP64_MARKER_U32 = 0xffffffff;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8_NAME = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const ZLIB_OUTPUT_TOO_LARGE = "ERR_BUFFER_TOO_LARGE";
const MIN_ZLIB_OUTPUT_LIMIT = 1;

const BYTES_PER_MIB = 1024 * 1024;

function formatMiB(bytes: number): string {
  return `${Math.round((bytes / BYTES_PER_MIB) * 10) / 10} MiB`;
}

function formatError(detail: string): Error {
  return new Error(`zip 형식 오류: ${detail}`);
}

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * zip 끝 표시(EOCD)를 뒤에서부터 찾는다. 끝 표시 뒤에는 주석만 올 수 있으므로, 서명이 보여도
 * "끝 표시 + 주석 길이 = 파일 끝" 이 맞을 때만 받아들인다 — 주석 안에 서명 바이트를 넣어
 * 가짜 목록을 가리키게 만든 zip 을 진짜 끝 표시로 착각하지 않는다.
 */
function findEndOfCentralDirectory(view: DataView): number {
  const lowest = Math.max(0, view.byteLength - EOCD_MIN_BYTES - EOCD_MAX_COMMENT_BYTES);
  for (let at = view.byteLength - EOCD_MIN_BYTES; at >= lowest; at--) {
    if (view.getUint32(at, true) !== EOCD_SIGNATURE) continue;
    const commentLength = view.getUint16(at + EOCD_COMMENT_LENGTH_OFFSET, true);
    if (at + EOCD_MIN_BYTES + commentLength === view.byteLength) return at;
  }
  throw formatError("zip 끝 표시(end of central directory)를 찾지 못했다");
}

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  // 이름 칸 UTF-8 표시가 없으면 옛 zip 관례대로 한 바이트 = 한 글자로 읽는다(fflate 와 같다).
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(utf8 ? "utf8" : "latin1");
}

/** zip 목록을 읽고, 아무것도 풀기 전에 개수·크기 상한을 검사한다. */
function readCentralDirectory(bytes: Uint8Array, limits: ZipExtractionLimits): CentralEntry[] {
  if (bytes.byteLength < EOCD_MIN_BYTES) throw formatError("zip 으로 보기에 너무 짧다");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (entryCount === ZIP64_MARKER_U16 || directoryOffset === ZIP64_MARKER_U32) {
    throw formatError("zip64 형식은 지원하지 않는다");
  }
  if (entryCount > limits.maxEntries) {
    throw new ZipLimitExceededError(
      "maxEntries",
      limits.maxEntries,
      `zip 엔트리 수(${entryCount}개)가 상한(maxEntries=${limits.maxEntries}개)을 넘었다`,
    );
  }
  const entries: CentralEntry[] = [];
  let totalBytes = 0;
  let at = directoryOffset;
  for (let i = 0; i < entryCount; i++) {
    if (at + CENTRAL_HEADER_BYTES > bytes.byteLength || view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw formatError(`zip 목록 ${i + 1}번째 항목이 깨졌다`);
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localHeaderOffset = view.getUint32(at + 42, true);
    const nameEnd = at + CENTRAL_HEADER_BYTES + nameLength;
    if (nameEnd > bytes.byteLength) throw formatError(`zip 목록 ${i + 1}번째 항목 이름이 잘렸다`);
    const name = decodeName(bytes.subarray(at + CENTRAL_HEADER_BYTES, nameEnd), (flags & FLAG_UTF8_NAME) !== 0);
    if (flags & FLAG_ENCRYPTED) throw formatError(`암호화된 엔트리 ${name} 는 지원하지 않는다`);
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw formatError(`엔트리 ${name} 의 압축 방식(${method})은 지원하지 않는다`);
    }
    if (compressedSize === ZIP64_MARKER_U32 || uncompressedSize === ZIP64_MARKER_U32 || localHeaderOffset === ZIP64_MARKER_U32) {
      throw formatError(`엔트리 ${name} 가 zip64 크기를 쓴다(지원하지 않음)`);
    }
    if (uncompressedSize > limits.maxEntryUncompressedBytes) {
      throw new ZipLimitExceededError(
        "maxEntryUncompressedBytes",
        limits.maxEntryUncompressedBytes,
        `zip 엔트리 ${name} 의 풀린 크기가 상한(maxEntryUncompressedBytes=${formatMiB(limits.maxEntryUncompressedBytes)})을 넘었다`,
      );
    }
    totalBytes += uncompressedSize;
    if (totalBytes > limits.maxTotalUncompressedBytes) {
      throw new ZipLimitExceededError(
        "maxTotalUncompressedBytes",
        limits.maxTotalUncompressedBytes,
        `zip 의 풀린 크기 합계가 상한(maxTotalUncompressedBytes=${formatMiB(limits.maxTotalUncompressedBytes)})을 넘었다`,
      );
    }
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    at = nameEnd + extraLength + commentLength;
  }
  return entries;
}

/** 엔트리의 압축 데이터 위치를 로컬 헤더에서 찾는다. */
function entryData(bytes: Uint8Array, view: DataView, entry: CentralEntry): Uint8Array {
  const at = entry.localHeaderOffset;
  if (at + LOCAL_HEADER_BYTES > bytes.byteLength || view.getUint32(at, true) !== LOCAL_SIGNATURE) {
    throw formatError(`엔트리 ${entry.name} 의 로컬 헤더가 깨졌다`);
  }
  const start = at + LOCAL_HEADER_BYTES + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const end = start + entry.compressedSize;
  if (end > bytes.byteLength) throw formatError(`엔트리 ${entry.name} 의 데이터가 잘렸다`);
  return bytes.subarray(start, end);
}

function inflateEntry(data: Uint8Array, entry: CentralEntry): Uint8Array {
  if (entry.method === METHOD_STORED) {
    if (data.byteLength !== entry.uncompressedSize) {
      throw formatError(`무압축 엔트리 ${entry.name} 의 크기가 zip 목록과 다르다`);
    }
    return data;
  }
  let out: Uint8Array;
  try {
    // zlib 은 0 바이트 상한을 받지 않아 최소 1 로 건다. 크기 0 이라 적힌 엔트리가 실제로 1 바이트를
    // 내면 아래 크기 대조에서, 그보다 크면 여기서 걸린다.
    out = inflateRawSync(data, { maxOutputLength: Math.max(entry.uncompressedSize, MIN_ZLIB_OUTPUT_LIMIT) });
  } catch (err) {
    if ((err as { code?: string }).code === ZLIB_OUTPUT_TOO_LARGE) {
      throw new ZipLimitExceededError(
        "declaredEntrySize",
        entry.uncompressedSize,
        `zip 엔트리 ${entry.name} 의 실제 풀린 크기가 zip 목록에 적힌 크기(${entry.uncompressedSize} 바이트)를 넘었다 — 크기를 속인 zip`,
      );
    }
    throw formatError(`엔트리 ${entry.name} 압축 풀기 실패 — ${(err as Error).message}`);
  }
  if (out.byteLength !== entry.uncompressedSize) {
    throw formatError(`엔트리 ${entry.name} 의 풀린 크기가 zip 목록과 다르다`);
  }
  return out;
}

/**
 * bytes(zip)를 상한 안에서 푼다. 상한 초과(목록 크기 또는 실제로 푼 크기)는
 * ZipLimitExceededError, 깨졌거나 다루지 않는 zip 은 "zip 형식 오류" 에러를 던진다
 * (호출자가 파일 이름을 붙여 다시 던진다).
 */
export function unzipWithinLimits(bytes: Uint8Array, limits: ZipExtractionLimits): UnzippedEntries {
  const entries = readCentralDirectory(bytes, limits);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 엔트리 이름이 "__proto__" 같은 값이어도 객체 원형을 건드리지 않게 원형 없는 객체를 쓴다.
  const out: UnzippedEntries = Object.create(null);
  for (const entry of entries) {
    out[entry.name] = inflateEntry(entryData(bytes, view, entry), entry);
  }
  return out;
}
