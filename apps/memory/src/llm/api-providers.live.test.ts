/**
 * 실키 확인 테스트 — OpenAI·Gemini 실제 API (2026-10-11 llm-api-providers spec 10장, 선택 실행).
 *
 * 비용이 드는 실제 호출이라 환경변수가 모두 있을 때만 돈다. 없으면 "건너뜀" 으로 표시된다(통과로 위장하지 않음).
 *   OpenAI : BARA_LIVE_OPENAI_API_KEY + BARA_LIVE_OPENAI_MODEL (예: 사용자가 고른 대화 모델 이름)
 *   Gemini : BARA_LIVE_GEMINI_API_KEY + BARA_LIVE_GEMINI_MODEL
 * 모델 이름은 코드에 박지 않는다(사용자 결정 Q4). 실행은 사용자 동의 후에만.
 *
 * 공급자마다 4번 호출한다: 모델 목록 1회, 짧은 JSON 스키마 추출 1회, 작은 한도로 잘림 유도 1회, 이미지 캡션 1회.
 * 결과(temperature 거절 여부, responseJsonSchema 동작, 생각 토큰과 한도 관계)는 console.log 로 남겨
 * spec 결정 기록에 옮겨 적는다.
 */
import { describe, expect, test } from "bun:test";
import { OpenAiClient } from "./openai-client.ts";
import { GeminiClient } from "./gemini-client.ts";
import { OpenAiVisionProvider } from "./vision/openai.ts";
import { GeminiVisionProvider } from "./vision/gemini.ts";
import { listProviderModels } from "./model-listing.ts";
import type { ObservableLlmClient } from "./types.ts";
import type { VisionProvider } from "./vision/index.ts";

/** 실제로 디코딩되는 8x8 빨간 PNG(데이터 fixture). */
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAE0lEQVR4nGP4z8CAFWEXHawSDAAo/z/BjYT1yQAAAABJRU5ErkJggg==",
  "base64",
);
const LIVE_TIMEOUT_MS = 60_000;
const EXTRACT_SCHEMA = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
};

interface LiveTarget {
  name: string;
  keyVar: string;
  modelVar: string;
  provider: "openai" | "google";
  makeClient: (apiKey: string, model: string) => ObservableLlmClient;
  makeVision: (apiKey: string, model: string) => VisionProvider;
}

const TARGETS: LiveTarget[] = [
  {
    name: "OpenAI",
    keyVar: "BARA_LIVE_OPENAI_API_KEY",
    modelVar: "BARA_LIVE_OPENAI_MODEL",
    provider: "openai",
    makeClient: (apiKey, model) => new OpenAiClient({ apiKey, model, timeoutMs: LIVE_TIMEOUT_MS }),
    makeVision: (apiKey, model) => new OpenAiVisionProvider({ limitSettingPath: "llm.vision.tokenCap", apiKey, model, defaultMaxTokens: 400, timeoutMs: LIVE_TIMEOUT_MS }),
  },
  {
    name: "Gemini",
    keyVar: "BARA_LIVE_GEMINI_API_KEY",
    modelVar: "BARA_LIVE_GEMINI_MODEL",
    provider: "google",
    makeClient: (apiKey, model) => new GeminiClient({ apiKey, model, timeoutMs: LIVE_TIMEOUT_MS }),
    makeVision: (apiKey, model) => new GeminiVisionProvider({ limitSettingPath: "llm.vision.tokenCap", apiKey, model, defaultMaxTokens: 400, timeoutMs: LIVE_TIMEOUT_MS }),
  },
];

for (const target of TARGETS) {
  const apiKey = process.env[target.keyVar]?.trim() ?? "";
  const model = process.env[target.modelVar]?.trim() ?? "";
  const missing = [apiKey ? null : target.keyVar, model ? null : target.modelVar].filter((v) => v !== null);
  const skip = missing.length > 0;
  const suffix = skip ? ` — 건너뜀: ${missing.join(", ")} 미설정` : "";

  describe(`${target.name} 실키 확인${suffix}`, () => {
    test.skipIf(skip)("모델 목록 1회", async () => {
      const result = await listProviderModels({ provider: target.provider, slot: "cleanup", apiKey });
      console.log(`[live ${target.name}] 목록 ${result.models.length}개, 거름=${JSON.stringify(result.filter)}`);
      expect(result.models.length).toBeGreaterThan(0);
    }, LIVE_TIMEOUT_MS);

    test.skipIf(skip)("짧은 추출 1회 (JSON 스키마 + temperature)", async () => {
      const result = await target.makeClient(apiKey, model).chatDetailed(
        [{ role: "user", content: "다음 문장에서 도시 이름만 JSON 으로: 나는 부산에 산다." }],
        { jsonSchema: EXTRACT_SCHEMA, temperature: 0.1, maxOutputTokens: 2000 },
      );
      console.log(`[live ${target.name}] 추출 stop=${result.stopReason} usage=${JSON.stringify(result.usage)} text=${result.text}`);
      expect(JSON.parse(result.text)).toHaveProperty("city");
    }, LIVE_TIMEOUT_MS);

    test.skipIf(skip)("잘림 유도 1회 (작은 한도)", async () => {
      const result = await target.makeClient(apiKey, model).chatDetailed(
        [{ role: "user", content: "한국의 역사를 아주 길게 설명하라." }],
        { maxOutputTokens: 16 },
      );
      console.log(`[live ${target.name}] 잘림 stop=${result.stopReason} 글자수=${result.text.length} usage=${JSON.stringify(result.usage)}`);
      expect(result.stopReason).toBe("max_tokens");
    }, LIVE_TIMEOUT_MS);

    test.skipIf(skip)("이미지 캡션 1회", async () => {
      const out = await target.makeVision(apiKey, model).captionImage(RED_PNG, "image/png", "이 이미지의 색을 한 단어로.");
      console.log(`[live ${target.name}] 캡션 stop=${out.stopReason} usage=${JSON.stringify(out.usage)} caption=${out.caption}`);
      expect(out.caption.length).toBeGreaterThan(0);
    }, LIVE_TIMEOUT_MS);
  });
}
