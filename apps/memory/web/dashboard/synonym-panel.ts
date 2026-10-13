/**
 * synonym-panel.ts — 동의어 설정 탭 패널 (웨이브3 항목12 B3).
 *
 * 사용자가 검색 동의어를 직접 통제하는 통로. term + synonym 을 입력해 추가하고,
 * 사용자가 추가한 쌍은 삭제한다. yaml 원본 사전 쌍은 출처를 "yaml" 로 표시하고
 * 읽기전용(삭제 버튼 없음) — user 쌍만 삭제 버튼이 붙는다.
 *
 * 한계 노출(조용한 fallback 금지 정합): query expansion 이 BM25/FTS5 키워드 채널에만
 * 들어가고 임베딩(의미) 검색엔 안 들어간다. 이 한계를 패널 위에 고정 안내문으로
 * 노출한다(spec 항목12 / 13.3).
 *
 * 설계 정신 — fetch 와 DOM 조립 분리(concept-alias-panel 본보기 그대로):
 *   - renderSynonymList 는 *순수 DOM 조립*. 행 데이터를 인자로 받아 DOM 만 만든다.
 *   - 실제 fetch 는 createSynonymPanelApi 가 별도 책임(synonym-panel-api.ts).
 *   - renderSynonymPanel 만 api 를 들고 추가·삭제 직후 목록을 다시 불러와 갱신한다.
 *
 * silent fallback 금지: api 실패 시 명시 에러 박스 + toast. 빈 목록으로 가리지
 * 않는다. 쌍 0건은 "등록된 동의어 없음" 안내만(정직한 빈 상태 — 가짜 샘플 0).
 */

import { showToast } from "./form/toast";
import {
  createSynonymPanelApi,
  type SynonymPanelApi,
  type SynonymRow,
} from "./synonym-panel-api";

/** 사용자 노출 문구 한 곳 모음 — 흩뿌리지 않는다. */
const LABELS = {
  title: "검색 동의어",
  intro:
    "같은 뜻의 다른 단어도 함께 찾도록 동의어를 등록합니다. 직접 추가한 동의어는 삭제할 수 있으며, 기본 사전의 동의어는 수정할 수 없습니다.",
  // 한계 노출 안내문(spec 항목12 고정 문구). 임베딩 검색엔 안 들어감을 글로 명시.
  embedNotice: "동의어는 단어를 찾는 키워드 검색에만 적용됩니다. 문장의 뜻을 비교하는 의미 검색에는 적용되지 않습니다.",
  termPlaceholder: "단어 (예: 고양이)",
  synonymPlaceholder: "동의어 (예: 냥이)",
  addBtn: "추가",
  deleteBtn: "삭제",
  sourceYaml: "기본",
  sourceUser: "추가",
  arrow: "→",
  empty: "등록된 동의어가 없습니다.",
  loadFailed: "동의어 목록을 불러오지 못했습니다",
  addFailed: "동의어 추가에 실패했습니다",
  deleteFailed: "동의어 삭제에 실패했습니다",
  addedToast: "동의어를 추가했습니다.",
  deletedToast: "동의어를 삭제했습니다.",
  needBothFields: "단어와 동의어를 모두 입력하세요.",
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

/**
 * 동의어 목록 순수 렌더 — term → synonym + 출처 배지. user 출처만 삭제 버튼이
 * 붙는다(yaml 은 읽기전용). onDelete(id) 는 user 행 삭제 버튼 클릭 시만 호출한다
 * (네트워크는 호출자 책임). 0건이면 빈 행 대신 "등록된 동의어 없음" 안내만.
 */
export function renderSynonymList(
  rows: SynonymRow[],
  onDelete: (id: string) => void,
): HTMLElement {
  const list = el("div", "synonym-list");

  if (rows.length === 0) {
    const empty = el("p", "synonym-empty", LABELS.empty);
    empty.dataset.synonymEmpty = "true";
    list.appendChild(empty);
    return list;
  }

  for (const row of rows) {
    const item = el("div", "synonym-row");
    item.dataset.synonymRow = "true";
    item.dataset.source = row.source;

    const pair = el("div", "synonym-pair");
    pair.appendChild(el("span", "synonym-term", row.term));
    pair.appendChild(el("span", "synonym-arrow", ` ${LABELS.arrow} `));
    pair.appendChild(el("span", "synonym-synonym", row.synonym));
    item.appendChild(pair);

    const badge = el(
      "span",
      "synonym-source-badge",
      row.source === "yaml" ? LABELS.sourceYaml : LABELS.sourceUser,
    );
    badge.dataset.source = row.source;
    item.appendChild(badge);

    // yaml 항목은 id 가 없고 읽기전용 — 삭제 버튼 없음. user 항목(id 보유)만 삭제 가능.
    if (row.source === "user" && row.id !== null) {
      const deleteBtn = el("button", "synonym-delete-btn", LABELS.deleteBtn);
      deleteBtn.type = "button";
      const id = row.id;
      deleteBtn.addEventListener("click", () => onDelete(id));
      item.appendChild(deleteBtn);
    }

    list.appendChild(item);
  }

  return list;
}

/**
 * 동의어 설정 패널 통째 — 제목 + 안내 + 임베딩 미반영 고정 안내문 + 입력 폼 + 목록.
 * 추가·삭제 직후 목록을 다시 불러와 즉시 갱신한다. fetch 실패 = 명시 에러 박스 + toast.
 * api 를 인자로 받지 않으면 실제 createSynonymPanelApi() 로 same-origin 호출한다.
 */
export function renderSynonymPanel(
  api: SynonymPanelApi = createSynonymPanelApi(),
): HTMLElement {
  const panel = el("div", "synonym-panel");
  panel.dataset.section = "synonym-panel";

  panel.appendChild(el("h2", "synonym-title", LABELS.title));
  panel.appendChild(el("p", "synonym-intro", LABELS.intro));

  // 한계 고정 안내문 — 임베딩 검색엔 안 들어감을 글로 노출(조용한 fallback 금지).
  const notice = el("p", "synonym-embed-notice", LABELS.embedNotice);
  notice.dataset.synonymEmbedNotice = "true";
  panel.appendChild(notice);

  // ── 입력 폼: 단어 + 동의어 + 추가 버튼 ──────────────────────────────────────
  const form = el("form", "synonym-add-form");
  const termInput = el("input", "synonym-term-input");
  termInput.type = "text";
  termInput.placeholder = LABELS.termPlaceholder;
  const synonymInput = el("input", "synonym-synonym-input");
  synonymInput.type = "text";
  synonymInput.placeholder = LABELS.synonymPlaceholder;
  const addBtn = el("button", "synonym-add-btn", LABELS.addBtn);
  addBtn.type = "submit";
  form.appendChild(termInput);
  form.appendChild(synonymInput);
  form.appendChild(addBtn);
  panel.appendChild(form);

  const listHost = el("div", "synonym-list-host");
  panel.appendChild(listHost);

  async function reload(): Promise<void> {
    listHost.textContent = "";
    try {
      const rows = await api.list();
      listHost.appendChild(renderSynonymList(rows, (id) => void deleteThenReload(id)));
    } catch (e) {
      const box = el(
        "p",
        "synonym-error",
        `${LABELS.loadFailed}: ${(e as Error).message}`,
      );
      listHost.appendChild(box);
    }
  }

  async function deleteThenReload(id: string): Promise<void> {
    try {
      await api.remove(id);
      showToast(LABELS.deletedToast, "success");
      await reload();
    } catch (e) {
      showToast(`${LABELS.deleteFailed}: ${(e as Error).message}`, "error");
    }
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void (async () => {
      const term = termInput.value.trim();
      const synonym = synonymInput.value.trim();
      if (term.length === 0 || synonym.length === 0) {
        showToast(LABELS.needBothFields, "error");
        return;
      }
      addBtn.disabled = true;
      try {
        await api.add({ term, synonym });
        showToast(LABELS.addedToast, "success");
        termInput.value = "";
        synonymInput.value = "";
        await reload();
      } catch (e) {
        showToast(`${LABELS.addFailed}: ${(e as Error).message}`, "error");
      } finally {
        addBtn.disabled = false;
      }
    })();
  });

  // 진입 시점 목록 로드 — 비동기(DOM 은 이미 만들어져 반환 가능).
  void reload();

  return panel;
}
