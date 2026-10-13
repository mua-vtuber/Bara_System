/**
 * Stanford Generative Agents inspired 3-factor scoring.
 *
 * Combines recency, relevance, and importance into a single retrieval score.
 * Recency uses exponential decay so memories gradually fade unless accessed.
 *
 * Port of backend/app/services/memory/scoring.py
 */

/**
 * Parse an ISO timestamp string, treating naive timestamps as UTC.
 *
 * Matches Python's datetime.fromisoformat() + .replace(tzinfo=timezone.utc)
 * behavior for naive datetimes. JS Date treats naive strings as local time
 * by default, so we explicitly append "Z" when no timezone marker present.
 */
function parseIsoAsUtc(s: string): Date | null {
  const hasTimezone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(s);
  const normalized = hasTimezone ? s : s + "Z";
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d;
}

/**
 * Compute recency score using exponential decay.
 *
 * Score is 1.0 when just accessed, decaying to 0.5 after `halfLifeDays`.
 *
 * @param lastAccessedAt ISO timestamp string or Date of last access.
 * @param halfLifeDays Number of days for the score to halve. Default 30.
 * @returns Recency score in [0.0, 1.0]. Returns 0.0 on parse failure.
 */
export function computeRecency(
  lastAccessedAt: string | Date,
  halfLifeDays: number = 30.0,
): number {
  const now = new Date();

  let dt: Date | null;
  if (typeof lastAccessedAt === "string") {
    dt = parseIsoAsUtc(lastAccessedAt);
    if (dt === null) {
      return 0.0;
    }
  } else {
    dt = lastAccessedAt;
  }

  const ageMs = now.getTime() - dt.getTime();
  const ageHours = Math.max(0.0, ageMs / (1000 * 3600));
  const halfLifeHours = halfLifeDays * 24.0;

  if (halfLifeHours <= 0) {
    return ageHours === 0 ? 1.0 : 0.0;
  }

  // Exponential decay: score = 2^(-age/half_life)
  const decay = Math.pow(2.0, -ageHours / halfLifeHours);
  return Math.max(0.0, Math.min(1.0, decay));
}

/**
 * Compute effective importance with exponential time decay.
 *
 * importance에 시간 가중치를 곱한 effective 값.
 * 본인이 노드 검색하면 lastAccessedAt 갱신 → 시간 0 → importance 원래 값 회복.
 * 안 보면 자연 감쇠. spec의 (C) 디자인 핵심 함수.
 *
 * **2026-05-16 spec section 4.2 — isProtected=true 면 시간 감쇠 면제.**
 * 호출자는 `Boolean(node.metadata.is_protected)` 로 derive.
 * is_concept 컬럼과 무관 — 개념 노드라도 unprotected 면 정상 감쇠,
 * 일반 메모리라도 사용자가 영구화하면 면제. parse 실패 lastAccessedAt 만
 * 들어와도 isProtected=true 면 importance 반환 (시간 정보 무시).
 *
 * @param importance Base importance score [0, 1].
 * @param lastAccessedAt ISO timestamp string or Date of last access.
 * @param halfLifeDays Number of days for the score to halve. Default 90.
 * @param isProtected metadata.is_protected 면 true — 시간 감쇠 면제.
 * @returns Effective importance in [0.0, 1.0]. Returns 0.0 on parse failure
 *          (단 isProtected=true 면 importance 반환).
 */
export function computeEffectiveImportance(
  importance: number,
  lastAccessedAt: string | Date,
  halfLifeDays: number = 90,
  isProtected: boolean = false,
): number {
  if (isProtected) {
    return Math.max(0.0, Math.min(1.0, importance));
  }

  const now = new Date();

  let dt: Date | null;
  if (typeof lastAccessedAt === "string") {
    dt = parseIsoAsUtc(lastAccessedAt);
    if (dt === null) {
      return 0.0;
    }
  } else {
    dt = lastAccessedAt;
  }

  const ageMs = now.getTime() - dt.getTime();
  const ageHours = Math.max(0.0, ageMs / (1000 * 3600));
  const halfLifeHours = halfLifeDays * 24.0;

  if (halfLifeHours <= 0) {
    return ageHours === 0 ? importance : 0.0;
  }

  const decay = Math.pow(2.0, -ageHours / halfLifeHours);
  const effective = importance * decay;
  return Math.max(0.0, Math.min(1.0, effective));
}

/**
 * Options for computeNodeValue.
 */
export interface NodeValueOptions {
  recencyHalfLifeDays?: number;
  importanceHalfLifeDays?: number;
  wRecency?: number;
  wImportance?: number;
  mentionBoost?: number;
}

/**
 * Input for computeNodeValue.
 */
export interface NodeValueInput {
  importance: number;
  lastAccessedAt: string | Date;
  mentionCount: number;
  /** spec 4.2 — metadata.is_protected 면 true. effective importance 면제 */
  isProtected?: boolean;
}

/**
 * Compute query-independent node value score.
 *
 * 쿼리 무관 노드 가치 점수. evolver의 휴지통 후보 판단에 사용.
 * retriever 검색 점수식과 가중치 공유.
 *
 * @param node Node with importance, lastAccessedAt, mentionCount.
 * @param options Configuration for recency half-life, importance half-life, and weights.
 * @returns Node value score in [0.0, 1.0].
 */
export function computeNodeValue(
  node: NodeValueInput,
  options: NodeValueOptions = {},
): number {
  const {
    recencyHalfLifeDays = 30,
    importanceHalfLifeDays = 90,
    wRecency = 0.3,
    wImportance = 0.2,
    mentionBoost = 0.05,
  } = options;

  const recency = computeRecency(node.lastAccessedAt, recencyHalfLifeDays);
  const effective = computeEffectiveImportance(
    node.importance,
    node.lastAccessedAt,
    importanceHalfLifeDays,
    node.isProtected,
  );
  const boost = node.mentionCount * mentionBoost;

  const score = wRecency * recency + wImportance * effective + boost;
  return Math.max(0.0, Math.min(1.0, score));
}
