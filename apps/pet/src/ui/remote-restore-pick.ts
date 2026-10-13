import type { RestoreListing } from "../shared/contracts.ts";
import { element, field, input } from "./dom.ts";
import { messages } from "./messages.ts";
import { remoteRestoreRows, restoreChoice, type RestoreChoice } from "./remote-restore-model.ts";

export interface RemoteRestorePick { element: HTMLElement; choice(): RestoreChoice; setDisabled(disabled: boolean): void }

/** The "백업에서 시작" option of the remote install (spec 4.1): turning it on lists the backups on this PC. */
export function renderRemoteRestorePick(load: () => Promise<RestoreListing>, describeError: (error: unknown) => string): RemoteRestorePick {
  const root = element("div", "remote-restore");
  const toggle = input("checkbox");
  const status = element("p", "hint");
  const list = element("div", "restore-list"); list.hidden = true;
  const group = `remote-restore-${crypto.randomUUID()}`;
  let selected: string | null = null;
  let generation = 0;
  toggle.addEventListener("change", async () => {
    const mine = ++generation;
    selected = null; list.replaceChildren(); list.hidden = !toggle.checked; delete status.dataset.kind;
    if (!toggle.checked) { status.textContent = ""; return; }
    status.textContent = messages.remoteRestorePick.loading;
    try {
      const rows = remoteRestoreRows(await load());
      if (mine !== generation) return; // switched off (or on again) while the list was loading
      status.textContent = rows.length === 0 ? messages.remoteRestorePick.empty : "";
      for (const row of rows) {
        const radio = input("radio"); radio.name = group; radio.value = row.id;
        radio.addEventListener("change", () => { selected = row.id; });
        const label = element("label", "restore-choice");
        label.append(radio, element("span", "", row.line));
        list.append(label);
      }
    } catch (error) {
      if (mine !== generation) return;
      status.textContent = describeError(error); status.dataset.kind = "error";
    }
  });
  root.append(field(messages.remoteRestorePick.option, toggle, messages.remoteRestorePick.hint), status, list);
  return {
    element: root,
    choice: () => restoreChoice(toggle.checked, selected),
    setDisabled(disabled) { toggle.disabled = disabled; for (const radio of list.querySelectorAll("input")) radio.disabled = disabled; },
  };
}
