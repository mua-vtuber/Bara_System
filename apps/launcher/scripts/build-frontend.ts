import { mkdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
const assets = join(dist, "assets");
const tauriIcons = join(root, "src-tauri", "icons");
const rel = relative(root, dist);

if (rel.startsWith("..") || rel === "") {
  throw new Error(`refusing to clean unexpected dist path: ${dist}`);
}

await rm(dist, { recursive: true, force: true });
await mkdir(assets, { recursive: true });
await mkdir(tauriIcons, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "src", "main.ts")],
  outdir: assets,
  target: "browser",
  format: "esm",
  sourcemap: "external",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const html = await Bun.file(join(root, "index.html")).text();
await Bun.write(join(dist, "index.html"), html.replace(
  '<script type="module" src="/src/main.ts"></script>',
  '<link rel="stylesheet" href="./assets/main.css" /><script type="module" src="./assets/main.js"></script>',
));

const dib = Buffer.alloc(48);
dib.writeUInt32LE(40, 0); // BITMAPINFOHEADER
dib.writeInt32LE(1, 4); // width
dib.writeInt32LE(2, 8); // height = XOR bitmap + AND mask
dib.writeUInt16LE(1, 12); // planes
dib.writeUInt16LE(32, 14); // bit count
dib.writeUInt32LE(0, 16); // BI_RGB
dib.writeUInt32LE(4, 20); // image bytes
dib.writeUInt32LE(0, 24);
dib.writeUInt32LE(0, 28);
dib.writeUInt32LE(0, 32);
dib.writeUInt32LE(0, 36);
dib.writeUInt8(47, 40); // blue
dib.writeUInt8(33, 41); // green
dib.writeUInt8(23, 42); // red
dib.writeUInt8(255, 43); // alpha

const ico = Buffer.alloc(22 + dib.length);
ico.writeUInt16LE(0, 0);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico.writeUInt8(1, 6);
ico.writeUInt8(1, 7);
ico.writeUInt8(0, 8);
ico.writeUInt8(0, 9);
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(dib.length, 14);
ico.writeUInt32LE(22, 18);
dib.copy(ico, 22);
await Bun.write(join(tauriIcons, "icon.ico"), ico);
