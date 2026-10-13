/**
 * routes/search-result-floor.ts — AI 경로 검색 결과 하한선(spec F / 결정 D-B).
 *
 * 무관한 글로 top-k 를 채우던 동작을 끝낸다. 하한선 미달 결과는 *목록에서 버린다* —
 * 0건 회신이 정직한 상태다(D-B). 사람 눈으로 훑는 대시보드는 낮은 점수도 단서로
 * 쓰므로 이 게이트는 AI 경로에만 걸린다(단락 11 확정 3) — 호출측이 명시하는
 * `applyResultFloor` 플래그로 가른다. 호출자 정체(REST/MCP)를 이 모듈이 추측하는
 * silent 분기는 두지 않는다.
 *
 * **관측 대상은 `components.vectorRawCosine`(보정 전 raw cosine)이지 융합 최종
 * 점수가 아니다.** T19 실측에서 unanswerable 문항 최종 점수 최대값(0.3828)이 gold
 * 최대값과 소수점 4자리까지 같았다 — RRF 는 순위만 보고 절대 강도를 버리기 때문에
 * 융합 점수로는 어떤 값을 잡아도 무관 결과와 정답이 안 갈린다. raw cosine 은 절대
 * 강도를 보존해 갈린다(factory EMBEDDING_RESULT_FLOOR_PARAMS 주석에 분포 기재).
 *
 * 이미 있는 `applyBaselineFloor`(calibration.ts)와는 하는 일이 다르다 — 그쪽은 raw
 * cosine 이 낮은 노드의 *정밀 강도를 0 으로 깎되 결과는 남기는* 게이트다. 여기는
 * *결과를 버리는* 게이트라 척도(raw cosine)가 같아도 값이 따로다.
 *
 * 동작 비용: 이미 계산된 값을 읽는 비교 N회 — 추가 임베딩·DB 조회 0(D-D).
 */

import type { RetrievalResult } from "../../memory/retriever.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import {
  DEFAULT_EMBEDDER_MODEL,
  resultFloorParamsOf,
  type ResultFloorParams,
} from "../../embedding/factory.ts";

/**
 * 한 결과가 하한선을 통과하는지. 순수 함수 — 테스트가 직접 부른다.
 *
 * **`vectorRawCosine` 가 undefined 면 통과시킨다.** vector 채널에 안 뜬 노드(fts·
 * graph 채널로만 올라온 노드)는 이 칸이 없다 — 그걸 "cosine 0" 으로 읽으면 정상
 * 결과를 버린다. 강도를 *관측하지 못한 것* 과 강도가 *낮은 것* 은 다르다(T19 인계
 * 항목2). 기존 `applyBaselineFloor` 도 같은 이유로 raw 를 모르는 노드는 판정을
 * 건너뛴다. 이 코퍼스에서는 966건 전수 undefined 0건이었지만, vector 채널 후보
 * 상한을 넘는 큰 코퍼스에서는 실제로 생길 수 있는 갈래다.
 */
export function passesResultFloor(
  result: RetrievalResult,
  params: ResultFloorParams,
): boolean {
  const raw = result.components.vectorRawCosine;
  if (raw === undefined) return true;
  if (params.mode === "absolute") return raw >= params.floor;
  // baselineMargin 갈래는 factory 타입에만 있고 등록된 모델이 없다(T19 — bge-m3
  // 에서 absolute 에 졌다). 등록 없이 이 갈래로 들어오면 조용히 통과시키지 않고
  // 명시적으로 멈춘다 — 미구현을 "전건 통과" 로 위장하면 게이트가 꺼진 걸 아무도
  // 모른다. 새 모델이 이 방식으로 등록되는 시점에 함께 구현한다.
  throw new Error(
    `Result floor mode="${params.mode}" is registered in the factory map but not implemented here. ` +
      `Implement the branch in search-result-floor.ts before registering a model that uses it.`,
  );
}

/** 하한선 적용 산출 — 통과 결과와 버린 개수(processing_info.afterFiltering 반영용). */
export interface ResultFloorOutcome {
  kept: RetrievalResult[];
  /**
   * 하한선 판정이 실제로 돌았는지. 호출자가 `processing_info.afterFiltering` 을
   * 어느 근거로 셀지 고르는 데 쓴다.
   *
   * **버린 개수(dropped)를 노출하지 않는 것이 의도다.** 개수를 주면 호출자가
   * `stats.afterFiltering - dropped` 라는 뺄셈을 하기 쉬운데, 그 두 수는 모집단이
   * 다르다 — retriever 의 `stats.afterFiltering` 은 limit 절단 *전* 후보 수이고
   * (retriever.ts: `results.length` 를 `slice(0, limit)` 앞에서 캡처), 여기 kept 는
   * 이미 절단된 배열에서 나온다. 코퍼스가 limit 보다 크면 뺄셈이 어긋나 전건
   * 탈락인데도 afterFiltering > 0 이 나오고(D-B 정직한 0 신호 파괴), 리랭커
   * topKOutput 절단까지 겹치면 음수도 가능하다. 세는 근거를 생존자 쪽으로
   * 고정하려고 개수 대신 이 플래그를 준다(2026-08-03 수정 순환 1회차).
   */
  applied: boolean;
}

/**
 * settings 의 하한선 노브를 읽어 결과를 거른다.
 *
 * 적용 조건 세 겹이 전부 참일 때만 거른다:
 *   1. `applyFloor` — 호출측 명시 플래그(AI 경로 ON / 대시보드 REST OFF).
 *   2. `settings.search.resultFloor.enabled` — 사용자 토글.
 *   3. mode 가 "off" 가 아님 — 방식 자체를 끈 상태.
 * 하나라도 거짓이면 입력 배열을 *그대로* 돌려준다(새 배열 조립조차 안 함 — 참조
 * 동일). OFF 토글이 도입 전과 byte 동일해야 하는 계약(spec F 테스트 의무)이다.
 *
 * 임계값 출처: `resultFloorParamsOf(DEFAULT_EMBEDDER_MODEL)` factory 단일 출처.
 * settings 의 `absolute` 가 0 이상이면 그 사용자값이 모델값을 이긴다(음수 -1 =
 * 미지정 sentinel — search 그룹 baselineVectorCosine·writeGuard duplicateCheck 와
 * 같은 규칙). 맵 밖 임계 리터럴은 두지 않는다(2026-07-10 fail 21건 교훈).
 */
export function applyResultFloor(
  results: RetrievalResult[],
  settings: MemorySettings | undefined,
  applyFloor: boolean,
): ResultFloorOutcome {
  if (!applyFloor) return { kept: results, applied: false };

  const knob = settings?.search?.resultFloor;
  // settings 미주입(테스트 직호출 / buildMemoryApi 직호출)이면 default 를 쓴다 —
  // 스키마 default 가 enabled=true 라 AI 경로는 설정 없이도 하한선이 걸린다.
  const enabled = knob?.enabled ?? true;
  if (!enabled) return { kept: results, applied: false };

  const mode = knob?.mode ?? "absolute";
  if (mode === "off") return { kept: results, applied: false };

  const params = resolveResultFloorParams(knob);

  const kept = results.filter((r) => passesResultFloor(r, params));
  return { kept, applied: true };
}

/**
 * settings 노브 → 실제 판정 파라미터. 모델 연동 factory 값이 기준이고, settings 의
 * 값이 음수 sentinel 이 아니면 그 사용자값이 이긴다(resolveModelSentinel 과 같은 규칙).
 *
 * settings 의 mode 가 factory 등록 방식과 다른 갈래를 가리키면 settings 를 따른다 —
 * 사용자가 명시한 방식이 모델 default 를 이기는 것이 이 sentinel 규칙의 취지다.
 * 다만 그 갈래 계수는 settings 값이 유효할 때만 쓸 수 있으므로, 계수가 미지정이면
 * factory 가 그 방식으로 등록돼 있어야 한다(아니면 loud fail).
 */
function resolveResultFloorParams(
  knob: MemorySettings["search"]["resultFloor"] | undefined,
): ResultFloorParams {
  const modelParams = resultFloorParamsOf(DEFAULT_EMBEDDER_MODEL);
  const mode = knob?.mode ?? modelParams.mode;

  if (mode === "absolute") {
    const override = knob?.absolute;
    if (override !== undefined && override >= 0) {
      return { mode: "absolute", floor: override };
    }
    if (modelParams.mode !== "absolute") {
      throw new Error(
        `settings.search.resultFloor.mode="absolute" needs an explicit absolute value: ` +
          `the model default for "${DEFAULT_EMBEDDER_MODEL}" is mode="${modelParams.mode}".`,
      );
    }
    return modelParams;
  }

  // baselineMargin — settings 가 이 방식을 고를 수는 있으나 판정 구현이 없다.
  // passesResultFloor 가 명시 throw 로 멈춘다(위 주석). 여기서 계수를 조립해
  // 넘겨도 그 갈래에서 멈추므로, 원인을 이 자리에서 그대로 드러낸다.
  if (modelParams.mode === "baselineMargin") return modelParams;
  throw new Error(
    `settings.search.resultFloor.mode="baselineMargin" is not implemented: ` +
      `the model default for "${DEFAULT_EMBEDDER_MODEL}" is mode="${modelParams.mode}".`,
  );
}
