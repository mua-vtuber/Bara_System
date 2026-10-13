/** The module specifier the UI build (`scripts/license-texts.ts`) resolves to the license texts it read from their
 * source files. `license-texts.d.ts` declares the same specifier for the type checker. */
export const LICENSE_TEXTS_MODULE = "bara:license-texts";

/** The license texts the settings screen shows, verbatim. */
export interface LicenseTexts {
  /** The repository root's `LICENSE-EXCEPTION.md`: Bara's additional permission for the Spine combination. */
  baraException: string;
  /** The `LICENSE` file of the bundled `@esotericsoftware/spine-webgl` package. */
  spineRuntimes: string;
}
