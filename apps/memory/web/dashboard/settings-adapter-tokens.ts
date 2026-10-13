/**
 * dashboard/settings-adapter-tokens.ts — 어댑터 토큰 승인·권한 화면 (WP-B1-14).
 *
 * 권위: docs/decisions/2026-09-27-audit-fix-plan-memory-core.md WP-B1-14
 *       (다루는 문제 SA-3, CR-0(화면)). 서버 계약은 WP-B1-13
 *       (apps/memory/src/server-internal/routes/adapter-tokens.ts,
 *       apps/memory/SHARED_MEMORY.md).
 *
 * settings.ts(2634줄, 800줄 한계 초과)에서 어댑터 토큰 패널 전체를 옮긴다
 * (settings-backup-section.ts 선례) — DTO, API, 요청/발급 행 렌더, 패널,
 * adapterDescription(연합 앱 패널도 재사용). settings.ts 본체를 줄이기 위한
 * 분리이지, 동작을 새로 만드는 것이 아니다.
 *
 * 근본 원인(옛 코드): approve() 가 body 없이 POST 하고 DTO 에 scope 가 없어
 * 화면이 권한을 보이거나 고를 수 없었다(CR-0). 새 계약(WP-B1-13)은
 * GET /adapter-tokens 의 requests[] 에 requestedScope·existingAdapter,
 * issued[] 에 scope·legacyScope 를 실어 화면이 권한을 표시·선택할 재료를 준다.
 *
 * 대기 요청 기본 선택(SA-3 완료 기준):
 *   requestedScope 가 read-only·mcp-standard 면 그 값을 기본 선택.
 *   requestedScope 가 없으면 mcp-standard 기본.
 *   requestedScope 가 full 이면 기본 선택 없음(관리자가 직접 '전체 관리'를
 *   선택해야 승인 버튼이 켜진다) — full 요청 자동 승인 사고를 막는다.
 *
 * 기존 어댑터 재등록(SA-2 위험 표시): existingAdapter 가 있으면 경고 문구 +
 * "기존 토큰 공유"/"토큰 교체" 선택을 보인다. 공유 승인 시 고른 권한이 그
 * 어댑터의 모든 연결(공유 토큰)에도 적용됨을 알린다.
 *
 * 발급 행: 현재 권한 배지(옛 토큰은 legacyScope 안내) + 권한 변경 선택 +
 * 적용 버튼(PATCH /adapter-tokens/:adapterId/scope). 실패는 서버 오류 문구를
 * 그대로 토스트로 보여준다(silent 실패 금지).
 */

import { showToast } from "./form/toast";
import { apiFetch } from "./api-fetch";
import {
  ADAPTER_REQUEST_STATUS_LABELS,
  ADAPTER_TOKEN_LABELS,
  ADAPTER_TOKEN_LEGACY_SUFFIX,
  ADAPTER_TOKEN_SCOPE_DESCRIPTIONS,
  ADAPTER_TOKEN_SCOPE_LABELS,
} from "./settings-adapter-token-labels";
import { TOKEN_SCOPES, type TokenScope } from "../../src/federation/token-scope";

/**
 * "share" | "rotate" — 서버 계약(WP-B1-13, src/federation/sse-tokens.ts
 * ExistingTokenChoice)과 같은 값의 대시보드 쪽 로컬 정의다. sse-tokens.ts 를
 * 직접 import 하지 않는 이유: 그 모듈은 SseTokenStore(node:crypto 사용)를
 * 담은 서버 전용 코드라, dashboard 브라우저 번들(bun build --target browser)
 * 이 그 모듈까지 통째로 끌어들여 "Browser polyfill for node:crypto doesn't
 * have timingSafeEqual" 로 빌드가 깨진다(실측 확인). token-scope.ts 는
 * "의존성 없음"이 명시된 별도 파일이라 TokenScope 는 그대로 import 해도 안전.
 */
export type ExistingTokenChoice = "share" | "rotate";
export const EXISTING_TOKEN_CHOICES: readonly ExistingTokenChoice[] = ["share", "rotate"] as const;

// ── DTO — GET /adapter-tokens 응답 계약 (WP-B1-13 정합) ────────────────────

/** 이미 토큰이 발급된 같은 adapterId 의 현재 권한 정보. 새 어댑터면 null. */
export interface ExistingAdapterScopeDTO {
  scope: TokenScope;
  legacyScope: boolean;
}

export interface AdapterTokenRequestDTO {
  requestId: string;
  adapterId: string;
  displayName: string;
  description: string;
  endpoint: string;
  remoteAddr: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  /** 요청자가 밝힌 필요 권한. 승인 화면 표시용이며 권한 부여에 쓰지 않는다. */
  requestedScope: TokenScope | null;
  /** 같은 adapterId 로 이미 발급된 토큰이 있으면 그 현재 권한·옛 토큰 여부. */
  existingAdapter: ExistingAdapterScopeDTO | null;
}

export interface IssuedAdapterTokenDTO {
  adapterId: string;
  issuedAt: string | null;
  scope: TokenScope;
  /** 메타에 scope 칸이 없던 옛 토큰 = full 로 해석된 토큰이면 true. */
  legacyScope: boolean;
}

export interface AdapterTokenManagementDTO {
  requests: AdapterTokenRequestDTO[];
  issued: IssuedAdapterTokenDTO[];
}

// ── API ─────────────────────────────────────────────────────────────────

export interface ApproveAdapterTokenOptions {
  /** 생략 시 서버 기본값(신규 어댑터 mcp-standard / 기존 어댑터 현재 권한 유지). */
  scope?: TokenScope;
  /** 생략 = share(현행). 기존 어댑터 재등록에서만 의미가 있다. */
  existingToken?: ExistingTokenChoice;
}

export interface AdapterTokenManagementApi {
  list(): Promise<AdapterTokenManagementDTO>;
  approve(requestId: string, options?: ApproveAdapterTokenOptions): Promise<void>;
  reject(requestId: string): Promise<void>;
  revoke(adapterId: string): Promise<void>;
  setScope(adapterId: string, scope: TokenScope): Promise<void>;
}

async function parseJsonError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

export function createAdapterTokenManagementApi(): AdapterTokenManagementApi {
  async function ensureOk(res: Response, fallback: string): Promise<void> {
    if (res.ok) return;
    throw new Error(await parseJsonError(res, fallback));
  }
  return {
    async list() {
      const res = await apiFetch("/adapter-tokens");
      if (!res.ok) {
        throw new Error(await parseJsonError(res, "어댑터 토큰 목록 조회 실패"));
      }
      return (await res.json()) as AdapterTokenManagementDTO;
    },
    async approve(requestId, options) {
      const body: Record<string, unknown> = {};
      if (options?.scope !== undefined) body.scope = options.scope;
      if (options?.existingToken !== undefined) body.existingToken = options.existingToken;
      const res = await apiFetch(`/adapter-tokens/${encodeURIComponent(requestId)}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await ensureOk(res, "어댑터 토큰 승인 실패");
    },
    async reject(requestId) {
      const res = await apiFetch(`/adapter-tokens/${encodeURIComponent(requestId)}/reject`, {
        method: "POST",
      });
      await ensureOk(res, "어댑터 토큰 거절 실패");
    },
    async revoke(adapterId) {
      const res = await apiFetch(`/adapter-tokens/${encodeURIComponent(adapterId)}`, {
        method: "DELETE",
      });
      await ensureOk(res, "어댑터 토큰 회수 실패");
    },
    async setScope(adapterId, scope) {
      const res = await apiFetch(`/adapter-tokens/${encodeURIComponent(adapterId)}/scope`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope }),
      });
      await ensureOk(res, "어댑터 권한 변경 실패");
    },
  };
}

// ── adapterDescription — 연합 앱 패널(settings.ts renderAdapterTab)도 사용 ──

/**
 * bot-discord 어댑터의 옛 영문/기술 설명을 사용자용 한글 문구로 바꾼다.
 * 다른 어댑터는 원문 그대로(서버가 준 description 자유 텍스트 신뢰).
 */
export function adapterDescription(adapterId: string, description: string): string {
  if (adapterId !== "bot-discord") return description;
  if (description === "Discord reference adapter") {
    return "디스코드 메시지를 메모리에 저장하는 기본 연결 앱입니다.";
  }
  if (
    description ===
    "메모리 모듈의 reference 입력 어댑터. 디스코드 메시지를 메모리에 기록하고, evolver 알림 / 슬래시 커맨드를 제공."
  ) {
    return "디스코드 메시지를 메모리에 저장하고, 메모리 알림과 슬래시 명령어를 제공하는 기본 연결 앱입니다.";
  }
  return description;
}

// ── 표시 헬퍼 ────────────────────────────────────────────────────────────

function formatAdapterTime(value: string | null): string {
  if (!value) return "기록 없음";
  return value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

/**
 * 승인·거절·회수·권한 변경 버튼 공통 래퍼. onClick 이 던지는 오류(서버 오류
 * 문구 포함)를 여기서 한 번 잡아 대시보드 기존 토스트 통로(showToast)로
 * 원인 그대로 보여준다 — QA 후속(21e08068): 옛 코드는 catch 가 없어 승인
 * (:389-397 근방)·거절·권한 변경·회수 실패가 unhandled rejection 으로
 * 사라지고 화면에 아무것도 안 남았다(silent 실패 — CLAUDE.md 금지 패턴).
 * 버튼 재활성은 그대로 finally 에 남긴다.
 */
function createAdapterTokenButton(
  label: string,
  className: string,
  onClick: () => Promise<void>,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await onClick();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      showToast(`${ADAPTER_TOKEN_LABELS.errorPrefix}: ${message}`, "error");
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

/** scope 선택 select — TOKEN_SCOPES 순서대로 옵션을 채운다. */
function createScopeSelect(
  className: string,
  selected: TokenScope | null,
): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = className;
  if (selected === null) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "권한 선택...";
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);
  }
  for (const scope of TOKEN_SCOPES) {
    const option = document.createElement("option");
    option.value = scope;
    option.textContent = ADAPTER_TOKEN_SCOPE_LABELS[scope];
    if (scope === selected) option.selected = true;
    select.appendChild(option);
  }
  return select;
}

function createScopeDescription(scope: TokenScope | null): HTMLParagraphElement {
  const desc = document.createElement("p");
  desc.className = "adapter-token-scope-desc";
  desc.textContent = scope === null ? "" : ADAPTER_TOKEN_SCOPE_DESCRIPTIONS[scope];
  return desc;
}

/**
 * requestedScope 로부터 대기 요청의 기본 선택을 정한다(SA-3 완료 기준):
 * read-only·mcp-standard 는 그 값 그대로, 없거나 full 이 아니면 mcp-standard,
 * full 이면 null(관리자가 직접 골라야 한다).
 */
function defaultScopeForRequest(requestedScope: TokenScope | null): TokenScope | null {
  if (requestedScope === "read-only" || requestedScope === "mcp-standard") {
    return requestedScope;
  }
  if (requestedScope === "full") return null;
  return "mcp-standard";
}

function requestedScopeLine(requestedScope: TokenScope | null): string {
  if (requestedScope === null) return ADAPTER_TOKEN_LABELS.requestedScopeUnspecified;
  return `${ADAPTER_TOKEN_LABELS.requestedScopePrefix}: ${ADAPTER_TOKEN_SCOPE_LABELS[requestedScope]}`;
}

function existingAdapterScopeLine(existing: ExistingAdapterScopeDTO): string {
  const scopeLabel = ADAPTER_TOKEN_SCOPE_LABELS[existing.scope];
  const legacy = existing.legacyScope ? `, ${ADAPTER_TOKEN_LEGACY_SUFFIX}` : "";
  return `${ADAPTER_TOKEN_LABELS.existingAdapterWarningPrefix} ${scopeLabel}${legacy}${ADAPTER_TOKEN_LABELS.existingAdapterWarningSuffix}`;
}

function renderInlineError(host: HTMLElement, message: string): void {
  host.textContent = "";
  const error = document.createElement("p");
  error.className = "adapter-token-error";
  error.textContent = `${ADAPTER_TOKEN_LABELS.errorPrefix}: ${message}`;
  host.appendChild(error);
}

// ── 대기 요청 행 ─────────────────────────────────────────────────────────

/**
 * export 이유(QA 후속, 21e08034): 존재하지 않는 requestId 를 가진 순수 데이터
 * fixture 로 이 행을 직접 렌더링해, "화면엔 아직 pending 인데 서버에는 그
 * 요청이 없는" 상황(요청 삭제·경합)에서 거절 버튼이 실 서버의 404 응답을
 * 정확히 토스트로 보여주는지 테스트한다. mock 클래스가 아니라 데이터
 * fixture 라 CLAUDE.md 테스트 정책과 맞는다.
 */
export function renderAdapterRequestRow(
  request: AdapterTokenRequestDTO,
  api: AdapterTokenManagementApi,
  reload: () => Promise<void>,
): HTMLElement {
  const row = document.createElement("article");
  row.className = `adapter-token-row adapter-token-row--${request.status}`;

  const main = document.createElement("div");
  main.className = "adapter-token-main";
  const title = document.createElement("h3");
  title.textContent = `${request.displayName} (${request.adapterId})`;
  main.appendChild(title);

  const meta = document.createElement("p");
  meta.className = "adapter-token-meta";
  meta.textContent = [
    ADAPTER_REQUEST_STATUS_LABELS[request.status],
    `요청 ${formatAdapterTime(request.createdAt)}`,
    request.remoteAddr ? `접속 ${request.remoteAddr}` : "",
    request.endpoint ? `연결 주소 ${request.endpoint}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  main.appendChild(meta);

  if (request.description) {
    const desc = document.createElement("p");
    desc.className = "adapter-token-desc";
    desc.textContent = adapterDescription(request.adapterId, request.description);
    main.appendChild(desc);
  }

  const actions = document.createElement("div");
  actions.className = "adapter-token-actions";

  if (request.status === "pending") {
    const scopeBlock = document.createElement("div");
    scopeBlock.className = "adapter-token-scope-block";

    const requestedLine = document.createElement("p");
    requestedLine.className = "adapter-token-requested-scope";
    requestedLine.textContent = requestedScopeLine(request.requestedScope);
    scopeBlock.appendChild(requestedLine);

    // 기존 어댑터 재등록 경고 + 공유/교체 선택 (SA-2).
    let existingTokenChoice: ExistingTokenChoice = "share";
    if (request.existingAdapter) {
      const warning = document.createElement("p");
      warning.className = "adapter-token-existing-warning";
      warning.textContent = existingAdapterScopeLine(request.existingAdapter);
      scopeBlock.appendChild(warning);

      const choiceLabel = document.createElement("label");
      choiceLabel.className = "adapter-token-existing-choice-label";
      choiceLabel.textContent = ADAPTER_TOKEN_LABELS.existingTokenChoiceLabel;
      const choiceSelect = document.createElement("select");
      choiceSelect.className = "adapter-token-existing-choice";
      const choiceLabels: Record<ExistingTokenChoice, string> = {
        share: ADAPTER_TOKEN_LABELS.existingTokenChoiceShare,
        rotate: ADAPTER_TOKEN_LABELS.existingTokenChoiceRotate,
      };
      for (const choice of EXISTING_TOKEN_CHOICES) {
        const option = document.createElement("option");
        option.value = choice;
        option.textContent = choiceLabels[choice];
        choiceSelect.appendChild(option);
      }
      choiceSelect.addEventListener("change", () => {
        existingTokenChoice = choiceSelect.value as ExistingTokenChoice;
        appliesNotice.hidden = existingTokenChoice !== "share";
      });
      choiceLabel.appendChild(choiceSelect);
      scopeBlock.appendChild(choiceLabel);

      const appliesNotice = document.createElement("p");
      appliesNotice.className = "adapter-token-existing-applies-notice";
      appliesNotice.textContent = ADAPTER_TOKEN_LABELS.existingAdapterScopeAppliesNotice;
      appliesNotice.hidden = false;
      scopeBlock.appendChild(appliesNotice);
    }

    const scopeLabel = document.createElement("label");
    scopeLabel.className = "adapter-token-scope-select-label";
    scopeLabel.textContent = ADAPTER_TOKEN_LABELS.scopeSelectLabel;
    let selectedScope = defaultScopeForRequest(request.requestedScope);
    const scopeSelect = createScopeSelect("adapter-token-scope-select", selectedScope);
    const scopeDesc = createScopeDescription(selectedScope);
    scopeLabel.appendChild(scopeSelect);
    scopeBlock.appendChild(scopeLabel);
    scopeBlock.appendChild(scopeDesc);

    const fullNotice = document.createElement("p");
    fullNotice.className = "adapter-token-full-confirm-notice";
    fullNotice.textContent = ADAPTER_TOKEN_LABELS.fullScopeConfirmNotice;
    fullNotice.hidden = selectedScope !== null;
    scopeBlock.appendChild(fullNotice);

    const approveBtn = createAdapterTokenButton(
      ADAPTER_TOKEN_LABELS.approveBtn,
      "adapter-token-primary",
      async () => {
        if (selectedScope === null) return;
        await api.approve(request.requestId, {
          scope: selectedScope,
          existingToken: request.existingAdapter ? existingTokenChoice : undefined,
        });
        showToast(ADAPTER_TOKEN_LABELS.approveSuccessToast, "success");
        await reload();
      },
    );
    approveBtn.disabled = selectedScope === null;

    scopeSelect.addEventListener("change", () => {
      const value = scopeSelect.value;
      selectedScope = value === "" ? null : (value as TokenScope);
      scopeDesc.textContent = selectedScope === null ? "" : ADAPTER_TOKEN_SCOPE_DESCRIPTIONS[selectedScope];
      fullNotice.hidden = selectedScope !== null;
      approveBtn.disabled = selectedScope === null;
    });

    main.appendChild(scopeBlock);
    actions.appendChild(approveBtn);
    actions.appendChild(
      createAdapterTokenButton(ADAPTER_TOKEN_LABELS.rejectBtn, "adapter-token-secondary", async () => {
        await api.reject(request.requestId);
        showToast(ADAPTER_TOKEN_LABELS.rejectSuccessToast, "success");
        await reload();
      }),
    );
  }

  row.appendChild(main);
  row.appendChild(actions);
  return row;
}

// ── 발급 행 ─────────────────────────────────────────────────────────────

function renderIssuedAdapterRow(
  issued: IssuedAdapterTokenDTO,
  api: AdapterTokenManagementApi,
  reload: () => Promise<void>,
): HTMLElement {
  const row = document.createElement("article");
  row.className = "adapter-token-row adapter-token-row--issued";

  const main = document.createElement("div");
  main.className = "adapter-token-main";
  const title = document.createElement("h3");
  title.textContent = issued.adapterId;
  main.appendChild(title);
  const meta = document.createElement("p");
  meta.className = "adapter-token-meta";
  meta.textContent = `발급 ${formatAdapterTime(issued.issuedAt)}`;
  main.appendChild(meta);

  const currentScope = document.createElement("p");
  currentScope.className = "adapter-token-current-scope";
  const legacySuffix = issued.legacyScope ? ` · ${ADAPTER_TOKEN_LEGACY_SUFFIX}` : "";
  currentScope.textContent =
    `${ADAPTER_TOKEN_LABELS.currentScopePrefix}: ${ADAPTER_TOKEN_SCOPE_LABELS[issued.scope]}${legacySuffix}`;
  main.appendChild(currentScope);

  const scopeChangeRow = document.createElement("div");
  scopeChangeRow.className = "adapter-token-scope-change-row";
  let selectedScope: TokenScope = issued.scope;
  const scopeSelect = createScopeSelect("adapter-token-scope-select", selectedScope);
  const applyBtn = createAdapterTokenButton(
    ADAPTER_TOKEN_LABELS.changeScopeBtn,
    "adapter-token-secondary",
    async () => {
      await api.setScope(issued.adapterId, selectedScope);
      showToast(ADAPTER_TOKEN_LABELS.scopeChangeSuccessToast, "success");
      await reload();
    },
  );
  scopeSelect.addEventListener("change", () => {
    selectedScope = scopeSelect.value as TokenScope;
  });
  scopeChangeRow.appendChild(scopeSelect);
  scopeChangeRow.appendChild(applyBtn);
  main.appendChild(scopeChangeRow);

  const actions = document.createElement("div");
  actions.className = "adapter-token-actions";
  actions.appendChild(
    createAdapterTokenButton(ADAPTER_TOKEN_LABELS.revokeBtn, "adapter-token-danger", async () => {
      await api.revoke(issued.adapterId);
      showToast(ADAPTER_TOKEN_LABELS.revokeSuccessToast, "success");
      await reload();
    }),
  );

  row.appendChild(main);
  row.appendChild(actions);
  return row;
}

// ── 패널 ────────────────────────────────────────────────────────────────

export function renderAdapterTokenManagementPanel(
  api: AdapterTokenManagementApi = createAdapterTokenManagementApi(),
): HTMLElement {
  const root = document.createElement("section");
  root.className = "adapter-token-panel";

  const title = document.createElement("h2");
  title.className = "adapter-token-title";
  title.textContent = ADAPTER_TOKEN_LABELS.panelTitle;
  const intro = document.createElement("p");
  intro.className = "adapter-token-intro";
  intro.textContent = ADAPTER_TOKEN_LABELS.panelIntro;

  const pendingTitle = document.createElement("h3");
  pendingTitle.className = "adapter-token-section-title";
  pendingTitle.textContent = ADAPTER_TOKEN_LABELS.pendingSectionTitle;
  const pendingHost = document.createElement("div");
  pendingHost.className = "adapter-token-list";

  const issuedTitle = document.createElement("h3");
  issuedTitle.className = "adapter-token-section-title";
  issuedTitle.textContent = ADAPTER_TOKEN_LABELS.issuedSectionTitle;
  const issuedHost = document.createElement("div");
  issuedHost.className = "adapter-token-list";

  async function load(): Promise<void> {
    pendingHost.textContent = "불러오는 중...";
    issuedHost.textContent = "";
    try {
      const data = await api.list();
      pendingHost.textContent = "";
      issuedHost.textContent = "";
      const pending = data.requests.filter((r) => r.status === "pending");
      if (pending.length === 0) {
        const empty = document.createElement("p");
        empty.className = "adapter-token-empty";
        empty.textContent = ADAPTER_TOKEN_LABELS.pendingEmpty;
        pendingHost.appendChild(empty);
      } else {
        for (const request of pending) {
          pendingHost.appendChild(renderAdapterRequestRow(request, api, load));
        }
      }
      if (data.issued.length === 0) {
        const empty = document.createElement("p");
        empty.className = "adapter-token-empty";
        empty.textContent = ADAPTER_TOKEN_LABELS.issuedEmpty;
        issuedHost.appendChild(empty);
      } else {
        for (const issued of data.issued) {
          issuedHost.appendChild(renderIssuedAdapterRow(issued, api, load));
        }
      }
    } catch (e) {
      renderInlineError(pendingHost, e instanceof Error ? e.message : String(e));
    }
  }

  root.appendChild(title);
  root.appendChild(intro);
  root.appendChild(pendingTitle);
  root.appendChild(pendingHost);
  root.appendChild(issuedTitle);
  root.appendChild(issuedHost);
  void load();
  return root;
}
