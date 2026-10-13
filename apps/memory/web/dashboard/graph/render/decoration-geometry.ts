// 장식 3D geometry 빌더 — 평면 링(고리)과 별을 품은 보석(반투명 크리스탈 구).
// decorations.ts 가 한 번만 만들어 공유한다. 형태 수치는 전부 토큰에서 받는다.
// 노드 id 해시로 고리 기울기를 흩는 순수 함수, 빛살(ray) 텍스처의 픽셀별 알파를
// 구하는 순수 함수(T18)를 WebGL·canvas 없이 단위 테스트한다.
import * as THREE from "three";

/**
 * 평면 링(고리) geometry 를 만든다 — 두께 없는 납작한 환형.
 * THREE.RingGeometry(innerRadius, outerRadius, segments) 사용.
 * 타입당 1개만 만들어 공유한다(노드마다 transform·기울기만 다르게).
 *
 * @param innerRadius  안쪽 반지름(도넛 구멍 크기).
 * @param outerRadius  바깥쪽 반지름.
 */
export function makeRingGeometry(
  innerRadius: number,
  outerRadius: number,
): THREE.RingGeometry {
  // thetaSegments 64 — 링이 매끄럽게 둥글게 보이는 최소값(부하 균형).
  return new THREE.RingGeometry(innerRadius, outerRadius, 64);
}

/**
 * 노드 id 해시로 고리 기울기 각도를 결정적으로 흩는다(spec 3.6·DCL-3).
 * 같은 id 는 매번 같은 각도라 라이브에서 깜빡이지 않는다. 결과는 base ± jitter 안.
 * FNV-1a 32비트 해시 — 짧은 문자열에 분포가 고르고 WebGL 없이 테스트한다.
 *
 * 순수 함수 — Three.js 의존 없음.
 */
export function ringTiltForNode(
  nodeId: string,
  baseDeg: number,
  jitterDeg: number,
): number {
  // FNV-1a 32비트 해시
  let h = 2166136261;
  for (let i = 0; i < nodeId.length; i++) {
    h ^= nodeId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // 0~1 단위 비율로 정규화한 뒤 [-1, 1] 로 매핑해 jitter 에 곱한다.
  const unit = ((h >>> 0) % 100000) / 100000;
  return baseDeg + (unit * 2 - 1) * jitterDeg;
}

/**
 * 별을 감싸는 반투명 크리스탈 보석 구 하나의 geometry 를 만든다.
 * IcosahedronGeometry — 평평한 삼각면으로 이뤄진 다면체. flatShading 적용 시
 * 각 면이 명암을 독립적으로 받아 깨진 유리/보석처럼 면마다 빛이 다르게 든다.
 * detail=0 은 20면(각진 크리스탈), detail=1 은 80면(둥근 보석에 가까움).
 *
 * @param radius  보석 구 반지름(별 코어보다 크게 — 별을 품는다).
 * @param detail  세분 단계(0=각진 20면, 1=80면). 면 명암을 살리려면 0~1.
 */
export function makeCrystalShardGeometry(
  radius: number,
  detail: number,
): THREE.IcosahedronGeometry {
  return new THREE.IcosahedronGeometry(radius, detail);
}

/**
 * 빛살(ray) 한 가닥의 알파(불투명도)를 위치(t, u)로 계산하는 순수 함수(T18/T20).
 * 기존 makeRayTexture 는 ctx.createLinearGradient 로 중심→끝 축 방향(길이) 페이드만
 * 걸었다 — 그 축에 수직인 폭 방향(가장자리)은 그라데이션이 안 걸려 실루엣이 여전히
 * 단색 삼각형으로 보였다(사용자 스크린샷 증상). 이 함수는 길이·폭 두 방향을 모두
 * 반영해 캔버스에 픽셀 단위로 그릴 때 쓴다. WebGL 없이 순수 함수로 단위 테스트한다.
 *
 * T20: rootFade 파라미터로 뿌리(t=0 근처) 알파를 0에서 서서히 올린다. T18까지는
 * rayPixelAlpha 가 밑변 반경(baseR) 안쪽을 통째로 alpha=1 로 채우고 그 경계 밖은
 * 이 함수의 lengthFade 값으로 넘어갔는데, 경계에서 두 계산식이 만나 알파가 뚝
 * 떨어지는 하드엣지가 생겼다(사용자 "중심 쪽이 끊겨 비어 보인다" 증상). rootFade=0
 * 이면 옛 동작과 완전히 같다(하위호환) — t=0 에서 즉시 lengthFade=1.
 *
 * @param t  중심(밑변, 0)~끝점(1) 사이 길이 방향 위치 비율.
 * @param u  폭 방향 위치 비율(-1=한쪽 가장자리, 0=중심선, 1=반대쪽 가장자리).
 * @param edgePower  가장자리 페이드 강도(클수록 중심선에 더 몰린 좁은 빛줄기).
 * @param rootFade  뿌리 페이드인 구간 폭(0~1, t 기준). 0이면 비활성(하위호환).
 *   0<t<rootFade 구간에서 알파가 0→1로 매끄럽게(smoothstep) 올라온다.
 * @returns 0(완전 투명)~1(완전 불투명) 알파값.
 */
export function rayAlphaAt(
  t: number,
  u: number,
  edgePower: number,
  rootFade: number,
): number {
  const lengthFade = Math.max(0, 1 - t);
  // |u|=0(중심선)일 때 1, |u|=1(가장자리)일 때 0. (1-|u|) 자체가 이미 가장자리에서
  // 0에 닿는 선형 페이드이고, 그 결과를 edgePower 제곱해 중심 쪽으로 더 빨리 죽이면
  // (지수가 클수록 1보다 작은 값이 더 작아짐) 좁은 빛줄기 형태가 된다.
  const edgeFade = Math.max(0, 1 - Math.abs(u)) ** edgePower;
  // root 구간(0~rootFade) 안에서는 smoothstep(3x²-2x³)으로 0→1 배율을 곱해 뿌리를
  // 서서히 밝힌다 — 선형 램프 대신 smoothstep 을 쓰는 이유는 구간 경계(x=0,1)에서
  // 기울기가 0이라 lengthFade*edgeFade 값과 이어붙는 지점의 불연속이 더 안 보이기 때문.
  // rootFade<=0 이면 비율 1(항상 전체 밝기) — 옛 동작 그대로.
  const rootRamp = rootFade > 0
    ? (() => {
        const x = Math.min(1, Math.max(0, t / rootFade));
        return x * x * (3 - 2 * x);
      })()
    : 1;
  return lengthFade * edgeFade * rootRamp;
}

/**
 * 빛살 텍스처 캔버스의 한 픽셀(px, py)이 빛살 하나의 (t, u) 좌표계에서 어디에
 * 해당하는지 구해 rayAlphaAt 로 최종 알파를 낸다. 픽셀→로컬좌표 변환(회전+비스듬한
 * 이등변삼각형 내부 좌표화)까지 순수 계산이라 WebGL·canvas 없이 테스트한다.
 * makeRayTexture 가 이 함수를 픽셀마다 불러 ImageData 알파 채널을 직접 채운다.
 *
 * T20: 밑변 반경(baseR) 안쪽을 통째로 alpha=1 로 채우던 옛 하드컷 분기를 없앴다.
 * 그 분기가 만든 "원 안쪽=1, 원 밖=rayAlphaAt 값"의 이어붙임 경계가 바로 사용자가
 * 본 "중심 쪽이 끊겨 비어 보인다" 증상의 원인이었다 — 이제는 중심점 특례(전 빛살
 * 공통 최대 알파)를 빼면 전 구간이 rayAlphaAt 하나로만 계산되어 끊김이 없다.
 *
 * @param px  픽셀 x(캔버스 좌표, 중심이 c).
 * @param py  픽셀 y.
 * @param c   캔버스 중심 좌표(= size / 2).
 * @param angle  이 빛살의 중심선 각도(라디안).
 * @param outer  빛살 길이(중심~끝점 반지름, px).
 * @param baseHalf  밑변 반각(라디안) — 폭 방향 최대 각도 벌어짐.
 * @param edgePower  rayAlphaAt 가장자리 페이드 강도.
 * @param rootFade  rayAlphaAt 뿌리 페이드인 구간 폭(0~1, t 기준). 0이면 비활성.
 * @returns 0~1 알파값. 빛살 부채꼴(각도 baseHalf) 밖이면 0.
 */
export function rayPixelAlpha(
  px: number,
  py: number,
  c: number,
  angle: number,
  outer: number,
  baseHalf: number,
  edgePower: number,
  rootFade: number,
): number {
  const dx = px - c;
  const dy = py - c;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1e-6) return 1; // 중심점 자체는 전 빛살 공통 — 가장 밝게(core glow 와 자연 융합).
  // 이 픽셀의 각도와 빛살 중심각의 차이를 [-PI, PI] 로 정규화.
  let da = Math.atan2(dy, dx) - angle;
  while (da > Math.PI) da -= Math.PI * 2;
  while (da < -Math.PI) da += Math.PI * 2;
  if (Math.abs(da) > baseHalf) return 0; // 부채꼴 밖.
  const t = dist / outer;
  const u = da / baseHalf; // -1~1 폭 방향 위치.
  return rayAlphaAt(t, u, edgePower, rootFade);
}
