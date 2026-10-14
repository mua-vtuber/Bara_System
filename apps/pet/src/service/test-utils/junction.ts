/** A real directory junction, the link `mklink /J` makes without administrator rights (Windows only). Shared by the
 * tests that prove the updates folder is never entered or written through a link. */
export function junction(link: string, target: string): void {
  const made = Bun.spawnSync(["cmd", "/c", "mklink", "/J", link, target], { stdout: "ignore", stderr: "ignore" });
  if (made.exitCode !== 0) throw new Error(`mklink /J failed: ${made.exitCode}`);
}
