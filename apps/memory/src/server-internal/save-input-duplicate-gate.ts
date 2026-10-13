/**
 * server-internal/save-input-duplicate-gate.ts — saveTextInput 의 유사-중복 관문 실행
 * (T16 / 결정 D-A). save-input.ts 에서 옮겼다(WP-B1-08): 저장(잠금 안)과 즉시 추출 준비
 * (잠금 밖, save-input-immediate.ts)가 같은 관문을 같은 순서로 돌려야 하기 때문이다.
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import {
  checkDuplicateBeforeStore,
  resolveDuplicateThreshold,
} from "./write-guard/duplicate-check.ts";
import {
  DEFAULT_EMBEDDER_MODEL,
  storeDuplicateThresholdOf,
} from "../embedding/factory.ts";
import type { SaveTextInputArgs } from "./save-input-types.ts";

/**
 * 유사-중복 관문 실행 — 검사 대상이 아니면 undefined 를 돌려 저장 경로가 평소대로
 * 자기 임베딩을 계산하게 하고, 대상이면 계산한 임베딩을 돌려 저장이 그것을
 * 재사용하게 한다(단일 임베딩 불변식 — 글 1건당 embed 정확히 1회).
 *
 * precomputedEmbedding 은 같은 본문으로 잠금 밖 준비가 이미 계산한 임베딩이다. 잠금 안
 * 재검사는 그 사이 들어온 닮은 기억을 잡으려고 KNN 만 다시 하고 임베딩은 다시 계산하지 않는다.
 *
 * 검사를 건너뛰는 경우와 그 이유:
 *   - force=true — 호출자가 "알고도 따로 남기겠다"고 명시했다. 비밀값 관문과
 *     sanitize 는 force 로 못 넘는다(그쪽은 안전 문제라 협상 대상이 아니다).
 *   - 긴 글 — 짧은 글 경로 한정(spec D). saveTextInput 호출부 주석 참조.
 *   - 정확-중복이 이미 있는 글 — 흡수(성공 경로)가 담당한다. 거부로 바꾸면
 *     "같은 글 두 번 저장"이 에러가 되어 기존 멱등 계약이 깨진다.
 *   - settings 로 꺼짐 — checkDuplicateBeforeStore 안에서 임베딩 계산 전에 판정.
 */
export async function runDuplicateGate(
  store: SqliteMemoryStore,
  args: SaveTextInputArgs,
  isLong: boolean,
  precomputedEmbedding?: Float32Array,
): Promise<Float32Array | undefined> {
  if (args.force === true || isLong) return undefined;
  // 정확-중복은 흡수 경로 — 유사-중복 검사보다 앞선다(게이트 순서 계약).
  const exactId = await store.findNodeIdByContentHash(
    args.content,
    args.projectId ?? null,
  );
  if (exactId !== null) return undefined;
  const result = await checkDuplicateBeforeStore(
    store,
    args.content,
    // 모델 연동 임계 단일 출처 — concept-alias-detect 가 aliasThresholdOf 를 얻는
    // 방식과 같은 양식(DEFAULT_EMBEDDER_MODEL 기준). Embedder 인터페이스는 모델
    // 식별자를 노출하지 않으므로 factory 의 운영 default 모델로 조회한다.
    resolveDuplicateThreshold(
      storeDuplicateThresholdOf(DEFAULT_EMBEDDER_MODEL),
      args.duplicateCheck?.threshold,
    ),
    // 위 해시 프리체크와 **같은 스코프**를 넘긴다 — 한쪽만 project 를 보면
    // "해시는 통과했는데 KNN 이 남의 프로젝트 글로 막는" 어긋남이 생긴다.
    args.projectId ?? null,
    args.duplicateCheck,
    precomputedEmbedding,
  );
  return result.embedding;
}
