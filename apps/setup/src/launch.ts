/** Local first-run entry. Keep token-bearing links out of logs and process error messages. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveSetupPaths, type SetupPaths } from "./paths.ts";
import { resolveDashboardLinkOptions, waitForDashboardLink } from "../../memory/src/tools/dashboard-link.ts";

export function setupComplete(paths: Pick<SetupPaths, "settingsPath" | "setupStatePath">): boolean {
  if (!existsSync(paths.settingsPath)) return false;
  try {
    const state = JSON.parse(readFileSync(paths.setupStatePath, "utf8"));
    return state.status === "complete" && typeof state.completedAt === "string";
  } catch { return false; }
}

async function openBrowser(link: string, browserCommand?: string[]): Promise<void> {
  const windows = process.platform === "win32";
  const wsl = Boolean(process.env.WSL_DISTRO_NAME);
  const command = browserCommand ?? (windows || wsl
    ? [windows ? "powershell.exe" : "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", "Start-Process -FilePath ([Console]::In.ReadToEnd().Trim())"]
    : process.platform === "darwin" ? ["open", link] : ["xdg-open", link]);
  const child = Bun.spawn(command, { stdin: windows || wsl ? new Blob([link]) : "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true });
  if (await child.exited !== 0) throw new Error("브라우저를 열지 못했습니다. 같은 명령에 --link를 붙여 인증 링크를 확인하세요.");
}

export async function openDashboardAndWait(server: Pick<Bun.Subprocess, "exited">, link: string, browserCommand?: string[]): Promise<number> {
  try {
    await openBrowser(link, browserCommand);
    console.log("인증된 대시보드를 열었습니다. Ctrl+C로 서버를 종료할 수 있습니다.");
  } catch {
    // Opening a browser is optional once the authenticated server is healthy.
    // Do not stringify spawn errors: they can contain the private link.
    console.error("브라우저를 자동으로 열지 못했습니다. 서버는 계속 실행 중입니다. 다른 터미널에서 같은 실행 명령에 --link를 붙여 인증 링크를 받으세요. Ctrl+C로 서버를 종료할 수 있습니다.");
  }
  return await server.exited;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repoRoot = resolve(import.meta.dir, "../../..");
  const mode = args.includes("--desktop") ? "desktop-windows" : "local";
  const paths = resolveSetupPaths({ mode, repoRoot });
  const linkOnly = args.includes("--link");
  const waitOnly = args.includes("--wait-only");
  if (!linkOnly && !waitOnly && !setupComplete(paths)) {
    console.log("처음 실행하거나 준비가 끝나지 않았습니다. 설정과 모델을 준비합니다.");
    const setup = Bun.spawn([process.execPath, "run", resolve(import.meta.dir, "index.ts"), mode === "desktop-windows" ? "--desktop" : "--local"], {
      cwd: repoRoot, env: { ...process.env, ...paths.env }, stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsHide: true,
    });
    if (await setup.exited !== 0 || !setupComplete(paths)) throw new Error("초기 준비가 끝나지 않았습니다. 위 오류를 해결한 뒤 다시 실행하세요.");
  }
  const options = resolveDashboardLinkOptions(paths.memoryAppDir, { ...process.env, ...paths.env });
  if (linkOnly || waitOnly) {
    const link = await waitForDashboardLink(options);
    if (linkOnly) process.stdout.write(`${link}\n`);
    return;
  }
  console.log("대시보드를 빌드합니다.");
  const build = Bun.spawn([process.execPath, "run", "build:dashboard"], { cwd: paths.memoryAppDir, stdout: "inherit", stderr: "inherit" });
  if (await build.exited !== 0) throw new Error("대시보드 빌드 실패. 오류를 해결한 뒤 다시 실행하세요.");
  console.log("서버와 모델을 준비합니다. 처음 실행할 때는 몇 분 걸릴 수 있습니다.");
  const server = Bun.spawn([process.execPath, "run", "src/index.ts"], {
    cwd: paths.memoryAppDir, env: { ...process.env, ...paths.env }, stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsHide: true,
  });
  const stop = () => { server.kill(); };
  const readyAbort = new AbortController();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const link = await Promise.race([
      waitForDashboardLink(options, { signal: readyAbort.signal }),
      server.exited.then(code => { throw new Error(`서버가 준비 전에 종료됐습니다 (exit ${code}). 위 오류를 확인하세요.`); }),
    ]);
    process.exitCode = await openDashboardAndWait(server, link);
  } finally {
    readyAbort.abort();
    stop();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (import.meta.main) main().catch(() => {
  // Child output already identifies build/setup errors. Never stringify a browser spawn error containing a link.
  console.error("시작 또는 대시보드 연결에 실패했습니다. 위 준비 단계 오류와 설정 경로·포트를 확인한 뒤 재시도하세요.");
  process.exitCode = 1;
});
