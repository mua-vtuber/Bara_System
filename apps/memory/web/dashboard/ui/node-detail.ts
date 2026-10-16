/**
 * apps/memory/web/dashboard/ui/node-detail.ts
 *
 * CardView 를 inspect 표면으로 펼치는 컴포넌트.
 * 있는 정보만 그린다 — 없는 칸은 요소 자체를 만들지 않는다.
 */

import { el } from "./dom.ts";
import { memoryNumberChip } from "./memory-number.ts";
import { memoryInfoSection } from "./memory-info.ts";
import type { CardView, ImagePreview } from "./card-view.ts";
import { renderMarkdownSafe } from "./markdown.ts";
import { getToken } from "../api-fetch.js";
import {
  sourceBadge,
  stateBadge,
  markerBadge,
  scoreChip,
  tagChip,
  kindBadge,
  componentChips,
  scheduleLineText,
  isSameDisplayGraphKind,
} from "./badges.ts";

const MARKER_KEYS = ["important", "uncertain", "supersedes", "superseded"] as const;
type MarkerKey = (typeof MARKER_KEYS)[number];

export interface NodeDetailOptions {
  /** true 면 본문 snippet 이 타이핑되듯 드러난다. 클릭하면 즉시 전체 본문을 보여준다. */
  animateContent?: boolean;
}

const ACTIVE_DETAIL_TYPEWRITERS = new WeakMap<HTMLElement, () => boolean>();
const DETAIL_TYPEWRITER_MAX_TICKS = 130;
const DETAIL_TYPEWRITER_INTERVAL_MS = 18;

function assetPath(kind: "thumbs" | "assets", sha: string): string {
  return `/${kind}/${encodeURIComponent(sha)}`;
}

function withToken(path: string, token: string): string {
  return `${path}?token=${encodeURIComponent(token)}`;
}

function setImageSourceWithToken(img: HTMLImageElement, path: string): void {
  void getToken()
    .then((token) => {
      img.src = withToken(path, token);
    })
    .catch((caught) => {
      console.warn("[dashboard] 이미지 토큰 발급 실패:", caught);
    });
}

/** markers 에서 true 인 것만 배지 배열로 반환한다. */
function activeMarkerBadges(markers: CardView["markers"]): HTMLElement[] {
  if (markers == null) return [];
  return MARKER_KEYS.filter((k): boolean => markers[k as MarkerKey] === true).map(
    (k) => markerBadge(k as MarkerKey),
  );
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function renderSnippetContent(block: HTMLElement, view: CardView, snippet: string): void {
  if (view.renderMode !== "markdown") {
    block.textContent = snippet;
    return;
  }
  try {
    block.innerHTML = renderMarkdownSafe(snippet);
  } catch (caught) {
    console.warn("[dashboard] 마크다운 렌더 실패 — 평문 표시:", caught);
    block.textContent = snippet;
  }
}

/** 현재 상세 패널에 타이핑 중인 본문이 있으면 즉시 끝내고 true 를 돌린다. */
export function skipNodeDetailTypewriter(rootEl: HTMLElement | null): boolean {
  if (!rootEl) return false;
  const active = rootEl.querySelectorAll<HTMLElement>(
    '.node-detail__snippet[data-typewriter-active="true"]',
  );
  for (const snip of active) {
    const skip = ACTIVE_DETAIL_TYPEWRITERS.get(snip);
    if (skip?.() === true) return true;
  }
  return false;
}

function startSnippetTypewriter(block: HTMLElement, view: CardView, snippet: string): void {
  const chars = Array.from(snippet);
  if (chars.length === 0) return;

  let index = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = true;
  const stepSize = Math.max(1, Math.ceil(chars.length / DETAIL_TYPEWRITER_MAX_TICKS));

  const cleanup = (): void => {
    active = false;
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    block.classList.remove("node-detail__snippet--typing");
    delete block.dataset["typewriterActive"];
    ACTIVE_DETAIL_TYPEWRITERS.delete(block);
    block.removeEventListener("pointerdown", onSkipPointer);
    block.removeEventListener("click", onSkipPointer);
  };

  const finish = (): boolean => {
    if (!active) return false;
    cleanup();
    renderSnippetContent(block, view, snippet);
    return true;
  };

  function onSkipPointer(event: Event): void {
    if (finish()) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  const tick = (): void => {
    if (!active) return;
    if (!block.isConnected) {
      cleanup();
      return;
    }
    index = Math.min(chars.length, index + stepSize);
    block.textContent = chars.slice(0, index).join("");
    if (index >= chars.length) {
      finish();
      return;
    }
    timer = setTimeout(tick, DETAIL_TYPEWRITER_INTERVAL_MS);
  };

  block.classList.add("node-detail__snippet--typing");
  block.dataset["typewriterActive"] = "true";
  block.textContent = "";
  ACTIVE_DETAIL_TYPEWRITERS.set(block, finish);
  block.addEventListener("pointerdown", onSkipPointer);
  block.addEventListener("click", onSkipPointer);
  timer = setTimeout(tick, DETAIL_TYPEWRITER_INTERVAL_MS);
}

function snippetBlock(view: CardView, animateContent: boolean): HTMLElement {
  const className =
    view.renderMode === "markdown"
      ? "node-detail__snippet graph-node-snippet"
      : "node-detail__snippet";
  const snippet = view.snippet ?? "";
  const block = el("div", { className });
  if (animateContent && !prefersReducedMotion()) {
    startSnippetTypewriter(block, view, snippet);
    return block;
  }
  renderSnippetContent(block, view, snippet);
  return block;
}

function openImageModal(image: ImagePreview): void {
  const overlay = el("div", {
    className: "node-image-modal",
    role: "dialog",
    "aria-modal": "true",
  });
  const frame = el("div", { className: "node-image-modal__frame" });
  const close = el("button", {
    className: "node-image-modal__close",
    type: "button",
    title: "닫기",
    "aria-label": "닫기",
  }, "x") as HTMLButtonElement;
  const img = document.createElement("img");
  img.className = "node-image-modal__image";
  img.alt = image.alt ?? "image";
  img.decoding = "async";
  setImageSourceWithToken(img, assetPath("assets", image.assetSha256));

  function closeModal(): void {
    overlay.remove();
    document.removeEventListener("keydown", onKeyDown);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") closeModal();
  }

  close.addEventListener("click", closeModal);
  overlay.addEventListener("click", (event: MouseEvent) => {
    if (event.target === overlay) closeModal();
  });
  document.addEventListener("keydown", onKeyDown);

  frame.append(close, img);
  overlay.append(frame);
  document.body.append(overlay);
  close.focus();
}

function imagePreviews(images: ImagePreview[]): HTMLElement {
  const items = images.map((image) => {
    const button = el("button", {
      className: "node-detail__image-thumb",
      type: "button",
      title: "원본 이미지 보기",
      "aria-label": image.alt ? `${image.alt} 원본 보기` : "원본 이미지 보기",
    }) as HTMLButtonElement;
    const img = document.createElement("img");
    img.alt = image.alt ?? "image";
    img.loading = "lazy";
    img.decoding = "async";
    setImageSourceWithToken(
      img,
      assetPath("thumbs", image.thumbSha256 ?? image.assetSha256),
    );
    button.append(img);
    button.addEventListener("click", () => openImageModal(image));
    return button;
  });
  return el("div", { className: "node-detail__images" }, ...items);
}

/**
 * CardView → .node-detail 컨테이너 요소.
 * 있는 정보만 포함한다.
 */
export function nodeDetail(view: CardView, options: NodeDetailOptions = {}): HTMLElement {
  const container = el("div", { className: "node-detail" });

  // title — 항상
  container.append(el("div", { className: "node-detail__title" }, view.title));

  // snippet — 있으면
  if (view.snippet != null) {
    container.append(snippetBlock(view, options.animateContent === true));
  }

  if (view.images != null && view.images.length > 0) {
    container.append(imagePreviews(view.images));
  }

  // 배지 목록: sourceType + score + markers + state
  const badgeItems: HTMLElement[] = [];
  // 기억 번호 — 접히지 않는 배지 줄 맨 앞에 항상 보인다.
  if (view.memoryId != null) badgeItems.push(memoryNumberChip(view.memoryId));
  if (view.sourceType != null && !isSameDisplayGraphKind(view.sourceType, view.nodeType)) {
    badgeItems.push(sourceBadge(view.sourceType));
  }
  if (view.kind != null && view.kind.length > 0) badgeItems.push(kindBadge(view.kind));
  if (view.score != null) badgeItems.push(scoreChip(view.score));
  badgeItems.push(...activeMarkerBadges(view.markers));
  if (view.state != null) badgeItems.push(stateBadge(view.state));

  if (badgeItems.length > 0) {
    container.append(el("div", { className: "node-detail__badges" }, ...badgeItems));
  }

  // sources — 있고 비어있지 않으면
  if (view.sources != null && view.sources.length > 0) {
    const sourceRow = el(
      "div",
      { className: "node-detail__sources" },
      ...view.sources.map(sourceBadge),
    );
    container.append(sourceRow);
  }

  const componentItems = componentChips(view.components, 4);
  if (componentItems.length > 0) {
    container.append(
      el(
        "div",
        { className: "node-detail__components" },
        el("span", { className: "node-detail__components-label" }, "점수 구성"),
        ...componentItems,
      ),
    );
  }

  // matchReason — 있으면 각 사유 한 줄
  if (view.matchReason != null && view.matchReason.length > 0) {
    const matchBlock = el(
      "div",
      { className: "node-detail__match" },
      ...view.matchReason.map((reason) => el("div", {}, reason)),
    );
    container.append(matchBlock);
  }

  // tags — 있으면
  if (view.tags != null && view.tags.length > 0) {
    const tagRow = el(
      "div",
      { className: "node-detail__tags" },
      el("span", { className: "node-detail__tags-label" }, "태그"),
      ...view.tags.map(tagChip),
    );
    container.append(tagRow);
  }

  // 일정 — eventAt 있으면 '일정: 시작 → 종료'(종료 없으면 시작만). card__date 와 별 줄.
  if (view.eventAt != null) {
    const text = scheduleLineText(view.eventAt, view.eventUntil);
    container.append(el("div", { className: "node-detail__schedule" }, text));
  }

  // date — 있으면
  if (view.date != null) {
    container.append(el("div", { className: "card__date" }, view.date));
  }

  // 정보 — 장소·시각(출처)·작성자·저장 경로. 의미추출 섹션과 같은 접힘 요소(기본 접힘).
  if (view.info != null) {
    const infoSection = memoryInfoSection({ info: view.info });
    if (infoSection != null) container.append(infoSection);
  }

  return container;
}
