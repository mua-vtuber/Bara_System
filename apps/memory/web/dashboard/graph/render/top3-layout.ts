// Top3 카드 좌표 순수 계산 모듈.
//
// 검색 결과 Top3 카드를 각 노드의 화면 위치 옆에 띄울 때 쓰는 좌표를 계산한다.
// WebGL/DOM 에 의존하지 않는 순수 함수라 단위 테스트로 검증한다.
// 원본: docs/web_sample/src/app.jsx 의 Top3Floats useEffect 위치 계산.
// DOM·드래그·RAF 배선은 이 파일이 아니라 호출하는 쪽이 담당한다.

/** 노드의 화면 좌표. visible=false 면 화면 밖이라 카드도 숨긴다. */
export interface ScreenPoint {
  x: number;
  y: number;
  visible: boolean;
}

export interface Top3LayoutInput {
  /** top3 순서대로 담은 노드 화면 좌표. null 이면 좌표를 아직 못 구한 항목. */
  nodePoints: Array<ScreenPoint | null>;
  /** 그래프 화면(캔버스) 크기. */
  size: { w: number; h: number };
  /** 카드 한 장의 크기. */
  card: { w: number; h: number };
  /** 사용자가 드래그로 고정한 위치. 없으면 null. */
  userPositions: Array<{ x: number; y: number } | null>;
}

export interface Top3CardPlacement {
  index: number;
  x: number;
  y: number;
  hidden: boolean;
}

/** 카드 사이에 두는 최소 여백(px). 겹침 판정·이동에 같이 쓴다. */
const GAP = 12;
/** 겹침 회피로 한 번 비낄 때 더하는 간격(px). */
const SHIFT_PAD = 14;
/** 겹침 회피 반복 최대 횟수. */
const MAX_ATTEMPTS = 8;

interface PlacedCard {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** a 카드가 b 카드와 GAP 여백 기준으로 겹치는지 판정한다. */
function overlaps(
  ax: number,
  ay: number,
  cardW: number,
  cardH: number,
  b: PlacedCard,
): boolean {
  return (
    ax < b.x + b.w + GAP &&
    ax + cardW + GAP > b.x &&
    ay < b.y + b.h + GAP &&
    ay + cardH + GAP > b.y
  );
}

/**
 * Top3 카드들의 화면 좌표를 계산한다.
 *
 * - 노드가 없거나 화면 밖이면 hidden=true 로 표시한다.
 * - 사용자가 드래그로 고정한 카드는 그 좌표를 그대로 쓰고 겹침 회피 대상에서 뺀다.
 * - 자동 배치 카드는 노드에서 바깥으로 밀어내 두고 화면 안으로 클램프한 뒤,
 *   이미 놓인 자동 카드와 겹치면 최대 8회까지 비껴 옮긴다.
 */
export function computeTop3CardLayout(
  input: Top3LayoutInput,
): Top3CardPlacement[] {
  const { nodePoints, size, card, userPositions } = input;
  const cx = size.w / 2;
  const cy = size.h / 2;
  const margin = { top: 80, bottom: 132, side: 12 };

  const minX = margin.side;
  const maxX = Math.max(minX, size.w - card.w - margin.side);
  const minY = margin.top;
  const maxY = Math.max(minY, size.h - card.h - margin.bottom);

  const clampX = (x: number) => Math.max(minX, Math.min(maxX, x));
  const clampY = (y: number) => Math.max(minY, Math.min(maxY, y));

  const compact = size.w < 1000 || size.h < 640;
  const offset = compact ? 110 : 150;

  const placed: PlacedCard[] = [];
  const result: Top3CardPlacement[] = [];

  for (let index = 0; index < nodePoints.length; index++) {
    const point = nodePoints[index];
    if (!point || point.visible === false) {
      result.push({ index, x: 0, y: 0, hidden: true });
      continue;
    }

    const userPos = userPositions[index];
    if (userPos) {
      // 사용자가 일부러 둔 위치라 클램프도 안 하고 겹침 회피 대상에도 넣지 않는다.
      result.push({ index, x: userPos.x, y: userPos.y, hidden: false });
      continue;
    }

    // 노드에서 화면 중심 반대 방향으로 카드를 밀어낸다.
    let dx = point.x - cx;
    let dy = point.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    if (len < 50) {
      // 노드가 중심 근처라 방향이 모호하면 부채처럼 펼친다.
      const ang = ((index * 120 - 30) * Math.PI) / 180;
      dx = Math.cos(ang);
      dy = Math.sin(ang);
    } else {
      dx /= len;
      dy /= len;
    }

    let tx = clampX(point.x + dx * offset - card.w / 2);
    let ty = clampY(point.y + dy * offset - card.h / 2);

    // 이미 놓인 자동 카드와 겹치면 비껴 옮긴다.
    // 세로로만 밀면 두 카드 사이를 오가며 같은 자리로 되돌아오는 진동이 생긴다.
    // 직전에 들렀던 좌표를 기억해 두고, 세로 이동이 그 자리로 되돌아가려 하면
    // 세로 대신 가로로 보내 카드를 다른 열로 떼어 놓는다.
    const shiftV = card.h + SHIFT_PAD;
    const visited = new Set<string>([`${Math.round(tx)},${Math.round(ty)}`]);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const hit = placed.some((p) => overlaps(tx, ty, card.w, card.h, p));
      if (!hit) break;

      const downSpace = maxY - ty;
      const upSpace = ty - minY;

      // 세로 이동 후보를 먼저 골라 두고, 되돌이 좌표면 가로 이동으로 갈아탄다.
      let nextY: number | null = null;
      if (downSpace > shiftV) nextY = clampY(ty + shiftV);
      else if (upSpace > shiftV) nextY = clampY(ty - shiftV);

      const revisits =
        nextY !== null && visited.has(`${Math.round(tx)},${Math.round(nextY)}`);

      if (nextY !== null && !revisits) {
        ty = nextY;
      } else {
        const rightSpace = maxX - tx;
        const leftSpace = tx - minX;
        if (rightSpace > card.w + GAP) {
          tx = clampX(tx + card.w + SHIFT_PAD);
        } else if (leftSpace > card.w + GAP) {
          tx = clampX(tx - card.w - SHIFT_PAD);
        } else if (nextY !== null) {
          // 가로 공간이 없으면 세로 이동이라도 한다(되돌이여도 진행은 시킨다).
          ty = nextY;
        } else {
          break;
        }
      }
      visited.add(`${Math.round(tx)},${Math.round(ty)}`);
    }

    placed.push({ x: tx, y: ty, w: card.w, h: card.h });
    result.push({ index, x: tx, y: ty, hidden: false });
  }

  return result;
}
