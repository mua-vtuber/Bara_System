import type { GraphNode } from "../graph-view-model.ts";

export interface RecentNodeOptions {
  windowHours: number;
  labelCap: number;
  glowMultiplier: number;
  pulseDurationS: number;
  pulseAmplitude: number;
}

export const DEFAULT_RECENT_NODE_OPTIONS: RecentNodeOptions = {
  windowHours: 12,
  labelCap: 15,
  glowMultiplier: 1.45,
  pulseDurationS: 20,
  pulseAmplitude: 0.22,
};

const HOUR_MS = 60 * 60 * 1000;

export function parseNodeTimestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

export function recentNodeTimestampMs(
  node: GraphNode,
  sessionBornAtMs: ReadonlyMap<string, number>,
): number | null {
  const created = parseNodeTimestampMs(node.createdAt);
  const session = sessionBornAtMs.get(node.id);
  if (created == null) return session ?? null;
  if (session == null) return created;
  return Math.max(created, session);
}

export function isRecentNode(
  node: GraphNode,
  sessionBornAtMs: ReadonlyMap<string, number>,
  nowMs: number,
  options: RecentNodeOptions = DEFAULT_RECENT_NODE_OPTIONS,
): boolean {
  const ts = recentNodeTimestampMs(node, sessionBornAtMs);
  if (ts == null) return false;
  return nowMs - ts >= 0 && nowMs - ts <= Math.max(0, options.windowHours) * HOUR_MS;
}

export function resolveRecentNodeIds(
  nodes: GraphNode[],
  sessionBornAtMs: ReadonlyMap<string, number>,
  nowMs: number,
  options: RecentNodeOptions = DEFAULT_RECENT_NODE_OPTIONS,
): Set<string> {
  const rows = nodes.flatMap((node) => {
    if (!isRecentNode(node, sessionBornAtMs, nowMs, options)) return [];
    const ts = recentNodeTimestampMs(node, sessionBornAtMs);
    return ts == null ? [] : [{ id: node.id, ts }];
  });
  rows.sort((a, b) => (b.ts - a.ts) || a.id.localeCompare(b.id));
  return new Set(rows.slice(0, Math.max(0, options.labelCap)).map((row) => row.id));
}

export function recentNodeGlowBoost(
  node: GraphNode,
  sessionBornAtMs: ReadonlyMap<string, number>,
  nowMs: number,
  elapsedS: number,
  options: RecentNodeOptions = DEFAULT_RECENT_NODE_OPTIONS,
): number {
  if (!isRecentNode(node, sessionBornAtMs, nowMs, options)) return 1;
  const ts = recentNodeTimestampMs(node, sessionBornAtMs);
  if (ts == null) return 1;
  const ageS = Math.max(0, (nowMs - ts) / 1000);
  const pulseWindow = Math.max(0, options.pulseDurationS);
  const pulseT = pulseWindow <= 0 ? 1 : Math.min(1, ageS / pulseWindow);
  const pulseFade = 1 - pulseT;
  const pulse = Math.max(0, options.pulseAmplitude) *
    pulseFade *
    (0.5 + 0.5 * Math.sin(elapsedS * Math.PI * 2 * 0.45));
  return Math.max(1, options.glowMultiplier + pulse);
}
