/** Whether the main window keeps the view it shows when asked to show `next` (`main.ts` `show`). The host asks each
 * time it brings the panel up, also when the panel already shows that view: the first-run setup and the settings are
 * kept as they are (a step, a form being filled in, a backup or restore being followed), while a result or the last
 * answer is drawn again, since it shows the latest one. */
export function sameViewKept(current: string, next: string): boolean {
  return current === next && (next === "onboarding" || next === "settings");
}
