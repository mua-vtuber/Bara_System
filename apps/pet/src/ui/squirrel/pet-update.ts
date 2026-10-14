import type { SelfUpdateStatus } from "../../shared/contracts.ts";
import { SELF_UPDATE } from "../../shared/self-update.ts";
import { command, errorMessage, native, request } from "../bridge.ts";
import { element } from "../dom.ts";
import { messages } from "../messages.ts";
import type { PetPress } from "./pet-press.ts";
import { PetUpdateModel } from "./pet-update-model.ts";

/** The pet window's part of its own update (spec 5.3, 5.4, 7): the small update button at the bottom right, shown
 * only while a newer version is offered, which opens the bubble's "install now?" question; the check failure on the
 * notice line; and the new-version notice bubble, recorded as shown only once the host really showed it. The window
 * asks the service every `SELF_UPDATE.statusPollMs`; its first ask of a start begins the service's checks. */
export function mountPetUpdate(app: HTMLElement, parts: { notice(text: string): void; press: PetPress }): void {
  const updateButton = element("button", "pet-update", messages.selfUpdate.buttonGlyph);
  updateButton.type = "button";
  updateButton.hidden = true;
  updateButton.title = messages.selfUpdate.buttonLabel;
  updateButton.setAttribute("aria-label", messages.selfUpdate.buttonLabel);
  app.append(updateButton);
  const model = new PetUpdateModel();
  let offered: string | null = null;
  let announcing = false;
  let announceFailedFor: string | null = null;

  // The button sits beside the pet button, and a press on it is never the pet's click or drag (spec 7).
  updateButton.addEventListener("pointerdown", (event) => { event.stopPropagation(); parts.press.cancel(); });
  updateButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (offered === null) return;
    command<boolean>("show_update_bubble", { phase: "confirm", version: offered })
      .catch((error: unknown) => parts.notice(messages.selfUpdate.openFailed(errorMessage(error))));
  });

  async function announce(version: string): Promise<void> {
    if (announcing || announceFailedFor === version) return;
    announcing = true;
    try {
      // A hidden pet or a bubble in use refuses the notice; it is tried again on a later ask and recorded only once shown.
      if (await command<boolean>("show_update_bubble", { phase: "notice", version })) await request("selfUpdate.acknowledge", { version });
    } catch (error) {
      announceFailedFor = version;
      parts.notice(messages.selfUpdate.announceFailed(errorMessage(error)));
    } finally {
      announcing = false;
    }
  }

  async function poll(): Promise<void> {
    let status: SelfUpdateStatus;
    try { status = await request("selfUpdate.status", {}); }
    catch (error) {
      const text = model.pollFailed(errorMessage(error));
      if (text !== null) parts.notice(text);
      return;
    }
    const step = model.status(status);
    offered = step.buttonVersion;
    updateButton.hidden = offered === null;
    if (step.notice !== null) parts.notice(step.notice);
    if (step.announce !== null) void announce(step.announce);
  }

  if (!native) return;
  void poll();
  window.setInterval(() => { void poll(); }, SELF_UPDATE.statusPollMs);
}
