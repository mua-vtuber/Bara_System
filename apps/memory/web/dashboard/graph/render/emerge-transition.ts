// 창발(2d) 트윈 — 순수 계획·샘플 함수. WebGL 비의존이라 데이터 fixture 로 단위
// 테스트한다. graph-controller(Task 10)가 매 프레임 sampleEmergeTween 을 적용해
// 출처 노드들에서 목표 한 점으로 모이는 수렴선과 그 점의 탄생 번쩍을 그린다.
//
// Phase 1 node-transition.ts 의 탄생 재료 재사용:
//  - 크기 팝 = easeOutBack(0→오버슈트→1) — born 의 bornPop 과 같은 모양.
//  - 광채 버스트 = Math.sin(Math.PI*t)(0→peak→0) — born 의 burst 와 같은 모양.
//  - 진행은 0~1 로 clamp(발산 방지), durationS <= 0 이면 즉시 끝값(연출 꺼짐).
//
// 정직 원칙: fromSources 중 화면(sourcePositions)에 없는 노드는 선을 안 그린다.

import type { Vec3 } from "../layout/force-layout.ts";

// 탄생 크기 팝 오버슈트 세기(easeOutBack c1). 클수록 더 튄다. 라이브 조절용.
const BORN_SCALE_OVERSHOOT = 2.2;
// 탄생 광채 버스트 진폭(0~1+). 클수록 더 번쩍. 0 이면 평탄(끄기). 라이브 조절용.
const BORN_BURST_AMPLITUDE = 1.0;

/** 한 출처에서 목표로 뻗는 수렴선의 머리(현재 끝점) 위치. */
export interface ConvergeLine {
  /** 출처 노드 id. */
  from: string;
  /** 출처에서 목표로 보간 이동하는 선 머리 위치. */
  headPos: Vec3;
}

export interface EmergeTween {
  /** 새로 태어나는 개념 노드 id(`concept:<id>`). */
  nodeId: string;
  /** 화면에 실제로 있는 출처만 추린 (id, 시작 위치) 목록. */
  sources: { id: string; pos: Vec3 }[];
  /** 수렴 목표(태어나는 노드 위치). */
  targetPos: Vec3;
  startedAt: number;
  duration: number;
}

export interface EmergeSample {
  /** 출처별 수렴선 머리 위치(목표로 뻗어 들어간다). 화면에 없던 출처는 빠진 채. */
  converge: ConvergeLine[];
  /** 태어나는 노드 크기 배율(0→오버슈트→1). 기준 scale 에 절대 곱. */
  bornScaleMul: number;
  /** 탄생 광채 버스트(0→peak→0, 가산 글로우 밝힘). */
  bornBurst: number;
  done: boolean;
}

/** 시각 진행을 0~1 로 clamp(발산 방지). duration <= 0 이면 즉시 1(연출 꺼짐). */
function progress(nowS: number, startedAt: number, duration: number): number {
  if (duration <= 0) return 1;
  return Math.max(0, Math.min(1, (nowS - startedAt) / duration));
}

/** 끝에서 부드럽게 감속하는 보간(easeOutCubic). 끝점 0·1 보존. */
function easeOutCubic(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - x, 3);
}

/** 탄생 크기 팝 — 0→(중간 1 초과 오버슈트)→정확히 1. easeOutBack(끝점 0·1 보존). */
function bornPop(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  const c1 = BORN_SCALE_OVERSHOOT;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

/**
 * 창발 트윈을 만든다. fromSources 중 sourcePositions 에 있는 노드만 수렴선 출처가
 * 된다(화면에 없는 출처는 정직하게 건너뛴다). nowS·durationS 단위는 초.
 */
export function planEmergeTween(
  nodeId: string,
  fromSources: readonly string[],
  sourcePositions: ReadonlyMap<string, Vec3>,
  targetPos: Vec3,
  nowS: number,
  durationS: number,
): EmergeTween {
  const sources: { id: string; pos: Vec3 }[] = [];
  for (const id of fromSources) {
    const pos = sourcePositions.get(id);
    if (!pos) continue; // 화면에 없는 출처는 선을 안 그린다(정직).
    sources.push({ id, pos: { ...pos } });
  }
  return { nodeId, sources, targetPos, startedAt: nowS, duration: durationS };
}

/**
 * 현재 시각 nowS(초)의 창발 진행값을 돌려준다. 수렴선 머리는 출처에서 목표로
 * 보간 이동(easeOutCubic)하고, 목표점은 탄생 팝·광채로 떠오른다. now ≥
 * start+duration 이면 done=true·끝값 고정(머리=targetPos·scale 1·burst 0).
 * 누적 곱 없이 매번 t 로 계산해 발산이 없다.
 */
export function sampleEmergeTween(tween: EmergeTween, nowS: number): EmergeSample {
  const t = progress(nowS, tween.startedAt, tween.duration);
  const done = t >= 1;
  // 끝에 닿으면 끝값을 그대로 고정한다(clamp). Math.sin(Math.PI) 부동소수점 잔차와
  // 누적 발산을 차단한다. 머리는 목표에 정확히 닿고 탄생이 정착한다.
  if (done) {
    return {
      converge: tween.sources.map((s) => ({ from: s.id, headPos: { ...tween.targetPos } })),
      bornScaleMul: 1,
      bornBurst: 0,
      done: true,
    };
  }
  const ease = easeOutCubic(t);
  const converge: ConvergeLine[] = tween.sources.map((s) => ({
    from: s.id,
    headPos: {
      x: s.pos.x + (tween.targetPos.x - s.pos.x) * ease,
      y: s.pos.y + (tween.targetPos.y - s.pos.y) * ease,
      z: s.pos.z + (tween.targetPos.z - s.pos.z) * ease,
    },
  }));
  return {
    converge,
    bornScaleMul: bornPop(t),
    bornBurst: BORN_BURST_AMPLITUDE * Math.sin(Math.PI * t),
    done,
  };
}
