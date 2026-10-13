import type { ConnectionStatus, PublicSettings, StartupCheck } from "../shared/contracts.ts";
import { errorText } from "./error-text.ts";
import { messages } from "./messages.ts";

export type { StartupCheck } from "../shared/contracts.ts";

/** The startup check: read the saved settings, then (only when a token is saved) check the server connection.
 * Reading the settings and checking the connection fail for different reasons and call for different fixes,
 * so each failure carries its own stage. A first run has no token to check, and no connection is attempted.
 * The service runs it once per start (`startup.check`, `src/service/router.ts`); the screen only observes it
 * (`observeStartupCheck`). */
export async function checkStartup(readSettings: () => Promise<Pick<PublicSettings, "hasToken">>,
  testConnection: () => Promise<Pick<ConnectionStatus, "connected" | "message">>): Promise<StartupCheck> {
  let settings: Pick<PublicSettings, "hasToken">;
  try { settings = await readSettings(); }
  catch (error) {
    const reason = errorText(error);
    return { kind: "failed", stage: "settings", reason, text: messages.feedback.startupSettingsFailed(reason) };
  }
  if (!settings.hasToken) return { kind: "firstRun" };
  try {
    const result = await testConnection();
    return result.connected ? { kind: "connected", message: result.message }
      : { kind: "failed", stage: "connection", reason: result.message, text: result.message };
  } catch (error) {
    const reason = errorText(error);
    return { kind: "failed", stage: "connection", reason, text: reason };
  }
}

/** The main window's view of the startup check the native host already started when the app started: `join`
 * (`startup.check`) waits for that same run, or starts it when the window asks first; it never runs a second
 * check. The answer is reduced to `StartupCheck` (the host's bubble is the host's business). When the request
 * itself fails (the service could not be started or stopped answering, or the app is quitting), the check could
 * not be followed to its end, which reads as a failed connection check with that cause. */
export async function observeStartupCheck(join: () => Promise<StartupCheck>): Promise<StartupCheck> {
  let check: StartupCheck;
  try { check = await join(); }
  catch (error) {
    const reason = errorText(error);
    return { kind: "failed", stage: "connection", reason, text: reason };
  }
  if (check.kind === "failed") return { kind: "failed", stage: check.stage, reason: check.reason, text: check.text };
  return check.kind === "connected" ? { kind: "connected", message: check.message } : { kind: "firstRun" };
}
