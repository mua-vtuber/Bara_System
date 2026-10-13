import type { AiDiscovery, DiscoveredCli, DiscoveredServer } from "../shared/contracts.ts";
import { listModelsAt } from "./ai.ts";
import { isCliInstalled, type CliProvider } from "./cli.ts";
import { ServiceError } from "./errors.ts";

/** One local AI server address the Pet looks at. Only these fixed loopback addresses are ever contacted. */
export interface DiscoveryCandidate { id: string; provider: DiscoveredServer["provider"]; baseUrl: string }

/** The default addresses of Ollama, LM Studio, Jan and llama.cpp's server, in the order `discoverAi` reports them. */
export const DISCOVERY_CANDIDATES: readonly DiscoveryCandidate[] = [
  { id: "ollama", provider: "ollama", baseUrl: "http://127.0.0.1:11434" },
  { id: "lm-studio", provider: "openai-compatible", baseUrl: "http://127.0.0.1:1234" },
  { id: "jan", provider: "openai-compatible", baseUrl: "http://127.0.0.1:1337" },
  { id: "llama-cpp", provider: "openai-compatible", baseUrl: "http://127.0.0.1:8080" },
];
/** How long one candidate may take; the candidates are asked in parallel, so this also bounds the whole call. */
export const DISCOVERY_TIMEOUT_MS = 2000;
export const DISCOVERY_CLIS: readonly CliProvider[] = ["claude", "codex"];

export interface DiscoveryDeps {
  candidates?: readonly DiscoveryCandidate[];
  timeoutMs?: number;
  /** Whether the executable resolves on PATH; nothing is run. */
  cliInstalled?: (provider: CliProvider) => boolean;
}

/** Looks for local AI servers at the fixed candidate addresses and for the `claude`/`codex` commands on PATH.
 * A candidate that refuses, times out or does not answer with a model list is simply not found; an empty
 * model list is a server that is running with nothing loaded, and is reported. No key is sent, no login is
 * checked. A cancelled `signal` ends the call with the service's `CANCELLED` error. */
export async function discoverAi(signal: AbortSignal, deps: DiscoveryDeps = {}): Promise<AiDiscovery> {
  const { candidates = DISCOVERY_CANDIDATES, timeoutMs = DISCOVERY_TIMEOUT_MS, cliInstalled = isCliInstalled } = deps;
  signal.throwIfAborted();
  const found = await Promise.all(candidates.map(async (candidate): Promise<DiscoveredServer | null> => {
    try {
      return { id: candidate.id, provider: candidate.provider, baseUrl: candidate.baseUrl, models: await listModelsAt(candidate.provider, candidate.baseUrl, null, signal, timeoutMs) };
    } catch (error) {
      // No answer, a refusal and a reply that is not a model list all mean "not here"; a cancellation and a defect propagate.
      if (!(error instanceof ServiceError) || error.code === "CANCELLED") throw error;
      return null;
    }
  }));
  const clis: DiscoveredCli[] = DISCOVERY_CLIS.map((provider) => ({ provider, installed: cliInstalled(provider) }));
  return { servers: found.filter((server): server is DiscoveredServer => server !== null), clis };
}
