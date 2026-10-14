import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Feedback, ProgressEvent, RpcMethod, RpcOperations, UpdateBubbleEvent } from "../shared/contracts.ts";
import nativeHost from "../shared/native-host.json";
import { errorText } from "./error-text.ts";
import { messages } from "./messages.ts";

export const native = isTauri();
export async function request<M extends RpcMethod>(method: M, params: RpcOperations[M]["params"], id: string = crypto.randomUUID()): Promise<RpcOperations[M]["result"]> {
  if (!native) throw new Error(messages.errors.desktopOnly);
  return invoke("request", { payload: { id, method, params } });
}
export async function command<T = void>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!native) throw new Error(messages.errors.desktopOnly);
  return invoke(name, args);
}
export function onProgress(callback: (event: ProgressEvent) => void): Promise<() => void> {
  return native ? listen<ProgressEvent>("pet-progress", event => callback(event.payload)) : Promise.resolve(() => {});
}
export function onPanel(callback: (mode: string) => void): Promise<() => void> {
  return native ? listen<string>("pet-panel", event => callback(event.payload)) : Promise.resolve(() => {});
}
export function onQuick(callback: (mode: "input" | "question") => void): Promise<() => void> {
  return native ? listen<"input" | "question">("pet-quick", event => callback(event.payload)) : Promise.resolve(() => {});
}
/** The host tells the pet window when the quick input opens (`true`) or closes (`false`); the event name is
 * the contract's (`native-host.json` `contract.quickVisibilityEvent`), shared with the Rust side. */
export function onQuickVisibility(callback: (visible: boolean) => void): Promise<() => void> {
  return native ? listen<boolean>(nativeHost.contract.quickVisibilityEvent, event => callback(event.payload)) : Promise.resolve(() => {});
}
/** The host tells the pet window when the pet is shown (`true`) or hidden (`false`): the tray toggle, the setup's
 * display step and the start in tray-only mode. The page asks for the state at load with `get_pet_visible`; the event
 * name is the contract's (`native-host.json` `contract.petVisibilityEvent`), shared with the Rust side. */
export function onPetVisibility(callback: (visible: boolean) => void): Promise<() => void> {
  return native ? listen<boolean>(nativeHost.contract.petVisibilityEvent, event => callback(event.payload)) : Promise.resolve(() => {});
}
/** The host tells the main window when a tray menu command fails; the payload is the host error, turned
 * into text with `errorMessage`. The event name is the contract's (`native-host.json` `contract.trayErrorEvent`). */
export function onTrayError(callback: (error: unknown) => void): Promise<() => void> {
  return native ? listen<unknown>(nativeHost.contract.trayErrorEvent, event => callback(event.payload)) : Promise.resolve(() => {});
}
export function onFeedback(callback: (feedback: Feedback) => void): Promise<() => void> {
  return native ? listen<Feedback>("pet-feedback", event => callback(event.payload)) : Promise.resolve(() => {});
}
/** The host tells the bubble when its update phase changes (spec 6.1); the event name is the contract's
 * (`native-host.json` `contract.updateBubbleEvent`), shared with the Rust side (`update_bubble.rs`). */
export function onUpdateBubble(callback: (event: UpdateBubbleEvent) => void): Promise<() => void> {
  return native ? listen<UpdateBubbleEvent>(nativeHost.contract.updateBubbleEvent, event => callback(event.payload)) : Promise.resolve(() => {});
}
export function errorMessage(error: unknown): string {
  return errorText(error);
}
