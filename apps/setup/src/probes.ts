export interface ProbeResult<T = unknown> {
  ok: boolean;
  value?: T;
  error?: string;
}

export interface OllamaModel {
  name: string;
}

export interface OpenAiCompatibleModel {
  id: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(handle);
  }
}

export async function detectOllama(
  baseUrl = "http://127.0.0.1:11434",
  timeoutMs = 2000,
): Promise<ProbeResult<OllamaModel[]>> {
  try {
    const json = await fetchJson<{ models?: Array<{ name?: unknown }> }>(
      `${normalizeBaseUrl(baseUrl)}/api/tags`,
      timeoutMs,
    );
    const models = (json.models ?? [])
      .map((m) => (typeof m.name === "string" ? { name: m.name } : null))
      .filter((m): m is OllamaModel => m !== null);
    return { ok: true, value: models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function detectOpenAiCompatible(
  baseUrl = "http://127.0.0.1:1234/v1",
  timeoutMs = 2000,
): Promise<ProbeResult<OpenAiCompatibleModel[]>> {
  try {
    const json = await fetchJson<{ data?: Array<{ id?: unknown }> }>(
      `${normalizeBaseUrl(baseUrl)}/models`,
      timeoutMs,
    );
    const models = (json.data ?? [])
      .map((m) => (typeof m.id === "string" ? { id: m.id } : null))
      .filter((m): m is OpenAiCompatibleModel => m !== null);
    return { ok: true, value: models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

