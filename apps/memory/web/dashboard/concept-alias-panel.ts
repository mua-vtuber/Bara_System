/**
 * concept-alias-panel.ts — D2 별칭 후보 게이트 패널 (Phase 6b T10 / 사용자 결정 1).
 *
 * 메모리 코어가 0.95+ 로 가까운 두 개념을 찾으면 자동으로 합치지 않고 여기 게이트에
 * 후보로 쌓아 둔다. 사용자가 두 개념 이름과 유사도를 보고 [합치기] 또는 [거절] 을
 * 직접 누른다(자동 합류 금지). [합치기] 를 누르면 그 즉시 합류 API 를 호출하고 목록을
 * 다시 불러와 갱신한다.
 *
 * 설계 정신 — fetch 와 DOM 조립 분리(테스트에 fetch mock 0):
 *   - renderConceptAliasList 는 *순수 DOM 조립*. 후보 데이터를 인자로 받아 DOM 만
 *     만들고 네트워크는 안 건드린다 → 단위 테스트가 plain 데이터로 렌더만 검증.
 *   - 실제 fetch 는 createConceptAliasPanelApi 가 별도 책임(T10 라우트 호출).
 *   - renderConceptAliasPanel 만 api 를 들고 resolve 직후 refetch 로 목록 갱신.
 *
 * silent fallback 금지: api 실패 시 명시 에러 박스 + toast. 빈 목록으로 가리지
 * 않는다. 후보 0건은 "후보 없음" 안내만(정직한 빈 게이트 — 가짜 후보 0).
 *
 * Phase 8 경계: 색·아이콘·그래프 시각화는 Phase 8(W10/R9) 권위라 여기 없다 —
 * 이 패널은 최소 기능 목록 + 합치기/거절 버튼만.
 */

import { showToast } from "./form/toast";
import { apiFetch } from "./api-fetch";

const API_BASE = "/api";

/** GET /api/concept-aliases 후보 한 건(concept-aliases.ts candidates[] 정합). */
export interface ConceptAliasCandidate {
  suggestion_id: string;
  new_concept_id: string;
  new_concept_name: string;
  candidate_concept_id: string;
  candidate_concept_name: string;
  cosine: number;
  status: "pending" | "merged" | "rejected";
}

/** 게이트 결정 action — 라우트 계약과 일치. */
export type ResolveAction = "merged" | "rejected";

/** 패널이 호출하는 API 계약 — 실제 fetch 구현은 createConceptAliasPanelApi. */
export interface ConceptAliasPanelApi {
  listPending(): Promise<ConceptAliasCandidate[]>;
  resolve(id: string, action: ResolveAction): Promise<void>;
}

const LABELS = {
  title: "비슷한 개념 후보 — 합칠까요?",
  intro:
    "메모리가 의미가 거의 같은 두 개념을 찾았습니다. 한 개념으로 합칠지 직접 결정하세요(자동으로 합치지 않습니다).",
  similarity: "유사도",
  mergeArrow: "←",
  mergeBtn: "합치기",
  rejectBtn: "거절",
  empty: "합칠지 결정할 후보가 없습니다.",
  loadFailed: "후보 목록을 불러오지 못했습니다",
  mergedToast: "두 개념을 합쳤습니다.",
  rejectedToast: "후보를 거절했습니다.",
  resolveFailed: "처리에 실패했습니다",
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** cosine(0~1) → 사람이 읽는 백분율 문자열(0.97 → "97%"). */
function similarityLabel(cosine: number): string {
  return `${Math.round(cosine * 100)}%`;
}

/**
 * 후보 목록 순수 렌더 — 두 개념 이름 + 유사도 + [합치기]·[거절] 버튼.
 * onResolve(suggestionId, action) 는 버튼 클릭 시 호출(네트워크는 호출자 책임).
 * 후보 0건이면 빈 행 대신 "후보 없음" 안내만(정직한 빈 게이트).
 */
export function renderConceptAliasList(
  candidates: ConceptAliasCandidate[],
  onResolve: (id: string, action: ResolveAction) => void,
): HTMLElement {
  const list = el("div", "alias-list");

  if (candidates.length === 0) {
    const empty = el("p", "alias-empty", LABELS.empty);
    empty.dataset.aliasEmpty = "true";
    list.appendChild(empty);
    return list;
  }

  for (const cand of candidates) {
    const row = el("div", "alias-row");
    row.dataset.aliasRow = "true";

    // 어느 개념 ↔ 어느 개념 — 신규(new)가 기존(candidate)으로 흡수됨을 화살표로 풀이.
    const pair = el("div", "alias-pair");
    pair.appendChild(el("span", "alias-candidate-name", cand.candidate_concept_name));
    pair.appendChild(el("span", "alias-arrow", ` ${LABELS.mergeArrow} `));
    pair.appendChild(el("span", "alias-new-name", cand.new_concept_name));
    row.appendChild(pair);

    const sim = el(
      "div",
      "alias-similarity",
      `${LABELS.similarity} ${similarityLabel(cand.cosine)}`,
    );
    row.appendChild(sim);

    const actions = el("div", "alias-actions");
    const mergeBtn = el("button", "alias-merge-btn", LABELS.mergeBtn);
    mergeBtn.type = "button";
    mergeBtn.addEventListener("click", () => onResolve(cand.suggestion_id, "merged"));
    actions.appendChild(mergeBtn);

    const rejectBtn = el("button", "alias-reject-btn", LABELS.rejectBtn);
    rejectBtn.type = "button";
    rejectBtn.addEventListener("click", () => onResolve(cand.suggestion_id, "rejected"));
    actions.appendChild(rejectBtn);

    row.appendChild(actions);
    list.appendChild(row);
  }

  return list;
}

/** T10 라우트를 same-origin 으로 호출하는 실제 API 구현. */
export function createConceptAliasPanelApi(): ConceptAliasPanelApi {
  return {
    async listPending() {
      const res = await apiFetch(`${API_BASE}/concept-aliases?status=pending`);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
      }
      const data = (await res.json()) as { candidates: ConceptAliasCandidate[] };
      return data.candidates;
    },
    async resolve(id, action) {
      const res = await apiFetch(
        `${API_BASE}/concept-aliases/${encodeURIComponent(id)}/resolve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
    },
  };
}

/**
 * 게이트 패널 통째 — 제목 + 안내 + 후보 목록. resolve 직후 목록을 다시 불러와
 * 즉시 갱신한다(합친 후보가 바로 빠진다). fetch 실패 = 명시 에러 박스 + toast.
 */
export function renderConceptAliasPanel(api: ConceptAliasPanelApi): HTMLElement {
  const panel = el("div", "alias-panel");
  panel.dataset.section = "concept-alias-panel";

  panel.appendChild(el("h2", "alias-title", LABELS.title));
  panel.appendChild(el("p", "alias-intro", LABELS.intro));

  const listHost = el("div", "alias-list-host");
  panel.appendChild(listHost);

  async function reload(): Promise<void> {
    listHost.textContent = "";
    try {
      const rows = await api.listPending();
      listHost.appendChild(renderConceptAliasList(rows, (id, action) => void resolveThenReload(id, action)));
    } catch (e) {
      const box = el("p", "alias-error", `${LABELS.loadFailed}: ${(e as Error).message}`);
      listHost.appendChild(box);
    }
  }

  async function resolveThenReload(id: string, action: ResolveAction): Promise<void> {
    try {
      await api.resolve(id, action);
      showToast(action === "merged" ? LABELS.mergedToast : LABELS.rejectedToast, "success");
      await reload();
    } catch (e) {
      showToast(`${LABELS.resolveFailed}: ${(e as Error).message}`, "error");
    }
  }

  // 진입 시점 목록 로드 — 비동기(DOM 은 이미 만들어져 반환 가능).
  void reload();

  return panel;
}
