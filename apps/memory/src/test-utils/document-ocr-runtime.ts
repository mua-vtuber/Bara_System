/**
 * test-utils/document-ocr-runtime.ts — buildMemoryApi 를 직접 부르는 테스트에 실제 문서 OCR 실행기 관리자를 얹는다.
 * 테스트 전용: 제품 코드가 import 하지 않는다. 운영은 createMemoryApi 가 같은 함수로 만든다.
 */
import type { MemoryApiDeps } from "../server-internal/types.ts";
import type { MemorySettings } from "../settings/memory-settings.ts";
import { createDocumentOcrRuntime, type DocumentOcrRuntimeOptions } from "../server-internal/document-ocr/runtime.ts";
import type { DocumentOcrRuntime } from "../server-internal/document-ocr/runtime-types.ts";

/** deps 에 실행기 관리자를 붙여 그대로 돌려준다. getSettings 가 없으면 이름을 대며 멈춘다. */
export function withDocumentOcrRuntime<T extends MemoryApiDeps>(
  deps: T,
  extra: Omit<DocumentOcrRuntimeOptions, "api" | "getSettings"> & { getSettings?: () => MemorySettings } = {},
): T & { documentOcrRuntime: DocumentOcrRuntime } {
  const getSettings = extra.getSettings ?? deps.getSettings;
  if (!getSettings) throw new Error("withDocumentOcrRuntime: deps.getSettings 가 없음 — 테스트 설정을 넘겨라");
  const documentOcrRuntime = createDocumentOcrRuntime({ ...extra, api: deps, getSettings });
  deps.documentOcrRuntime = documentOcrRuntime;
  return Object.assign(deps, { documentOcrRuntime });
}
