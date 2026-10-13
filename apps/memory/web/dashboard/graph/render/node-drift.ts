// 노드 상시 드리프트(시각효과 #3·분리형). 별이 평소에도 아주 천천히 떠다니게 한다.
// 이 파일 + graph-controller 의 applyNodeDrift 호출 한 줄을 지우면 0 영향으로 떼어낸다.
// force-layout 기준 좌표(basePositions)를 중심으로 미세하게만 일렁인다 — 배치는 무너지지 않는다.
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";
import { seedFromId } from "../layout/force-layout.ts";
import type { Vec3 } from "../layout/force-layout.ts";

// seedFromId 를 이 모듈 밖에서도 쓸 수 있도록 재내보낸다.
// graph-controller 의 finishSettle 이 같은 시드로 offset 을 재현하는 데 필요하다.
export { seedFromId };

/**
 * 시간·시드 기반 미세 드리프트 오프셋. 순수·결정적·연속이다.
 * - 결정적: Math.random 을 쓰지 않아 같은 (time, seed) 는 항상 같은 값.
 * - 연속: time 이 미세하게 바뀌면 sin/cos 가 미세하게만 바뀐다(깜빡임 없음).
 * - 작은 진폭: 각 축이 sin/cos 한 항이라 절대값이 토큰 amplitude 를 넘지 못한다.
 *   amplitude 를 0 으로 두면 세 축 모두 0 이라 효과가 통째로 꺼진다(제거 가능성).
 * 시드는 노드마다 다른 위상을 줘 군집이 한 덩어리로 같이 움직이지 않게 한다.
 */
export function nodeDriftOffset(time: number, seed: number): Vec3 {
  const { amplitude, speed } = GRAPH_RENDER_THEME.nodeDrift;
  const a = seed * 0.017;
  return {
    x: Math.sin(time * speed + a) * amplitude,
    y: Math.sin(time * speed * 0.7 + a * 1.9) * amplitude,
    z: Math.cos(time * speed * 0.9 + a * 1.3) * amplitude,
  };
}
