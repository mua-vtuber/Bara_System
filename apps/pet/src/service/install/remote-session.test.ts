import { expect, test } from "bun:test";
import { scpLocalPath } from "./remote-session.ts";

// The Tauri host hands the service its resource folder in Windows' verbatim form (`\\?\C:\...`). scp reads any
// argument with a colon as `host:path`, so a verbatim local path made it try a host named `\\?\C` and exit 255
// before connecting (A1 migration, 2026-10-09).
test("a verbatim drive path becomes a plain drive path for scp on Windows", () => {
  expect(scpLocalPath("\\\\?\\C:\\Users\\example\\AppData\\Local\\Bara Pet\\resources\\server-source.tar.gz", "win32"))
    .toBe("C:\\Users\\example\\AppData\\Local\\Bara Pet\\resources\\server-source.tar.gz");
});

test("a verbatim UNC path becomes a plain UNC path for scp on Windows", () => {
  expect(scpLocalPath("\\\\?\\UNC\\nas\\share\\backup.tar.gz", "win32")).toBe("\\\\nas\\share\\backup.tar.gz");
});

test("plain Windows paths and non-Windows paths are passed through unchanged", () => {
  expect(scpLocalPath("C:\\Users\\example\\file.tar.gz", "win32")).toBe("C:\\Users\\example\\file.tar.gz");
  expect(scpLocalPath("\\\\nas\\share\\file.tar.gz", "win32")).toBe("\\\\nas\\share\\file.tar.gz");
  expect(scpLocalPath("/home/bara/file.tar.gz", "linux")).toBe("/home/bara/file.tar.gz");
});
