import type { BackupResult, ConnectionMode, ProgressDetail, ProgressStage, PublicSettings, RestoreEntry, RestoreResult, ServerUpdateStatus, TunnelPortNotice,
  SshConnection, UpdateStatus } from "../shared/contracts.ts";
import { CORE_DEFAULT_PORT } from "../shared/contracts.ts";
import { renderAiSettings } from "./ai-settings.ts";
import { attachOrder, JobFollower, type JobPorts } from "./backup-jobs.ts";
import { command, errorMessage, native, onProgress, request } from "./bridge.ts";
import { button, confirmAction, element, field, input, select, type Notice } from "./dom.ts";
import { hostErrorCode } from "./error-text.ts";
import { installLock } from "./install-lock.ts";
import { messages } from "./messages.ts";
import { readOnboarding, startStep, type OnboardingStep } from "./onboarding-model.ts";
import { elapsedText, entryLine, lastRestoreText, RESTORE_UNSTOPPABLE_STAGES, restoreDoneText } from "./restore-model.ts";
import { renderLicenses } from "./licenses.ts";
import { renderRemoteRestorePick } from "./remote-restore-pick.ts";
import { downloadBar, downloadText } from "./progress-text.ts";
import { confirmConnection, connectionCredential, enrollmentConnected, leaveSetup, readServerUpdate, serverUpdateReadNotice, serverUpdateText, stopSetup, tunnelPortText, updateNoticeText,
  type SetupCancellers } from "./settings-helpers.ts";

/** Where memories are kept: this PC, a new external server, or an existing Bara. `done` runs once the chosen
 * storage is connected. Used by the settings screen and by the first-run setup's first step. */
export interface ConnectionView {
  element: HTMLElement; populate(value: PublicSettings): void; dispose(): void;
  /** Shows (or hides) the line about an update a previous start left unfinished (`status.update`). */
  showUpdate(update: UpdateStatus | null): void;
  /** Shows (or hides) the line about the remote server's update or dev build (`status.serverUpdate`). */
  showServerUpdate(update: ServerUpdateStatus | null): void;
  /** Shows (or hides) the line about the remote tunnel not being on its preferred local port (`status.tunnelPort`). */
  showTunnelPort(notice: TunnelPortNotice | null): void;
}

export function renderConnection(notice: Notice, done: () => void, compact = false): ConnectionView {
  const root = element("div", "connection-setup");
  let live = true; let busy = false; let operation = ""; let mode: ConnectionMode = "local"; let awaitingSsh = false;
  let verifiedFingerprint = ""; let enrollmentTimer: ReturnType<typeof setTimeout> | undefined;
  const intro = element("div", "composer-intro");
  intro.append(element(compact ? "h2" : "h1", "", messages.settings.heading));
  if (!compact) intro.append(element("p", "muted", messages.settings.intro));
  const updateLine = element("p", "action-status"); updateLine.hidden = true; updateLine.dataset.kind = "error";
  const serverLine = element("p", "action-status"); serverLine.hidden = true;
  const showServerLine = (update: ServerUpdateStatus | null) => {
    const line = serverUpdateText(update);
    serverLine.textContent = line?.text ?? ""; serverLine.hidden = line === null;
    if (line?.error) serverLine.dataset.kind = "error"; else delete serverLine.dataset.kind;
  };
  const tunnelLine = element("p", "action-status"); tunnelLine.hidden = true; tunnelLine.dataset.kind = "error";
  const showTunnelLine = (text: string | null) => { tunnelLine.textContent = text ?? ""; tunnelLine.hidden = text === null; };
  // The line needs both answers (`status` and the saved settings), which arrive in either order.
  let unfinishedUpdate: UpdateStatus | null = null; let savedMode: ConnectionMode | null = null;
  const showUpdateLine = () => {
    const text = updateNoticeText(unfinishedUpdate, savedMode);
    updateLine.textContent = text ?? ""; updateLine.hidden = text === null;
  };
  const choices = element("div", "install-choices");
  const details = element("details", "connection-details");
  details.append(element("summary", "", messages.settings.connectionDetails));
  const local = element("section", "setup-route");
  local.append(element("p", "", messages.settings.localDescription), element("p", "hint", messages.settings.localRequirements));
  const remote = element("section", "setup-route"); remote.hidden = true;
  remote.append(element("p", "", messages.settings.remoteDescription));
  const restorePick = renderRemoteRestorePick(() => request("backup.list", { scope: "remote-install" }), errorMessage);
  remote.append(restorePick.element);
  const existing = element("section", "setup-route"); existing.hidden = true;
  const url = input("url", "", messages.settings.serverUrlPlaceholder);
  const token = input("password", "", messages.settings.connectionPlaceholder);
  const tunnel = input("checkbox");
  existing.append(field(messages.settings.serverAddress, url), field(messages.settings.connectionInfo, token, messages.settings.enrollmentHint), field(messages.settings.sshConnection, tunnel));
  const sshFields = element("div", "ssh-fields"); sshFields.hidden = true;
  const sshHost = input("text", "", messages.settings.hostPlaceholder);
  const sshUser = input("text", "", messages.settings.userPlaceholder);
  const sshPort = input("number", "22"); sshPort.min = "1"; sshPort.max = "65535";
  const serverPort = input("number", String(CORE_DEFAULT_PORT)); serverPort.min = "1"; serverPort.max = "65535";
  const keyPath = input("text", "", messages.settings.keyPlaceholder);
  const keyRow = element("div", "input-with-button");
  keyRow.append(keyPath, button(messages.settings.findKey, async () => { try { const selected = await command<string | null>("choose_key_file"); if (selected) keyPath.value = selected; } catch (error) { notice(errorMessage(error), "error"); } }));
  const fingerprint = element("p", "fingerprint");
  const trust = input("checkbox");
  const trustField = field(messages.settings.fingerprintTrust, trust); trustField.hidden = true;
  for (const control of [sshHost, sshPort, sshUser, keyPath]) control.addEventListener("input", () => { verifiedFingerprint = ""; trust.checked = false; trustField.hidden = true; fingerprint.textContent = ""; });
  function ssh(): SshConnection {
    return { host: sshHost.value.trim(), user: sshUser.value.trim(), port: Number(sshPort.value), keyPath: keyPath.value.trim(),
      serverPort: Number(serverPort.value), ...(verifiedFingerprint && trust.checked ? { fingerprint: verifiedFingerprint } : {}) };
  }
  const inspect = button(messages.settings.inspectServer, async () => {
    await run(async id => {
      notice(messages.settings.preparingSsh);
      awaitingSsh = true;
      try { await command("ensure_ssh"); } finally { awaitingSsh = false; }
      const result = await request("ssh.inspect", { ssh: ssh() }, id);
      verifiedFingerprint = result.fingerprint; fingerprint.textContent = `${result.keyType}\n${result.fingerprint}`;
      trust.checked = result.known; trustField.hidden = false;
      notice(result.known ? messages.settings.knownServer : messages.settings.verifyFingerprint);
    });
  });
  sshFields.append(field(messages.settings.hostLabel, sshHost), field(messages.settings.userLabel, sshUser), field(messages.settings.sshPortLabel, sshPort), field(messages.settings.keyLabel, keyRow), field(messages.settings.serverPortLabel, serverPort), inspect, fingerprint, trustField);
  const start = button(messages.settings.prepareLocal, install, "button primary full");
  const cancellers: SetupCancellers = { ssh: () => command("cancel_ensure_ssh"), operation: requestId => request("operation.cancel", { requestId }).then(() => {}) };
  const reportCancelFailure = (error: unknown) => notice(errorMessage(error), "error");
  const cancel = button(messages.settings.stopSetup, () => stopSetup(awaitingSsh, operation, cancellers, reportCancelFailure)); cancel.hidden = true;
  const progress = element("div", "setup-progress"); progress.setAttribute("role", "status");
  // Byte progress sits outside the live status, which would otherwise announce every update; the stage text
  // above it changes (and is announced) only when the stage does.
  const download = element("div", "setup-download"); download.hidden = true;
  const downloadLine = element("p", "hint");
  const downloadMeter = element("progress", "setup-download-bar"); downloadMeter.setAttribute("aria-label", messages.downloadProgress.barLabel);
  download.append(downloadLine, downloadMeter);
  let shownStage: ProgressStage | "" = "";
  function showDownload(stage?: ProgressStage, detail?: ProgressDetail) {
    const text = stage ? downloadText(stage, detail) : null;
    const bar = stage ? downloadBar(stage, detail) : null;
    download.hidden = text === null; downloadLine.textContent = text ?? "";
    downloadMeter.hidden = !bar; if (bar) { downloadMeter.max = bar.max; downloadMeter.value = bar.value; }
  }
  const connectActions = element("div", "stack-actions"); connectActions.append(start, cancel);
  const routeButtons = new Map<ConnectionMode, HTMLButtonElement>();
  for (const [key, title, description] of [
    ["local", messages.settings.localChoice, messages.settings.localChoiceDescription], ["remote", messages.settings.remoteChoice, messages.settings.remoteChoiceDescription], ["existing", messages.settings.existingChoice, messages.settings.existingChoiceDescription],
  ] as const) {
    const choice = button("", () => { choose(key); if (compact) details.open = true; }, "install-choice");
    choice.append(element("strong", "", title), element("span", "", description));
    routeButtons.set(key, choice); choices.append(choice);
  }
  function choose(next: ConnectionMode) {
    if (busy) return; mode = next;
    local.hidden = mode !== "local"; remote.hidden = mode !== "remote"; existing.hidden = mode !== "existing";
    sshFields.hidden = mode !== "remote" && !(mode === "existing" && tunnel.checked);
    start.textContent = mode === "local" ? messages.settings.prepareLocal : mode === "remote" ? messages.settings.installRemote : messages.settings.connectExisting;
    for (const [key, choice] of routeButtons) choice.setAttribute("aria-pressed", String(mode === key));
  }
  tunnel.addEventListener("change", () => choose(mode));
  async function run(work: (id: string) => Promise<void>) {
    if (busy) return; busy = true; operation = crypto.randomUUID(); restorePick.setDisabled(true); start.disabled = true; inspect.disabled = true; cancel.hidden = false;
    shownStage = ""; showDownload();
    try { await work(operation); }
    catch (error) { if (live) { notice(errorMessage(error), "error"); progress.textContent = errorMessage(error); } }
    finally { busy = false; operation = ""; if (live) { restorePick.setDisabled(false); start.disabled = false; inspect.disabled = false; cancel.hidden = true; showDownload(); } }
  }
  async function install() {
    await run(async id => {
      if (mode === "local") {
        // The lock keeps this screen while the install runs and ends before `done` moves on (`install-lock.ts`).
        const result = await installLock.track(() => request("install.local", {}, id)); if (live) { notice(result.message, "success"); done(); }
      } else if (mode === "remote") {
        if (!verifiedFingerprint || !trust.checked) throw new Error(messages.settings.verifyBeforeInstall);
        const choice = restorePick.choice();
        if ("error" in choice) throw new Error(choice.error);
        const result = await installLock.track(() => request("install.remote", { ssh: ssh(), acceptedFingerprint: verifiedFingerprint, ...choice }, id));
        // Connecting to a server the Pet installed earlier first brings it to this Pet's server version (spec 5.3). An
        // update that failed but left the server serving does not fail the install, so its cause is told here, read
        // before `done` can close this view. A status that cannot be read is told as an error with its cause, so a failed
        // update never looks like success.
        const status = request("status", {});
        const update = await readServerUpdate(() => status, errorMessage);
        // A status that cannot be read is already told above as the update notice's cause.
        const tunnelText = await status.then(value => tunnelPortText(value.tunnelPort), () => null);
        if (live) {
          notice(result.message, "success");
          showServerLine(update.ok ? update.update : null);
          showTunnelLine(tunnelText);
          if (tunnelText !== null) notice(tunnelText, "info");
          const failure = serverUpdateReadNotice(update);
          if (failure !== null) notice(failure, "error");
          done();
        }
      } else {
        if (tunnel.checked && (!verifiedFingerprint || !trust.checked)) throw new Error(messages.settings.verifyBeforeInstall);
        await request("settings.save", { connection: { mode: "existing", baseUrl: url.value.trim(), ...(tunnel.checked ? { ssh: ssh() } : {}) }, ...connectionCredential(token.value) });
        const saved = await request("settings.get", {});
        token.value = "";
        if (saved.hasToken) {
          await confirmConnection(testConnection);
          if (live) { notice(messages.settings.connected, "success"); done(); }
        } else {
          const result = await request("enrollment.start", {}); if (live) { progress.textContent = result.message; notice(result.message); }
          if (await enrollmentConnected(result, testConnection)) enrollmentFinished(); else pollEnrollment();
        }
      }
    });
  }
  const testConnection = () => request("connection.test", {});
  /** Reached only through `enrollmentConnected`, which runs `connection.test` on an approval before the
   * screen reports success (an outdated server can still approve enrollment). */
  function enrollmentFinished(): void {
    if (live) { notice(messages.settings.connectionApproved, "success"); done(); }
  }
  function pollEnrollment() {
    if (!live) return;
    enrollmentTimer = setTimeout(async () => {
      try {
        const result = await request("enrollment.poll", {}); if (!live) return;
        progress.textContent = result.message;
        if (await enrollmentConnected(result, testConnection)) enrollmentFinished();
        else if (result.state === "pending") pollEnrollment();
        else notice(result.message, "error");
      } catch (error) { if (live) notice(errorMessage(error), "error"); }
    }, 3_000);
  }

  root.append(intro, updateLine, serverLine, tunnelLine, choices);
  if (compact) {
    details.append(local, remote, existing, sshFields, connectActions, progress, download);
    root.append(details);
  } else root.append(local, remote, existing, sshFields, connectActions, progress, download);
  choose("local");
  let stop: (() => void) | undefined;
  void onProgress(event => {
    if (!live || event.requestId !== operation) return;
    if (event.stage !== shownStage) { shownStage = event.stage; const text = messages.progress[event.stage]; progress.textContent = text; notice(text); }
    showDownload(event.stage, event.detail);
  }).then(fn => { if (live) stop = fn; else fn(); });
  return {
    element: root,
    populate(value) {
      savedMode = value.connection.mode; showUpdateLine();
      choose(value.connection.mode); url.value = value.connection.baseUrl; token.placeholder = value.hasToken ? messages.settings.savedConnection : token.placeholder;
      if (value.connection.ssh) { const saved = value.connection.ssh; sshHost.value = saved.host; sshUser.value = saved.user; sshPort.value = String(saved.port); keyPath.value = saved.keyPath; serverPort.value = String(saved.serverPort ?? CORE_DEFAULT_PORT); verifiedFingerprint = saved.fingerprint ?? ""; tunnel.checked = true; trust.checked = !!verifiedFingerprint; trustField.hidden = !verifiedFingerprint; fingerprint.textContent = verifiedFingerprint; choose(value.connection.mode); }
    },
    dispose() { live = false; stop?.(); if (enrollmentTimer) clearTimeout(enrollmentTimer); void leaveSetup(awaitingSsh, cancellers, reportCancelFailure); },
    showUpdate(update) { unfinishedUpdate = update; showUpdateLine(); },
    showServerUpdate: showServerLine,
    showTunnelPort(value) { showTunnelLine(tunnelPortText(value)); },
  };
}

/** "Start Bara when I sign in": the Windows registration and the saved setting change together, and the
 * registration is put back if saving fails. Applies to the whole app, never to the memory server alone. */
export interface AutoStartView { element: HTMLElement; populate(value: PublicSettings): void; dispose(): void }

/** "입력한 메모 바로 정리": the saved on/off preference plus the last result the Pet's detached cleanup recorded,
 * so a cleanup that failed after the save is still seen here. */
export interface CleanupOnSaveView { element: HTMLElement; populate(value: PublicSettings): void; dispose(): void }

export function renderCleanupOnSave(notice: Notice): CleanupOnSaveView {
  let live = true;
  const toggle = input("checkbox");
  const last = element("p", "hint"); last.hidden = true;
  const lastFailure = element("p", "hint"); lastFailure.hidden = true;
  const showLast = () => request("cleanup.onSaveStatus", {}).then(report => {
    if (!live) return;
    const { latest, lastFailure: failure } = report;
    last.hidden = latest === null;
    if (latest) last.textContent = messages.settings.cleanupOnSaveLast(messages.settings.cleanupOnSaveOutcome[latest.outcome], latest.detail, new Date(latest.at).toLocaleString());
    // The newest failure stays visible after a later success; it is not repeated when it is the latest result.
    lastFailure.hidden = failure === null || failure.at === latest?.at && failure.memoryId === latest?.memoryId;
    if (failure) lastFailure.textContent = messages.settings.cleanupOnSaveLastFailure(failure.detail, new Date(failure.at).toLocaleString());
  }).catch(error => { if (live) notice(errorMessage(error), "error"); });
  toggle.addEventListener("change", async () => {
    const desired = toggle.checked;
    toggle.disabled = true;
    try { await request("settings.save", { cleanupOnSave: desired }); }
    catch (error) { toggle.checked = !desired; notice(errorMessage(error), "error"); }
    finally { toggle.disabled = false; }
  });
  const root = element("div", "preferences");
  root.append(element("h2", "", messages.settings.cleanupOnSaveHeading), field(messages.settings.cleanupOnSavePreference, toggle, messages.settings.cleanupOnSaveHelp), last, lastFailure);
  return {
    element: root,
    populate(value) { toggle.checked = value.cleanupOnSave; void showLast(); },
    dispose() { live = false; },
  };
}

export function renderAutoStart(notice: Notice): AutoStartView {
  let live = true;
  const autoStart = input("checkbox");
  autoStart.addEventListener("change", async () => {
    const desired = autoStart.checked;
    autoStart.disabled = true;
    let previous = !desired;
    try {
      previous = await command<boolean>("get_autostart");
      await command("set_autostart", { enabled: desired });
      try { await request("settings.save", { autoStart: desired }); }
      catch (error) { await command("set_autostart", { enabled: previous }); throw error; }
      notice(desired ? messages.settings.autoStarted : messages.settings.autoStartOff, "success");
    } catch (error) {
      try { autoStart.checked = await command<boolean>("get_autostart"); }
      catch { autoStart.checked = previous; }
      notice(errorMessage(error), "error");
    } finally { autoStart.disabled = false; }
  });
  const root = element("div", "preferences"); root.append(field(messages.settings.autoStartPreference, autoStart));
  return {
    element: root,
    populate(value) {
      autoStart.checked = value.autoStart;
      // Windows' own registration wins over the saved setting when they disagree.
      void command<boolean>("get_autostart").then(actual => { if (live) autoStart.checked = actual; })
        .catch(error => { if (live) notice(errorMessage(error), "error"); });
    },
    dispose() { live = false; },
  };
}

/** "백업 만들기": exports the memories kept on this PC to a new folder under the host's backup folder, while the
 * memory server keeps running. "백업에서 되살리기" lists the backups the service knows (`backup.list`), and after the
 * user picks one and confirms, restores this PC's memories from it (`backup.restore`, by the backup's opaque id),
 * showing the stage and the time so far, with "중단" until the switch begins. Only a local store can be backed up or
 * restored from here, so the buttons wait for the saved settings and stay off for a remote or existing server.
 * Both run in the service, not in this screen (`backup-jobs.ts`): leaving the screen ends only its wait, the screen
 * opened again joins a backup or restore still running and shows its stage, time and outcome, or how one that ended
 * meanwhile went, and only "중단" stops one. */
export interface BackupView { element: HTMLElement; populate(value: PublicSettings): void; dispose(): void }

export function renderBackup(notice: Notice): BackupView {
  let live = true, allowed = !native, restoreStage: ProgressStage | null = null;
  let elapsedTimer: ReturnType<typeof setInterval> | undefined; let stopProgress: (() => void) | undefined;
  let entries: RestoreEntry[] = [];
  const root = element("section", "preferences backup-settings");
  const heading = element("h2", "", messages.backup.heading); heading.id = `backup-heading-${crypto.randomUUID()}`;
  root.setAttribute("aria-labelledby", heading.id);
  const blocked = element("p", "hint", messages.backup.notLocal); blocked.hidden = true;
  const make = button(messages.backup.make, () => run(), "button primary"); make.disabled = !allowed;
  const stop = button(messages.backup.stop, () => cancel()); stop.hidden = true;
  const open = button(messages.backup.openFolder, () => openFolder()); open.hidden = true;
  const restoreOpen = button(messages.restore.open, () => openList()); restoreOpen.disabled = !allowed;
  const status = element("p", "action-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  // The time so far changes every second, so it is outside the live status line and not read out each time.
  const elapsed = element("p", "hint"); elapsed.hidden = true;
  const actions = element("div", "stack-actions"); actions.append(make, stop, open, restoreOpen);
  const panel = element("div", "restore-panel"); panel.hidden = true;
  const last = element("p", "hint"); last.hidden = true;
  const choices = element("fieldset", "restore-choices");
  const legend = element("legend", "field-label", messages.restore.legend);
  const list = element("div", "restore-list");
  choices.append(legend, list);
  const restoreStart = button(messages.restore.start, () => startRestore(), "button primary"); restoreStart.disabled = true;
  const restoreClose = button(messages.restore.close, () => closeList());
  const restoreStop = button(messages.restore.stop, () => cancelRestore()); restoreStop.hidden = true;
  const panelActions = element("div", "stack-actions"); panelActions.append(restoreStart, restoreClose, restoreStop);
  panel.append(last, choices, panelActions);
  const help = element("details", "backup-help");
  help.append(element("summary", "", messages.backup.help), element("p", "hint", messages.backup.description));
  root.append(heading, blocked, actions, help, panel, status, elapsed);
  function show(text: string, kind?: "error" | "success") {
    status.textContent = text;
    if (kind) status.dataset.kind = kind; else delete status.dataset.kind;
  }
  const ports: JobPorts = {
    request: (method, params, id) => request(method, params as never, id),
    newId: () => crypto.randomUUID(), now: () => Date.now(),
  };
  const exporting = new JobFollower<BackupResult>("export", ports, {
    running() { open.hidden = true; sync(); show(messages.backup.running); },
    stage() {},
    done(result) {
      const text = messages.backup.done(result.folderName, result.memories, result.attachments);
      show(text, "success"); notice(text, "success"); open.hidden = false;
    },
    failed(error) {
      const text = hostErrorCode(error) === "CANCELLED" ? messages.backup.cancelled : errorMessage(error);
      show(text, "error"); notice(text, "error");
    },
    ended() { sync(); },
  });
  const restoring = new JobFollower<RestoreResult>("restore", ports, {
    running(startedAt) {
      restoreStage = null;
      const tick = () => { elapsed.textContent = elapsedText(startedAt, Date.now()); };
      if (elapsedTimer) clearInterval(elapsedTimer);
      tick(); elapsed.hidden = false; elapsedTimer = setInterval(tick, 1000);
      sync(); show(messages.restore.running); notice(messages.restore.running);
    },
    stage(stage, detail) {
      if (stage !== restoreStage) { restoreStage = stage; sync(); show(messages.progress[stage]); }
      const bytes = downloadText(stage, detail);
      if (bytes) show(`${messages.progress[stage]} ${bytes}`);
    },
    done(result) {
      const text = restoreDoneText(result);
      show(text, "success"); notice(text, "success"); panel.hidden = true;
    },
    failed(error) {
      const text = hostErrorCode(error) === "CANCELLED" ? messages.restore.cancelled : errorMessage(error);
      show(text, "error"); notice(text, "error");
    },
    ended() {
      restoreStage = null;
      if (elapsedTimer) clearInterval(elapsedTimer); elapsedTimer = undefined;
      elapsed.hidden = true; sync();
      // A restore that did not finish changes the list: a resumable entry and the last outcome.
      if (!panel.hidden) void loadList();
    },
  });
  /** Every control follows one rule: nothing starts while an export or a restore runs, or for another server. */
  function sync() {
    const busy = exporting.busy || restoring.busy;
    make.disabled = !allowed || busy; restoreOpen.disabled = !allowed || busy;
    stop.hidden = !exporting.busy;
    restoreStart.disabled = !allowed || busy || selected() === null; restoreClose.disabled = busy;
    for (const radio of list.querySelectorAll("input")) radio.disabled = busy;
    restoreStop.hidden = !restoring.busy || (restoreStage !== null && RESTORE_UNSTOPPABLE_STAGES.has(restoreStage));
  }
  function selected(): RestoreEntry | null {
    const checked = list.querySelector<HTMLInputElement>("input:checked");
    return entries.find(entry => entry.id === checked?.value) ?? null;
  }
  async function run() {
    if (exporting.busy || restoring.busy || !allowed) return;
    await exporting.start({});
  }
  async function cancel() {
    if (!exporting.busy) return;
    try { await exporting.cancel(); }
    catch (error) { if (live) notice(errorMessage(error), "error"); }
  }
  async function openFolder() {
    try { await command("open_backup_folder"); }
    catch (error) { if (live) notice(errorMessage(error), "error"); }
  }
  function renderEntries(found: RestoreEntry[]) {
    entries = found;
    list.replaceChildren();
    if (found.length === 0) list.append(element("p", "hint", messages.restore.empty));
    const name = `restore-${crypto.randomUUID()}`;
    for (const entry of found) {
      const radio = input("radio"); radio.name = name; radio.value = entry.id;
      radio.addEventListener("change", () => {
        restoreStart.textContent = entry.resumable ? messages.restore.resume : messages.restore.start; sync();
      });
      const label = element("label", "restore-choice");
      const text = element("span", "", entryLine(entry));
      label.append(radio, text);
      if (entry.resumable) label.append(element("small", "hint", messages.restore.resumable));
      list.append(label);
    }
  }
  async function openList() {
    if (exporting.busy || restoring.busy || !allowed) return;
    show(messages.restore.loading);
    try {
      const listing = await request("backup.list", {});
      if (!live) return;
      const lastText = lastRestoreText(listing.last);
      last.textContent = lastText ?? ""; last.hidden = lastText === null;
      renderEntries(listing.entries); restoreStart.textContent = messages.restore.start;
      panel.hidden = false; show(""); sync();
      (list.querySelector<HTMLInputElement>("input") ?? restoreClose).focus();
    } catch (error) {
      if (!live) return;
      const text = errorMessage(error); show(text, "error"); notice(text, "error");
    }
  }
  function closeList() {
    if (restoring.busy) return;
    panel.hidden = true; entries = []; list.replaceChildren(); restoreOpen.focus(); sync();
  }
  async function startRestore() {
    const entry = selected();
    if (!entry || exporting.busy || restoring.busy || !allowed) return;
    if (!(await confirmAction(messages.restore.confirmTitle, messages.restore.confirmMessage(entryLine(entry), entry.resumable), messages.restore.confirmAction))) return;
    if (!live || exporting.busy || restoring.busy) return;
    await restoring.start({ id: entry.id });
  }
  /** Reads the list again, keeping the chosen entry: after a restore that did not finish, or for a restore this screen
   * joined (its list shown with the controls off while it runs). */
  async function loadList() {
    try {
      const listing = await request("backup.list", {});
      if (!live) return;
      const lastText = lastRestoreText(listing.last);
      last.textContent = lastText ?? ""; last.hidden = lastText === null;
      const chosen = selected()?.id;
      renderEntries(listing.entries);
      const again = chosen ? list.querySelector<HTMLInputElement>(`input[value="${chosen}"]`) : null;
      if (again) { again.checked = true; again.dispatchEvent(new Event("change")); }
      sync();
    } catch { /* the list stays as it was */ }
  }
  async function cancelRestore() {
    if (!restoring.busy) return;
    restoreStop.disabled = true; show(messages.restore.stopping);
    try { await restoring.cancel(); }
    catch (error) { if (live) notice(errorMessage(error), "error"); }
    finally { restoreStop.disabled = false; }
  }
  void onProgress(event => { exporting.progress(event); restoring.progress(event); })
    .then(fn => { if (live) stopProgress = fn; else fn(); });
  // A backup or restore that runs (started before this screen opened) is joined; one that ended while no screen
  // waited shows how it ended.
  if (native) void request("backup.status", {}).then(jobs => {
    if (!live) return;
    for (const kind of attachOrder(jobs)) {
      if (kind === "restore" && jobs.restore?.state === "running") { panel.hidden = false; void loadList(); }
      void (kind === "export" ? exporting.attach(jobs.export) : restoring.attach(jobs.restore));
    }
  }).catch(() => {});
  return {
    element: root,
    populate(value) {
      allowed = value.connection.mode === "local";
      blocked.hidden = allowed;
      if (!allowed && !restoring.busy) { panel.hidden = true; entries = []; list.replaceChildren(); }
      sync();
    },
    dispose() {
      // Only this screen's waits end; a backup or restore goes on, and the screen opened again joins it.
      live = false; stopProgress?.();
      if (elapsedTimer) clearInterval(elapsedTimer);
      exporting.dispose(); restoring.dispose();
    },
  };
}

/** `resumeOnboarding`, when given, is offered as "처음 설정 이어 하기" while a first-run setup with connected
 * storage is unfinished. */
export function renderSettings(host: HTMLElement, notice: Notice, done: () => void, resumeOnboarding?: (step: OnboardingStep) => void): () => void {
  host.replaceChildren(); let live = true;
  const resume = element("div", "stack-actions"); resume.hidden = true;
  const connection = renderConnection(notice, done, true);
  const ai = renderAiSettings(notice);
  const autoStart = renderAutoStart(notice);
  const cleanupOnSave = renderCleanupOnSave(notice);
  const backup = renderBackup(notice);
  const settings = element("div", "notebook-settings");
  ai.element.querySelector("summary")?.append(element("small", "notebook-section-hint", messages.settings.aiOptional));
  autoStart.element.prepend(element("h2", "", messages.settings.autoStartHeading));
  settings.append(element("h1", "notebook-page-title", messages.common.settings), resume, connection.element, ai.element, cleanupOnSave.element, autoStart.element, backup.element, renderLicenses());
  host.append(settings);
  if (native) void request("settings.get", {}).then(value => {
    if (!live) return;
    const step = startStep(readOnboarding(), value.hasToken);
    if (resumeOnboarding && value.hasToken && step !== "done") {
      resume.append(button(messages.onboarding.resume, () => resumeOnboarding(step), "button primary full")); resume.hidden = false;
    }
    connection.populate(value); ai.populate(value); autoStart.populate(value); cleanupOnSave.populate(value); backup.populate(value);
  }).catch(error => { if (live) { ai.loadFailed(errorMessage(error)); notice(errorMessage(error), "error"); } });
  // Lines about an update an earlier start left unfinished and about the remote server's update or dev build; without
  // the status the screen simply shows none.
  if (native) void request("status", {}).then(status => {
    if (live) { connection.showUpdate(status.update ?? null); connection.showServerUpdate(status.serverUpdate ?? null); connection.showTunnelPort(status.tunnelPort ?? null); }
  }).catch(() => {});
  return () => { live = false; connection.dispose(); ai.dispose(); autoStart.dispose(); cleanupOnSave.dispose(); backup.dispose(); };
}
