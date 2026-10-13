import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { launcherView, type LauncherState } from "./status-view.ts";
import "./styles.css";

type ServerStatus = {
  running: boolean;
  pid?: number;
};

const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;
const errorEl = document.querySelector<HTMLParagraphElement>("#error")!;
const openBtn = document.querySelector<HTMLButtonElement>("#open")!;
const restartBtn = document.querySelector<HTMLButtonElement>("#restart")!;
const stopBtn = document.querySelector<HTMLButtonElement>("#stop")!;
const setupActions = document.querySelector<HTMLDivElement>("#setup-actions")!;
const setupKeepBtn = document.querySelector<HTMLButtonElement>("#setup-keep")!;
const setupOllamaBtn = document.querySelector<HTMLButtonElement>("#setup-ollama")!;
const setupLmStudioBtn =
  document.querySelector<HTMLButtonElement>("#setup-lmstudio")!;
const setupNoAiBtn = document.querySelector<HTMLButtonElement>("#setup-noai")!;
const state: LauncherState = { needsSetup: true, running: false, busy: false, progress: "", error: "", hasExistingSettings: false };

function render(): void {
  const view = launcherView(state);
  statusEl.textContent = view.status;
  statusEl.setAttribute("aria-busy", String(state.busy));
  errorEl.textContent = view.error;
  errorEl.hidden = !view.error;
  setupActions.hidden = !state.needsSetup;
  setupKeepBtn.hidden = !view.keepCurrentVisible;
  for (const button of [setupKeepBtn, setupOllamaBtn, setupLmStudioBtn, setupNoAiBtn]) button.disabled = view.setupDisabled;
  openBtn.disabled = view.openDisabled;
  restartBtn.disabled = view.openDisabled;
  stopBtn.disabled = state.busy || !state.running;
}

async function refreshStatus(): Promise<void> {
  state.needsSetup = await invoke<boolean>("setup_needed");
  state.hasExistingSettings = await invoke<boolean>("settings_file_exists");
  const status = await invoke<ServerStatus>("server_status");
  state.running = status.running;
  state.pid = status.pid;
  render();
}

async function runAction(progress: string, action: () => Promise<unknown>): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  state.progress = progress;
  state.error = "";
  render();
  try { await action(); }
  catch (error) { state.error = String(error); }
  finally {
    state.busy = false;
    try { await refreshStatus(); }
    catch { state.error ||= "서버 상태를 확인하지 못했습니다. 런처를 다시 열어 주세요."; }
    render();
  }
}

openBtn.addEventListener("click", () => { void runAction("서버 준비를 확인하고 대시보드를 엽니다…", () => invoke("open_dashboard")); });
restartBtn.addEventListener("click", () => { void runAction("서버를 재시작합니다…", async () => { await invoke("restart_server"); await invoke("open_dashboard"); }); });
stopBtn.addEventListener("click", () => { void runAction("서버를 종료합니다…", () => invoke("stop_server")); });

async function runSetup(profile: "keep" | "ollama" | "lmstudio" | "none"): Promise<void> {
  await runAction("설정과 모델을 준비합니다. 처음에는 몇 분 걸릴 수 있습니다…", async () => {
    await invoke("run_setup", { profile });
    await invoke("open_dashboard");
  });
}

// WP-B2-06R — "keep" sends no explicit AI provider flag; writeSettingsAndMigrateDb
// then preserves the currently configured llm slot instead of applying a default.
setupKeepBtn.addEventListener("click", () => {
  void runSetup("keep");
});

setupOllamaBtn.addEventListener("click", () => {
  void runSetup("ollama");
});

setupLmStudioBtn.addEventListener("click", () => {
  void runSetup("lmstudio");
});

setupNoAiBtn.addEventListener("click", () => {
  void runSetup("none");
});

void listen<string>("launcher-progress", event => {
  state.progress = event.payload;
  if (state.busy) render();
  else statusEl.textContent = event.payload;
});
void listen<string>("launcher-error", event => { state.error = event.payload; render(); });
void refreshStatus().catch(() => { state.error = "런처 연결에 실패했습니다. 앱을 다시 열어 주세요."; render(); });
