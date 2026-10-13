import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
if (!existsSync(join(root, "resources/runtime/bun.exe"))) throw new Error("먼저 bun run package:runtime 으로 개발용 실행 환경을 준비하세요.");
for (const script of ["build:ui", "build:service"]) {
  const command = Bun.spawn([process.execPath, "run", script], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (await command.exited !== 0) process.exit(1);
}
const server = Bun.serve({ hostname: "127.0.0.1", port: 1420, async fetch(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
  let pathname: string;
  try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response(null, { status: 400 }); }
  const file = resolve(dist, `.${pathname === "/" ? "/index.html" : pathname}`);
  const suffix = relative(dist, file);
  if (suffix.startsWith("..") || isAbsolute(suffix)) return new Response(null, { status: 403 });
  return existsSync(file) ? new Response(Bun.file(file)) : new Response(null, { status: 404 });
} });
const child = Bun.spawn([process.execPath, "run", "tauri", "dev"], { cwd: root, stdout: "inherit", stderr: "inherit", env: {
  ...process.env, BARA_PET_RESOURCES: join(root, "resources"),
  BARA_PET_DATA_DIR: process.env.BARA_PET_DATA_DIR ?? join(root, ".omx", "dev-data"),
} });
const close = () => { child.kill(); server.stop(true); };
process.on("SIGINT", close); process.on("SIGTERM", close);
const status = await child.exited; server.stop(true); process.exitCode = status;
