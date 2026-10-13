/**
 * Dynamic-enum 위젯 (Phase 5.5.3 / spec section 5.5).
 *
 * 런타임 옵션 (디스코드 채널 / Ollama 모델 / Notion 페이지 등)을 드롭다운으로
 * 노출. 탭 진입 시 매니페스트 action (`returns: 'enum'`) 자동 호출 1회 +
 * *갱신* 버튼으로 재호출. labelField / valueField 반영.
 *
 * 본 위젯은 actions.ts 의 `dynamicEnumBus` 를 구독 — 폼 외부 액션
 * (`returns: 'enum'`) 도 같은 actionId 이면 본 위젯 옵션을 갱신할 수 있음
 * (spec section 6.5).
 */

import {
  assemble,
  createDescription,
  createErrorContainer,
  createFieldWrapper,
  createLabel,
  shouldShowDescription,
} from "./helpers";
import type { WidgetContext } from "./widget";
import {
  dynamicEnumBus,
  emitDynamicEnumRefresh,
  type ManifestAction,
} from "../actions";
import { showToast } from "../toast";
import { apiFetch } from "../../api-fetch";

export interface DynamicEnumOptions {
  /** 본 위젯의 actionId 가 가리키는 매니페스트 action. */
  action: ManifestAction;
  /** 어댑터 endpoint base URL (매니페스트 `endpoint`). */
  endpoint: string;
}

function isOptionRecord(
  v: unknown,
): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function renderDynamicEnumWidget(
  ctx: WidgetContext,
  options: DynamicEnumOptions,
): HTMLElement {
  const wrapper = createFieldWrapper();
  wrapper.dataset.widget = "dynamic-enum";
  wrapper.dataset.path = ctx.path;
  wrapper.dataset.actionId = options.action.id;

  const label = createLabel(ctx.key, ctx.schema, ctx.required ?? false);

  const row = document.createElement("div");
  row.className = "form-dynamic-enum-row";

  const select = document.createElement("select");
  select.className = "form-select";
  select.name = ctx.path;

  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "form-dynamic-enum-refresh";
  refreshBtn.textContent = "갱신";

  row.appendChild(select);
  row.appendChild(refreshBtn);

  const labelField = ctx.schema["x-ui"]?.labelField ?? "name";
  const valueField = ctx.schema["x-ui"]?.valueField ?? "id";
  let currentOptions: Array<{ label: string; value: string }> = [];

  function rebuildSelect(): void {
    select.innerHTML = "";
    if (!ctx.required) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "— 선택 —";
      select.appendChild(empty);
    }
    for (const opt of currentOptions) {
      const optEl = document.createElement("option");
      optEl.value = opt.value;
      optEl.textContent = opt.label;
      if (ctx.value === opt.value) optEl.selected = true;
      select.appendChild(optEl);
    }
  }

  function applyData(data: unknown[]): void {
    currentOptions = [];
    for (const item of data) {
      if (!isOptionRecord(item)) continue;
      const v = item[valueField];
      const l = item[labelField];
      if (typeof v !== "string" && typeof v !== "number") continue;
      const labelText =
        typeof l === "string" || typeof l === "number"
          ? String(l)
          : String(v);
      currentOptions.push({ value: String(v), label: labelText });
    }
    rebuildSelect();
  }

  async function fetchOptions(): Promise<void> {
    refreshBtn.disabled = true;
    try {
      const url = `${options.endpoint.replace(/\/$/, "")}${options.action.path}`;
      const res = await apiFetch(url, { method: options.action.method });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `액션 '${options.action.id}' 실패 — HTTP ${res.status}${text ? `: ${text}` : ""}`,
        );
      }
      const data = await res.json();
      if (!Array.isArray(data)) {
        throw new Error(
          `액션 '${options.action.id}' 응답이 배열 형태가 아님 (type=${typeof data})`,
        );
      }
      emitDynamicEnumRefresh(options.action.id, data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(msg, "error");
    } finally {
      refreshBtn.disabled = false;
    }
  }

  refreshBtn.addEventListener("click", () => {
    void fetchOptions();
  });

  select.addEventListener("change", () => {
    const v = select.value;
    if (v === "" && !ctx.required) {
      ctx.onChange(ctx.path, undefined);
      return;
    }
    ctx.onChange(ctx.path, v);
  });

  const eventType = `refresh:${options.action.id}`;
  const listener = (ev: Event): void => {
    const ce = ev as CustomEvent<{ data: unknown[] }>;
    if (ce.detail && Array.isArray(ce.detail.data)) {
      applyData(ce.detail.data);
    }
  };
  dynamicEnumBus.addEventListener(eventType, listener);

  rebuildSelect();
  // 탭 진입 시 자동 호출 1회 (spec section 5.5 + 6.3).
  void fetchOptions();

  const description = shouldShowDescription(ctx.schema) && ctx.schema.description
    ? createDescription(ctx.schema.description)
    : undefined;
  const errorEl = createErrorContainer();
  return assemble(wrapper, label, row, description, errorEl);
}
