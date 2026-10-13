import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Resize the supplied artwork with the installed Tauri CLI; preserve its colors, background and transparency. */
export async function buildIcon(root: string): Promise<void> {
  const source = join(root, "art", "squirrel", "icon.png");
  // Tauri uses the first ICO frame as its default window/tray image, including on high-DPI screens.
  const sizes = [256, 128, 64, 48, 32, 24, 16];
  const temporaryRoot = resolve(tmpdir());
  const temporary = await mkdtemp(join(temporaryRoot, "bara-pet-icons-"));
  if (dirname(resolve(temporary)) !== temporaryRoot) throw new Error("Invalid temporary icon directory");
  try {
    const child = Bun.spawn([process.execPath, "run", "tauri", "icon", source, "--output", temporary,
      ...sizes.flatMap(size => ["--png", String(size)])], { cwd: root, stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    if (code !== 0) throw new Error(`Tauri icon generation failed (exit ${code})`);
    const images = await Promise.all(sizes.map(async size => ({
      size, png: Buffer.from(await Bun.file(join(temporary, `${size}x${size}.png`)).arrayBuffer()),
    })));

    // Windows ICO accepts the generated PNG bytes directly; no second image conversion is needed.
    const header = Buffer.alloc(6 + 16 * images.length);
    header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
    let offset = header.length;
    for (const [index, { size, png }] of images.entries()) {
      const at = 6 + index * 16;
      header[at] = size === 256 ? 0 : size; header[at + 1] = header[at];
      header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
      header.writeUInt32LE(png.length, at + 8); header.writeUInt32LE(offset, at + 12);
      offset += png.length;
    }
    const directory = join(root, "src-tauri", "icons");
    await mkdir(directory, { recursive: true });
    await Bun.write(join(directory, "icon.ico"), Buffer.concat([header, ...images.map(image => image.png)]));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
