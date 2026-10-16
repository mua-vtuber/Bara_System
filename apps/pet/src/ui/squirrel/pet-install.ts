import { errorMessage, native, onProgress, request } from "../bridge.ts";
import { messages } from "../messages.ts";
import type { NoticeKind } from "./pet-notice.ts";
import { PET_INSTALL_POLL_MS, PetInstallModel } from "./pet-install-model.ts";

interface NoticeLine { show(kind: NoticeKind, text: string): void; clear(kind: NoticeKind): void }

/** The pet window's part of the install lock: the lasting "설치 중" notice (with the stage, and the download share
 * while models arrive), and whether the pet's click may open the input strip. The window asks the service's `status`
 * when it loads, when it becomes visible again, when an install stage's progress arrives while it knows of no install,
 * and every `PET_INSTALL_POLL_MS` while an install runs, so a reloaded window finds a running install again and the
 * notice ends once the install did. */
export function mountPetInstall(notice: NoticeLine): { readonly installing: boolean } {
  const model = new PetInstallModel();
  let asking = false;
  let lastAsk = Number.NEGATIVE_INFINITY;
  let timer: number | undefined;

  function render(): void {
    const text = model.text;
    if (text === null) notice.clear("install");
    else notice.show("install", text);
  }

  async function ask(): Promise<void> {
    if (asking) return;
    asking = true;
    lastAsk = Date.now();
    window.clearTimeout(timer);
    timer = undefined;
    let failure: string | null;
    try {
      failure = model.status((await request("status", {})).installing);
    } catch (error) {
      failure = model.statusFailed(errorMessage(error));
    } finally {
      asking = false;
    }
    if (failure !== null) notice.show("installNote", failure);
    render();
    if (model.installing) timer = window.setTimeout(() => { void ask(); }, PET_INSTALL_POLL_MS);
  }

  if (native) {
    void onProgress((event) => {
      const step = model.progress(event);
      // Progress of other work can carry the same stage names (the startup check starts the server too), so an ask
      // it causes is made at most once per poll interval.
      if (step === "ask" && Date.now() - lastAsk >= PET_INSTALL_POLL_MS) void ask();
      else if (step === "text") render();
    }).catch((error) => notice.show("listen", messages.pet.listenFailed(errorMessage(error))));
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void ask(); });
    void ask();
  }
  return { get installing() { return model.installing; } };
}
