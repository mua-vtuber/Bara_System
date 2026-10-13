import { expect, test } from "bun:test";
import { join } from "node:path";
import { checkNativeExeSubsystem } from "../scripts/check-native-exe.ts";
import { IMAGE_FILE_MACHINE_AMD64, IMAGE_SUBSYSTEM_WINDOWS_CUI, IMAGE_SUBSYSTEM_WINDOWS_GUI, readPeHeader } from "../scripts/pe-header.ts";

// Windows-only: reads real system executables to prove the PE parser against
// known-good GUI and console subsystems. SystemRoot is required and never
// guessed: if it is unset, this test fails loudly instead of skipping.
test.skipIf(process.platform !== "win32")("known system executables report the expected PE subsystem", async () => {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("SystemRoot environment variable is required for this test");

  const explorer = join(systemRoot, "explorer.exe");
  const explorerHeader = readPeHeader(await Bun.file(explorer).bytes());
  expect(explorerHeader.subsystem).toBe(IMAGE_SUBSYSTEM_WINDOWS_GUI);
  expect(await checkNativeExeSubsystem(explorer)).toBe(IMAGE_SUBSYSTEM_WINDOWS_GUI);

  const cmd = join(systemRoot, "System32", "cmd.exe");
  const cmdHeader = readPeHeader(await Bun.file(cmd).bytes());
  expect(cmdHeader.subsystem).toBe(IMAGE_SUBSYSTEM_WINDOWS_CUI);
  await expect(checkNativeExeSubsystem(cmd)).rejects.toThrow(String(IMAGE_SUBSYSTEM_WINDOWS_CUI));

  // The Bun executable itself is a console-subsystem binary today; this pins
  // that assumption so a future Bun release flipping it does not go unnoticed.
  const bunHeader = readPeHeader(await Bun.file(process.execPath).bytes());
  expect(bunHeader.machine).toBe(IMAGE_FILE_MACHINE_AMD64);
  expect(bunHeader.subsystem).toBe(IMAGE_SUBSYSTEM_WINDOWS_CUI);
});

test("truncated bytes and files without an MZ signature are rejected", () => {
  expect(() => readPeHeader(new Uint8Array(0))).toThrow();
  expect(() => readPeHeader(new Uint8Array(10))).toThrow();
  const notMz = new Uint8Array(128);
  notMz[0] = 0x00;
  notMz[1] = 0x00;
  expect(() => readPeHeader(notMz)).toThrow("MZ signature");
});

test("a PE signature pointer past the buffer end is rejected instead of reading out of bounds", () => {
  const bytes = new Uint8Array(0x40);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  const view = new DataView(bytes.buffer);
  view.setUint32(0x3c, 0x1000, true); // e_lfanew points far beyond the 64-byte buffer
  expect(() => readPeHeader(bytes)).toThrow();
});

test("a PE signature that is missing PE\\0\\0 magic is rejected", () => {
  const bytes = new Uint8Array(0x60);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  const view = new DataView(bytes.buffer);
  view.setUint32(0x3c, 0x40, true);
  bytes.set([0x50, 0x00, 0x00, 0x00], 0x40); // "P\0\0\0", not "PE\0\0"
  expect(() => readPeHeader(bytes)).toThrow("PE signature");
});

test("checkNativeExeSubsystem fails loud when the target file does not exist", async () => {
  await expect(checkNativeExeSubsystem(join(import.meta.dir, "does-not-exist.exe"))).rejects.toThrow();
});
