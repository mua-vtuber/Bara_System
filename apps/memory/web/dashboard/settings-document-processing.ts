/**
 * dashboard/settings-document-processing.ts — 문서 처리 목록(OCR 필요 문서 카드) (settings.ts 에서 옮김).
 *
 * OCR 이 필요한 문서를 카드로 보이고, 결과 Markdown 을 직접 붙이거나(수동) 서버 자동 처리 모드(로컬·API)일 때
 * "서버에서 다시 읽기"로 그 문서 하나를 서버에서 다시 읽게 한다(2026-10-11 document-ocr spec 8.4). 서버에서 다시
 * 읽기는 그 문서의 멈춘 쪽 기록을 지우고 처음부터 다시 부른다(사용자의 명시적 요청).
 */

import { apiFetch } from "./api-fetch";
import { DOCUMENT_OCR_LABELS as L } from "./settings-document-ocr-labels";
import { parseResponseError } from "./settings-document-ocr-controls";
import { SERVER_OCR_WORKER_ID } from "../../src/settings/document-ocr-api-providers";

export interface DocumentParseDTO {
  status: string;
  /** 서버 OCR 이 빈 쪽으로 읽은 쪽 수. */
  blankPageCount?: number;
  method: string;
  warnings?: string[];
  errorMessage?: string;
  providerName?: string;
  lease?: {
    workerId: string;
    claimedAt: string;
    leaseUntil: string;
  };
  updatedAt?: string;
}

export interface DocumentOcrCandidateDTO {
  documentId: string;
  title: string;
  documentType: string;
  chunkCount: number;
  parse: DocumentParseDTO | null;
  originalAssetSha256: string;
  assetUrl: string;
  assetMimeType?: string | null;
  originalName?: string | null;
  createdAt: string;
  updatedAt: string;
  nodeId?: number;
  leaseActive?: boolean;
  extraction?: { totalChunks: number; completedChunks: number };
  /** 상태 조회만 채운다 — 같은 파일이 이미 다른 노드로 있어 이 기록이 그 결과를 함께 쓸 때. notice 는 서버 문장. */
  absorbedInto?: { nodeId: number; documentId: string | null; inTrash: boolean; notice: string };
  /** 상태 조회만 채운다 — 예전 버전이 이름만 같은 다른 파일·기억에 잘못 합쳐 둔 기록일 때. notice 는 서버 문장. */
  legacyMerged?: { nodeId: number; documentId: string | null; inTrash: boolean; notice: string };
}

/** 서버에서 다시 읽기 결과 — 응답 본문 그대로(ok·error·parse·summary). */
export interface ServerRerunResult {
  ok: boolean;
  error?: string;
  parse?: DocumentParseDTO | null;
  summary?: { pageCalls: number; documentsApplied: number };
}

export interface DocumentProcessingApi {
  listOcrCandidates(): Promise<DocumentOcrCandidateDTO[]>;
  applyOcrResult(documentId: string, markdown: string): Promise<void>;
  getDocument?(documentId: string): Promise<DocumentOcrCandidateDTO | null>;
  /** 서버에서 이 문서 하나를 다시 읽는다(run-server-once?documentId=). 실패 응답도 본문을 돌려준다. */
  rerunOnServer?(documentId: string): Promise<ServerRerunResult>;
}

export function createDocumentProcessingApi(): DocumentProcessingApi {
  return {
    async getDocument(documentId): Promise<DocumentOcrCandidateDTO | null> {
      const res = await apiFetch(`/api/documents/${encodeURIComponent(documentId)}/status`);
      if (res.status === 404 || res.status === 410) return null;
      const body = await res.json() as { document?: DocumentOcrCandidateDTO };
      if (!res.ok) throw new Error(parseResponseError(body, `문서 상태 조회 실패 (HTTP ${res.status})`));
      if (!body.document || body.document.documentId !== documentId) throw new Error("문서 상태 응답을 확인할 수 없습니다.");
      return body.document;
    },
    async listOcrCandidates(): Promise<DocumentOcrCandidateDTO[]> {
      const res = await apiFetch("/api/documents/ocr-candidates");
      const body = (await res.json()) as unknown;
      if (!res.ok) {
        throw new Error(parseResponseError(body, `문서 목록 조회 실패 (HTTP ${res.status})`));
      }
      const candidates = (body as { candidates?: unknown } | null)?.candidates;
      if (!Array.isArray(candidates)) {
        // 빈 목록으로 바꾸지 않는다 — 응답 형식이 어긋났다는 것을 그대로 알린다.
        throw new Error("문서 목록 응답에 candidates 배열이 없습니다 — 서버·화면 버전을 확인하세요.");
      }
      return candidates as DocumentOcrCandidateDTO[];
    },
    async rerunOnServer(documentId: string): Promise<ServerRerunResult> {
      const res = await apiFetch(`/api/documents/ocr-jobs/run-server-once?documentId=${encodeURIComponent(documentId)}`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => null)) as ServerRerunResult | null;
      if (!body) throw new Error(`서버 OCR 응답을 읽을 수 없음 (HTTP ${res.status})`);
      if (!res.ok) return { ...body, ok: false, error: parseResponseError(body, `HTTP ${res.status}`) };
      return body;
    },
    async applyOcrResult(documentId: string, markdown: string): Promise<void> {
      const res = await apiFetch(`/api/documents/${encodeURIComponent(documentId)}/ocr-result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown, source: "manual" }),
      });
      const body = (await res.json()) as unknown;
      if (!res.ok) {
        throw new Error(parseResponseError(body, `OCR 결과 적용 실패 (HTTP ${res.status})`));
      }
    },
  };
}

function labelForParseStatus(parse: DocumentParseDTO | null, leaseActive?: boolean): string {
  if (parse?.lease && leaseActive !== false) return "처리 중";
  const status = parse?.status;
  switch (status) {
    case "needs_ocr":
      return "OCR 필요";
    case "password_required":
      return "암호 필요";
    case "parse_failed":
      return "파싱 실패";
    case "ocr_failed":
      return "OCR 실패";
    case "ocr_succeeded":
      return "OCR 완료";
    case "text_succeeded":
      return "텍스트 추출 완료 · OCR 불필요";
    default:
      return "파싱 상태 확인 불가";
  }
}

export interface DocumentProcessingOptions {
  /** 서버 자동 처리 모드(로컬·API)인지 — 그때만 "서버에서 다시 읽기" 버튼을 보인다. */
  serverOcrEnabled?: boolean;
}

function renderServerRerun(
  candidate: DocumentOcrCandidateDTO,
  api: DocumentProcessingApi,
  status: HTMLElement,
  reload: () => Promise<void>,
): HTMLButtonElement | null {
  if (candidate.parse?.status !== "ocr_failed" || !api.rerunOnServer) return null;
  // 서버가 읽을 수 없는 문서(PDF·그림이 아님)나 다른 작업자가 잡고 있는 문서에는 버튼을 두지 않는다.
  const mime = (candidate.assetMimeType ?? "").toLowerCase();
  if (mime !== "application/pdf" && !mime.startsWith("image/")) return null;
  const lease = candidate.parse.lease;
  if (lease && candidate.leaseActive !== false && lease.workerId !== SERVER_OCR_WORKER_ID) return null;
  const rerun = api.rerunOnServer;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "document-processing-rerun au-btn";
  button.textContent = L.rerunOnServer;
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.classList.remove("error");
    status.textContent = L.rerunRunning;
    try {
      const result = await rerun(candidate.documentId);
      if (!result.ok) {
        status.textContent = L.rerunFailed(result.error ?? result.parse?.errorMessage ?? "");
        status.classList.add("error");
        button.disabled = false;
        return;
      }
      if (result.parse?.status === "ocr_succeeded") status.textContent = L.rerunDone;
      else if ((result.summary?.pageCalls ?? 0) > 0) status.textContent = L.rerunPartial;
      else {
        // 아무 쪽도 읽지 않았으면 "일부 쪽만 읽었다" 고 하지 않는다.
        status.textContent = L.rerunFailed(result.error ?? "");
        status.classList.add("error");
        button.disabled = false;
        return;
      }
      await reload();
    } catch (err) {
      status.textContent = L.rerunFailed(err instanceof Error ? err.message : String(err));
      status.classList.add("error");
      button.disabled = false;
    }
  });
  return button;
}

function renderDocumentCandidate(
  candidate: DocumentOcrCandidateDTO,
  api: DocumentProcessingApi,
  reload: () => Promise<void>,
  options: DocumentProcessingOptions,
): HTMLElement {
  const item = document.createElement("article");
  item.className = "document-processing-item";
  item.dataset.documentId = candidate.documentId;

  const header = document.createElement("div");
  header.className = "document-processing-header";
  const title = document.createElement("h3");
  title.textContent = candidate.title;
  const badge = document.createElement("span");
  badge.className = "document-processing-badge";
  badge.textContent = candidate.legacyMerged
    ? L.legacyMergedBadge
    : candidate.absorbedInto
      ? L.absorbedBadge
      : labelForParseStatus(candidate.parse, candidate.leaseActive);
  header.appendChild(title);
  header.appendChild(badge);

  const meta = document.createElement("p");
  meta.className = "document-processing-meta";
  meta.textContent = `${candidate.documentType} · 청크 ${candidate.chunkCount}개 · ${candidate.updatedAt}`;

  const actions = document.createElement("div");
  actions.className = "document-processing-actions";
  const assetLink = document.createElement("a");
  assetLink.href = candidate.assetUrl;
  assetLink.rel = "noreferrer";
  assetLink.textContent = "원본 다운로드";
  actions.appendChild(assetLink);
  if (candidate.nodeId !== undefined) {
    const graphLink = document.createElement("a");
    graphLink.href = "/web/graph.html";
    graphLink.textContent = "그래프 열기";
    actions.appendChild(graphLink);
  }

  const textarea = document.createElement("textarea");
  textarea.className = "document-processing-textarea";
  textarea.rows = 7;
  textarea.placeholder = "OCR 결과 Markdown";
  const passwordRequired = candidate.parse?.status === "password_required";
  if (passwordRequired) {
    textarea.disabled = true;
    textarea.placeholder = "암호 해제 후 다시 업로드";
  }

  const status = document.createElement("p");
  status.className = "document-processing-status";
  status.setAttribute("role", "status");
  assetLink.addEventListener("click", async (event) => {
    event.preventDefault();
    if (assetLink.getAttribute("aria-disabled") === "true") return;
    assetLink.setAttribute("aria-disabled", "true");
    status.classList.remove("error");
    status.textContent = "원본을 불러오는 중...";
    let objectUrl: string | null = null;
    try {
      const response = await apiFetch(candidate.assetUrl);
      if (!response.ok) throw new Error(`원본 다운로드 실패 (HTTP ${response.status})`);
      objectUrl = URL.createObjectURL(await response.blob());
      const download = document.createElement("a");
      download.href = objectUrl;
      download.download = candidate.originalName || candidate.title || "document";
      document.body.append(download);
      download.click();
      download.remove();
      status.textContent = "원본 다운로드를 시작했습니다.";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "원본 다운로드에 실패했습니다.";
      status.classList.add("error");
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      assetLink.removeAttribute("aria-disabled");
    }
  });

  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "document-processing-submit";
  submit.textContent = "OCR 결과 붙이기";
  submit.disabled = passwordRequired;
  submit.addEventListener("click", async () => {
    const markdown = textarea.value;
    if (markdown.trim().length === 0) {
      status.textContent = "Markdown을 입력해야 합니다.";
      status.classList.add("error");
      return;
    }
    submit.disabled = true;
    status.classList.remove("error");
    status.textContent = "적용 중...";
    try {
      await api.applyOcrResult(candidate.documentId, markdown);
      status.textContent = "적용 완료";
      await reload();
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e);
      status.classList.add("error");
      submit.disabled = false;
    }
  });

  item.appendChild(header);
  item.appendChild(meta);
  if (candidate.parse?.errorMessage) {
    const error = document.createElement("p");
    error.className = "document-processing-error";
    error.textContent = candidate.parse.errorMessage;
    item.appendChild(error);
  }
  if (passwordRequired) {
    const notice = document.createElement("p");
    notice.className = "document-processing-meta";
    notice.textContent = "암호가 걸린 문서는 암호를 해제한 파일로 다시 업로드해야 한다.";
    item.appendChild(notice);
  }
  if (candidate.parse?.lease) {
    const lease = document.createElement("p");
    lease.className = "document-processing-meta";
    lease.textContent = candidate.leaseActive === false
      ? `처리 예약 만료 · ${candidate.parse.lease.workerId} · 다시 처리 대기`
      : `${candidate.parse.lease.workerId} · ${candidate.parse.lease.leaseUntil}까지 처리 중`;
    item.appendChild(lease);
  }
  item.appendChild(actions);
  const parseStatus = candidate.parse?.status;
  const notOwned = candidate.legacyMerged ?? candidate.absorbedInto;
  if (notOwned) {
    // 자기 노드가 없는 기록 — 결과는 주인 문서가 받거나(같은 파일) 다시 올려야 받는다(옛 버전의 잘못된 합침).
    // 이 카드에서 글자 인식 결과를 붙이거나 다시 읽게 하지 않는다.
    const notice = document.createElement("p");
    notice.className = candidate.legacyMerged
      ? "document-processing-meta document-processing-legacy-merged error"
      : "document-processing-meta document-processing-absorbed";
    notice.textContent = notOwned.notice;
    item.appendChild(notice);
  } else if (parseStatus === "text_succeeded" || parseStatus === "ocr_succeeded") {
    const progress = document.createElement("p");
    progress.className = "document-processing-meta";
    const extraction = candidate.extraction;
    progress.textContent = !extraction ? "의미 추출 상태를 확인할 수 없습니다."
      : extraction.totalChunks === 0 ? "의미 추출 대상 청크가 없습니다."
      : extraction.completedChunks < extraction.totalChunks
        ? `의미 추출 대기 · ${extraction.totalChunks}개 청크 중 ${extraction.completedChunks}개 처리됨. 자동 처리 설정과 실행 주기에 따라 진행됩니다.`
        : `의미 추출 완료 · 청크 ${extraction.completedChunks}개 처리됨.`;
    item.appendChild(progress);
    const blank = candidate.parse?.blankPageCount ?? 0;
    if (parseStatus === "ocr_succeeded" && blank > 0) {
      const note = document.createElement("p");
      note.className = "document-processing-meta document-processing-blank";
      note.textContent = L.blankPages(blank);
      item.appendChild(note);
    }
  } else if (parseStatus) {
    item.appendChild(textarea);
    item.appendChild(submit);
    const rerun = options.serverOcrEnabled ? renderServerRerun(candidate, api, status, reload) : null;
    if (rerun) item.appendChild(rerun);
  }
  item.appendChild(status);
  return item;
}

export function linkedDocumentId(): string | null {
  return new URLSearchParams(window.location.search).get("documentId")?.trim() || null;
}

export function renderDocumentProcessingPanel(
  api: DocumentProcessingApi = createDocumentProcessingApi(),
  options: DocumentProcessingOptions = {},
): HTMLElement {
  const root = document.createElement("section");
  root.className = "document-processing-panel";
  const list = document.createElement("div");
  list.className = "document-processing-list";
  const targetId = linkedDocumentId();
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "document-processing-retry au-btn";
  refresh.textContent = "문서 상태 새로고침";
  refresh.addEventListener("click", () => void load());
  let loadGeneration = 0;

  async function load(): Promise<void> {
    const generation = ++loadGeneration;
    refresh.disabled = true;
    list.textContent = "";
    const loading = document.createElement("p");
    loading.className = "document-processing-empty";
    loading.textContent = "문서 상태를 불러오는 중...";
    list.appendChild(loading);
    try {
      const [candidateResult, targetResult] = await Promise.allSettled([
        api.listOcrCandidates(),
        targetId && api.getDocument ? api.getDocument(targetId) : Promise.resolve(undefined),
      ]);
      if (generation !== loadGeneration) return;
      list.textContent = "";
      const candidates = candidateResult.status === "fulfilled" ? candidateResult.value : [];
      const target = targetResult.status === "fulfilled" ? targetResult.value : undefined;
      for (const result of [candidateResult, targetResult]) {
        if (result.status !== "rejected") continue;
        const error = document.createElement("p");
        error.className = "document-processing-empty error";
        error.textContent = result.reason instanceof Error ? result.reason.message : String(result.reason);
        list.appendChild(error);
      }
      if (targetId && target === null) {
        const missing = document.createElement("p");
        missing.className = "document-processing-empty error";
        missing.textContent = "요청한 문서는 삭제되었거나 찾을 수 없습니다. 휴지통을 확인하세요.";
        list.appendChild(missing);
      }
      const documents = target ? [target, ...candidates.filter((item) => item.documentId !== targetId)]
        : candidates.filter((item) => target !== null || item.documentId !== targetId);
      if (documents.length === 0 && target !== null && candidateResult.status === "fulfilled" && targetResult.status === "fulfilled") {
        const empty = document.createElement("p");
        empty.className = "document-processing-empty";
        empty.textContent = "OCR 처리가 필요한 문서 없음";
        list.appendChild(empty);
        return;
      }
      for (const candidate of documents) {
        const row = renderDocumentCandidate(candidate, api, load, options);
        if (candidate.documentId === targetId) {
          row.setAttribute("aria-current", "true");
          row.tabIndex = -1;
        }
        list.appendChild(row);
        if (candidate.documentId === targetId) {
          row.focus({ preventScroll: true });
          row.scrollIntoView?.({ block: "nearest", behavior: "instant" });
        }
      }
    } catch (e) {
      if (generation !== loadGeneration) return;
      list.textContent = "";
      const error = document.createElement("p");
      error.className = "document-processing-empty error";
      error.textContent = e instanceof Error ? e.message : String(e);
      list.appendChild(error);
    } finally {
      if (generation === loadGeneration) refresh.disabled = false;
    }
  }

  root.appendChild(refresh);
  root.appendChild(list);
  void load();
  return root;
}

