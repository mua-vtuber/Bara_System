import type { HostVault } from "../../src/shared/contracts.ts";

const PROTECT = "Add-Type -AssemblyName System.Security; $value=[Console]::In.ReadToEnd(); $bytes=[Text.Encoding]::UTF8.GetBytes($value); $sealed=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($sealed))";
const UNPROTECT = "Add-Type -AssemblyName System.Security; $value=[Console]::In.ReadToEnd(); $sealed=[Convert]::FromBase64String($value); $bytes=[System.Security.Cryptography.ProtectedData]::Unprotect($sealed,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))";

async function dpapi(script: string, input: string): Promise<string> {
  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true,
  });
  child.stdin.write(input); child.stdin.end();
  const output = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error("Windows DPAPI operation failed");
  return output;
}

/** Test storage holds only actual DPAPI ciphertext. No mock vault or plaintext fallback. */
export class DpapiVault implements HostVault {
  private readonly encrypted = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    const sealed = this.encrypted.get(key);
    return sealed ? dpapi(UNPROTECT, sealed) : null;
  }
  async set(key: string, value: string): Promise<void> { this.encrypted.set(key, await dpapi(PROTECT, value)); }
  async delete(key: string): Promise<void> { this.encrypted.delete(key); }
}
