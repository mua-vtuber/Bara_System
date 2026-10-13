/**
 * 레이아웃 공용 기하 타입·결정적 시드 — radial-layout.ts·radial-hierarchy.ts 가 import 한다.
 * 옛 force 레이아웃·종류공 코드는 계층 방사형 전환으로 제거됐다(2026-06-14).
 */

export interface Vec3 { x: number; y: number; z: number; }

/** 문자열 id를 결정적 정수 시드로 변환한다(FNV-1a 32bit). Math.random 미사용. */
export function seedFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
