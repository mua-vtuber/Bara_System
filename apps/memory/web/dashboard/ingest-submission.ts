import { apiFetch } from "./api-fetch.js";
import { isIngestSuccess, type IngestResult } from "../../src/memory/ingest-result.ts";

type Body = Record<string, unknown>;
type State = "ready" | "pending" | "saved" | "failed" | "unknown";
interface Job {
  label: string;
  text: string;
  revision: number;
  file?: File;
  parent?: Job;
  payload?: Body;
  requestId: string;
  state: State;
  result?: IngestResult;
  detail?: string;
}
interface SubmissionContext {
  apiBase: string;
  inputEl: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  resultEl: HTMLElement;
  getFiles(): File[];
  removeFile(file: File): void;
  resetInput(): void;
  textPayload(text: string): Body;
  filePayload(file: File, text: string, parent: number | null): Promise<Body>;
  resultLines(body: Body): string[];
  renderBlock(label: string, state: State, lines: string[]): HTMLElement;
  onIngested?: () => void;
  showStatus(message: string): void;
  hideStatus(): void;
}

// getRandomValues also works on LAN HTTP origins where randomUUID is unavailable.
function requestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Keeps each attempted item separate from the editable draft and current attachments. */
export function createIngestSubmission(ctx: SubmissionContext): () => Promise<void> {
  const jobs: Job[] = [];
  let revision = 0;
  let busy = false;
  ctx.inputEl.addEventListener("input", () => { revision += 1; });

  function markSaved(job: Job, result: IngestResult): void {
    job.state = "saved";
    job.result = result;
    job.payload = undefined;
    if (job.file) ctx.removeFile(job.file);
    else if (ctx.inputEl.value === job.text && revision === job.revision) ctx.resetInput();
    try { ctx.onIngested?.(); } catch { /* The stored result remains visible if refreshing fails. */ }
  }

  function render(): void {
    ctx.resultEl.hidden = jobs.length === 0;
    ctx.resultEl.replaceChildren(...jobs.map(job => {
      const lines = job.result ? ctx.resultLines(job.result) : [job.detail ?? "처리 중…"];
      const block = ctx.renderBlock(job.label, job.state, lines);
      if (job.state === "saved" && typeof job.result?.documentId === "string") {
        const link = document.createElement("a");
        link.href = `/web/dashboard/settings.html?documentId=${encodeURIComponent(job.result.documentId)}#memory`;
        link.textContent = "문서 처리 상태 확인";
        block.append(link);
      }
      if (job.state === "failed" || job.state === "unknown") {
        const action = document.createElement("button");
        action.type = "button";
        action.disabled = busy;
        action.dataset[job.state === "failed" ? "ingestRetry" : "ingestCheck"] = "";
        action.textContent = job.state === "failed" ? "이 항목만 다시 전송" : "저장 결과 확인";
        action.addEventListener("click", () => {
          if (job.state === "failed") void run([job]);
          else void check(job);
        });
        block.append(action);
      }
      return block;
    }));
  }

  async function check(job: Job): Promise<void> {
    if (busy) return;
    busy = true;
    render();
    try {
      const response = await apiFetch(`${ctx.apiBase}/ingest/status/${encodeURIComponent(job.requestId)}`);
      if (!response.ok) throw new Error(`결과 조회 실패 (HTTP ${response.status})`);
      const body = await response.json() as Record<string, unknown>;
      if (body.state === "saved" && isIngestSuccess(body.result)) markSaved(job, body.result);
      else job.detail = body.state === "pending"
        ? "서버에서 아직 처리 중입니다. 잠시 뒤 결과를 다시 확인하세요."
        : "저장 여부를 확인할 수 없습니다. 서버 재시작·기록 만료일 수 있어 재전송하지 않았습니다. 검색으로 확인하세요.";
    } catch (error) {
      job.detail = `결과 확인 필요 · ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      busy = false;
      render();
    }
  }

  async function execute(job: Job): Promise<void> {
    // A confirmed rejection can be retried with the now-confirmed parent from the same batch.
    if (job.state === "failed") { job.payload = undefined; job.requestId = requestId(); }
    // Reading a file is local and has no write effect, so failures here are retryable.
    try {
      job.payload ??= job.file
        ? await ctx.filePayload(job.file, job.text, job.parent?.result?.originNodeId ?? null)
        : ctx.textPayload(job.text.trim());
    } catch (error) {
      job.state = "failed";
      job.detail = `파일 읽기 실패 · ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    job.state = "pending";
    render();
    try {
      const response = await apiFetch(`${ctx.apiBase}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...job.payload, requestId: job.requestId }),
      });
      const body = await response.json().catch(() => null);
      if (response.ok && isIngestSuccess(body)) markSaved(job, body);
      else {
        // Only an explicit pre-write rejection proves a retry cannot repeat side effects.
        job.state = !response.ok && response.headers.get("X-Ingest-Retryable") === "true" ? "failed" : "unknown";
        job.detail = body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error : (response.ok ? "저장 응답의 형식을 확인할 수 없습니다." : `HTTP ${response.status}`);
      }
    } catch (error) {
      job.state = "unknown";
      job.detail = `응답을 받지 못했습니다. 재전송 전에 결과를 확인하세요. (${error instanceof Error ? error.message : String(error)})`;
    }
  }

  async function run(selected: Job[]): Promise<void> {
    if (busy || selected.length === 0) return;
    busy = true;
    ctx.sendBtn.disabled = true;
    ctx.showStatus("처리 중… 큰 문서는 시간이 걸릴 수 있어요.");
    try {
      for (const job of selected) await execute(job);
    } finally {
      busy = false;
      ctx.sendBtn.disabled = false;
      ctx.hideStatus();
      render();
    }
  }

  return async () => {
    if (busy) return;
    // Keep unresolved results visible, but release prior successful attachment snapshots.
    for (let index = jobs.length - 1; index >= 0; index--) if (jobs[index]!.state === "saved") jobs.splice(index, 1);
    const text = ctx.inputEl.value;
    const selected: Job[] = [];
    const newJob = (file?: File): Job => {
      const job: Job = { label: file?.name ?? "메모", text, revision, file, requestId: requestId(), state: "ready" };
      jobs.push(job);
      return job;
    };
    let parent: Job | undefined;
    if (text.trim()) {
      // Uncertain inputs remain blocked even if input events occurred without changing their content.
      parent = jobs.find(job => !job.file && job.text === text && job.state === "unknown")
        ?? jobs.find(job => !job.file && job.text === text && job.revision === revision && job.state !== "saved")
        ?? newJob();
      if (parent.state === "ready" || parent.state === "failed") selected.push(parent);
    }
    for (const file of [...ctx.getFiles()]) {
      const job = jobs.find(item => item.file === file) ?? newJob(file);
      job.parent ??= parent;
      if (job.state === "ready" || job.state === "failed") selected.push(job);
    }
    if (selected.length === 0) { render(); ctx.inputEl.focus(); return; }
    await run(selected);
  };
}
