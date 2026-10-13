/**
 * 해석적 방사 좌표 — buildHierarchy 의 계층에서 결정적 3D 좌표를 만든다.
 *
 * 루트(종류)는 구 표면 피보나치로 흩고, 자식은 부모가 들어온 방향(headDir) 둘레의
 * 하위 콘 안에 해바라기(골든앵글 + sqrt 반지름)로 균등 분포한다. 자식의 콘 half-angle 은
 * 부모 콘 × sqrt(자기 자손 잎 / 형제 총 잎) 이라 형제끼리 콘 면적이 안 겹쳐 가지 엉킴을 막는다.
 * 외톨이 글은 바깥 껍질에 흩고, 그 뒤 겹침만 보정한다. Math.random 미사용·결정적.
 *
 * 이 모듈은 좌표만 계산한다. 배선(Task 3)·정리(Task 5)는 범위 밖이다.
 */
import type { GraphNode, GraphEdge } from "../graph-view-model.ts";
import type { Vec3 } from "./force-layout.ts";
import { seedFromId } from "./force-layout.ts";
import { buildHierarchy, ORPHAN_PARENT } from "./radial-hierarchy.ts";
import { fibonacciAnchors } from "./ball-geometry.ts";
import { minGapOf } from "./spacing.ts";
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";

export interface RadialTokens {
  rootSphereRadius: number; depthStep: number; coneHalfAngle: number;
  orphanShellRadius: number; collisionPasses: number;
  entityClusterMinRadius: number; entityClusterLeafScale: number;
  entityClusterDepthScale: number; entityClusterGap: number;
}

function unit(v: Vec3): Vec3 { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; }
function basis(dir: Vec3): [Vec3, Vec3] {
  const ref: Vec3 = Math.abs(dir.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const a = unit({ x: dir.y * ref.z - dir.z * ref.y, y: dir.z * ref.x - dir.x * ref.z, z: dir.x * ref.y - dir.y * ref.x });
  const b = unit({ x: dir.y * a.z - dir.z * a.y, y: dir.z * a.x - dir.x * a.z, z: dir.x * a.y - dir.y * a.x });
  return [a, b];
}

export function computeRadialLayout(
  nodes: GraphNode[], edges: GraphEdge[], t: RadialTokens, radii?: Map<string, number>,
): Map<string, Vec3> {
  const pos = new Map<string, Vec3>();
  if (nodes.length === 0) return pos;
  const h = buildHierarchy(nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const rootDepthSpan = new Map<string, number>();
  const clusterRadii = new Map<string, number>();
  for (const r of h.roots) {
    const span = maxDepthOffset(r, h.childrenOf);
    rootDepthSpan.set(r, span);
    clusterRadii.set(r, rootClusterRadius(r, byId, h.descendantLeaves, span, t));
  }

  const maxClusterRadius = Math.max(0, ...clusterRadii.values());
  const rootAnchors = fibonacciAnchors(h.roots, Math.max(t.rootSphereRadius, maxClusterRadius + t.entityClusterGap));
  for (const r of h.roots) pos.set(r, rootAnchors.get(r) ?? { x: 0, y: 0, z: 0 });
  relaxClusterCenters(h.roots, pos, clusterRadii, t.entityClusterGap, 24);

  // 노드별 진행 방향(headDir)과 자기 하위 콘 half-angle.
  const headDir = new Map<string, Vec3>();
  const coneOf = new Map<string, number>();
  const rootOf = new Map<string, string>();
  for (const r of h.roots) {
    const rp = pos.get(r)!;
    rootOf.set(r, r);
    headDir.set(r, unit(rp.x === 0 && rp.y === 0 && rp.z === 0 ? { x: 1, y: 0, z: 0 } : rp));
    coneOf.set(r, t.coneHalfAngle);
  }
  const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // 황금각 ≈ 2.39996

  const queue = [...h.roots];
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i]!;
    const kids = h.childrenOf.get(parent) ?? [];
    if (kids.length === 0) continue;
    const pp = pos.get(parent)!;
    const pdir = headDir.get(parent)!;
    const [ba, bb] = basis(pdir);
    const cone = coneOf.get(parent)!;
    const root = rootOf.get(parent) ?? parent;
    const rootNode = byId.get(root);
    const clusterCenter = pos.get(root)!;
    const isEntityCluster = rootNode?.type === "entity_group";
    const rootSpan = rootDepthSpan.get(root) ?? 1;
    const clusterRadius = clusterRadii.get(root) ?? t.depthStep;
    const rootDepth = h.depthOf.get(root) ?? 1;

    const leaves = kids.map((k) => h.descendantLeaves.get(k) ?? 1);
    const totalLeaves = leaves.reduce((s, l) => s + l, 0) || 1;
    const n = kids.length;
    const sphereDirs = parent === root && isEntityCluster
      ? fibonacciAnchors(kids, 1)
      : undefined;
    for (let ki = 0; ki < n; ki++) {
      const k = kids[ki]!;
      let cdir: Vec3;
      if (sphereDirs) {
        cdir = unit(sphereDirs.get(k) ?? { x: 1, y: 0, z: 0 });
      } else {
        // 부모 콘 안 해바라기 균등 분포: frac 0(축)→1(테두리), sqrt 로 면적 균등.
        const frac = n === 1 ? 0 : (ki + 0.5) / n;
        const rho = cone * Math.sqrt(frac);
        const theta = ki * GOLDEN;
        const tilt = { x: Math.cos(theta), y: Math.sin(theta), z: 0 };
        const off = { x: ba.x * tilt.x + bb.x * tilt.y, y: ba.y * tilt.x + bb.y * tilt.y, z: ba.z * tilt.x + bb.z * tilt.y };
        cdir = unit({
          x: pdir.x * Math.cos(rho) + off.x * Math.sin(rho),
          y: pdir.y * Math.cos(rho) + off.y * Math.sin(rho),
          z: pdir.z * Math.cos(rho) + off.z * Math.sin(rho),
        });
      }
      if (isEntityCluster) {
        const depthOffset = Math.max(1, (h.depthOf.get(k) ?? rootDepth + 1) - rootDepth);
        const shell = localClusterShellRadius(clusterRadius, depthOffset, rootSpan);
        pos.set(k, {
          x: clusterCenter.x + cdir.x * shell,
          y: clusterCenter.y + cdir.y * shell,
          z: clusterCenter.z + cdir.z * shell,
        });
      } else {
        pos.set(k, { x: pp.x + cdir.x * t.depthStep, y: pp.y + cdir.y * t.depthStep, z: pp.z + cdir.z * t.depthStep });
      }
      rootOf.set(k, root);
      headDir.set(k, cdir);
      // 자식 콘 = 부모 콘 × sqrt(자기 잎/형제 총잎). 형제 콘 면적 합 = 부모 콘 면적 → 안 겹침.
      const nextCone = cone * Math.sqrt(leaves[ki]! / totalLeaves);
      coneOf.set(k, sphereDirs ? Math.min(t.coneHalfAngle * 0.65, nextCone) : Math.min(cone, nextCone));
      queue.push(k);
    }
  }

  const orphans = nodes.filter((n) => h.parentOf.get(n.id) === ORPHAN_PARENT);
  const orphanAnchors = fibonacciAnchors(orphans.map((n) => n.id), t.orphanShellRadius);
  for (const n of orphans) pos.set(n.id, orphanAnchors.get(n.id)!);

  for (const n of nodes) if (!pos.has(n.id)) {
    const s = seedFromId(n.id); pos.set(n.id, { x: (s % 7) - 3, y: ((s >> 3) % 7) - 3, z: ((s >> 6) % 7) - 3 });
  }

  if (radii) relaxCollisions(nodes, pos, radii, t.collisionPasses);
  return pos;
}

function maxDepthOffset(root: string, childrenOf: Map<string, string[]>): number {
  let max = 0;
  const queue: Array<{ id: string; depth: number }> = [{ id: root, depth: 0 }];
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i]!;
    max = Math.max(max, item.depth);
    for (const child of childrenOf.get(item.id) ?? []) {
      queue.push({ id: child, depth: item.depth + 1 });
    }
  }
  return max;
}

function rootClusterRadius(
  root: string,
  byId: Map<string, GraphNode>,
  descendantLeaves: Map<string, number>,
  depthSpan: number,
  t: RadialTokens,
): number {
  if (byId.get(root)?.type !== "entity_group") return t.depthStep;
  const leaves = Math.max(1, descendantLeaves.get(root) ?? 1);
  return t.entityClusterMinRadius +
    Math.sqrt(leaves) * t.entityClusterLeafScale +
    Math.max(0, depthSpan - 1) * t.entityClusterDepthScale;
}

function localClusterShellRadius(clusterRadius: number, depthOffset: number, depthSpan: number): number {
  const span = Math.max(1, depthSpan);
  const frac = Math.max(0, Math.min(1, depthOffset / span));
  return clusterRadius * Math.sqrt(frac);
}

function relaxClusterCenters(
  roots: string[],
  pos: Map<string, Vec3>,
  radii: Map<string, number>,
  gap: number,
  passes: number,
): void {
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
      const a = pos.get(roots[i]!)!, b = pos.get(roots[j]!)!;
      let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      let d = Math.hypot(dx, dy, dz);
      const minDist = (radii.get(roots[i]!) ?? 0) + (radii.get(roots[j]!) ?? 0) + gap;
      if (d >= minDist) continue;
      if (d < 1e-6) {
        const s = seedFromId(roots[i]! + roots[j]!);
        dx = (s % 5) - 2; dy = ((s >> 3) % 5) - 2; dz = ((s >> 6) % 5) - 2;
        d = Math.hypot(dx, dy, dz) || 1;
      }
      const push = (minDist - d) / 2;
      const ux = dx / d, uy = dy / d, uz = dz / d;
      a.x += ux * push; a.y += uy * push; a.z += uz * push;
      b.x -= ux * push; b.y -= uy * push; b.z -= uz * push;
    }
    const center = roots.reduce((acc, id) => {
      const v = pos.get(id)!;
      acc.x += v.x; acc.y += v.y; acc.z += v.z;
      return acc;
    }, { x: 0, y: 0, z: 0 });
    center.x /= roots.length || 1; center.y /= roots.length || 1; center.z /= roots.length || 1;
    for (const id of roots) {
      const v = pos.get(id)!;
      v.x -= center.x; v.y -= center.y; v.z -= center.z;
    }
  }
}

function relaxCollisions(nodes: GraphNode[], pos: Map<string, Vec3>, radii: Map<string, number>, passes: number): void {
  const pad = GRAPH_RENDER_THEME.nodeSpacing.gapPadding;
  const ids = nodes.map((n) => n.id);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = pos.get(ids[i]!)!, b = pos.get(ids[j]!)!;
      let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      let d = Math.hypot(dx, dy, dz);
      const minGap = minGapOf(radii.get(ids[i]!) ?? 0, radii.get(ids[j]!) ?? 0, pad);
      if (d >= minGap) continue;
      if (d < 1e-6) { const s = seedFromId(ids[i]! + ids[j]!); dx = (s % 5) - 2; dy = ((s >> 3) % 5) - 2; dz = ((s >> 6) % 5) - 2; d = Math.hypot(dx, dy, dz) || 1; }
      const push = (minGap - d) / 2; const ux = dx / d, uy = dy / d, uz = dz / d;
      a.x += ux * push; a.y += uy * push; a.z += uz * push;
      b.x -= ux * push; b.y -= uy * push; b.z -= uz * push;
    }
  }
}
