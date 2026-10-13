import { mkdir, readFile, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { buildIcon } from "./icon.ts";
import { licenseSources, licenseTextsPlugin, readLicenseTexts } from "./license-texts.ts";
import { copyUiAssets } from "./ui-assets.ts";
import { rewriteUiEntry } from "./ui-entry.ts";
const root = resolve(import.meta.dir, "..");
const output = join(root, "dist");
const inside = relative(root, output);
if (!inside || inside.startsWith("..")) throw new Error("Invalid build output path");
// The license texts the settings screen shows are read from their source files here; a missing one stops the build.
const licenseTexts = await readLicenseTexts(licenseSources(root));
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "assets"), { recursive: true });
// Splitting keeps the Spine runtime, which only the pet window imports (dynamically), out of `main.js`, which every
// window loads; the entry files keep their names `main.js` and `main.css`.
const result = await Bun.build({ entrypoints: [join(root, "src/ui/main.ts")], outdir: join(output, "assets"), target: "browser", format: "esm", minify: true, splitting: true, plugins: [licenseTextsPlugin(licenseTexts)] });
if (!result.success) throw new Error(result.logs.map(item => item.message).join("\n"));
const html = await readFile(join(root, "index.html"), "utf8");
await Bun.write(join(output, "index.html"), rewriteUiEntry(html));
await copyUiAssets(root, output);
await buildIcon(root);
await Bun.write(join(output, "favicon.ico"), Bun.file(join(root, "src-tauri/icons/icon.ico")));
