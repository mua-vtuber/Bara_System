/** Counts runs of one kind of work from the call until each ends, whether it succeeded, failed or was cancelled. The
 * count changes in one place, `track`, whose `finally` ends every run, and it goes up before the work starts, so a
 * caller sees the run at once. Used for installs: the service's `AppStatus.installing` and its `INSTALL_RUNNING`
 * refusals (`src/service/router.ts`), and the main window's install lock (`src/ui/install-lock.ts`). */
export class RunCount {
  private count = 0;

  get running(): boolean {
    return this.count > 0;
  }

  async track<T>(work: () => Promise<T>): Promise<T> {
    this.count++;
    try {
      return await work();
    } finally {
      this.count--;
    }
  }
}
