import { readFile, writeFile } from "node:fs/promises";

export interface CliProbeResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  delayMs?: number;
  startedFile?: string;
}

/** A real CLI subprocess driven solely by test data, with no user configuration or credentials. */
if (import.meta.main) {
  const responses: Record<string, CliProbeResponse> = JSON.parse(await readFile(process.argv[2]!, "utf8"));
  const response = responses[process.argv[3] ?? ""] ?? { exitCode: 2 };
  if (response.startedFile) await writeFile(response.startedFile, "started");
  if (response.delayMs) await Bun.sleep(response.delayMs);
  if (response.stdout) await Bun.write(Bun.stdout, response.stdout);
  if (response.stderr) await Bun.write(Bun.stderr, response.stderr);
  process.exit(response.exitCode ?? 0);
}
