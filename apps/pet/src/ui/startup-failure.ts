import type { Feedback, StartupStage } from "../shared/contracts.ts";
import { errorFeedback } from "./feedback-model.ts";
import { messages } from "./messages.ts";

export type { StartupStage } from "../shared/contracts.ts";

/** The error bubble for a failed startup step. It goes through `errorFeedback`, so a credential-shaped
 * fragment in `reason` is masked and the detail is length-limited like every other error bubble. The
 * bubble's own line is the fixed error summary; `detail` (cause and how to retry) opens with it. The app
 * ran the check by itself, so it is a `background` result: with the pet hidden it waits in "최근 결과". */
export function startupFailureFeedback(id: string, stage: StartupStage, reason: string): Feedback {
  return { ...errorFeedback(id, "input", stage === "settings"
    ? messages.feedback.startupSettingsFailed(reason) : messages.feedback.startupConnectionFailed(reason)), origin: "background" };
}
