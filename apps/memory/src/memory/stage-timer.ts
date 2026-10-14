/**
 * 단계 시간 도구 — 한 번의 처리 안에서 단계마다 걸린 시간(ms)을 재는 작은 도구.
 *
 * lap(단계) 은 "직전 lap(또는 시작) 이후 지난 시간"을 그 단계 몫으로 기록한다.
 * 시계는 주입할 수 있다(기본 performance.now) — 테스트가 값 배열로 정확히 검증한다.
 * 같은 단계 이름을 두 번 기록하면 오류다(한 단계 시간이 조용히 덮여 쓰이는 것을 막는다).
 */
export class StageTimer {
  private readonly startedAt: number;
  private lastMark: number;
  private readonly lapMs = new Map<string, number>();

  constructor(private readonly clock: () => number = () => performance.now()) {
    this.startedAt = clock();
    this.lastMark = this.startedAt;
  }

  /** 직전 지점부터 지금까지를 `stage` 몫으로 기록하고 그 ms 를 돌려준다. */
  lap(stage: string): number {
    if (this.lapMs.has(stage)) {
      throw new Error(`StageTimer: 단계 '${stage}' 가 이미 기록됐습니다.`);
    }
    const now = this.clock();
    const ms = now - this.lastMark;
    this.lastMark = now;
    this.lapMs.set(stage, ms);
    return ms;
  }

  /** 시작부터 지금까지 걸린 전체 ms. */
  elapsed(): number {
    return this.clock() - this.startedAt;
  }

  /** 기록된 단계별 ms (기록 순서). 기록 안 된 단계는 들어 있지 않다. */
  laps(): ReadonlyMap<string, number> {
    return this.lapMs;
  }
}

/**
 * retriever 단계별 시간. 돌지 않은 단계(결과 0건으로 일찍 끝난 길의 점수·갱신 등)는 null.
 * 검색 캐시에는 저장하지 않는다 — 캐시 적중 때 옛 시간이 다시 찍히면 안 되기 때문이다.
 */
export interface RetrieveStageTimings {
  prepMs: number | null;
  embedMs: number | null;
  embedCacheHit: boolean | null;
  planMs: number | null;
  vectorFtsMs: number | null;
  conceptMs: number | null;
  imageVecMs: number | null;
  projectMs: number | null;
  personMs: number | null;
  graphMs: number | null;
  scoreMs: number | null;
  touchMs: number | null;
  totalMs: number;
}

/** retriever 가 lap 에 쓰는 단계 이름. RetrieveStageTimings 의 ms 칸 이름과 같다. */
export type RetrieveLapStage = Exclude<
  keyof RetrieveStageTimings,
  "embedCacheHit" | "totalMs"
>;

/** StageTimer 기록을 RetrieveStageTimings 로 옮긴다 — 기록 안 된 단계는 null. */
export function buildRetrieveTimings(
  timer: StageTimer,
  embedCacheHit: boolean | null,
): RetrieveStageTimings {
  const laps = timer.laps();
  const ms = (stage: RetrieveLapStage): number | null => laps.get(stage) ?? null;
  return {
    prepMs: ms("prepMs"),
    embedMs: ms("embedMs"),
    embedCacheHit,
    planMs: ms("planMs"),
    vectorFtsMs: ms("vectorFtsMs"),
    conceptMs: ms("conceptMs"),
    imageVecMs: ms("imageVecMs"),
    projectMs: ms("projectMs"),
    personMs: ms("personMs"),
    graphMs: ms("graphMs"),
    scoreMs: ms("scoreMs"),
    touchMs: ms("touchMs"),
    totalMs: timer.elapsed(),
  };
}
