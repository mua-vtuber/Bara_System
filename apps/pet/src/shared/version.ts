import { version } from "../../package.json" with { type: "json" };

/** This Pet's own release version, read once from `package.json` (the single source of truth) and
 * bundled in at build time by `Bun.build` (`scripts/build-service.ts`), which inlines a
 * `with { type: "json" }` import instead of reading the file at runtime. The import names only
 * `version`, so the bundler keeps that one value and drops the rest of `package.json` (scripts,
 * dependency lists); `tests/service-bundle.test.ts` fails if a whole-object import brings it back.
 * Anything that reports or negotiates this Pet's version -- the MCP `clientInfo.version`
 * (`src/service/mcp.ts`) -- imports this instead of repeating the literal. */
export const PET_VERSION: string = version;
