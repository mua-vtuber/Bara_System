import type { ProgressDetail, ProgressFrame, ProgressStage, RequestContext } from "../shared/contracts.ts";

/** Shortest gap between two byte-progress frames of one request. The producers already send at most two lines a
 * second per download, but each frame crosses the host and wakes the screen, so the service keeps its own bound. */
export const PROGRESS_DETAIL_INTERVAL_MS = 250;

/** `RequestContext.progress` for one request. A frame without a detail, one that names another stage than the
 * last frame, the first detail of a new part and a part's finished count (loaded equal to a known total) always go
 * out; any other detail is dropped inside `PROGRESS_DETAIL_INTERVAL_MS` of the last detail sent (a later one
 * replaces it, so the screen only skips intermediate counts and never stays on an unfinished one). */
export function progressReporter(requestId: string, send: (frame: ProgressFrame) => void,
  now: () => number = () => performance.now()): RequestContext["progress"] {
  let lastStage: ProgressStage | undefined;
  let lastPart: number | undefined;
  let detailAt = Number.NEGATIVE_INFINITY;
  return (stage: ProgressStage, detail?: ProgressDetail) => {
    const at = now();
    const boundary = !!detail && (detail.part !== lastPart || (detail.total > 0 && detail.loaded === detail.total));
    if (detail && !boundary && stage === lastStage && at - detailAt < PROGRESS_DETAIL_INTERVAL_MS) return;
    lastStage = stage;
    if (detail) lastPart = detail.part;
    if (detail) detailAt = at;
    send(detail ? { event: "progress", requestId, stage, detail } : { event: "progress", requestId, stage });
  };
}
