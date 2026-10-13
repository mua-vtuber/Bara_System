/** Fails the build if the given executable is not a Windows GUI-subsystem PE file.
 * Guards against a regression where the release exe ships with the console
 * subsystem (3) instead of the GUI subsystem (2), which flashes a console
 * window on every launch including Start Menu and logon autostart.
 */
import { readFile } from "node:fs/promises";
import { IMAGE_SUBSYSTEM_WINDOWS_GUI, readPeHeader } from "./pe-header.ts";

export async function checkNativeExeSubsystem(path: string): Promise<number> {
  const bytes = await readFile(path);
  const { subsystem } = readPeHeader(bytes);
  if (subsystem !== IMAGE_SUBSYSTEM_WINDOWS_GUI) {
    throw new Error(
      `Release executable must use the Windows GUI subsystem (${IMAGE_SUBSYSTEM_WINDOWS_GUI}), ` +
        `but read subsystem ${subsystem} from: ${path}`,
    );
  }
  return subsystem;
}

if (import.meta.main) {
  const path = Bun.argv[2];
  if (!path) {
    process.stderr.write("Usage: bun run scripts/check-native-exe.ts <path-to-exe>\n");
    process.exitCode = 1;
  } else {
    try {
      const subsystem = await checkNativeExeSubsystem(path);
      process.stdout.write(`OK: subsystem=${subsystem} (${path})\n`);
    } catch (error) {
      process.stderr.write((error instanceof Error ? error.message : "Native exe check failed") + "\n");
      process.exitCode = 1;
    }
  }
}
