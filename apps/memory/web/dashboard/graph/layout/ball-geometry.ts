/**
 * 구 표면 피보나치 앵커 순수 모듈 — Three.js 무관·결정적(Math.random 금지).
 * radial-layout.ts 가 루트 노드·외톨이 노드 배치에 사용한다.
 */
import type { Vec3 } from "./force-layout.ts";

/**
 * id 목록을 큰 구 표면에 피보나치 황금각 나선으로 균등 배치한다(결정적).
 * N 개 점을 구 표면에 거의 균등하게 분포하는 표준 알고리즘을 사용한다.
 * 입력이 비어 있으면 빈 Map을 반환한다.
 */
export function fibonacciAnchors(
  ballIds: string[],
  sphereRadius: number,
): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  const n = ballIds.length;
  if (n === 0) return out;

  const golden = Math.PI * (3 - Math.sqrt(5));

  for (let i = 0; i < n; i++) {
    // y 는 -1 ~ +1 선형 분포. n===1 이면 나눗셈을 피하고 적도(y=0)에 놓는다.
    const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
    const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;

    out.set(ballIds[i]!, {
      x: Math.cos(theta) * radiusAtY * sphereRadius,
      y: y * sphereRadius,
      z: Math.sin(theta) * radiusAtY * sphereRadius,
    });
  }

  return out;
}
