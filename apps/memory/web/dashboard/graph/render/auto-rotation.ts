import type * as THREE from "three";
import { AutoRotationMotion } from "./auto-rotation-motion.ts";

/** 자동 회전만 관리한다. OrbitControls 의 사용자 조작·관성에는 손대지 않는다. */
export class GraphAutoRotation {
  private readonly motion: AutoRotationMotion;
  private readonly pointers = new Set<number>();
  private readonly doc: Document;
  private readonly view: Window;
  private detailOpen = false;
  private blocked = false;
  private blurred = false;
  private disposed = false;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly target: THREE.Vector3,
    private readonly canvas: HTMLElement,
    private readonly now = () => performance.now() / 1000,
  ) {
    this.motion = new AutoRotationMotion(now());
    this.doc = canvas.ownerDocument;
    this.view = this.doc.defaultView!;
    // capture 로 OrbitControls·노드 드래그보다 먼저 입력을 기록한다.
    canvas.addEventListener("pointerdown", this.onPointerDown, true);
    canvas.addEventListener("lostpointercapture", this.onPointerEnd, true);
    canvas.addEventListener("wheel", this.onWheel, { capture: true, passive: true });
    this.view.addEventListener("pointerup", this.onPointerEnd, true);
    this.view.addEventListener("pointercancel", this.onPointerEnd, true);
    this.view.addEventListener("pointermove", this.onPointerMove, true);
    this.view.addEventListener("blur", this.onBlur);
    this.view.addEventListener("focus", this.onFocus);
    this.doc.addEventListener("visibilitychange", this.onVisibilityChange);
    this.syncPaused();
  }

  /** 카메라 전환·reduced-motion 은 호출부가 blocked 로 전달한다. */
  update(blocked = false): void {
    if (this.disposed) return;
    this.blocked = blocked;
    this.syncPaused();
    const angle = this.motion.step(this.now());
    if (angle === 0) return;
    // 별의 좌표·연결선은 유지하고, 현재 사용자가 잡은 시점의 target 주위를 돈다.
    // controls.update 전에 적용해 자동 회전량이 사용자 damping 에 누적되지 않게 한다.
    this.camera.position.sub(this.target).applyAxisAngle(this.camera.up, -angle).add(this.target);
    this.camera.lookAt(this.target);
  }

  setDetailOpen(open: boolean): void {
    this.detailOpen = open;
    this.syncPaused();
  }

  private syncPaused(): void {
    this.motion.setPaused(this.detailOpen || this.blocked || this.blurred || this.doc.hidden, this.now());
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.pointers.add(event.pointerId);
    this.motion.setInteracting(true, this.now());
  };

  private readonly onPointerEnd = (event: PointerEvent): void => {
    if (!this.pointers.delete(event.pointerId)) return;
    this.motion.setInteracting(this.pointers.size > 0, this.now());
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    // 창 전환 중 capture 를 잃어도 복귀한 포인터가 누른 상태면 hold 를 복원한다.
    if (event.buttons !== 0 && event.target === this.canvas) this.onPointerDown(event);
    // 창 밖에서 버튼을 놓아 pointerup 을 놓쳤을 때도 영구 정지하지 않는다.
    if (event.pointerType !== "touch" && event.buttons === 0) this.onPointerEnd(event);
  };

  private readonly onWheel = (): void => { this.motion.activity(this.now()); };

  private readonly onBlur = (): void => {
    this.blurred = true;
    // blur 는 버튼 해제를 뜻하지 않는다. up/cancel 또는 buttons=0 으로 확인한다.
    this.syncPaused();
  };

  private readonly onFocus = (): void => {
    this.blurred = false;
    this.syncPaused();
  };

  private readonly onVisibilityChange = (): void => {
    this.syncPaused();
  };

  dispose(): void {
    this.disposed = true;
    this.canvas.removeEventListener("pointerdown", this.onPointerDown, true);
    this.canvas.removeEventListener("lostpointercapture", this.onPointerEnd, true);
    this.canvas.removeEventListener("wheel", this.onWheel, true);
    this.view.removeEventListener("pointerup", this.onPointerEnd, true);
    this.view.removeEventListener("pointercancel", this.onPointerEnd, true);
    this.view.removeEventListener("pointermove", this.onPointerMove, true);
    this.view.removeEventListener("blur", this.onBlur);
    this.view.removeEventListener("focus", this.onFocus);
    this.doc.removeEventListener("visibilitychange", this.onVisibilityChange);
  }
}
