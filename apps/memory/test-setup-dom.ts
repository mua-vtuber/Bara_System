/**
 * happy-dom 을 globalThis 에 등록 — bun:test 안에서 DOM API 사용 가능
 * (Phase 5.5.2 자동 폼 위젯 테스트). devDependency 전용, production 번들
 * 에는 포함 안 됨.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

type NativeWebApiKey =
  | "AbortController"
  | "AbortSignal"
  | "Blob"
  | "File"
  | "FormData"
  | "Headers"
  | "Request"
  | "Response"
  | "URL"
  | "URLSearchParams"
  | "ReadableStream"
  | "TransformStream"
  | "WritableStream"
  | "fetch";

const NATIVE_WEB_API_KEYS: NativeWebApiKey[] = [
  "AbortController",
  "AbortSignal",
  "Blob",
  "File",
  "FormData",
  "Headers",
  "Request",
  "Response",
  "URL",
  "URLSearchParams",
  "ReadableStream",
  "TransformStream",
  "WritableStream",
  "fetch",
];

const nativeWebApis = new Map<NativeWebApiKey, unknown>(
  NATIVE_WEB_API_KEYS.map((key) => [key, globalThis[key]]),
);

const WINDOW_FACADE_MARK = Symbol.for("bara.testSetupDom.windowFacade");

export function registerDomTestGlobals(): void {
  if (!(globalThis as { document?: unknown }).document) {
    GlobalRegistrator.register({ url: "http://127.0.0.1/" });
  }

  for (const [key, value] of nativeWebApis) {
    if (value === undefined) continue;
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  hideWindowDocumentFromBrowserDetection();
}

registerDomTestGlobals();

function hideWindowDocumentFromBrowserDetection(): void {
  const currentWindow = (globalThis as { window?: unknown }).window;
  if (!currentWindow || typeof currentWindow !== "object") return;
  if ((currentWindow as Record<symbol, unknown>)[WINDOW_FACADE_MARK]) return;

  const facade = Object.create(currentWindow) as Record<PropertyKey, unknown>;
  Object.defineProperty(facade, "document", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: undefined,
  });
  Object.defineProperty(facade, "window", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: facade,
  });
  Object.defineProperty(facade, "self", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: facade,
  });
  Object.defineProperty(facade, WINDOW_FACADE_MARK, {
    configurable: false,
    enumerable: false,
    value: true,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: facade,
  });
}
