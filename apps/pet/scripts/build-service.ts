import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dir, "..");

/** Bundles the service entry. With `outdir` the bundle is written there (`bun run build:service`);
 * without it the result stays in memory, which is how `tests/service-bundle.test.ts` inspects it. */
export async function buildServiceBundle(outdir?: string): Promise<Bun.BuildOutput> {
  const result = await Bun.build({ entrypoints: [join(root, "src/service/main.ts")], ...(outdir ? { outdir } : {}), target: "bun", format: "esm", minify: false });
  if (!result.success) throw new Error(result.logs.map(log => log.message).join("\n"));
  return result;
}

if (import.meta.main) {
  const outdir = join(root, "resources", "service");
  await mkdir(outdir, { recursive: true });
  await buildServiceBundle(outdir);
}
