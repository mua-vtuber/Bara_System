import { messages } from "./messages.ts";
export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function button(text: string, action: () => void | Promise<void>, className = "button secondary"): HTMLButtonElement {
  const node = element("button", className, text); node.type = "button";
  node.addEventListener("click", () => { void action(); }); return node;
}
export function field(label: string, input: HTMLElement, hint?: string): HTMLLabelElement {
  const node = element("label", "field"); node.append(element("span", "field-label", label), input);
  if (hint) node.append(element("small", "hint", hint)); return node;
}
export function input(type: string, value = "", placeholder = ""): HTMLInputElement {
  const node = element("input", "control"); node.type = type; node.value = value; node.placeholder = placeholder;
  node.autocomplete = type === "password" ? "new-password" : "off"; return node;
}
export function select(options: [string, string][], value: string): HTMLSelectElement {
  const node = element("select", "control");
  for (const [key, label] of options) { const option = element("option", "", label); option.value = key; node.append(option); }
  node.value = value; return node;
}
export type Notice = (message: string, kind?: "info" | "error" | "success") => void;
export function confirmAction(title: string, message: string, action: string): Promise<boolean> {
  return new Promise(resolve => {
    const dialog = element("dialog", "memory-dialog");
    const actions = element("div", "dialog-actions");
    let accepted = false;
    const cancel = button(messages.common.cancel, () => dialog.close());
    actions.append(cancel, button(action, () => { accepted = true; dialog.close(); }, "button primary"));
    dialog.append(element("h2", "", title), element("p", "", message), actions);
    dialog.addEventListener("close", () => { dialog.remove(); resolve(accepted); }, { once: true });
    document.body.append(dialog); dialog.showModal(); cancel.focus();
  });
}
