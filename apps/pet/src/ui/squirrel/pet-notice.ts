/** What a notice on the pet window's notice line reports (design section 8).
 * - `command`: a command of the pet window the host refused (decision D10). A later successful command ends it.
 * - `contract`: a feedback that broke its contract (section 9.1).
 * - `listen`: the window cannot hear the app's events. It lasts, because that stays broken.
 * - `update`: the pet's own update: a failed check (first of a run), a failed notice or update button
 *   (docs/decisions/2026-10-14-pet-self-update-spec.md 5.4).
 * - `install`: an install runs ("설치 중", with its stage or download share). It lasts while the install runs and is
 *   ended by `clear("install")` when the service says the install is over (`pet-install.ts`).
 * - `installNote`: something the install lock said once: the pet's click refused while installing, or the install
 *   state that could not be read.
 * `command`, `contract`, `update` and `installNote` notices pass: the screen ends them after `ui.commandNoticeMs`. */
export type NoticeKind = "command" | "contract" | "listen" | "update" | "install" | "installNote";

/** How a notice looks: `error` for what went wrong, `info` for what is only being told (an install that runs, a click
 * that has to wait for it). `update` is always a failure (its doc above), so it looks like one. */
export type NoticeLook = "error" | "info";

export function noticeLook(kind: NoticeKind): NoticeLook {
  return kind === "install" || kind === "installNote" ? "info" : "error";
}

/** Which notice the line shows. A passing notice covers a lasting one for its time and the lasting one shows again
 * when it ends, so a short failure never hides one that stays; a newer passing notice replaces an older one. Of the two
 * lasting notices, a running install shows before `listen`: the user is in the middle of the install and must see that
 * it still runs, and closing the app to fix `listen` would stop it; `listen` shows again once the install is over. The
 * screen keeps the timer and the element (`pet-view.ts`); this holds only the rules. */
export class NoticeState {
  private listen: string | null = null;
  private install: string | null = null;
  private passing: { kind: NoticeKind; text: string } | null = null;

  /** The kind of the notice `text` shows now, or `null` when the line is hidden. */
  get kind(): NoticeKind | null {
    if (this.passing) return this.passing.kind;
    if (this.install !== null) return "install";
    return this.listen !== null ? "listen" : null;
  }

  /** The text the line shows now, or `null` when it is hidden. */
  get text(): string | null {
    return this.passing?.text ?? this.install ?? this.listen;
  }

  /** Shows `text` as a notice of `kind`. Returns whether it is a passing notice, whose time starts now. */
  show(kind: NoticeKind, text: string): boolean {
    if (kind === "listen") {
      this.listen = text;
      return false;
    }
    if (kind === "install") {
      this.install = text;
      return false;
    }
    this.passing = { kind, text };
    return true;
  }

  /** Ends the notice of `kind`: the passing notice when it is of `kind`, or the install notice (the `listen` notice never
   * ends). Returns whether a passing notice ended, whose timer then stops. */
  clear(kind: NoticeKind): boolean {
    if (kind === "install") {
      this.install = null;
      return false;
    }
    if (this.passing?.kind !== kind) return false;
    this.passing = null;
    return true;
  }

  /** The passing notice's time is over. */
  expire(): void {
    this.passing = null;
  }
}
