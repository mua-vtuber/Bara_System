/**
 * session-grouping.ts — Phase 7 2차 갈래 2(맥락 추론 메타 전파)의 순수 함수 묶음.
 *
 * 권위: docs/decisions/2026-06-04-phase7-2nd-active-loop-plan.md Task 6
 *       docs/decisions/2026-06-02-phase7-redesign-design.md 단락 3.7
 *
 * 한 작성자의 시간순 노드를 "세션"(간격 G 분으로 끊은 한 사건 후보)으로 묶고,
 * 그중 (1) 더는 글이 안 붙는 "익은(닫힌) 세션"만, (2) 메타가 섞인 세션(메타 있음
 * ≥1 + 없음 ≥1)만 추리는 세 순수 함수를 둔다. DB·LLM 의존은 metadata-infer-cycle.ts
 * 글루가 담당하고, 여기 세 함수는 입력 배열만 보고 결정한다(테스트 결정성).
 *
 * 시각은 전부 밀리초(ms) epoch 로 받는다 — ISO 문자열 파싱·now() 호출은 호출자
 * (글루)가 책임지고, 이 모듈은 숫자 비교만 한다. now 직접 호출 금지(인자 주입).
 */

/**
 * 세션 묶기 입력 한 노드. metadata-infer-cycle 글루가 후보 SQL 회신을 이 양식으로
 * 환산해 넘긴다. 시각은 createdAtMs(밀리초 epoch) 하나만 본다 — event_at 은 묶기
 * 기준이 아니라 메타 유무 플래그(hasEventAt)로만 쓴다.
 */
export interface SessionNode {
  /** knowledge_nodes.id. */
  readonly id: number;
  /** 작성자(author). 세션은 같은 작성자 안에서만 묶는다. */
  readonly author: string;
  /** 등록 시각(created_at) 밀리초 epoch. 세션 끊기·익음 판정은 이 값만 본다. */
  readonly createdAtMs: number;
  /** 장소 메타(분류 태그 '장소')가 이미 있는지. 섞인 세션 추림용. */
  readonly hasPlace: boolean;
  /** 사건 시각 메타(event_at)가 이미 있는지. 섞인 세션 추림용. */
  readonly hasEventAt: boolean;
}

/**
 * 한 세션 — 같은 작성자의 시간 인접 노드 묶음. nodes 는 createdAtMs 오름차순.
 */
export interface Session {
  /** 세션 노드 목록(createdAtMs ASC). 최소 1개. */
  readonly nodes: readonly SessionNode[];
}

/** 한 노드의 메타 유무 — place 또는 event_at 중 하나라도 있으면 "메타 있음". */
function hasAnyMeta(node: SessionNode): boolean {
  return node.hasPlace || node.hasEventAt;
}

/**
 * 분 단위 간격을 밀리초로 환산. 음수·NaN 은 호출자(설정값 검증)가 막지만, 방어로
 * 0 미만이면 0 으로 본다(같은 시각이면 항상 한 세션 — 끊지 않음).
 */
function gapMs(gapMinutes: number): number {
  if (!Number.isFinite(gapMinutes) || gapMinutes < 0) return 0;
  return gapMinutes * 60_000;
}

/**
 * 노드 목록을 작성자별 + 시간 간격 G 로 세션으로 묶는다(순수 — 노드 시각만으로).
 *
 * 규칙:
 *   1. 작성자(author)가 다르면 무조건 다른 세션.
 *   2. 같은 작성자 안에서 createdAtMs 오름차순으로 보며, 직전 노드와의 간격이
 *      G 분을 *넘으면*(> G) 새 세션을 연다. 정확히 G 분이면 같은 세션(경계 포함).
 *
 * 입력 순서는 신경 쓰지 않는다 — 내부에서 작성자별로 모은 뒤 createdAtMs 로 정렬한다.
 * 회신 세션의 nodes 는 createdAtMs ASC. 빈 입력이면 빈 배열.
 */
export function groupSessions(
  nodes: readonly SessionNode[],
  gapMinutes: number,
): Session[] {
  if (nodes.length === 0) return [];
  const limit = gapMs(gapMinutes);

  // 작성자별로 모은다 — 다른 작성자는 절대 한 세션에 섞이지 않는다.
  const byAuthor = new Map<string, SessionNode[]>();
  for (const node of nodes) {
    const bucket = byAuthor.get(node.author);
    if (bucket) {
      bucket.push(node);
    } else {
      byAuthor.set(node.author, [node]);
    }
  }

  const sessions: Session[] = [];
  for (const bucket of byAuthor.values()) {
    // 같은 작성자 안에서 시간 오름차순 — 간격 비교의 전제.
    bucket.sort((a, b) => a.createdAtMs - b.createdAtMs);

    let current: SessionNode[] = [];
    let prevMs: number | null = null;
    for (const node of bucket) {
      if (prevMs !== null && node.createdAtMs - prevMs > limit) {
        // 직전 노드와 G 분을 넘게 떨어졌다 — 세션 끊고 새로 연다.
        sessions.push({ nodes: current });
        current = [];
      }
      current.push(node);
      prevMs = node.createdAtMs;
    }
    if (current.length > 0) {
      sessions.push({ nodes: current });
    }
  }
  return sessions;
}

/**
 * 익은(닫힌) 세션만 추린다 — 세션의 *마지막 글 createdAtMs + G 분* 이 now 이하인
 * 세션만(더는 글이 안 붙는다고 보는 닫힌 세션). 마지막 글이 now 기준 G 분 이내인
 * 진행 중 세션은 이번 주기에서 건너뛰고 다음 extractor 주기로 미룬다.
 *
 * 경계 처리(AC 2 — 세 경계 테스트 대상):
 *   - 마지막 글 + G == now  → 익음(포함). "정확히 G 분 전" 은 닫힌 것으로 본다.
 *   - 마지막 글 + G  > now   → 미성숙(제외). 아직 G 분이 안 지났다.
 *   - 마지막 글 + G  < now   → 익음(포함). G 분이 지났다.
 *
 * now 는 인자로 받는다(밀리초 epoch) — Date.now 직접 호출 금지(순수·테스트 결정성).
 */
export function pickRipeSessions(
  sessions: readonly Session[],
  gapMinutes: number,
  now: number,
): Session[] {
  const limit = gapMs(gapMinutes);
  const ripe: Session[] = [];
  for (const session of sessions) {
    const last = session.nodes[session.nodes.length - 1];
    // groupSessions 회신은 항상 nodes.length >= 1 이지만, 외부 입력 방어.
    if (last === undefined) continue;
    if (last.createdAtMs + limit <= now) {
      ripe.push(session);
    }
  }
  return ripe;
}

/**
 * 섞인 세션만 추린다 — 메타 있음(place 또는 event_at) ≥ 1 *그리고* 메타 없음 ≥ 1
 * 인 세션만. 전부 채워진 세션(전파할 빈 칸 없음)과 전부 빈 세션(전파해 줄 근거
 * 없음)은 둘 다 LLM 호출 가치가 없으므로 제외한다(호출 절약).
 */
export function pickMixedSessions(sessions: readonly Session[]): Session[] {
  const mixed: Session[] = [];
  for (const session of sessions) {
    let withMeta = 0;
    let withoutMeta = 0;
    for (const node of session.nodes) {
      if (hasAnyMeta(node)) {
        withMeta += 1;
      } else {
        withoutMeta += 1;
      }
      // 둘 다 1 이상이면 더 셀 필요 없다 — 조기 종료(큰 세션 절약).
      if (withMeta > 0 && withoutMeta > 0) break;
    }
    if (withMeta > 0 && withoutMeta > 0) {
      mixed.push(session);
    }
  }
  return mixed;
}
