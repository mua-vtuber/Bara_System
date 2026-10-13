// 합침(2c) 트윈 — 순수 계획·샘플 함수. WebGL 비의존이라 데이터 fixture 로 단위
// 테스트한다. graph-controller(Task 9)가 매 프레임 sampleMergeTween 을 적용해
// from 노드가 into 로 끌려가 겹치며 사라지고, into 가 잠깐 부풀었다 정착하는
// 흡수 연출을 그린다.
//
// Phase 1 node-transition.ts 의 트윈 모델 재사용:
//  - 광채 버스트 = Math.sin(Math.PI*t)(0→peak→0) — born 의 burst 와 같은 모양.
//  - 진행은 0~1 로 clamp(발산 방지), durationS <= 0 이면 즉시 끝값(연출 꺼짐).

import type { Vec3 } from "../layout/force-layout.ts";

// into 흡수 광채 버스트 진폭(0~1+). 클수록 더 번쩍. 0 이면 평탄(끄기). 라이브 조절용.
const MERGE_BURST_AMPLITUDE = 1.0;
// into 흡수 시 부푸는 크기 오버슈트 폭(scale 1 위로 더 커지는 양). 0 이면 안 부푼다.
const MERGE_SWELL_AMPLITUDE = 0.35;

export interface MergeTween {
  /** 흡수되어 사라지는 source 노드 id(`concept:<id>`). */
  fromId: string;
  /** 남는 target 노드 id(`concept:<id>`). */
  intoId: string;
  /** from 노드 시작 위치. */
  fromPos: Vec3;
  /** into 노드 위치(from 이 끌려가 닿는 목표). */
  intoPos: Vec3;
  startedAt: number;
  duration: number;
}

export interface MergeSample {
  /** from 노드의 현재 위치(시작→intoPos 보간). */
  fromPos: Vec3;
  /** from 노드 불투명도(1→0). */
  fromOpacity: number;
  /** into 노드 크기 배율(1→peak→1, 흡수 부풀음). 기준 scale 에 절대 곱. */
  intoScaleMul: number;
  /** into 흡수 광채 버스트(0→peak→0, 가산 글로우 밝힘). */
  intoBurst: number;
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

/**
 * 합침 트윈을 만든다. from 노드가 into 위치로 끌려가 겹치며 사라지고, into 가
 * 잠깐 부풀었다 정착한다. nowS·durationS 단위는 초.
 */
export function planMergeTween(
  fromId: string,
  intoId: string,
  fromPos: Vec3,
  intoPos: Vec3,
  nowS: number,
  durationS: number,
): MergeTween {
  return { fromId, intoId, fromPos, intoPos, startedAt: nowS, duration: durationS };
}

/**
 * 현재 시각 nowS(초)의 합침 진행값을 돌려준다. from 은 into 로 보간 이동하며
 * 페이드(opacity 1→0), into 는 흡수 광채(sin)로 부풀었다 정착한다. now ≥
 * start+duration 이면 done=true·끝값 고정(from=intoPos·opacity 0, into scale 1·
 * burst 0). 누적 곱 없이 매번 t 로 계산해 발산이 없다.
 */
export function sampleMergeTween(tween: MergeTween, nowS: number): MergeSample {
  const t = progress(nowS, tween.startedAt, tween.duration);
  const done = t >= 1;
  // 끝에 닿으면 끝값을 그대로 고정한다(clamp). Math.sin(Math.PI) 가 부동소수점상
  // 정확히 0 이 아니어서 scale·burst 잔차가 남는 것을 막고, 누적 발산도 차단한다.
  if (done) {
    return {
      fromPos: { ...tween.intoPos },
      fromOpacity: 0,
      intoScaleMul: 1,
      intoBurst: 0,
      done: true,
    };
  }
  const ease = easeOutCubic(t);
  const fromPos: Vec3 = {
    x: tween.fromPos.x + (tween.intoPos.x - tween.fromPos.x) * ease,
    y: tween.fromPos.y + (tween.intoPos.y - tween.fromPos.y) * ease,
    z: tween.fromPos.z + (tween.intoPos.z - tween.fromPos.z) * ease,
  };
  const swell = Math.sin(Math.PI * t); // 0→1(t=0.5)→0
  return {
    fromPos,
    fromOpacity: 1 - t,
    intoScaleMul: 1 + MERGE_SWELL_AMPLITUDE * swell,
    intoBurst: MERGE_BURST_AMPLITUDE * swell,
    done,
  };
}
