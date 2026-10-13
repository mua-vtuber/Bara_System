/**
 * dashboard/settings-llm-style.ts — LLM 슬롯 DOM 의 스타일 부여 방식 (settings-llm-controls.ts 에서 분리).
 *
 * "class" = 설정 화면 기본(CSS 클래스), "inline" = 임베드용 소형 폼(인라인 스타일 + field-row 클래스).
 * 공급자 폼 모듈(settings-llm-provider-forms.ts)과 컨트롤 조립 모듈이 같은 프로필을 쓴다.
 */

/** 한 슬롯 DOM 의 스타일 부여 방식을 가르는 프로필. */
export interface StyleProfile {
  applySection(section: HTMLElement): void;
  makeHeading(text: string): HTMLElement;
  /** desc 단락 — 인라인 스타일 프로필은 null 반환(헤딩만). */
  makeDesc(text: string): HTMLElement | null;
  applyEnabledRow(row: HTMLElement, label: HTMLLabelElement): void;
  applyConfigBox(box: HTMLElement): void;
  applyFieldRow(row: HTMLElement): void;
  applyHint(hint: HTMLElement): void;
  applyBranchForm(form: HTMLElement): void;
}

export const CLASS_PROFILE: StyleProfile = {
  applySection(section) {
    section.className = "llm-section";
  },
  makeHeading(text) {
    const title = document.createElement("h2");
    title.className = "llm-section-title";
    title.textContent = text;
    return title;
  },
  makeDesc(text) {
    const desc = document.createElement("p");
    desc.className = "llm-section-desc";
    desc.textContent = text;
    return desc;
  },
  applyEnabledRow(row) {
    row.className = "llm-enabled-row";
  },
  applyConfigBox() {
    // settings configBox 는 id 만, 클래스/인라인 스타일 없음.
  },
  applyFieldRow(row) {
    row.className = "llm-field-row";
  },
  applyHint(hint) {
    hint.className = "llm-field-hint";
  },
  applyBranchForm(form) {
    form.className = "llm-branch-form";
  },
};

export const INLINE_PROFILE: StyleProfile = {
  applySection(section) {
    section.style.marginTop = "16px";
    section.style.padding = "12px";
    section.style.border = "1px solid #e0e0e0";
    section.style.borderRadius = "6px";
    section.style.background = "#fafafa";
  },
  makeHeading(text) {
    const heading = document.createElement("h3");
    heading.textContent = text;
    heading.style.fontSize = "1rem";
    heading.style.margin = "0 0 8px";
    return heading;
  },
  makeDesc() {
    // 인라인 임베드 폼은 헤딩만, desc 단락 없음.
    return null;
  },
  applyEnabledRow(row, label) {
    row.className = "field-row";
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "8px";
    label.style.display = "flex";
    label.style.alignItems = "center";
    label.style.gap = "6px";
    label.style.fontWeight = "600";
    label.style.cursor = "pointer";
  },
  applyConfigBox(box) {
    box.style.marginTop = "8px";
  },
  applyFieldRow(row) {
    row.className = "field-row";
  },
  applyHint(hint) {
    hint.className = "field-hint";
  },
  applyBranchForm() {
    // 인라인 임베드 폼은 id 만, 클래스 없음.
  },
};
