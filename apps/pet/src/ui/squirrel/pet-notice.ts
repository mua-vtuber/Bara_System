/** What a notice on the pet window's notice line reports (design section 8).
 * - `command`: a command of the pet window the host refused (decision D10). A later successful command ends it.
 * - `contract`: a feedback that broke its contract (section 9.1).
 * - `listen`: the window cannot hear the app's events. It lasts, because that stays broken.
 * `command` and `contract` notices pass: the screen ends them after `ui.commandNoticeMs`. */
export type NoticeKind = "command" | "contract" | "listen";

/** Which notice the line shows. A passing notice covers the lasting one for its time and the lasting one shows again
 * when it ends, so a short failure never hides one that stays; a newer passing notice replaces an older one. The
 * screen keeps the timer and the element (`pet-view.ts`); this holds only the rules. */
export class NoticeState {
  private lasting: string | null = null;
  private passing: { kind: NoticeKind; text: string } | null = null;

  /** The text the line shows now, or `null` when it is hidden. */
  get text(): string | null {
    return this.passing?.text ?? this.lasting;
  }

  /** Shows `text` as a notice of `kind`. Returns whether it is a passing notice, whose time starts now. */
  show(kind: NoticeKind, text: string): boolean {
    if (kind === "listen") {
      this.lasting = text;
      return false;
    }
    this.passing = { kind, text };
    return true;
  }

  /** Ends the passing notice when it is of `kind` (a lasting notice never ends). Returns whether one ended. */
  clear(kind: NoticeKind): boolean {
    if (this.passing?.kind !== kind) return false;
    this.passing = null;
    return true;
  }

  /** The passing notice's time is over. */
  expire(): void {
    this.passing = null;
  }
}
