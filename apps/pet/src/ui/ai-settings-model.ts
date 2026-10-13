import type { AiDiscovery, AiProbeResult, AiProvider, CleanupProvider } from "../shared/contracts.ts";
import { messages } from "./messages.ts";

/** One AI server found on this PC, as the settings screen offers it: picking it fills the answer AI's
 * provider and address, and its models become the model list. */
export interface ServerChoice { id: string; provider: Exclude<AiProvider, "none">; baseUrl: string; label: string; models: string[] }

export function serverChoices(discovery: AiDiscovery): ServerChoice[] {
  return discovery.servers.map(server => ({
    id: server.id, provider: server.provider, baseUrl: server.baseUrl, models: server.models,
    label: messages.settings.discoveredServer(serverName(server.id), server.models.length),
  }));
}

function serverName(id: string): string {
  return Object.hasOwn(messages.settings.serverNames, id) ? messages.settings.serverNames[id as keyof typeof messages.settings.serverNames] : id;
}

/** The model select's options. The current model stays selectable even when the server no longer lists it
 * (a model deleted after it was saved), so opening the screen never silently changes it. It is marked as
 * missing only once a list was actually loaded (`listed`); before that nobody has checked. */
export function modelOptions(models: readonly string[], current: string, listed = true): [string, string][] {
  const options: [string, string][] = [["", messages.settings.pickModel], ...models.map(model => [model, model] as [string, string])];
  if (current && !models.includes(current)) options.push([current, listed ? messages.settings.modelNotListed(current) : current]);
  return options;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether two answer-AI settings point at the same server: same provider and same address, where
 * `localhost`, `127.0.0.1` and `[::1]` on the same port count as one. The saved API key is bound to the
 * provider and address (`config.ts` `aiAudience`), so a different server never reuses it. */
export function sameAiServer(a: { provider: string; baseUrl: string }, b: { provider: string; baseUrl: string }): boolean {
  if (a.provider !== b.provider) return false;
  const origin = (value: string) => {
    try {
      const url = new URL(value.trim());
      const host = LOOPBACK.has(url.hostname) ? "loopback" : url.hostname;
      return `${url.protocol}//${host}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
    } catch { return value.trim(); }
  };
  return origin(a.baseUrl) === origin(b.baseUrl);
}

/** Whether a stored API key still applies: it is bound to the exact provider and origin it was saved with
 * (`config.ts` `aiAudience` over `parseBaseUrl`'s `url.origin`), so `localhost` and `127.0.0.1` differ here. */
export function keyStillApplies(current: { provider: string; baseUrl: string }, saved: { provider: string; baseUrl: string }): boolean {
  if (current.provider !== saved.provider) return false;
  const origin = (value: string) => { try { return new URL(value.trim()).origin; } catch { return value.trim(); } };
  return origin(current.baseUrl) === origin(saved.baseUrl);
}

/** Whether a model check produced a model list worth showing: a reachable server (with or without the chosen
 * model). A failed check lists nothing and must not mark the saved model as missing. */
export function checkListedModels(result: AiProbeResult): boolean {
  return result.available || result.reason === "model-missing";
}

/** The cleanup AI kinds that use the answer AI's server (and so its models); Claude Code and Codex do not. */
export function cleanupUsesAnswerServer(provider: CleanupProvider): boolean {
  return provider === "ollama" || provider === "openai-compatible";
}

/** The model to fill in after a list arrives: kept when it is still listed or the user typed one; the only
 * model when the list has exactly one; otherwise left for the user to choose. */
export function suggestedModel(models: readonly string[], current: string): string {
  if (current) return current;
  return models.length === 1 ? models[0]! : "";
}

/** The cleanup AI's provider options, marking Claude Code and Codex as found or not after a search. */
export function cleanupProviderOptions(discovery: AiDiscovery | null): [CleanupProvider, string][] {
  const installed = (provider: "claude" | "codex") => discovery?.clis.find(cli => cli.provider === provider)?.installed;
  const cli = (provider: "claude" | "codex", name: string): [CleanupProvider, string] => {
    const found = installed(provider);
    return [provider, found === undefined ? name : found ? messages.settings.cliFound(name) : messages.settings.cliNotFound(name)];
  };
  return [["none", messages.settings.cleanupNotSet], cli("claude", messages.settings.claudeCodeProvider), cli("codex", messages.settings.codexProvider),
    ["ollama", messages.settings.ollamaProvider], ["openai-compatible", messages.settings.compatibleApi]];
}

export type SlotStatus = { text: string; kind: "info" | "error" | "success" };

/** One AI slot's line: whether its settings are saved, and separately whether it can actually be used.
 * Saving a setting is not proof the AI answers, so a saved slot that failed its check reads as an error,
 * except a slot the user left unchosen (`chosen` false): that is a choice, shown as plain information. */
export function slotStatus(saved: boolean, probe: AiProbeResult | null, chosen = true): SlotStatus {
  if (!saved) return { text: messages.settings.slotUnsaved, kind: "info" };
  if (!probe) return { text: messages.settings.slotSavedUnchecked, kind: "info" };
  if (probe.available) return { text: messages.settings.slotUsable(probe.message), kind: "success" };
  return { text: messages.settings.slotNotUsable(probe.message), kind: chosen ? "error" : "info" };
}
