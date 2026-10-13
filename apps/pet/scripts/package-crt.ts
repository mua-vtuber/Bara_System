/** Package signed x64 Visual C++ release CRT DLLs beside native and ONNX binaries.
 * App-local copies avoid requiring an administrator-installed VC redist on a fresh PC.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { IMAGE_FILE_MACHINE_AMD64, readPeHeader } from "./pe-header.ts";

export const ESSENTIAL_CRT_DLLS = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "msvcp140_1.dll"] as const;
const ONNX_RELATIVE = "core/node_modules/onnxruntime-node/bin/napi-v6/win32/x64";
const RELEASE_LAYOUT = /[\\/]VC[\\/]Redist[\\/]MSVC[\\/](\d+\.\d+\.\d+)[\\/]x64[\\/]Microsoft\.VC\d+\.CRT$/i;
const NOTICE = (version: string) =>
  `Microsoft Visual C++ x64 release runtime DLLs (Visual Studio redist ${version}) are bundled app-local.\n` +
  "They must be serviced by updating this application installer.\n" +
  "Deployment guidance: https://learn.microsoft.com/en-us/cpp/windows/choosing-a-deployment-method\n";

export interface CrtPackageInfo {
  sourceVersion: string;
  dlls: string[];
  fileVersions: Record<string, string>;
  files: Record<string, string>;
}

function numbered(version: string): number[] { return version.split(".").map(Number); }
export function compareVersions(a: string, b: string): number {
  const left = numbered(a), right = numbered(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

export function validateCrtNames(names: string[]): string[] {
  const dlls = names.filter((name) => /\.dll$/i.test(name)).sort((a, b) => a.localeCompare(b));
  if (dlls.some((name) => !/^[a-z0-9][a-z0-9_.-]*\.dll$/i.test(name))) throw new Error("Invalid CRT DLL filename");
  const normalized = new Set(dlls.map((name) => name.toLowerCase()));
  if (ESSENTIAL_CRT_DLLS.some((name) => !normalized.has(name))) throw new Error("Release CRT is missing an imported DLL");
  if (dlls.some((name) => /(?:vcruntime|msvcp|concrt|vccorlib)\d+(?:_\d+)?d\.dll$/i.test(name)))
    throw new Error("Debug CRT DLLs are not redistributable");
  if (dlls.length < ESSENTIAL_CRT_DLLS.length) throw new Error("Release CRT set is incomplete");
  return dlls;
}

async function latestVersionDir(root: string): Promise<string> {
  const versions = (await readdir(root, { withFileTypes: true }))
    .filter((item) => item.isDirectory() && /^\d+\.\d+\.\d+$/.test(item.name))
    .map((item) => item.name).sort(compareVersions);
  if (!versions.length) throw new Error("Visual Studio release CRT version directory not found");
  return join(root, versions.at(-1)!, "x64");
}

async function selectCrtDir(root: string): Promise<string> {
  const dirs = (await readdir(root, { withFileTypes: true }))
    .filter((item) => item.isDirectory() && /^Microsoft\.VC\d+\.CRT$/i.test(item.name))
    .map((item) => item.name)
    .sort((a, b) => Number(a.match(/VC(\d+)/i)?.[1]) - Number(b.match(/VC(\d+)/i)?.[1]));
  if (!dirs.length) throw new Error("Visual Studio x64 release CRT directory not found");
  return join(root, dirs.at(-1)!);
}

function vswhereInstall(): string {
  const base = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const executable = join(base, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!existsSync(executable)) throw new Error("vswhere.exe is required to locate the release CRT");
  const result = Bun.spawnSync([executable, "-latest", "-products", "*", "-property", "installationPath"],
    { stdout: "pipe", stderr: "pipe" });
  const path = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !path) throw new Error("Visual Studio with MSVC redist is required to build the installer");
  return path;
}

export async function discoverReleaseCrtDir(explicit?: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const supplied = explicit || env.VCToolsRedistDir;
  let root = resolve(supplied || join(vswhereInstall(), "VC", "Redist", "MSVC"));
  if (RELEASE_LAYOUT.test(root)) return root;
  if (/[\\/]x64$/i.test(root)) root = await selectCrtDir(root);
  else if (/[\\/]\d+\.\d+\.\d+$/i.test(root)) root = await selectCrtDir(join(root, "x64"));
  else if (/[\\/]MSVC$/i.test(root)) root = await selectCrtDir(await latestVersionDir(root));
  else throw new Error("CRT source must be a Visual Studio VC/Redist/MSVC release folder");
  if (!RELEASE_LAYOUT.test(root) || /[\\/]debug[\\/]/i.test(root))
    throw new Error("CRT source must be an x64 release redistributable folder");
  return root;
}

function verifyPeX64(bytes: Buffer, name: string): void {
  let header: ReturnType<typeof readPeHeader>;
  try { header = readPeHeader(bytes); }
  catch { throw new Error(`Invalid CRT PE file: ${name}`); }
  if (header.machine !== IMAGE_FILE_MACHINE_AMD64) throw new Error(`CRT DLL is not x64: ${name}`);
}

async function verifyMicrosoftSignatures(dir: string, dlls: string[]): Promise<Record<string, string>> {
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(powershell)) throw new Error("Windows PowerShell is required to verify CRT Authenticode signatures");
  const paths = dlls.map((name) => join(dir, name).replaceAll("'", "''"));
  const quoted = paths.map((path) => `'${path}'`).join(",");
  const script = `$paths=@(${quoted});$result=@(foreach($path in $paths){` +
    `$sig=Get-AuthenticodeSignature -LiteralPath $path;` +
    `$v=[Diagnostics.FileVersionInfo]::GetVersionInfo($path);` +
    `[pscustomobject]@{name=[IO.Path]::GetFileName($path);status=[string]$sig.Status;subject=[string]$sig.SignerCertificate.Subject;version=[string]$v.FileVersion}` +
    `});ConvertTo-Json -InputObject $result -Compress -Depth 3`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  // Codex/PowerShell 7 can prepend incompatible modules to PSModulePath.
  // Force Windows PowerShell's own signed Security module for this process.
  const systemModules = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "Modules");
  const child = Bun.spawnSync([powershell, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, PSModulePath: systemModules } });
  if (child.exitCode !== 0) throw new Error("CRT Authenticode verification failed");
  let rows: Array<{ name: string; status: string; subject: string; version: string }>;
  try { rows = JSON.parse(child.stdout.toString()) as typeof rows; }
  catch { throw new Error("CRT Authenticode results could not be parsed"); }
  if (!Array.isArray(rows) || rows.length !== dlls.length) throw new Error("CRT Authenticode results are incomplete");
  const versions: Record<string, string> = {};
  for (const row of rows) {
    if (!dlls.includes(row.name) || row.status !== "Valid" ||
        !/(?:^|,)\s*O=Microsoft Corporation(?:,|$)/.test(row.subject) ||
        !/^14\.\d+\.\d+\.\d+$/.test(row.version))
      throw new Error(`CRT DLL is not a valid Microsoft release file: ${row.name} (${row.status || "signature unavailable"}; ${row.version || "version unavailable"})`);
    versions[row.name] = row.version;
  }
  return versions;
}

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

export async function packageCrt(args: { resourceDir: string; nativeOnly?: boolean; sourceDir?: string; updateManifest?: boolean }): Promise<CrtPackageInfo> {
  if (process.platform !== "win32") throw new Error("App-local CRT packaging requires Windows");
  const resourceDir = resolve(args.resourceDir);
  const sourceDir = await discoverReleaseCrtDir(args.sourceDir);
  const sourceVersion = sourceDir.match(RELEASE_LAYOUT)![1]!;
  const dlls = validateCrtNames(await readdir(sourceDir));
  const versions = await verifyMicrosoftSignatures(sourceDir, dlls);
  const onnxDir = join(resourceDir, ONNX_RELATIVE);
  if (!args.nativeOnly && !existsSync(onnxDir)) throw new Error("Packaged ONNX runtime is required before CRT staging");
  const runtimeDir = join(resourceDir, "runtime");
  await mkdir(runtimeDir, { recursive: true });
  const files: Record<string, string> = {};
  for (const name of dlls) {
    const bytes = await readFile(join(sourceDir, name));
    verifyPeX64(bytes, name);
    const digest = sha256(bytes);
    await copyFile(join(sourceDir, name), join(runtimeDir, name));
    files[`runtime/${name}`] = digest;
    if (!args.nativeOnly) {
      await copyFile(join(sourceDir, name), join(onnxDir, name));
      files[`${ONNX_RELATIVE}/${name}`] = digest;
    }
  }
  const notice = NOTICE(sourceVersion);
  await writeFile(join(runtimeDir, "CRT-NOTICE.txt"), notice);
  files["runtime/CRT-NOTICE.txt"] = sha256(Buffer.from(notice));
  if (!args.nativeOnly) {
    await writeFile(join(onnxDir, "CRT-NOTICE.txt"), notice);
    files[`${ONNX_RELATIVE}/CRT-NOTICE.txt`] = sha256(Buffer.from(notice));
  }
  const info: CrtPackageInfo = { sourceVersion, dlls, fileVersions: versions, files };
  if (!args.nativeOnly && args.updateManifest !== false) {
    const manifestPath = join(resourceDir, "payload-manifest.json");
    let manifest: Record<string, unknown>;
    try { manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>; }
    catch { throw new Error("Existing runtime manifest is required for standalone CRT staging"); }
    if (manifest.schemaVersion !== 1 || !manifest.files || typeof manifest.files !== "object")
      throw new Error("Existing runtime manifest is invalid");
    manifest.files = { ...(manifest.files as Record<string, string>), ...files };
    manifest.vcRuntime = { sourceVersion, dlls, fileVersions: versions, deployment: "app-local" };
    const temporary = `${manifestPath}.crt.tmp`;
    await writeFile(temporary, JSON.stringify(manifest, null, 2));
    await rename(temporary, manifestPath);
  }
  return info;
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, options: {
      "native-only": { type: "boolean" }, resources: { type: "string" }, "source-dir": { type: "string" },
    } });
    const info = await packageCrt({ resourceDir: values.resources || join(import.meta.dir, "..", "resources"),
      nativeOnly: values["native-only"], sourceDir: values["source-dir"] });
    process.stdout.write(JSON.stringify({ sourceVersion: info.sourceVersion, dlls: info.dlls }) + "\n");
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : "CRT packaging failed") + "\n");
    process.exitCode = 1;
  }
}
