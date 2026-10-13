/**
 * 타입 등급 판정 순수 모듈 — Three.js·force 무관.
 *
 * - 1급 엔티티(person·project + ENTITY_TYPE_METAS 8종) 여부 판정
 * - 2급 개념성 노드(concept·tag·classification_key·decision) 여부 판정
 *
 * radial-hierarchy.ts 가 주 부모 결정·사이클 해소·루트 판별에 사용한다.
 * 1급 타입 목록은 ENTITY_TYPE_METAS에서 파생한다 — 레이아웃 파일 내 하드코딩 금지.
 */
import { ENTITY_TYPE_METAS } from "../../../../src/db/store-internal/entity-type-registry.ts";

/**
 * 1급 = 엔티티 10종(레지스트리 8종 + 사람·프로젝트).
 * 레지스트리에서 파생해 타입 이름 하드코딩을 차단한다.
 */
const FIRST_TIER: ReadonlySet<string> = new Set<string>([
  ...ENTITY_TYPE_METAS.map((m) => m.typeName),
  "person",
  "project",
]);

/**
 * 2급 = 개념성 노드.
 * 엔티티 레지스트리에 없는 cross-cutting 분류 축(spec §2.2).
 */
const SECOND_TIER: ReadonlySet<string> = new Set<string>([
  "concept",
  "tag",
  "classification_key",
  "decision",
]);

/** 해당 타입이 1급 엔티티인지 확인한다. */
export function isFirstTier(type: string): boolean {
  return FIRST_TIER.has(type);
}

/** 해당 타입이 2급 개념성 노드인지 확인한다. */
export function isSecondTier(type: string): boolean {
  return SECOND_TIER.has(type);
}
