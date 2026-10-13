// 타입별 장식 시스템 — 별 둘레에 더하는 장식. 노드 종류를 색·형태로 구분한다.
// Phase8 Task 6 재매핑: 사람(person)=빛살·엔티티 9종+프로젝트=고리·분류키=별 품은 보석.
// concept·decision·tag 는 장식 제거(일반 별). 고리 기울기는 노드 id 해시로 흩는다.
// 장식을 빼려면 DECORATION_BY_TYPE 매핑 한 줄 + 해당 토큰 + 형태 함수만 지우면
// 별·다른 장식에 영향이 0이 되도록 구성했다(spec 6.6).
import * as THREE from "three";
import type { GraphNodeType } from "../graph-view-model.ts";
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";
import {
  makeCrystalShardGeometry,
  makeRingGeometry,
  rayPixelAlpha,
  ringTiltForNode,
} from "./decoration-geometry.ts";

/** 장식 종류 — 형태 한 가지 + 토큰 한 묶음에 대응한다. */
export type DecorationKind = "ring" | "ray" | "shard";

/**
 * 타입→장식 매핑표(단일 출처·제거 쉬움·spec 6.6).
 * Phase8 Task 6 재매핑: 엔티티 9종+프로젝트→고리·사람→빛살·분류키→유리조각.
 * 여기 없는 타입(concept·decision·tag·글·문서·이미지·llm_extract·unknown)은 장식 없음(일반 별).
 * 한 장식을 제거하려면 이 표에서 한 줄만 지우면 된다 — 다른 장식·별에 영향 0.
 */
const DECORATION_BY_TYPE: Partial<Record<GraphNodeType, DecorationKind>> = {
  // 사람: 빛살(starburst) — 2D 빌보드 스프라이트
  person: "ray",
  // 분류 키: 별 품은 보석 — 별 코어를 감싸는 반투명 크리스탈 구
  classification_key: "shard",
  // 엔티티 타입 9종(프로젝트 포함): 고리(행성 띠) — 3D 토러스 mesh
  work: "ring",
  creature: "ring",
  thing: "ring",
  intake: "ring",
  usable: "ring",
  material: "ring",
  place: "ring",
  schedule: "ring",
  project: "ring",
};

/** 흐림(dim) 상태일 때 장식 불투명도(별과 같이 옅어진다). */
const DIM_OPACITY = 0.18;

/** 빛살 스프라이트 텍스처 한 변(px). */
const RAY_TEX_SIZE = 128;

const DEG = Math.PI / 180;

/**
 * 노드 타입이 어떤 장식을 받는지 정한다(없으면 null).
 * 순수 함수라 WebGL 없이 단위 테스트한다.
 */
export function decorationKindFor(type: GraphNodeType): DecorationKind | null {
  return DECORATION_BY_TYPE[type] ?? null;
}

/**
 * 묶음 노드의 장식 종류를 자식 타입(groupType)으로 정한다.
 * groupType 문자열을 GraphNodeType 으로 보고 자식과 같은 장식을 고른다 — 묶음은
 * 자식과 같은 종류 장식을 큰 크기로 쓴다(R5). 순수 함수라 WebGL 없이 테스트한다.
 *
 * DECORATION_BY_TYPE 에 든 1급 종류(work·person·project 등)는 그 표가 정한 장식을 쓴다.
 * 표에 없는 groupType 은 사용자가 화면으로 더한 *새 종류*(user 1급 종류·plan 2026-06-28 G5
 * 문제2)다 — DECORATION_BY_TYPE 는 GraphNodeType 닫힌 union 키라 'ledger' 같은 user string
 * 이 표에 들어갈 수 없어 조회가 실패한다. 그때 8 타입과 같은 "ring"(고리)을 default 로 준다.
 * 이 함수는 *묶음 노드*(entity_group)에만 불리고 그 groupType 은 항상 1급 종류라(개념·글·이미지
 * 등 장식 없는 종류는 묶음 노드가 안 됨), 표에 없으면 user 1급 종류로 보고 ring 을 주는 게
 * 안전하다. user 종류 묶음만 맨 별(장식 0)로 떨어지던 비대칭을 없앤다(8 종 동등).
 */
export function decorationKindForGroup(groupType: string): DecorationKind {
  return decorationKindFor(groupType as GraphNodeType) ?? "ring";
}

// ---- 빛살(ray) 스프라이트 텍스처 (캔버스로 한 번만 그린다) -----------------

/**
 * 빛살(ray) — 중심에서 N 갈래가 방사하는 starburst 한 장.
 * T18 개정: ctx.createLinearGradient 는 중심→끝 축 방향(길이)으로만 페이드가 걸려
 * 그 축에 수직인 폭 방향(가장자리)은 하드엣지로 남아 "단색 삼각형" 실루엣으로
 * 보였다(사용자 스크린샷 증상). ImageData 를 픽셀 단위로 채워 rayPixelAlpha(길이+폭
 * 방향 모두 반영하는 순수 함수)로 알파를 계산하면 가장자리도 자연히 페이드된다.
 * T20 개정: 밑변(중심 쪽) 반경 안쪽을 통째로 최대 알파로 채우던 하드컷 분기를
 * 없앴다 — 그 경계에서 알파가 급격히 전환되며 "중심 쪽이 끊겨 비어 보이는" 하드엣지가
 * 남아 있었다(사용자 라이브 피드백). rootFade(뿌리 페이드인 구간)로 대체해 빛살이
 * 중심(코어 발광)에서 매끄럽게 이어져 나오게 한다.
 * 128x128 텍스처 1회 생성(타입당 공유)이라 픽셀 순회 부하는 무시할 만하다.
 */
function makeRayTexture(
  size: number,
  color: string,
  count: number,
  edgePower: number,
  halfAngleScale: number,
  rootFade: number,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;
  const outer = c * 0.94;
  const baseHalf = (Math.PI / count) * halfAngleScale;

  // CSS color 문자열 → 0~255 RGB. THREE.Color 가 hex/이름 색을 모두 파싱해준다.
  const rgb = new THREE.Color(color);
  const r = Math.round(rgb.r * 255);
  const g = Math.round(rgb.g * 255);
  const b = Math.round(rgb.b * 255);

  const img = ctx.createImageData(size, size);
  const data = img.data;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const dx = px + 0.5 - c;
      const dy = py + 0.5 - c;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // T20: 옛 "밑변 반경(baseR) 안쪽은 무조건 최대 알파" 하드컷 분기를 없앴다.
      // 그 분기와 rayPixelAlpha 계산값의 경계에서 알파가 뚝 떨어져 중심 쪽이
      // 끊겨 보이는 하드엣지가 생겼었다 — 이제 전 픽셀이 rayPixelAlpha 하나로만
      // 계산되고, 뿌리는 rootFade(smoothstep)로 매끄럽게 이어진다.
      let alpha = 0;
      for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i) / count;
        const a = rayPixelAlpha(
          px + 0.5,
          py + 0.5,
          c,
          angle,
          outer,
          baseHalf,
          edgePower,
          rootFade,
        );
        if (a > alpha) alpha = a; // 여러 빛살이 겹칠 수 있는 경계는 더 밝은 쪽.
      }
      const idx = (py * size + px) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---- 3D 머티리얼 헬퍼 (고리·크리스탈 파편 공유) ----------------------------

/** unlit 가산 머티리얼 한 장 — 조명 안 받음(고리 평면 링 전용). */
function unlitDecorationMaterial(
  color: string,
  opacity: number,
  doubleSide: boolean,
): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
  });
}

/**
 * 별 품은 보석 머티리얼 — 반투명 MeshStandardMaterial + flatShading.
 * 낮은 opacity 로 안의 별 코어(nodes.ts 발광 구)가 비쳐 보이게 하고, flatShading 으로
 * 각 면이 씬 조명을 독립적으로 받아 면마다 명암이 달라 깨진 유리/보석처럼 반짝인다.
 * metalness 는 낮게 둔다(높으면 표면 반사가 강해 뒤의 별빛이 가려진다).
 * AdditiveBlending 으로 별빛이 보석 면 위에 더해져 따뜻한 금빛으로 물든다.
 * DoubleSide — 안쪽 면도 그려 별을 감싼 구 안팎이 모두 보이게 한다.
 */
function crystalDecorationMaterial(
  color: string,
  opacity: number,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity,
    flatShading: true,
    roughness: 0.2,
    metalness: 0.1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// ---- 장식 dim 처리 (Object3D 종류 무관 — material.opacity 일괄 조정) -------

/**
 * 장식 하나의 기본 불투명도를 저장해 둔다 — dim 토글 때 되돌릴 기준값.
 * Sprite·Mesh·Group(파편 묶음) 어느 쪽이든 같은 키로 보관한다.
 */
function rememberBaseOpacity(obj: THREE.Object3D, base: number): void {
  obj.userData["decorationBaseOpacity"] = base;
}

/** Object3D 를 traverse 하며 모든 material 의 불투명도를 한 값으로 맞춘다. */
function setOpacityDeep(obj: THREE.Object3D, opacity: number): void {
  obj.traverse((child) => {
    const mat = (child as THREE.Mesh | THREE.Sprite).material;
    if (!mat) return;
    const list = Array.isArray(mat) ? mat : [mat];
    for (const m of list) {
      (m as THREE.Material & { opacity: number }).opacity = opacity;
    }
  });
}

// ---- DecorationBuilder: 형태·텍스처를 한 번 만들어 공유 -------------------

export class DecorationBuilder {
  /** 빛살 공유 텍스처(2D 빌보드). */
  private readonly rayTex: THREE.CanvasTexture;
  /**
   * 고리 공유 평면 링 geometry — 모든 ring 타입(엔티티·프로젝트) 노드가 같은 형태를 쓴다(부하 절감).
   * material 은 노드별로 복제한다: 공유하면 한 노드를 dim 할 때 같은 타입 노드가
   * 전부 흐려진다(공유 opacity 전파). geometry 공유로 부하 의도를 충족하고,
   * material 은 가벼운 객체라 노드별로 둬도 부담이 작다(dim 독립 보장).
   */
  private readonly ringGeo: THREE.RingGeometry;
  /** 노드별 material 복제의 원본 — 직접 렌더에 쓰지 않고 clone 만 한다. */
  private readonly ringMatProto: THREE.MeshBasicMaterial;
  /**
   * 별 품은 보석 공유 geometry — 별 코어를 감싸는 단위 반지름 IcosahedronGeometry 구.
   * 노드별 mesh 는 이 형태 하나를 공유하고 크기(scale)·material 복제만 다르게 둔다.
   */
  private readonly crystalGeo: THREE.IcosahedronGeometry;
  private readonly shardMatProto: THREE.MeshStandardMaterial;

  constructor() {
    const d = GRAPH_RENDER_THEME.decoration;

    this.rayTex = makeRayTexture(
      RAY_TEX_SIZE,
      d.rayColor,
      d.rayCount,
      d.rayEdgePower,
      d.rayHalfAngleScale,
      d.rayRootFade,
    );

    // 고리: 단위 반지름 평면 링. innerRadius·outerRadius 는 ringWidth 토큰으로.
    // mesh.scale 로 노드 크기에 맞게 키운다. DoubleSide 는 createRing 에서 지정.
    this.ringGeo = makeRingGeometry(
      1 - d.ringWidth / d.ringScale,
      1,
    );
    this.ringMatProto = unlitDecorationMaterial(
      d.ringColor,
      d.ringOpacity,
      true,
    );

    // 별 품은 보석: 단위 반지름 IcosahedronGeometry 하나. createShard 에서 노드
    // 크기에 맞춰 scale 한다. detail 은 토큰(shardDetail)으로 각진/둥근 정도를 정한다.
    this.crystalGeo = makeCrystalShardGeometry(1, d.shardDetail);
    this.shardMatProto = crystalDecorationMaterial(
      d.shardColor,
      d.shardOpacity,
    );
  }

  /**
   * 노드 타입에 맞는 장식 Object3D 를 만든다(매핑에 없으면 null).
   * 크기는 별 size 에 비례하고, 색·배율·각도·불투명도는 전부 토큰을 따른다.
   * createEntry 는 결과 Object3D 만 group 에 더하지 어떤 장식인지 직접 알지 않는다.
   *
   * nodeId — 고리 기울기를 결정적으로 흩을 때 해시 입력으로 쓴다(spec 3.6).
   */
  createDecoration(
    type: GraphNodeType,
    nodeSize: number,
    dim: boolean,
    nodeId: string,
    groupType?: string,
  ): THREE.Object3D | null {
    // 묶음 노드는 자식 타입(groupType)으로 자식과 같은 장식 종류를 고른다(R5).
    // 크기는 nodes.ts 가 groupScale 로 이미 키운 nodeSize 를 그대로 받는다.
    const kind = type === "entity_group" && groupType
      ? decorationKindForGroup(groupType)
      : decorationKindFor(type);
    if (kind === null) return null;
    if (kind === "ray") return this.createRay(nodeSize, dim);
    if (kind === "ring") return this.createRing(nodeSize, dim, nodeId);
    return this.createShard(nodeSize, dim);
  }

  /** 빛살 — 2D 빌보드 스프라이트(공유 텍스처). */
  private createRay(nodeSize: number, dim: boolean): THREE.Sprite {
    const d = GRAPH_RENDER_THEME.decoration;
    const mat = new THREE.SpriteMaterial({
      map: this.rayTex,
      color: new THREE.Color(d.rayColor),
      transparent: true,
      opacity: dim ? DIM_OPACITY : d.rayOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    const sz = nodeSize * d.rayScale;
    sprite.scale.set(sz, sz, 1);
    rememberBaseOpacity(sprite, d.rayOpacity);
    return sprite;
  }

  /**
   * 고리 — 두께 없는 평면 링(THREE.RingGeometry).
   * geometry 는 공유하고 material 만 복제한다(dim 이 노드별로 독립하도록).
   * DoubleSide 머티리얼이라 비스듬히 누운 타원으로 보일 때 뒷면도 렌더된다.
   *
   * nodeId — ringTiltForNode 로 기준 ringTilt ± ringTiltJitterDeg 안에서
   * 결정적으로 흩는다. 같은 노드는 항상 같은 각도(깜빡임 0·spec 3.6·DCL-3).
   */
  private createRing(nodeSize: number, dim: boolean, nodeId: string): THREE.Mesh {
    const d = GRAPH_RENDER_THEME.decoration;
    const mesh = new THREE.Mesh(this.ringGeo, this.ringMatProto.clone());
    mesh.scale.setScalar(nodeSize * d.ringScale);
    mesh.rotation.x = ringTiltForNode(nodeId, d.ringTilt, d.ringTiltJitterDeg) * DEG;
    if (dim) setOpacityDeep(mesh, DIM_OPACITY);
    rememberBaseOpacity(mesh, d.ringOpacity);
    return mesh;
  }

  /**
   * 별 품은 보석 — 별 코어를 감싸는 반투명 크리스탈 구 하나(IcosahedronGeometry).
   * 별 size × shardScale 로 별보다 크게 키워 별 중심에 둔다(group 원점=별 위치).
   * material 의 낮은 opacity + AdditiveBlending 으로 안의 별 코어(nodes.ts 발광 구)가
   * 비쳐 따뜻한 금빛으로 물들고, flatShading 으로 각 면이 명암을 달리 받아 깨진 유리처럼
   * 반짝인다. geometry 는 공유하고 material 만 복제한다(dim 이 노드별로 독립하도록).
   */
  private createShard(nodeSize: number, dim: boolean): THREE.Group {
    const d = GRAPH_RENDER_THEME.decoration;
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(this.crystalGeo, this.shardMatProto.clone());
    mesh.scale.setScalar(nodeSize * d.shardScale);
    group.add(mesh);
    if (dim) setOpacityDeep(group, DIM_OPACITY);
    rememberBaseOpacity(group, d.shardOpacity);
    return group;
  }

  /** 흐림 상태에 맞춰 장식 불투명도를 갱신한다(별과 같이 — 종류 무관). */
  applyDim(decoration: THREE.Object3D, dim: boolean): void {
    const base =
      (decoration.userData["decorationBaseOpacity"] as number | undefined) ??
      DIM_OPACITY;
    setOpacityDeep(decoration, dim ? DIM_OPACITY : base);
  }

  dispose(): void {
    this.rayTex.dispose();
    this.ringGeo.dispose();
    this.ringMatProto.dispose();
    this.crystalGeo.dispose();
    this.shardMatProto.dispose();
  }
}
