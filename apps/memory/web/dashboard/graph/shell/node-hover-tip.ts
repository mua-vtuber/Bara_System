/**
 * shell/node-hover-tip.ts
 * 마우스가 올라간 노드 옆에 작은 요약 카드를 띄워, 그 노드를 따라 떠다니게 한다.
 * 호스트(컨트롤러)가 매 프레임 노드의 화면 좌표를 알려주면 팁이 그 옆으로 따라간다.
 * 카드 표면(배경·테두리)은 안쪽 .card--hover 가 그리고, 팁 래퍼는 위치·쌓임만 둔다.
 * 팁은 pointer-events:none 이라 아래 노드 클릭을 막지 않는다.
 */

export interface HoverTipHost {
  getNodeScreenPosition(nodeId: string): { x: number; y: number; visible: boolean } | null;
  onFrame(cb: () => void): void;
}

export interface HoverTip {
  show(nodeId: string, card: HTMLElement): void;
  hide(): void;
}

export function createHoverTip(container: HTMLElement, host: HoverTipHost): HoverTip {
  const tip = document.createElement("div");
  tip.classList.add("node-hover-tip");
  tip.style.display = "none";
  tip.style.pointerEvents = "none";
  container.appendChild(tip);

  // 지금 따라가는 노드 id. null 이면 팁이 꺼진 상태다.
  let currentNodeId: string | null = null;

  // 현재 노드의 화면 좌표를 받아 팁 위치를 갱신한다 — 화면 밖이면 잠시 숨기되 id 는 유지한다.
  function updatePosition(): void {
    if (currentNodeId == null) return;
    const pos = host.getNodeScreenPosition(currentNodeId);
    if (!pos || !pos.visible) {
      // 노드가 화면 밖으로 나가면 표시만 끈다(다시 들어오면 자연히 복귀하게 id 는 그대로).
      tip.style.display = "none";
      return;
    }
    tip.style.display = "block";

    const tipW = tip.offsetWidth || 240;
    const tipH = tip.offsetHeight || 100;
    let tx = pos.x + 14;
    let ty = pos.y - tipH - 14;
    const w = container.clientWidth;
    const h = container.clientHeight;
    // 오른쪽으로 넘치면 노드 왼쪽으로 뒤집고, 위로 넘치면 노드 아래로 내린다.
    if (tx + tipW + 12 > w) tx = pos.x - tipW - 24;
    if (ty < 8) ty = pos.y + 18;
    if (ty + tipH + 12 > h) ty = h - tipH - 12;
    tip.style.left = tx + "px";
    tip.style.top = ty + "px";
  }

  // 매 프레임 위치를 따라가게 한 번만 등록한다(클로저라 createHoverTip 당 1회).
  host.onFrame(() => updatePosition());

  function show(nodeId: string, card: HTMLElement): void {
    currentNodeId = nodeId;
    tip.replaceChildren(card);
    tip.style.display = "block";
    // 첫 프레임을 기다리지 않고 즉시 한 번 자리를 잡는다.
    updatePosition();
  }

  function hide(): void {
    currentNodeId = null;
    tip.style.display = "none";
  }

  return { show, hide };
}
