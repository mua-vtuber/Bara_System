import { baraException, spineRuntimes } from "bara:license-texts";
import { license, repository } from "../../package.json" with { type: "json" };
import { button, element } from "./dom.ts";
import { messages } from "./messages.ts";

/** One license text as the screen shows it: verbatim in its own scrolling box, selectable, reachable with Tab so the
 * keyboard can scroll it, and named for screen readers. */
function licenseText(text: string, label: string): HTMLPreElement {
  const box = element("pre", "license-text", text);
  box.tabIndex = 0; box.setAttribute("role", "region"); box.setAttribute("aria-label", label);
  return box;
}

/** The license popup: Bara's own license in one sentence with the full additional permission for the Spine
 * combination, and the full Spine Runtimes License Agreement, which the agreement asks every redistribution to carry.
 * The texts are read from their source files when the UI is built; the license id and source address come from
 * `package.json`. */
function openLicenses(): void {
  const dialog = element("dialog", "memory-dialog license-dialog");
  const top = element("div", "dialog-top");
  top.append(element("h2", "", messages.licenses.heading), button(messages.common.close, () => dialog.close(), "text-button"));
  dialog.append(
    top,
    element("h3", "license-heading", messages.licenses.baraHeading),
    element("p", "hint", messages.licenses.baraSummary(license, repository.url)),
    licenseText(baraException, messages.licenses.baraTextLabel),
    element("h3", "license-heading", messages.licenses.spineHeading),
    element("p", "hint", messages.licenses.spineSummary),
    licenseText(spineRuntimes, messages.licenses.spineTextLabel),
    element("p", "hint", messages.licenses.otherNotices),
  );
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal();
}

/** The settings screen's last line: who made Bara, its license id, and a button that opens the full license texts. */
export function renderLicenses(): HTMLElement {
  const root = element("p", "settings-details license-settings");
  root.append(
    element("span", "", messages.licenses.credits(license)),
    button(messages.licenses.open, openLicenses, "text-button"),
  );
  return root;
}
