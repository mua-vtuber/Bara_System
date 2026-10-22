/**
 * test-utils/resolved-scope.ts — 테스트용 해석 완료 범위(ResolvedMemoryScope) 조립 함수.
 *
 * 안쪽 읽기 코드는 해석이 끝난 범위만 받는다(2026-10-21 spec 10.2). 해석기 자체를 검증하지
 * 않는 테스트가 "이 project_id 값들만 보는 범위"를 직접 만들 때 쓰는 데이터 조립 함수다.
 * 해석기 동작은 memory/project-scope-resolver.int.test.ts 가 실제 store 로 검증한다.
 */

import type { ResolvedMemoryScope } from "../memory/shared-memory-contract.ts";
import { GLOBAL_READ_SCOPE } from "../memory/project-scope-resolver.ts";

/** 프로젝트 없는 기억만 보는 범위(범위 없이 부른 recall_context·get_profile 의 기본값). */
export function globalScope(): ResolvedMemoryScope {
  return GLOBAL_READ_SCOPE;
}

/** project_id 가 values 중 하나인 기억(+ includeGlobal 이면 프로젝트 없는 기억)을 보는 범위. */
export function projectValuesScope(values: readonly string[], includeGlobal = false): ResolvedMemoryScope {
  if (values.length === 0) throw new Error("projectValuesScope: values 가 비었습니다");
  return {
    projectIds: [...values], includeGlobal, requested: values[0]!, resolvedFrom: "legacy_value", projectName: null,
  };
}
