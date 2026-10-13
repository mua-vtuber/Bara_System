export interface NodeWindow {
  nodeId: string;
  pos: { x: number; y: number };
  z: number;
}

/** 동시 창 최대 개수. 최대 4개까지 띄워 노드를 나란히 비교한다. */
export const MAX_NODE_WINDOWS = 4;

/** 노드 재클릭 3-상태 판정 결과. */
export type NodeClickAction = "open" | "focus" | "close";

/**
 * 노드를 다시 눌렀을 때 무엇을 할지 정하는 순수 함수.
 * - 그 노드 창이 없으면 새로 연다(open).
 * - 그 노드 창이 맨 앞(최상위 z)이면 닫는다(close).
 * - 그 노드 창이 다른 창에 묻혀 있으면 맨 앞으로 끌어올린다(focus).
 */
export function resolveNodeClickAction(
  windows: NodeWindow[],
  nodeId: string,
): NodeClickAction {
  const win = windows.find((w) => w.nodeId === nodeId);
  if (!win) return "open";
  const maxZ = windows.reduce((m, w) => Math.max(m, w.z), -Infinity);
  return win.z === maxZ ? "close" : "focus";
}

export class NodeWindowManager {
  private windows: NodeWindow[] = [];
  private zTop = 1;

  constructor(private readonly max: number = MAX_NODE_WINDOWS) {}

  open(nodeId: string, pos = { x: 80, y: 80 }): NodeWindow {
    const existing = this.windows.find((w) => w.nodeId === nodeId);
    if (existing) {
      this.focus(nodeId);
      return existing;
    }
    const win: NodeWindow = { nodeId, pos: { ...pos }, z: ++this.zTop };
    this.windows.push(win);
    while (this.windows.length > this.max) {
      this.windows.shift();
    }
    return win;
  }

  focus(nodeId: string): void {
    const win = this.windows.find((w) => w.nodeId === nodeId);
    if (win) win.z = ++this.zTop;
  }

  move(nodeId: string, pos: { x: number; y: number }): void {
    const win = this.windows.find((w) => w.nodeId === nodeId);
    if (win) win.pos = pos;
  }

  close(nodeId: string): void {
    this.windows = this.windows.filter((w) => w.nodeId !== nodeId);
  }

  list(): NodeWindow[] {
    return [...this.windows];
  }

  /** 최상위 z 창의 nodeId(창이 없으면 null). */
  frontNodeId(): string | null {
    if (this.windows.length === 0) return null;
    return this.windows.reduce((a, b) => (a.z >= b.z ? a : b)).nodeId;
  }
}
