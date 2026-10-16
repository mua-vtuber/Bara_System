import { RunCount } from "../shared/run-count.ts";

/** The main window's install lock: while an install started from this window's screen runs ("이 PC에 준비하기", or a
 * remote install, `settings.ts` `renderConnection`), that screen stays as it is, so its progress and its "준비 중단"
 * button stay visible and working. The tray's "설정", the pet's menu, the notebook's tabs and the result bubble then
 * bring the window up without switching it (`main.ts` `show`), and the setup's "나중에 하기" waits (`onboarding.ts`).
 *
 * It follows this window's own install request, not the service's `status`: it exists to keep the screen that shows
 * the install. A window reloaded during an install has no such screen any more; what cannot work before the install is
 * done is refused by the service itself (`INSTALL_RUNNING`), whichever window asks. `renderConnection` runs its install
 * request under `installLock.track`, which ends before the screen goes on to the next step. */
export const installLock = new RunCount();
