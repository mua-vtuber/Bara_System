/**
 * memory/calibration.ts — 채널별 강도 보정 순수 함수 모듈
 * (강도-반영 융합 설계 §5 / 무-LLM).
 *
 * 한 채널(vector / imageVec 등)의 후보별 원시 cosine 강도를 *그 채널 분포
 * 기준*으로 [0,1] 보정한다. 채널마다 같은 cosine 숫자가 다른 의미라(SigLIP
 * 0.14 = 좋은 매치 / bge-m3 0.5 = 글 baseline), 각 채널 분포로 "얼마나
 * 강한 매치인가"를 보정해야 채널 간 비교가 공정해진다. 라벨 없이 분포에서만
 * 계산하므로 LLM·DB·네트워크 의존이 0 이다.
 *
 * 제공하는 보정 방식 두 가지(설계 §5):
 *   - tmm (theoretical min-max): cosine 은 이론적 하한을 안다. 하한 +
 *     데이터 max 로 [0,1] 정규화. 쿼리 간 안정적이라 cosine 채널 적합.
 *   - dbsf (distribution-based, 3-시그마): mean ± 3·std 경계로 정규화 후
 *     [0,1] clip. 이상치 강건이라 SigLIP imageVec 의 가끔 튀는 값에 적합.
 *
 * ## 누락 채널 floor (설계 §5 / [[image-search-foundation-completed-2026-06-01]])
 *
 * 한 채널에만 잡힌 항목(예: 이미지가 imageVec 채널에만 떠서 vector 채널 통계엔
 * 없음)은 그 채널 보정 통계에서 빠진다. 호출부(T4)가 그 항목을 채널 점수 0 으로
 * 뭉개지 않고 CALIBRATION_FLOOR 의 방식별 하한값으로 사후에 채운다. floor 는
 * "그 채널 분포의 정직한 하한"이지 "잡음"이 아니다 — 외톨이 노드 부당 감점 차단.
 *
 * 설계 원칙:
 *   - 결정적 연산만(LLM 호출 0 / 부수효과 0 / 전역 상태 0).
 *   - 입력 Map 은 읽기만 — 새 Map 을 반환한다(불변).
 *   - 0 나눗셈·단일 후보·전부 동일값·빈 입력 모두 안전 처리.
 */

/**
 * denom(정규화 분모)을 "사실상 0" 으로 볼 임계값. 전부 동일값을 평균낼 때
 * (0.4+0.4+0.4)/3 가 0.4 가 아니라 0.4000…004 처럼 미세 오차를 남겨 std·denom
 * 이 0 이 아닌 극미한 양수가 된다. denom <= 0 만 보면 이런 경우를 "강약 변별
 * 가능"으로 오판해 한 점만 1.0, 나머지 0.0 같은 비정상 결과가 나온다. denom 이
 * 이 임계값 이하면 "변별 불가(폭 0)" 로 취급한다.
 */
const DENOM_EPSILON = 1e-9;

/**
 * 방식별 누락 채널 floor 값(설계 §5).
 *
 * 한 채널에 안 뜬 항목을 호출부(T4)가 사후에 채울 때 쓰는 정직한 하한.
 * 0 으로 뭉개는 게 아니라 "그 채널 분포의 정직한 하한"을 의미한다. 두 방식
 * 모두 보정 출력 [0,1] 의 하한인 0.0 을 floor 로 둔다 — 그 채널에 매치
 * 기록이 없는 항목은 그 채널 강도가 "관측 안 됨"이므로 가장 낮은 정직한
 * 강도로 들어간다. 호출부가 max-우세·가산 결합에서 이 값을 그 채널 기여로
 * 사용해 외톨이 항목이 부당하게 마이너스로 깎이지 않게 한다.
 */
export const CALIBRATION_FLOOR = { tmm: 0.0, dbsf: 0.0 } as const;

/**
 * theoretical min-max 보정. 이론적 하한(`theoreticalMin`, cosine 이면 보통 0
 * 또는 -1)과 데이터 max 로 각 점수를 [0,1] 로 옮긴다.
 *
 * 안전 처리:
 *   - 빈 입력 → 빈 Map.
 *   - denom = (max - theoreticalMin) 이 DENOM_EPSILON 이하(단일 후보가 하한
 *     이하이거나 전부 동일값이라 max == theoreticalMin 인 경우 포함, 부동소수점
 *     미세 오차도 흡수) → 0 나눗셈을 막고 모든
 *     항목을 1.0 으로 본다(관측된 유일 강도가 곧 그 분포의 최대 = 가득 찬
 *     강도). 단일 후보·전부 동일값에서 강도 차가 없으므로 가장 강한 매치로
 *     취급하는 것이 정직하다.
 *   - 결과는 Math.min(1, Math.max(0, ...)) 로 [0,1] clip — theoreticalMin
 *     보다 낮은 raw(있을 수 없지만 방어)도 0 으로 안전.
 *
 * @param scores 후보 id → 원시 cosine 강도.
 * @param theoreticalMin 그 채널 cosine 의 이론적 하한.
 * @returns 후보 id → [0,1] 보정 강도(새 Map).
 */
export function calibrateTmm(
  scores: ReadonlyMap<number, number>,
  theoreticalMin: number,
): Map<number, number> {
  const out = new Map<number, number>();
  if (scores.size === 0) return out;

  let max = -Infinity;
  for (const s of scores.values()) {
    if (s > max) max = s;
  }

  const denom = max - theoreticalMin;
  for (const [id, s] of scores) {
    if (denom <= DENOM_EPSILON) {
      out.set(id, 1.0);
    } else {
      out.set(id, Math.min(1, Math.max(0, (s - theoreticalMin) / denom)));
    }
  }
  return out;
}

/**
 * distribution-based 3-시그마 보정. 분포의 mean·std 로 [mean - 3·std,
 * mean + 3·std] 경계를 잡고 그 안에서 각 점수를 [0,1] 로 정규화한 뒤 clip.
 * 이상치 한 값이 튀어도 경계가 std 기반이라 나머지 보정이 합리적으로 유지된다.
 *
 * 안전 처리:
 *   - 빈 입력 → 빈 Map.
 *   - std == 0 (전부 동일값 / 단일 후보) → denom = 6·std 이 0(또는 부동소수점
 *     미세 오차로 극미한 양수)이라 DENOM_EPSILON 이하로 잡아 0 나눗셈·오판을
 *     막는다. 이때 모든 항목을 0.5 로 본다(분포 폭이 0 = 강약 변별 불가 →
 *     중립 강도). tmm 의 "유일값=최대=1.0" 과 달리 dbsf 는 분포 폭을 강도
 *     척도로 쓰므로, 폭이 0 이면 강도를 단정할 근거가 없어 중립이 정직하다.
 *   - 결과는 [0,1] clip — ±3σ 밖 이상치는 0 또는 1 로 포화.
 *
 * 모분산(N 나눗셈)을 쓴다 — 후보 집합 전체를 분포로 보므로 표본 보정(N-1)이
 * 아니라 모집단 정규화가 맞고, N==1 에서 0 나눗셈도 피한다.
 *
 * @param scores 후보 id → 원시 cosine 강도.
 * @returns 후보 id → [0,1] 보정 강도(새 Map).
 */
export function calibrateDbsf(
  scores: ReadonlyMap<number, number>,
): Map<number, number> {
  const out = new Map<number, number>();
  if (scores.size === 0) return out;

  const n = scores.size;
  let sum = 0;
  for (const s of scores.values()) sum += s;
  const mean = sum / n;

  let sqSum = 0;
  for (const s of scores.values()) {
    const d = s - mean;
    sqSum += d * d;
  }
  const std = Math.sqrt(sqSum / n);

  const lo = mean - 3 * std;
  const hi = mean + 3 * std;
  const denom = hi - lo;

  for (const [id, s] of scores) {
    if (denom <= DENOM_EPSILON) {
      out.set(id, 0.5);
    } else {
      out.set(id, Math.min(1, Math.max(0, (s - lo) / denom)));
    }
  }
  return out;
}

/**
 * 채널별 절대 baseline floor 게이트(방식 gate / 강도-반영 융합 §8.3·§8.6 후속).
 *
 * dbsf 보정은 "채널 안 상대 분포"만 본다 — 절대 강도를 무시한다. 그래서 후보가
 * 전부 무의미한 baseline 잡음이어도 그 중 상대 1위에 강도 1.0(최대)을 준다.
 * A1 실측: "노란후드" 검색에서 내용이 그냥 "---"(마크다운 표 구분선 청크)인
 * 노드가 vector 채널 상대 1위로 정밀 강도 최대를 받아 진짜 답인 이미지를 눌렀다.
 *
 * 이 함수는 dbsf/tmm 보정 *결과* Map 을 받아, raw cosine 이 채널 baseline 미만인
 * 노드의 보정 강도를 0 으로 덮는다(나머지는 그대로). dbsf 의 분별력은 유지한 채
 * baseline 수준 잡음만 0 으로 컷한다 — "그 노드는 진짜 매치가 아니라 모델이
 * 짧은 검색어에 부여하는 baseline 잡음" 이라는 절대 기준을 보정 결과에 덧씌운다.
 *
 * baseline 측정 근거(강도-반영 융합 §8.3·§8.6 + 2026-06-01 A1 실측):
 *   - vector(글 임베딩)는 모델에 연동된다 — bge-m3 ≈ 0.5(무관 글 0.28~0.49 /
 *     관련 글 0.559).
 *   - imageVec(SigLIP) ≈ 0.1(무관 이미지 0.057 / 관련 이미지 0.117~0.138 사이).
 * 운영 흐름: vector 운영 default 는 server.ts 가 vectorBaselineOf(model)로 retriever
 * 에 주입(모델 연동) / imageVec 은 SigLIP 고정이라 search-tuning.ts 의
 * IMAGE_VEC_COSINE_BASELINE 단일 상수. VECTOR_COSINE_BASELINE 은 모델 미상 최후 fallback.
 *
 * 안전 처리:
 *   - 빈 보정 Map → 빈 Map(복사).
 *   - raw 에 없는 노드(보정 Map 에만 있는 경우는 호출부 양식상 발생하지 않으나
 *     방어) → raw 강도를 알 수 없으므로 baseline 판정을 *건너뛰고* 보정값 그대로
 *     둔다(외톨이 부당 감점 차단 — 잡음으로 단정하지 않는다).
 *   - baseline = 0(또는 음수) → 모든 raw 가 baseline 이상이라 한 노드도 0 으로
 *     덮지 않는다(게이트 통째 비활성 = 보정 Map 그대로 복사 / off 와 동치).
 *
 * 입력 Map 은 읽기만 — 새 Map 을 반환한다(calibration.ts 불변 원칙 정합).
 *
 * @param calibrated 보정 결과 Map(calibrateDbsf / calibrateTmm 산출).
 * @param raw 같은 노드의 원시 cosine 강도 Map(보정 입력).
 * @param baseline 그 채널의 절대 baseline cosine. raw 가 이 값 미만이면 강도 0.
 * @returns 후보 id → baseline floor 적용 보정 강도(새 Map).
 */
export function applyBaselineFloor(
  calibrated: ReadonlyMap<number, number>,
  raw: ReadonlyMap<number, number>,
  baseline: number,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const [id, cal] of calibrated) {
    const r = raw.get(id);
    // raw 강도를 모르는 노드는 baseline 판정을 건너뛴다(보정값 보존).
    if (r !== undefined && r < baseline) {
      out.set(id, 0);
    } else {
      out.set(id, cal);
    }
  }
  return out;
}
