// 드래그 중 국소 출렁 순수 계산(spec 시각효과 #4). WebGL 비의존.
import type { GraphEdge } from "../graph-view-model.ts";
import { massOfSize, minGapOf } from "../layout/spacing.ts";
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";
export interface Vec3 { x: number; y: number; z: number; }

/** root 의 hops 단계 이내 이웃 id 집합(root 제외). 순수 BFS. */
export function neighborsWithin(edges: GraphEdge[], rootId: string, hops: number): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
    (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e.from);
  }
  const seen = new Set<string>([rootId]);
  let frontier = [rootId];
  for (let h = 0; h < hops; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (!seen.has(nb)) { seen.add(nb); next.push(nb); }
      }
    }
    frontier = next;
  }
  seen.delete(rootId);
  return seen;
}

/** 두 좌표 사이 거리. */
function distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 한 스텝 완화: anchor 는 anchorPos 로 고정, neighborIds 만 자연 길이 스프링으로 끌어 갱신한다.
 * 이웃 아닌 노드는 입력 위치 그대로 둔다. 순수 함수 — 새 Map 을 돌려준다.
 *
 * 옛 구현은 `(other - p) * k` 로 무조건 상대 위치로 끌어당겨 거리에 비례해 힘이 커졌고,
 * 연결 개수만큼 변위가 합산돼 지수적으로 발산했다(라인이 튀고 화면 밖으로 날아감).
 * 세 안전장치로 수렴을 보장한다:
 *  1. 자연 길이(rest length) — basePositions 의 원래 nb↔other 거리만큼 떨어져 있으려 한다.
 *     스프링 변위 = -단위벡터 * (현재거리 - 자연길이) * spring. 평형에서 힘 0.
 *  2. 연결 개수 정규화 — 이웃의 엣지 개수로 합산 변위를 나눠 평균. 연결 많은 노드 폭발 차단.
 *  3. 변위 클램프 — 한 스텝 변위 크기를 maxStep 으로 제한해 한 번 튀어도 더 세게 안 당겨진다.
 *
 * @param basePositions 자연 길이 계산 기준 좌표(force 레이아웃 결과·드래그 정착 좌표).
 *                      비어 있거나 키가 없는 쌍은 현재 거리를 자연 길이로 본다(=그 쌍은 평형).
 */
export function relaxStep(
  anchorId: string,
  anchorPos: Vec3,
  neighborIds: Set<string>,
  positions: Map<string, Vec3>,
  edges: GraphEdge[],
  spring: number,
  maxStep: number,
  basePositions: Map<string, Vec3>,
): Map<string, Vec3> {
  const out = new Map<string, Vec3>(positions);
  out.set(anchorId, { ...anchorPos });

  for (const nb of neighborIds) {
    const p = out.get(nb);
    if (!p) continue;
    const baseP = basePositions.get(nb);

    let dx = 0, dy = 0, dz = 0;
    let edgeCount = 0;
    for (const e of edges) {
      let other: string | null = null;
      if (e.from === nb) other = e.to;
      else if (e.to === nb) other = e.from;
      if (!other) continue;

      const op = other === anchorId ? anchorPos : out.get(other);
      if (!op) continue;
      edgeCount++;

      const cx = p.x - op.x, cy = p.y - op.y, cz = p.z - op.z;
      const dist = Math.sqrt(cx * cx + cy * cy + cz * cz);
      // 같은 위치면(거리 0) 단위벡터를 못 구한다 — 이 엣지는 변위 0 으로 건너뛴다.
      if (dist < 1e-6) continue;

      // 자연 길이: basePositions 기준 nb↔other 원래 거리. 기준 없으면 현재 거리(=평형).
      const baseOther = other === anchorId
        ? basePositions.get(anchorId)
        : basePositions.get(other);
      const rest = (baseP && baseOther) ? distance(baseP, baseOther) : dist;

      // 스프링 변위 = -단위벡터 * (현재거리 - 자연길이) * spring.
      // 현재거리>자연길이면 op 쪽으로 당기고, 짧으면 밀어낸다.
      const factor = -((dist - rest) / dist) * spring;
      dx += cx * factor;
      dy += cy * factor;
      dz += cz * factor;
    }

    if (edgeCount === 0) continue;
    // 연결 개수로 평균(정규화) — 연결 많은 노드가 한 스텝에 폭발하지 않게.
    dx /= edgeCount;
    dy /= edgeCount;
    dz /= edgeCount;

    // 합산 변위 크기를 maxStep 으로 클램프 — 한 번 튀어도 다음 스텝이 더 커지지 않게.
    const mag = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (mag > maxStep) {
      const s = maxStep / mag;
      dx *= s; dy *= s; dz *= s;
    }

    out.set(nb, { x: p.x + dx, y: p.y + dy, z: p.z + dz });
  }
  return out;
}

/** 속도 적분 스텝 옵션. spring=가속도 비율, damping<1=감쇠, maxStep=위치 변화 상한, maxVel=속도 상한. */
export interface PhysicsStepOpts {
  /** 스프링 가속도 비율(0~1). 현재거리−자연길이에 곱해 힘으로 누적한다. */
  spring: number;
  /** 감쇠 계수(1 미만). 매 스텝 속도에 곱해 에너지를 빼고 발산을 막는다. */
  damping: number;
  /** 한 스텝 위치 변화 크기 상한(world 단위). 한 번 튀어도 더 세게 안 끌리게 이중 안전. */
  maxStep: number;
  /** 한 스텝 속도 크기 상한(world 단위). 빠르게 누적돼도 위치가 폭발하지 않게 클램프. */
  maxVel: number;
  /**
   * 자연길이 배수(radii 모드 전용) — 최소간격 × 이 값이 maxDist 가 된다.
   * 이 범위 안에서 줄이 느슨해(free zone) 힘이 0 이다. radii 없을 때 무시.
   */
  slackFactor?: number;
  /**
   * 끌어당김 스프링 세기(radii 모드 전용) — maxDist 초과 시 당기는 힘에 쓴다.
   * 생략 시 spring 값을 그대로 사용한다.
   */
  pullSpring?: number;
  /**
   * 충돌 보정 강도(radii 모드 전용) — minGap 미만일 때 밀어내는 힘 배율.
   * 0 이면 위치 보정을 건너뛴다. 생략 시 0.
   */
  collisionStrength?: number;
}

/**
 * 속도(velocity) 기반 물리 한 스텝(시각효과 #4). position 만 굴리는 relaxStep 과 달리 각 이웃에
 * 속도 상태를 부여해 힘이 사라져도 관성으로 더 다가가다 감쇠로 느려진다 — anchor 를 놓아도 뒤따르던
 * 이웃이 살짝 더 모이고 멈춘다. anchor 는 anchorPos 고정, 이웃 아닌 노드는 위치·속도 불변.
 * 순수 함수 — 새 positions·velocities Map 두 개를 돌려준다.
 *
 * radii 가 없으면 기존 자연 길이 스프링 동작(하위 호환).
 * radii 가 있으면 세 구간 힘을 쓴다:
 *  - minGap 미만 → 밀어낸다(충돌).
 *  - minGap ~ maxDist → 힘 0(느슨한 줄 free zone).
 *  - maxDist 초과 → 당긴다(pullSpring).
 *  또한 무게(massOfSize)로 힘을 나눠 큰 노드가 덜 움직인다. 위치 적분 후 겹침 보정을 추가로 적용한다.
 *
 * 안전장치(radii 유무 공통):
 *  - 엣지 개수 정규화 — 연결 많은 노드 폭발 차단.
 *  - 감쇠(damping) — 관성 후 멈춤·발산 차단.
 *  - 속도 클램프(maxVel) — 빠른 누적 차단.
 *  - 위치 변화 클램프(maxStep) — 이중 안전, 발산 방지 핵심.
 *
 * @param velocities 이웃별 현재 속도. 키가 없으면 0 으로 시작한다.
 * @param basePositions 자연 길이 계산 기준 좌표. 비거나 키가 없는 쌍은 현재 거리를 자연 길이로 본다.
 * @param radii 노드 id → 반지름(월드 단위). 전달 시 느슨한 줄+무게 모드로 전환한다. 생략 시 기존 동작.
 */
export function relaxStepPhysics(
  anchorId: string,
  anchorPos: Vec3,
  neighborIds: Set<string>,
  positions: Map<string, Vec3>,
  velocities: Map<string, Vec3>,
  edges: GraphEdge[],
  basePositions: Map<string, Vec3>,
  opts: PhysicsStepOpts,
  radii?: Map<string, number>,
): { positions: Map<string, Vec3>; velocities: Map<string, Vec3> } {
  const { spring, damping, maxStep, maxVel } = opts;
  const outPos = new Map<string, Vec3>(positions);
  const outVel = new Map<string, Vec3>(velocities);
  outPos.set(anchorId, { ...anchorPos });

  // radii 모드에서 반지름 → size 역산에 쓰는 상수.
  const radiusFactor = GRAPH_RENDER_THEME.nodeSpacing.radiusFactor;
  const gapPadding = GRAPH_RENDER_THEME.nodeSpacing.gapPadding;
  // neighborIds 를 배열로 보관해 겹침 보정 시 다른 이웃 위치를 참조한다.
  const neighborArr = [...neighborIds];

  for (const nb of neighborIds) {
    const p = outPos.get(nb);
    if (!p) continue;
    const baseP = basePositions.get(nb);

    // 스프링 힘(가속도) 누적.
    let fx = 0, fy = 0, fz = 0;
    let edgeCount = 0;
    for (const e of edges) {
      let other: string | null = null;
      if (e.from === nb) other = e.to;
      else if (e.to === nb) other = e.from;
      if (!other) continue;

      const op = other === anchorId ? anchorPos : outPos.get(other);
      if (!op) continue;
      edgeCount++;

      const cx = p.x - op.x, cy = p.y - op.y, cz = p.z - op.z;
      const dist = Math.sqrt(cx * cx + cy * cy + cz * cz);
      // 같은 위치면(거리 0) 단위벡터를 못 구한다 — 이 엣지는 힘 0 으로 건너뛴다(NaN 가드).
      if (dist < 1e-6) continue;

      const baseOther = other === anchorId
        ? basePositions.get(anchorId)
        : basePositions.get(other);
      const rest = (baseP && baseOther) ? distance(baseP, baseOther) : dist;

      let factor: number;
      if (radii) {
        // 세 구간 힘: 충돌(밀어냄) / 자유(힘 0) / 팽팽(당김).
        const rNb = radii.get(nb) ?? 0;
        const rOther = radii.get(other) ?? 0;
        const minGap = minGapOf(rNb, rOther, gapPadding);
        const slack = opts.slackFactor ?? 1;
        // maxDist 는 rest 와 minGap 중 큰 값에 slackFactor 를 곱해 정한다.
        const maxDist = Math.max(rest, minGap) * slack;
        if (dist < minGap) {
          // minGap 미만 — 밀어낸다. 힘 방향은 cx(nb→other 반대 방향)이므로 양수가 되면 nb 가 other 에서 멀어진다.
          factor = -((dist - minGap) / dist) * Math.max(spring, opts.collisionStrength ?? spring);
        } else if (dist > maxDist) {
          // maxDist 초과 — 당긴다.
          factor = -((dist - maxDist) / dist) * (opts.pullSpring ?? spring);
        } else {
          // 자유 구간 — 힘 없음.
          factor = 0;
        }
      } else {
        // 기존 자연 길이 스프링 동작(하위 호환).
        factor = -((dist - rest) / dist) * spring;
      }

      fx += cx * factor;
      fy += cy * factor;
      fz += cz * factor;
    }

    // 현재 속도(없으면 0).
    const v = outVel.get(nb) ?? { x: 0, y: 0, z: 0 };

    if (edgeCount > 0) {
      // 엣지 개수로 평균(정규화) — 연결 많은 노드가 한 스텝에 폭발하지 않게.
      fx /= edgeCount;
      fy /= edgeCount;
      fz /= edgeCount;
    }

    if (radii) {
      // 무게로 나눠 큰(무거운) 노드가 덜 움직이게 한다.
      const rNb = radii.get(nb) ?? (GRAPH_RENDER_THEME.nodeSpacing.massRefSize * radiusFactor);
      const sizeNb = rNb / radiusFactor;
      const m = massOfSize(sizeNb);
      fx /= m; fy /= m; fz /= m;
    }

    // 속도 적분 + 감쇠: v = (v + force)·damping. 힘이 0 이어도 남은 속도가 damping 으로 줄며 멈춘다.
    let vx = (v.x + fx) * damping;
    let vy = (v.y + fy) * damping;
    let vz = (v.z + fz) * damping;

    // 속도 클램프 — 빠른 누적이 있어도 위치가 폭발하지 않게.
    const vmag = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (vmag > maxVel) {
      const s = maxVel / vmag;
      vx *= s; vy *= s; vz *= s;
    }

    // 한 스텝 위치 변화도 maxStep 으로 클램프(발산 방지 이중 안전 — 기존 핵심 안전장치 유지).
    let sx = vx, sy = vy, sz = vz;
    const smag = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (smag > maxStep) {
      const s = maxStep / smag;
      sx *= s; sy *= s; sz *= s;
    }

    if (radii) {
      // 위치 적분 후 anchor 와 다른 이웃 모두에 대해 최소거리 보정을 적용한다.
      const rNb = radii.get(nb) ?? 0;
      const strength = opts.collisionStrength ?? 0;
      // 비교 대상: anchor + 이미 갱신된 다른 이웃들.
      const checkAgainst: Array<[Vec3, number]> = [[anchorPos, radii.get(anchorId) ?? 0]];
      for (const other of neighborArr) {
        if (other === nb) continue;
        const op = outPos.get(other);
        if (op) checkAgainst.push([op, radii.get(other) ?? 0]);
      }

      let nx = p.x + sx, ny = p.y + sy, nz = p.z + sz;
      for (const [op, rO] of checkAgainst) {
        const ddx = nx - op.x, ddy = ny - op.y, ddz = nz - op.z;
        const dd = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
        const minGap = minGapOf(rNb, rO, gapPadding);
        if (dd >= minGap || dd < 1e-6) continue;
        // 겹침 만큼 밀어낸다. strength 가 1 이면 한 스텝에 완전 해소.
        const push = (minGap - dd) * strength;
        nx += (ddx / dd) * push;
        ny += (ddy / dd) * push;
        nz += (ddz / dd) * push;
      }

      // radii 경로: outVel·outPos 를 여기서 한 번만 설정하고 continue 로 기존 경로를 건너뛴다.
      outVel.set(nb, { x: vx, y: vy, z: vz });
      outPos.set(nb, { x: nx, y: ny, z: nz });
      continue;
    }

    // 기존 경로(radii 없을 때): 위에서 continue 하지 않았으므로 여기서 설정된다.
    outVel.set(nb, { x: vx, y: vy, z: vz });
    outPos.set(nb, { x: p.x + sx, y: p.y + sy, z: p.z + sz });
  }

  return { positions: outPos, velocities: outVel };
}
