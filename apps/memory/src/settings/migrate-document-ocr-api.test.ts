/**
 * 문서 OCR 설정 — 업체 표·새 칸·비밀 칸·옛 설정 옮기기·백업 복원 검사 (2026-10-11 document-ocr spec T1).
 * 실제 설정 파일(임시 폴더)·실제 비밀 파일·실제 검증을 쓴다. 키 문자열은 테스트용 값이다.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSettingsAt, putSettingsAt } from "../test-utils/settings-files";
import { MEMORY_DEFAULTS, MEMORY_SCHEMA, PASSWORD_FIELD_PATHS } from "./memory-schema";
import { maskSecrets, secretsPathBesideSettings } from "./memory-settings";
import { SecretStore } from "./secrets";
import {
  DOCUMENT_OCR_API_PROVIDERS,
  DOCUMENT_OCR_VISION_API_PROVIDERS,
  isDocumentOcrApiProvider,
  isDocumentOcrServerMode,
  isDocumentOcrVisionApiProvider,
} from "./document-ocr-api-providers";
import { migrateDocumentOcrApiProvider } from "./migrate-document-ocr-api";
import { parseBackupSettings, sanitizeDownloadSettings } from "../backup/restore-validation";

const TMP_ROOT = join(import.meta.dir, "_tmp_ocr_settings");
let tmpDir: string;
let counter = 0;

beforeEach(() => {
  counter += 1;
  tmpDir = join(TMP_ROOT, `${process.pid}-${Date.now()}-${counter}`);
  mkdirSync(tmpDir, { recursive: true });
});
afterEach(() => {
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
});

const OCR_KEY_PATHS = [
  "documents.ocr.api.anthropicApiKey",
  "documents.ocr.api.gptApiKey",
  "documents.ocr.api.geminiApiKey",
  "documents.ocr.api.openaiApiKey",
] as const;

function legacySettings(endpointUrl: string, extraApi: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    documents: {
      ocr: {
        mode: "api",
        api: {
          provider: "openai_compatible_vision",
          endpointUrl,
          model: "vision-model-x",
          apiKey: "",
          responseFormat: "markdown",
          ...extraApi,
        },
      },
    },
  };
}

function writeLegacyFile(settings: Record<string, unknown>, secretKey?: string): string {
  const path = join(tmpDir, "memory-settings.json");
  writeFileSync(path, JSON.stringify(settings));
  if (secretKey !== undefined) {
    new SecretStore(secretsPathBesideSettings(path)).set("documents.ocr.api.apiKey", secretKey);
  }
  return path;
}

describe("업체 표", () => {
  test("AI API 업체 다섯 개 순서와 판정", () => {
    expect([...DOCUMENT_OCR_API_PROVIDERS]).toEqual([
      "anthropic", "openai", "google", "openai_compatible", "http_file_api",
    ]);
    expect(DOCUMENT_OCR_VISION_API_PROVIDERS.every(isDocumentOcrVisionApiProvider)).toBe(true);
    expect(isDocumentOcrVisionApiProvider("http_file_api")).toBe(false);
    expect(isDocumentOcrApiProvider("openai_compatible_vision")).toBe(false);
    expect(isDocumentOcrServerMode("local")).toBe(true);
    expect(isDocumentOcrServerMode("pc_companion")).toBe(false);
  });

  test("스키마 provider 선택지는 업체 표 그대로", () => {
    const api = MEMORY_SCHEMA.properties.documents.properties.ocr.properties.api;
    expect([...api.properties.provider.enum]).toEqual([...DOCUMENT_OCR_API_PROVIDERS]);
  });
});

describe("새 칸 기본값·범위", () => {
  test("기본값: 출력 8192, 쪽 그림 1600, 10쪽/100쪽, 시도 3·대기 30·차단 3, 여유 8192, 모델·주소 빈 칸", () => {
    const ocr = MEMORY_DEFAULTS.documents.ocr;
    expect(ocr.maxOutputTokensPerPage).toBe(8192);
    expect(ocr.pageImage.maxEdgePx).toBe(1600);
    expect(ocr.schedule.maxPagesPerCycle).toBe(10);
    expect(ocr.schedule.maxPagesPerDay).toBe(100);
    expect(ocr.reliability).toEqual({ maxAttemptsPerPage: 3, retryDelayMinutes: 30, circuitBreakerThreshold: 3 });
    expect(ocr.local.ollamaInputTokenReserve).toBe(8192);
    for (const field of ["anthropicModel", "gptModel", "geminiModel", "openaiModel", "openaiBaseUrl"] as const) {
      expect(ocr.api[field]).toBe("");
    }
  });

  test("범위 밖 값은 저장 검사가 거절한다", () => {
    const path = join(tmpDir, "range.json");
    expect(() => putSettingsAt({ documents: { ocr: { maxOutputTokensPerPage: 100 } } }, path)).toThrow(
      /documents\.ocr\.maxOutputTokensPerPage/,
    );
    expect(() => putSettingsAt({ documents: { ocr: { schedule: { maxPagesPerDay: 0 } } } }, path)).toThrow(
      /maxPagesPerDay/,
    );
    expect(() => putSettingsAt({ documents: { ocr: { pageImage: { maxEdgePx: 5000 } } } }, path)).toThrow(
      /maxEdgePx/,
    );
    expect(() =>
      putSettingsAt({ documents: { ocr: { api: { provider: "openai_compatible_vision" as never } } } }, path),
    ).toThrow(/documents\.ocr\.api\.provider/);
  });

  test("일부 칸만 저장해도 다른 새 칸은 보존된다", () => {
    const path = join(tmpDir, "partial.json");
    putSettingsAt({ documents: { ocr: { reliability: { maxAttemptsPerPage: 5 } } } }, path);
    putSettingsAt({ documents: { ocr: { reliability: { retryDelayMinutes: 7 } } } }, path);
    const loaded = getSettingsAt(path);
    expect(loaded.documents.ocr.reliability).toEqual({
      maxAttemptsPerPage: 5,
      retryDelayMinutes: 7,
      circuitBreakerThreshold: 3,
    });
  });
});

describe("비밀 칸 4개", () => {
  test("PASSWORD_FIELD_PATHS 에 들어 있다", () => {
    for (const path of OCR_KEY_PATHS) expect(PASSWORD_FIELD_PATHS as readonly string[]).toContain(path);
  });

  test("설정 파일에 평문으로 남지 않고 비밀 파일로 가며 $secretsSet 에 경로만 실린다", () => {
    const path = join(tmpDir, "keys.json");
    putSettingsAt(
      { documents: { ocr: { api: { provider: "openai", gptApiKey: "sk-test-OCR-GPT-1", gptModel: "m1" } } } },
      path,
    );
    const raw = readFileSync(path, "utf-8");
    expect(raw).not.toContain("sk-test-OCR-GPT-1");
    expect(new SecretStore(secretsPathBesideSettings(path)).get("documents.ocr.api.gptApiKey")).toBe("sk-test-OCR-GPT-1");
    const loaded = getSettingsAt(path);
    expect(loaded.documents.ocr.api.gptApiKey).toBe("sk-test-OCR-GPT-1");
    const masked = maskSecrets(loaded);
    expect(JSON.stringify(masked)).not.toContain("sk-test-OCR-GPT-1");
    expect(masked.$secretsSet).toContain("documents.ocr.api.gptApiKey");
    expect(masked.$secretsSet).not.toContain("documents.ocr.api.geminiApiKey");
  });

  test("빈 키로 다시 저장하면 저장된 키를 유지한다", () => {
    const path = join(tmpDir, "keep.json");
    putSettingsAt({ documents: { ocr: { api: { geminiApiKey: "gm-test-OCR-1" } } } }, path);
    putSettingsAt({ documents: { ocr: { api: { geminiApiKey: "", geminiModel: "g1" } } } }, path);
    const loaded = getSettingsAt(path);
    expect(loaded.documents.ocr.api.geminiApiKey).toBe("gm-test-OCR-1");
    expect(loaded.documents.ocr.api.geminiModel).toBe("g1");
  });
});

describe("옛 openai_compatible_vision 옮기기 (표 4경우)", () => {
  test("api.openai.com → openai, gptModel·gptApiKey 로", () => {
    const path = writeLegacyFile(legacySettings("https://api.openai.com/v1/chat/completions"), "sk-test-LEGACY-1");
    const loaded = getSettingsAt(path);
    const api = loaded.documents.ocr.api;
    expect(api.provider).toBe("openai");
    expect(api.gptModel).toBe("vision-model-x");
    expect(api.gptApiKey).toBe("sk-test-LEGACY-1");
    expect(api.endpointUrl).toBe("");
    expect(api.model).toBe("");
  });

  test("그 밖 + /chat/completions 끝 → openai_compatible, 끝을 뗀 주소", () => {
    const path = writeLegacyFile(legacySettings("http://10.0.0.5:1234/v1/chat/completions"), "sk-test-LEGACY-2");
    const api = getSettingsAt(path).documents.ocr.api;
    expect(api.provider).toBe("openai_compatible");
    expect(api.openaiBaseUrl).toBe("http://10.0.0.5:1234/v1");
    expect(api.openaiModel).toBe("vision-model-x");
    expect(api.openaiApiKey).toBe("sk-test-LEGACY-2");
  });

  test("그 밖 + 끝이 다름 → 주소 그대로 + 경고(칸 이름, 키 없음)", () => {
    const settings = legacySettings("https://vision.example/ocr");
    const warnings: string[] = [];
    const copies = migrateDocumentOcrApiProvider(settings, warnings);
    const api = (settings.documents as { ocr: { api: Record<string, unknown> } }).ocr.api;
    expect(api.provider).toBe("openai_compatible");
    expect(api.openaiBaseUrl).toBe("https://vision.example/ocr");
    expect(warnings.some((w) => w.includes("documents.ocr.api.openaiBaseUrl"))).toBe(true);
    expect(copies).toEqual([{ from: "documents.ocr.api.apiKey", to: "documents.ocr.api.openaiApiKey" }]);
  });

  test("빈 주소 → openai_compatible, openaiBaseUrl 빈 칸", () => {
    const settings = legacySettings("");
    migrateDocumentOcrApiProvider(settings, []);
    const api = (settings.documents as { ocr: { api: Record<string, unknown> } }).ocr.api;
    expect(api.provider).toBe("openai_compatible");
    expect(api.openaiBaseUrl).toBeUndefined();
  });

  test("호스트가 정확히 일치해야 openai — 비슷한 이름은 호환으로", () => {
    const settings = legacySettings("https://api.openai.com.evil.example/v1/chat/completions");
    migrateDocumentOcrApiProvider(settings, []);
    expect((settings.documents as { ocr: { api: { provider: string } } }).ocr.api.provider).toBe("openai_compatible");
  });

  test("대상 칸에 이미 값이 있으면 덮지 않고, 두 번 돌려도 같다(멱등)", () => {
    const settings = legacySettings("http://h/v1/chat/completions", { openaiModel: "kept-model" });
    migrateDocumentOcrApiProvider(settings, []);
    const once = JSON.stringify(settings);
    const second = migrateDocumentOcrApiProvider(settings, []);
    expect(second).toEqual([]);
    expect(JSON.stringify(settings)).toBe(once);
    const api = (settings.documents as { ocr: { api: Record<string, unknown> } }).ocr.api;
    expect(api.openaiModel).toBe("kept-model");
  });

  test("이미 대상 키가 저장돼 있으면 옛 키로 덮지 않는다", () => {
    const path = writeLegacyFile(legacySettings("https://api.openai.com/v1/chat/completions"), "sk-test-OLD");
    new SecretStore(secretsPathBesideSettings(path)).set("documents.ocr.api.gptApiKey", "sk-test-NEW");
    expect(getSettingsAt(path).documents.ocr.api.gptApiKey).toBe("sk-test-NEW");
  });

  test("경고 문장에 키 값이 없다", () => {
    const path = writeLegacyFile(
      legacySettings("https://vision.example/ocr", { apiKey: "sk-test-INLINE-LEAK" }),
    );
    const logged: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    try {
      getSettingsAt(path);
    } finally {
      console.warn = original;
    }
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain("sk-test-INLINE-LEAK");
  });

  test("옮긴 뒤 한 번 저장하면 새 경로로 기록되고 다음 읽기는 옮기지 않는다", () => {
    const path = writeLegacyFile(legacySettings("https://api.openai.com/v1/chat/completions"), "sk-test-SAVE");
    putSettingsAt({ documents: { ocr: { schedule: { batchSize: 2 } } } }, path);
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    expect(raw.documents.ocr.api.provider).toBe("openai");
    expect(raw.documents.ocr.api.gptModel).toBe("vision-model-x");
    expect(JSON.stringify(raw)).not.toContain("sk-test-SAVE");
    expect(new SecretStore(secretsPathBesideSettings(path)).get("documents.ocr.api.gptApiKey")).toBe("sk-test-SAVE");
  });
});

describe("백업 복원 검사", () => {
  test("옛 값 백업은 통과하고 원본(옮기기 전)을 돌려준다", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(legacySettings("https://api.openai.com/v1/chat/completions")));
    const parsed = parseBackupSettings(bytes) as { documents: { ocr: { api: { provider: string } } } };
    expect(parsed.documents.ocr.api.provider).toBe("openai_compatible_vision");
  });

  test("다운로드 사본에서 OCR 키 4칸이 비워진다", () => {
    const api: Record<string, string> = { provider: "openai" };
    for (const path of OCR_KEY_PATHS) api[path.split(".").at(-1)!] = `sk-test-DL-${path}`;
    const bytes = new TextEncoder().encode(JSON.stringify({ documents: { ocr: { api } } }));
    const out = new TextDecoder().decode(sanitizeDownloadSettings(bytes));
    expect(out).not.toContain("sk-test-DL-");
  });
});
