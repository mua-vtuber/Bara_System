/** The dev entry tag in `index.html` that the UI build swaps for the bundled assets. */
export const DEV_ENTRY_SRC = "/src/ui/main.ts";
export const DEV_ENTRY_TAG = `<script type="module" src="${DEV_ENTRY_SRC}"></script>`;
export const BUNDLED_ENTRY_TAGS = '<link rel="stylesheet" href="./assets/main.css" /><script type="module" src="./assets/main.js"></script>';

function countOf(text: string, part: string): number {
  return text.split(part).length - 1;
}

/** Swap the dev entry tag for the bundled tags. A build that leaves the dev tag in place ships a page
 * that loads nothing, so anything but exactly one exact match, or a leftover dev path, is an error. */
export function rewriteUiEntry(html: string): string {
  const exact = countOf(html, DEV_ENTRY_TAG);
  if (exact !== 1) {
    throw new Error(`index.html must contain ${DEV_ENTRY_TAG} exactly once, found ${exact} exact match(es) and ${countOf(html, DEV_ENTRY_SRC)} reference(s) to ${DEV_ENTRY_SRC}`);
  }
  // A replacer function keeps `$` sequences in the bundled tags literal.
  const rewritten = html.replace(DEV_ENTRY_TAG, () => BUNDLED_ENTRY_TAGS);
  const left = countOf(rewritten, DEV_ENTRY_SRC);
  if (left > 0) throw new Error(`index.html still references ${DEV_ENTRY_SRC} ${left} time(s) after the entry tag was replaced`);
  return rewritten;
}
