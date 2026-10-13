import { expect, test } from "bun:test";
import type { AiDiscovery } from "../shared/contracts.ts";
import { checkListedModels, cleanupProviderOptions, cleanupUsesAnswerServer, keyStillApplies, modelOptions, sameAiServer, serverChoices, slotStatus, suggestedModel } from "./ai-settings-model.ts";
import { messages } from "./messages.ts";

const discovery: AiDiscovery = {
  servers: [
    { id: "ollama", provider: "ollama", baseUrl: "http://127.0.0.1:11434", models: ["qwen3:8b", "gemma3:4b"] },
    { id: "lm-studio", provider: "openai-compatible", baseUrl: "http://127.0.0.1:1234", models: [] },
  ],
  clis: [{ provider: "claude", installed: true }, { provider: "codex", installed: false }],
};

test("each found server is offered with its product name and how many models it has", () => {
  const choices = serverChoices(discovery);
  expect(choices.map(choice => choice.label)).toEqual([
    messages.settings.discoveredServer("Ollama", 2), messages.settings.discoveredServer("LM Studio", 0),
  ]);
  expect(choices[0]).toMatchObject({ provider: "ollama", baseUrl: "http://127.0.0.1:11434", models: ["qwen3:8b", "gemma3:4b"] });
  // A server with no models says so instead of offering an empty list as if it were usable.
  expect(choices[1]!.label).toContain("없음");
});

test("an unknown server id is shown as it is rather than dropped", () => {
  const [choice] = serverChoices({ servers: [{ id: "other", provider: "openai-compatible", baseUrl: "http://127.0.0.1:9", models: ["m"] }], clis: [] });
  expect(choice!.label).toBe(messages.settings.discoveredServer("other", 1));
});

test("a saved model the server no longer lists stays selectable and is marked", () => {
  expect(modelOptions(["a", "b"], "b")).toEqual([["", messages.settings.pickModel], ["a", "a"], ["b", "b"]]);
  expect(modelOptions(["a"], "gone")).toEqual([["", messages.settings.pickModel], ["a", "a"], ["gone", messages.settings.modelNotListed("gone")]]);
  expect(modelOptions([], "")).toEqual([["", messages.settings.pickModel]]);
});

test("before any list is loaded, a saved model is not claimed to be missing", () => {
  expect(modelOptions([], "qwen3:8b", false)).toEqual([["", messages.settings.pickModel], ["qwen3:8b", "qwen3:8b"]]);
});

test("loopback names on the same port are one server; anything else that differs is another", () => {
  const ollama = (baseUrl: string) => ({ provider: "ollama", baseUrl });
  expect(sameAiServer(ollama("http://localhost:11434"), ollama("http://127.0.0.1:11434"))).toBe(true);
  expect(sameAiServer(ollama("http://[::1]:11434"), ollama("http://127.0.0.1:11434"))).toBe(true);
  expect(sameAiServer(ollama("http://127.0.0.1:11434"), ollama("http://127.0.0.1:1234"))).toBe(false);
  expect(sameAiServer(ollama("http://127.0.0.1:1234"), { provider: "openai-compatible", baseUrl: "http://127.0.0.1:1234" })).toBe(false);
  expect(sameAiServer({ provider: "openai-compatible", baseUrl: "https://api.example.com" }, { provider: "openai-compatible", baseUrl: "https://api.example.com:443" })).toBe(true);
});

test("a stored key applies only to the exact provider and origin it was saved with", () => {
  const saved = { provider: "openai-compatible", baseUrl: "http://localhost:1234" };
  expect(keyStillApplies({ provider: "openai-compatible", baseUrl: "http://localhost:1234" }, saved)).toBe(true);
  // The server stores the origin as typed, so another loopback name drops the key on save.
  expect(keyStillApplies({ provider: "openai-compatible", baseUrl: "http://127.0.0.1:1234" }, saved)).toBe(false);
  expect(keyStillApplies({ provider: "ollama", baseUrl: "http://localhost:1234" }, saved)).toBe(false);
  expect(keyStillApplies({ provider: "openai-compatible", baseUrl: "https://api.example.com" }, { provider: "openai-compatible", baseUrl: "https://api.example.com:443" })).toBe(true);
});

test("only a reachable server's answer counts as a model list", () => {
  expect(checkListedModels({ available: true, models: ["a"], message: "" })).toBe(true);
  expect(checkListedModels({ available: false, models: ["a"], message: "", reason: "model-missing" })).toBe(true);
  expect(checkListedModels({ available: false, models: [], message: "", reason: "connection-failed" })).toBe(false);
});

test("only server-kind cleanup AIs share the answer AI's server and models", () => {
  expect(["none", "claude", "codex", "ollama", "openai-compatible"].filter(p => cleanupUsesAnswerServer(p as never))).toEqual(["ollama", "openai-compatible"]);
});

test("a model is filled in only when it is unambiguous", () => {
  expect(suggestedModel(["only"], "")).toBe("only");
  expect(suggestedModel(["a", "b"], "")).toBe("");
  expect(suggestedModel([], "")).toBe("");
  expect(suggestedModel(["a", "b"], "typed")).toBe("typed");
});

test("Claude Code and Codex are marked found or not only after a search", () => {
  const before = cleanupProviderOptions(null);
  expect(before.find(([key]) => key === "claude")![1]).toBe(messages.settings.claudeCodeProvider);
  const after = cleanupProviderOptions(discovery);
  expect(after.find(([key]) => key === "claude")![1]).toBe(messages.settings.cliFound(messages.settings.claudeCodeProvider));
  expect(after.find(([key]) => key === "codex")![1]).toBe(messages.settings.cliNotFound(messages.settings.codexProvider));
  expect(after.map(([key]) => key)).toEqual(["none", "claude", "codex", "ollama", "openai-compatible"]);
});

test("a slot's line keeps 'saved' apart from 'usable'", () => {
  expect(slotStatus(false, null)).toEqual({ text: messages.settings.slotUnsaved, kind: "info" });
  expect(slotStatus(true, null)).toEqual({ text: messages.settings.slotSavedUnchecked, kind: "info" });
  expect(slotStatus(true, { available: true, models: [], message: "연결됨" })).toEqual({ text: messages.settings.slotUsable("연결됨"), kind: "success" });
  expect(slotStatus(true, { available: false, models: [], message: "로그인 필요", reason: "login-required" }))
    .toEqual({ text: messages.settings.slotNotUsable("로그인 필요"), kind: "error" });
  // Choosing no cleanup AI is a choice, not a failure; a chosen AI the settings cannot reach is one.
  expect(slotStatus(true, { available: false, models: [], message: "선택 안 함", reason: "not-configured" }, false).kind).toBe("info");
  expect(slotStatus(true, { available: false, models: [], message: "같은 종류의 서버 필요", reason: "not-configured" }).kind).toBe("error");
});
