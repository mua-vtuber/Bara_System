/** Parse a Windows PE (Portable Executable) header: machine type and subsystem.
 * Shared by CRT DLL verification and the release-exe subsystem check so PE
 * parsing lives in one place.
 */

export interface PeHeader {
  machine: number;
  subsystem: number;
}

/** IMAGE_SUBSYSTEM_WINDOWS_GUI: no console is allocated at process start. */
export const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
/** IMAGE_SUBSYSTEM_WINDOWS_CUI: a console is allocated at process start. */
export const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;

/** IMAGE_FILE_MACHINE_AMD64 */
export const IMAGE_FILE_MACHINE_AMD64 = 0x8664;

/** Reads the machine type and subsystem out of a PE file's headers.
 * Layout (both PE32 and PE32+ share the same offsets used here):
 *   e_lfanew at offset 0x3C points to the "PE\0\0" signature.
 *   The optional header starts at e_lfanew + 24 (after the 4-byte signature
 *   and the 20-byte COFF file header).
 *   Subsystem (u16) sits at optionalHeaderStart + 68 in both PE32 and PE32+
 *   optional headers (Magic, MajorLinkerVersion, ... up through the
 *   Win32VersionValue field all share layout/size between the two formats).
 */
export function readPeHeader(bytes: Uint8Array): PeHeader {
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new Error("Not a valid PE file: missing MZ signature");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const peOffset = view.getUint32(0x3c, true);
  if (peOffset + 24 > bytes.length) {
    throw new Error("Not a valid PE file: truncated before COFF header");
  }
  if (
    bytes[peOffset] !== 0x50 ||
    bytes[peOffset + 1] !== 0x45 ||
    bytes[peOffset + 2] !== 0 ||
    bytes[peOffset + 3] !== 0
  ) {
    throw new Error("Not a valid PE file: missing PE signature");
  }
  const machine = view.getUint16(peOffset + 4, true);
  const optionalHeaderStart = peOffset + 24;
  const subsystemOffset = optionalHeaderStart + 68;
  if (subsystemOffset + 2 > bytes.length) {
    throw new Error("Not a valid PE file: truncated before optional header subsystem field");
  }
  const subsystem = view.getUint16(subsystemOffset, true);
  return { machine, subsystem };
}
