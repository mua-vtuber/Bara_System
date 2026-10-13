// Three.js 씬·카메라·렌더러·OrbitControls 셋업
// 견본 graph-3d.js L81~106 이식. dispose() 가 renderer·controls 정리.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";

// ---- 씬 상수 ---------------------------------------------------------------

const CAMERA_FOV = 48 as const;
const CAMERA_NEAR = 0.05 as const;
const CAMERA_FAR = 120 as const;
const CAMERA_INITIAL_Z = 30 as const;
const CAMERA_INITIAL_Y = 0.5 as const;
const CONTROLS_DAMPING = 0.075 as const;
const CONTROLS_MIN_DISTANCE = 5.5 as const;
const CONTROLS_MAX_DISTANCE = 64 as const;
const AMBIENT_COLOR = "#b8c4e8" as const;
const AMBIENT_INTENSITY = 1.15 as const;
const KEY_LIGHT_COLOR = "#e8ecff" as const;
const KEY_LIGHT_INTENSITY = 1.32 as const;

// ---- 공개 타입 ---------------------------------------------------------------

export interface SceneHandle {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  clock: THREE.Clock;
  /**
   * 화면 크기가 바뀔 때마다 새 픽셀 크기(width·height)로 부르는 콜백을 등록한다.
   * LineMaterial.resolution 처럼 해상도에 기대는 자원을 여기서 다시 맞춘다(엣지 굵기 유지).
   */
  onResize(cb: (width: number, height: number) => void): void;
  /** 렌더러·controls 를 정리하고 DOM 노드를 제거한다. */
  dispose(): void;
}

// ---- 생성 함수 ---------------------------------------------------------------

/**
 * Three.js 씬 전체를 초기화해 container 에 renderer.domElement 를 붙인다.
 *
 * 견본 graph-3d.js:
 *   - scene/fog: L81~82
 *   - camera: L84~85
 *   - renderer: L87~95
 *   - OrbitControls: L97~106
 *   - 조명: L126~136
 */
export function createScene(container: HTMLElement): SceneHandle {
  // 씬 + 안개 (견본 L81-82) — 성운 레이어가 배경을 깔므로 fog 는 남색·약하게(2단계).
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(
    GRAPH_RENDER_THEME.fogColor,
    GRAPH_RENDER_THEME.fogDensity,
  );

  // 카메라 (견본 L84-85)
  const camera = new THREE.PerspectiveCamera(
    CAMERA_FOV,
    container.clientWidth / Math.max(1, container.clientHeight),
    CAMERA_NEAR,
    CAMERA_FAR,
  );
  camera.position.set(0, CAMERA_INITIAL_Y, CAMERA_INITIAL_Z);

  // 렌더러 (견본 L87-95)
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // 알파 0 유지가 레이어링의 핵심 — 캔버스가 투명해야 성운이 비친다.
  renderer.setClearColor(GRAPH_RENDER_THEME.fogColor, 0);
  renderer.setSize(
    container.clientWidth || window.innerWidth,
    container.clientHeight || window.innerHeight,
    false,
  );
  // 캔버스 표시 크기를 컨테이너에 맞춰 100% 로 고정한다.
  // setSize 의 updateStyle=false 라 three.js 가 CSS 크기를 설정하지 않으므로,
  // 직접 지정하지 않으면 캔버스 표시 크기가 내부 렌더 해상도(논리크기 × devicePixelRatio)
  // 로 잡힌다. 그러면 DPR>1 인 화면(예: Windows 배율 125~150%)에서 캔버스가 그 배율만큼
  // 커지고, HTML 라벨은 논리 좌표 기준이라 점과 라벨이 배율만큼 어긋난다.
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  renderer.domElement.style.display = "block";
  container.appendChild(renderer.domElement);

  // OrbitControls (견본 L97-106)
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = CONTROLS_DAMPING;
  controls.screenSpacePanning = true;
  controls.minDistance = CONTROLS_MIN_DISTANCE;
  controls.maxDistance = CONTROLS_MAX_DISTANCE;
  controls.target.set(0, 0, 0);
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
  controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;

  // 조명 (견본 L126-136)
  const ambient = new THREE.AmbientLight(AMBIENT_COLOR, AMBIENT_INTENSITY);
  scene.add(ambient);
  const keyLight = new THREE.DirectionalLight(KEY_LIGHT_COLOR, KEY_LIGHT_INTENSITY);
  keyLight.position.set(4, 7, 8);
  scene.add(keyLight);

  const clock = new THREE.Clock();

  // 해상도 의존 자원(엣지 굵기 등)이 크기 변경에 따라가도록 부르는 콜백 목록.
  const resizeCallbacks: ((width: number, height: number) => void)[] = [];

  // 화면 크기 변경 대응
  const resizeObserver = new ResizeObserver(() => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    for (const cb of resizeCallbacks) cb(w, h);
  });
  resizeObserver.observe(container);

  function onResize(cb: (width: number, height: number) => void): void {
    resizeCallbacks.push(cb);
    // 등록 즉시 현재 크기로 1회 호출해 초기 해상도를 맞춘다.
    cb(
      container.clientWidth || window.innerWidth,
      container.clientHeight || window.innerHeight,
    );
  }

  function dispose(): void {
    resizeObserver.disconnect();
    controls.dispose();
    renderer.dispose();
    if (renderer.domElement.parentNode === container) {
      container.removeChild(renderer.domElement);
    }
  }

  return { scene, camera, renderer, controls, clock, onResize, dispose };
}
