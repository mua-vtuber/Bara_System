import { apiFetch } from "../api-fetch.ts";
import type {
  ArchiveItem,
  ArchivePage,
  CleanupProposal,
  CleanupProposalActionResult,
  CleanupProposalDetail,
  CleanupRunAvailability,
  CleanupRunView,
  DashboardStats,
  DashboardSearchOptions,
  DateOccurrencesResponse,
  EntityRegisterRevertResult,
  GraphOverviewResponse,
  MemoriesResponse,
  MemoryDetailResponse,
  PersonDetailResponse,
  ProjectDetailResponse,
  RecentAutoRegisterItem,
  SearchResponse,
} from "./types.ts";

/** 오류 응답에도 항목별 적용 결과와 처리 상태가 담길 수 있다. */
export class DashboardApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
    this.name = "DashboardApiError";
  }
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    let errorBody: unknown;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      errorBody = body;
      const message = body.error ?? body.message;
      if (message) detail += ` — ${message}`;
    } catch {
      // keep status-only detail
    }
    throw new DashboardApiError(detail, res.status, errorBody);
  }
  return res.json() as Promise<T>;
}

export function getStats(): Promise<DashboardStats> {
  return jsonFetch<DashboardStats>("/stats");
}

export function getLatest(limit = 30): Promise<MemoriesResponse> {
  return jsonFetch<MemoriesResponse>(`/memories?recent=${limit}`);
}

export function getMemoryDetail(id: number): Promise<MemoryDetailResponse> {
  return jsonFetch<MemoryDetailResponse>(`/memories/${encodeURIComponent(String(id))}`);
}

export function searchMemories(
  query: string,
  options: DashboardSearchOptions = {},
): Promise<SearchResponse> {
  const body: Record<string, unknown> = {
    query,
    limit: options.limit ?? 24,
  };
  if (options.kind) body["kind"] = options.kind;
  if (options.subcategory) body["filter"] = { subcategory: options.subcategory };
  if (options.since) body["since"] = options.since;
  if (options.until) body["until"] = options.until;

  return jsonFetch<SearchResponse>("/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getDateOccurrences(): Promise<DateOccurrencesResponse> {
  return jsonFetch<DateOccurrencesResponse>(
    "/api/date-occurrences?days=90&pastDays=30&limit=30",
  );
}

export function getGraphOverview(limit = 120): Promise<GraphOverviewResponse> {
  return jsonFetch<GraphOverviewResponse>(`/graph/overview?limit=${limit}`);
}

export async function listArchive(limit = 100): Promise<ArchiveItem[]> {
  const body = await jsonFetch<{ archive: ArchiveItem[] }>(`/archive?limit=${limit}`);
  return body.archive ?? [];
}

export function editMemory(id: number, content: string, expectedRevision: number, reason?: string): Promise<MemoryDetailResponse> {
  return jsonFetch<MemoryDetailResponse>("/memories/" + encodeURIComponent(String(id)), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, expectedRevision, reason, source: "dashboard", editor: "dashboard" }),
  });
}

export function listArchivePage(limit = 50, cursor?: string): Promise<ArchivePage> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor !== undefined) params.set("cursor", cursor);
  return jsonFetch<ArchivePage>("/archive?" + params.toString());
}

export function restoreArchiveItem(id: number): Promise<{ restored: boolean }> {
  return jsonFetch<{ restored: boolean }>(`/archive/${encodeURIComponent(String(id))}/restore`, {
    method: "POST",
  });
}

export async function listCleanupProposals(limit = 20, offset = 0): Promise<{
  proposals: CleanupProposal[];
  total: number;
}> {
  return jsonFetch<{ proposals: CleanupProposal[]; total: number }>(
    `/cleanup-proposals?status=pending&limit=${limit}&offset=${offset}`,
  );
}

export function getPersonDetail(id: string): Promise<PersonDetailResponse> {
  return jsonFetch<PersonDetailResponse>(`/persons/${encodeURIComponent(id)}`);
}

export function getProjectDetail(id: string): Promise<ProjectDetailResponse> {
  return jsonFetch<ProjectDetailResponse>(`/projects/${encodeURIComponent(id)}`);
}

export function getCleanupProposal(id: string): Promise<CleanupProposalDetail> {
  return jsonFetch<CleanupProposalDetail>(`/cleanup-proposals/${encodeURIComponent(id)}`);
}

export function actOnEntityRegisterProposal(id: string, choices: Record<string, unknown>): Promise<CleanupProposalActionResult> {
  return jsonFetch<CleanupProposalActionResult>(`/cleanup-proposals/${encodeURIComponent(id)}/approve`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choices }),
  });
}

export function actOnCleanupProposal(
  id: string,
  action: "approve" | "reject",
  itemKeys?: string[],
): Promise<CleanupProposalActionResult> {
  return jsonFetch<CleanupProposalActionResult>(
    `/cleanup-proposals/${encodeURIComponent(id)}/${action}`,
    {
      method: "POST",
      ...(action === "approve" && itemKeys !== undefined ? {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemKeys }),
      } : {}),
    },
  );
}

/** 기억(원문 + 추출 자식)을 휴지통으로 이동한다. 영구 삭제가 아니라 /archive 에서 복원 가능. */
export function trashMemory(
  id: number,
): Promise<{ trashed: number; cascadeTrashedIds: number[] }> {
  return jsonFetch<{ trashed: number; cascadeTrashedIds: number[] }>(
    `/memories/${encodeURIComponent(String(id))}/trash`,
    { method: "POST" },
  );
}

export function getCleanupRunAvailability(): Promise<CleanupRunAvailability> {
  return jsonFetch<CleanupRunAvailability>("/api/cleanup-runs/availability");
}

export function startCleanupRun(idempotencyKey: string): Promise<{ runId: string }> {
  return jsonFetch<{ runId: string }>("/api/cleanup-runs", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idempotencyKey }),
  });
}

export function getCleanupRun(runId: string): Promise<CleanupRunView> {
  return jsonFetch<CleanupRunView>(`/api/cleanup-runs/${encodeURIComponent(runId)}`);
}

/** limit 을 빼면 서버 상수(recentListDefaultLimit)가 목록 크기를 정한다. */
export function listEntityRegisterRecords(offset = 0): Promise<{ records: RecentAutoRegisterItem[]; total: number }> {
  return jsonFetch(`/api/entity-register/records?offset=${offset}`);
}

export function revertEntityRegisterRecord(id: number): Promise<{ reverted: number; result: EntityRegisterRevertResult }> {
  return jsonFetch(`/api/entity-register/records/${encodeURIComponent(String(id))}/revert`, { method: "POST" });
}
