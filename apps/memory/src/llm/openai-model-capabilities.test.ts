import { describe, expect, test } from "bun:test";
import {
  OPENAI_CHAT_MODEL_ID_PATTERNS,
  OPENAI_NON_CHAT_ID_MARKERS,
  isOpenAiChatModelId,
  openAiModelAcceptsSampling,
} from "./openai-model-capabilities.ts";

/**
 * 대화 모델 이름 규칙 고정 테스트(spec 10장 T4) — 규칙 상수를 바꾸면 이 표가 깨져 변경이 눈에 띈다.
 * 실제 OpenAI /v1/models 에 나오는 이름 모양의 데이터 fixture.
 */
const CHAT_IDS = ["gpt-4o", "gpt-4.1-mini", "gpt-5", "chatgpt-4o-latest", "o3", "o4-mini", "gpt-3.5-turbo", "ft:gpt-4o-mini:acme::abc123"];
const NON_CHAT_IDS = [
  "text-embedding-3-small",
  "whisper-1",
  "tts-1",
  "dall-e-3",
  "gpt-4o-audio-preview",
  "gpt-4o-realtime-preview",
  "gpt-4o-mini-transcribe",
  "gpt-4o-search-preview",
  "gpt-image-1",
  "gpt-3.5-turbo-instruct",
  "omni-moderation-latest",
  "babbage-002",
  "gpt-4o-mini-tts",
];

describe("isOpenAiChatModelId — 대화 모델 이름 규칙", () => {
  test.each(CHAT_IDS)("%s → 대화 모델", (id) => {
    expect(isOpenAiChatModelId(id)).toBe(true);
  });
  test.each(NON_CHAT_IDS)("%s → 대화 모델 아님", (id) => {
    expect(isOpenAiChatModelId(id)).toBe(false);
  });
  test("대문자도 같은 규칙", () => {
    expect(isOpenAiChatModelId("GPT-4o")).toBe(true);
  });
  test("규칙 상수 모양 고정", () => {
    expect(OPENAI_CHAT_MODEL_ID_PATTERNS.map(String)).toEqual(["/^gpt-\\d/", "/^chatgpt-/", "/^o\\d/"]);
    expect(OPENAI_NON_CHAT_ID_MARKERS.map(String)).toEqual([
      "/-audio/", "/-realtime/", "/-transcribe/", "/-tts/", "/-search/", "/-image/", "/instruct$/",
    ]);
  });
});

describe("openAiModelAcceptsSampling — temperature 허용 표", () => {
  const cases: Array<[string, boolean]> = [
    ["gpt-4o", true],
    ["gpt-4o-mini", true],
    ["gpt-4.1", true],
    ["gpt-4.1-nano", true],
    ["gpt-4-turbo", true],
    ["gpt-3.5-turbo", true],
    ["ft:gpt-4o-mini:acme::abc123", true],
    ["gpt-5", false],
    ["gpt-5-mini", false],
    ["o3", false],
    ["o4-mini", false],
    ["chatgpt-4o-latest", false],
    ["gpt-4.5-preview", false],
  ];
  test.each(cases)("%s → %p", (id, expected) => {
    expect(openAiModelAcceptsSampling(id)).toBe(expected);
  });
});
