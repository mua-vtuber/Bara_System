/**
 * render/top3-float.ts
 * 검색 Top3 카드를 그래프 캔버스 위에 띄운다.
 * 각 카드는 매 프레임 자기 노드 옆을 따라 떠다니고(좌표는 computeTop3CardLayout 가 계산),
 * 사용자가 드래그하면 그 자리에 고정된다. 카드와 노드를 잇는 leader line 은 노드를 계속 따라간다.
 */
import { memoryCard } from "../../ui/memory-card.ts";
import type { CardView } from "../../ui/card-view.ts";
import { computeTop3CardLayout } from "./top3-layout.ts";

export interface Top3FloatHost {
  getNodeScreenPosition(nodeId: string): { x: number; y: number; visible: boolean } | null;
  onFrame(cb: () => void): void;
}

/** 카드 한 장의 고정 크기. 좁은 화면 분기는 computeTop3CardLayout 안에서 offset 으로만 다룬다. */
const CARD = { w: 268, h: 188 } as const;

interface FloatEntry {
  btn: HTMLButtonElement;
  line: SVGLineElement;
  nodeId: string;
}

export interface Top3Layer {
  render(views: CardView[], onPick: (nodeId: string) => void): void;
  clear(): void;
}

export function createTop3Layer(
  container: HTMLElement,
  host: Top3FloatHost,
): Top3Layer {
  // SVG 선 레이어 — 카드보다 z 낮게(SVG 를 먼저, 카드를 나중에 append).
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("top3-leader-svg");
  container.appendChild(svg);

  let entries: FloatEntry[] = [];
  let frameRegistered = false;

  // 사용자가 드래그로 고정한 카드 위치. container 좌상단 기준 px. 키는 nodeId.
  const userPositions = new Map<string, { x: number; y: number }>();

  function removeAll(): void {
    for (const e of entries) {
      if (e.btn.parentNode === container) container.removeChild(e.btn);
      if (e.line.parentNode === svg) svg.removeChild(e.line);
    }
    entries = [];
  }

  // 매 프레임 카드 위치와 leader line 을 전체 갱신한다.
  function updateLines(): void {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));

    const nodePoints = entries.map((e) => host.getNodeScreenPosition(e.nodeId));
    // 실제 렌더된 카드 크기를 읽어 배치·leader line 에 함께 쓴다. CSS 폭·내용 높이가
    // 바뀌어도 leader line 끝점이 카드에서 떨어져 보이지 않게 한다.
    const sample = entries.find((e) => e.btn.offsetWidth > 0)?.btn;
    const cardW = sample?.offsetWidth || CARD.w;
    const cardH = sample?.offsetHeight || CARD.h;
    const placements = computeTop3CardLayout({
      nodePoints,
      size: { w, h },
      card: { w: cardW, h: cardH },
      userPositions: entries.map((e) => userPositions.get(e.nodeId) ?? null),
    });

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const p = placements[i];
      const np = nodePoints[i];
      if (!e || !p) continue;

      if (p.hidden || !np) {
        e.btn.classList.add("top3-float-card--hidden");
        e.line.classList.add("top3-leader-line--hidden");
        continue;
      }

      e.btn.classList.remove("top3-float-card--hidden");
      e.line.classList.remove("top3-leader-line--hidden");

      e.btn.style.left = `${p.x}px`;
      e.btn.style.top = `${p.y}px`;

      // leader line: 카드 하단 중앙 → 노드. 카드 실제 크기로 끝점을 맞춘다(고정 상수 아님).
      const cw = e.btn.offsetWidth || cardW;
      const ch = e.btn.offsetHeight || cardH;
      e.line.setAttribute("x1", (p.x + cw / 2).toFixed(1));
      e.line.setAttribute("y1", (p.y + ch).toFixed(1));
      e.line.setAttribute("x2", np.x.toFixed(1));
      e.line.setAttribute("y2", np.y.toFixed(1));
    }
  }

  // 카드 한 장에 드래그를 붙인다.
  // 좌표계는 container 좌상단 기준 px 로, getNodeScreenPosition·layout 과 같은 기준이다.
  function attachDrag(
    btn: HTMLButtonElement,
    nodeId: string,
    onPick: (nodeId: string) => void,
  ): void {
    // 드래그 직후 따라오는 click 한 번을 막기 위한 플래그.
    let suppressClick = false;
    let dragging = false;
    let moved = false;
    // pointerdown 때 잡아 두는 값. dx0/dy0 = 카드 좌상단과 포인터의 어긋남.
    let dx0 = 0;
    let dy0 = 0;
    let containerRect = container.getBoundingClientRect();

    function onMove(ev: PointerEvent): void {
      if (!dragging) return;
      moved = true;
      const x = ev.clientX - containerRect.left - dx0;
      const y = ev.clientY - containerRect.top - dy0;
      userPositions.set(nodeId, { x, y });
    }

    function onUp(ev: PointerEvent): void {
      if (!dragging) return;
      dragging = false;
      try {
        btn.releasePointerCapture(ev.pointerId);
      } catch {
        // capture 가 이미 풀렸으면 무시한다(드래그 종료 정리뿐이라 안전).
      }
      btn.removeEventListener("pointermove", onMove);
      btn.removeEventListener("pointerup", onUp);
      btn.removeEventListener("pointercancel", onUp);
      // 실제 이동이 있었으면 곧장 따라오는 click 을 한 번 무시한다.
      if (moved) suppressClick = true;
    }

    btn.addEventListener("pointerdown", (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      containerRect = container.getBoundingClientRect();
      const left = parseFloat(btn.style.left || "0");
      const top = parseFloat(btn.style.top || "0");
      dx0 = ev.clientX - containerRect.left - left;
      dy0 = ev.clientY - containerRect.top - top;
      dragging = true;
      moved = false;
      btn.setPointerCapture(ev.pointerId);
      btn.addEventListener("pointermove", onMove);
      btn.addEventListener("pointerup", onUp);
      btn.addEventListener("pointercancel", onUp);
    });

    btn.addEventListener("click", () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      onPick(nodeId);
    });
  }

  return {
    render(views: CardView[], onPick: (nodeId: string) => void): void {
      removeAll();
      // 새 검색이면 새 top3 셋이라 사용자가 고정한 위치를 초기화한다.
      userPositions.clear();

      const count = Math.min(views.length, 3);
      for (let i = 0; i < count; i++) {
        const view = views[i];
        if (!view) continue;

        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.classList.add("top3-leader-line");
        svg.appendChild(line);

        const btn = document.createElement("button");
        btn.type = "button";
        btn.classList.add("top3-float-card");
        btn.dataset["nodeId"] = view.nodeId;
        btn.dataset["rank"] = String(i + 1);
        btn.title = view.title;
        btn.appendChild(memoryCard(view, "top3"));
        attachDrag(btn, view.nodeId, onPick);
        container.appendChild(btn);

        entries.push({ btn, line, nodeId: view.nodeId });
      }

      if (!frameRegistered) {
        host.onFrame(updateLines);
        frameRegistered = true;
      }

      updateLines();
    },

    clear(): void {
      removeAll();
      userPositions.clear();
      svg.setAttribute("width", "0");
      svg.setAttribute("height", "0");
    },
  };
}
