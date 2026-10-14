/**
 * Memory Core Settings Schema — 검색·보관 그룹 (C2/schema 분해 2026-06-27).
 *
 * memory-schema.ts MEMORY_SCHEMA.properties 의 뒤쪽 7 그룹을 그대로 떼어낸 파일.
 * 회상·보관 흐름의 그룹 — search(유사도 임계값) / reranker / valueDecay /
 * assets / images / chunking / security. 각 그룹은 `as const satisfies GroupSchema`
 * 로, 옛 통째 `as const satisfies {...}` 와 동일한 리터럴 타입을 유지한다. 앞쪽
 * 7 그룹은 memory-schema-groups-pipeline.ts 에 있다.
 */

import { RERANKER_MAX_PAIR_TOKENS_MAX, RERANKER_MAX_PAIR_TOKENS_MIN } from "../memory/reranker-limits.ts";
import type { GroupSchema } from "./memory-schema-types.ts";

export const searchGroup = {
  type: "object",
  title: "검색·충돌·중복 정리",
  description:
    "retriever 와 conflict-checker 가 공유하는 유사도 임계값 그룹 (Phase 5.7.1 W1 — 시간 감쇠 가닥은 valueDecay 그룹으로 이전).",
  properties: {
    mergeSimThreshold: {
      type: "number",
      title: "같은 메모리로 합칠 비슷함 점수 (모델 연동)",
      description:
        "이 점수 위는 신규 노드 대신 옛 노드 병합으로 처리 (Phase 5.7.1 W1 — 옛 dedupSim + clusterSimHigh 통합). default -1 = 모델 연동 (bge-m3 0.85). 0~1 값을 직접 넣으면 그 값이 우선한다 (사용자 오버라이드). bge-m3 값은 실측 분포 기반 추정 — eval harness 확장(감사 H1) 후 sweep 으로 재측정 확정 대상.",
      default: -1,
      minimum: -1,
      maximum: 1,
    },
    conflictCheckMin: {
      type: "number",
      title: "충돌 검사 시작 점수 (모델 연동)",
      description:
        "이 점수 위 노드 쌍은 충돌 후보 검사 대상 (옛 conflictLow). default -1 = 모델 연동 (bge-m3 0.55). 0~1 값을 직접 넣으면 그 값이 우선 (사용자 오버라이드). bge-m3 값은 실측 분포(관련 0.559 / 무관 0.49) 기반 추정 — 감사 H1 후 sweep 재측정 확정 대상.",
      default: -1,
      minimum: -1,
      maximum: 1,
    },
    conflictSameMax: {
      type: "number",
      title: "사실상 동일로 처리할 점수 (모델 연동)",
      description:
        "이 점수 위는 충돌이 아닌 사실상 동일 노드로 처리 (옛 conflictHigh). default -1 = 모델 연동 (bge-m3 0.85). 0~1 값을 직접 넣으면 그 값이 우선 (사용자 오버라이드). bge-m3 값은 실측 분포 기반 추정 — 감사 H1 후 sweep 재측정 확정 대상.",
      default: -1,
      minimum: -1,
      maximum: 1,
    },
    mentionBoost: {
      type: "number",
      title: "사람 멘션 점수 보너스",
      description: "사람 멘션 매치 시 검색 점수 가산. 본인 결정 0.05 유지.",
      default: 0.05,
      minimum: 0,
      maximum: 1,
    },
    precisionStrengthWeight: {
      type: "number",
      title: "유사도 강도 정밀 가중치",
      description:
        "강도-반영 정밀 재채점 가중치 λ (강도-반영 융합 설계 §4.2 / T4). 유사도 채널(SigLIP 이미지·bge-m3 글)의 보정된 닮음 강도를 검색 점수에 더하는 정도다. 0 = 정밀 강도 미적용(순위 합산만 — 옛 동작). 1.0 보다 작은 값으로, 클수록 '강하게 닮은 항목'을 순위에 더 싣는다 — 검색어에 정확히 맞는 글·이미지가 연결성만 많은 약한 항목에 밀리지 않게 한다. default 0.2 (측정 확정 — 정확 매치 글을 약한 다채널 항목 위로 안정 격차로 올리면서 글 검색 품질 회귀 0). 너무 높이면 약하게 닮은 항목까지 끌어올린다. RRF 순위 합산 코어는 바뀌지 않고 가산 항으로만 들어간다.",
      default: 0.2,
      minimum: 0,
      maximum: 1,
    },
    baselineFloorMode: {
      type: "string",
      title: "유사도 baseline 잡음 컷 방식",
      description:
        "유사도 강도 정밀 재채점 시 '의미 없는 baseline 잡음'을 거르는 방식 (강도-반영 융합 §8.3·§8.6). 임베딩 모델은 짧은 검색어에 *무관한* 글·이미지에도 낮은 닮음 점수를 준다 — 그 잡음이 정밀 가중치로 증폭돼 진짜 답 위로 끼어드는 흠을 막는다. 'gate' (default) = 닮음 점수가 채널 baseline 미만인 항목의 정밀 강도를 0 으로 컷 (분별력은 유지). 'off' = 컷 안 함 (옛 동작). 'tmm-min' = baseline 을 정규화 하한으로 (비교용). RRF 순위 합산 코어는 불변.",
      default: "gate",
      enum: ["off", "gate", "tmm-min"] as const,
      "x-ui": { widget: "select" },
    },
    baselineVectorCosine: {
      type: "number",
      title: "글 유사도 baseline (모델 연동)",
      description:
        "글 유사도 채널의 절대 baseline 닮음 점수. 검색어와의 raw cosine 이 이 값 미만인 글은 정밀 강도 0 으로 처리 (baseline 잡음). default -1 = 모델 연동 (bge-m3 0.5, A1 실측). 0~1 값을 직접 넣으면 모델 연동 대신 그 값이 우선한다 (사용자 오버라이드). 낮추면 잡음 글이 끼어들고, 너무 높이면 약하게 맞는 진짜 글까지 컷한다. baselineFloorMode='off' 면 미사용.",
      default: -1,
      minimum: -1,
      maximum: 1,
    },
    baselineImageVecCosine: {
      type: "number",
      title: "이미지 유사도 baseline (SigLIP)",
      description:
        "이미지 유사도(SigLIP) 채널의 절대 baseline 닮음 점수. 검색어와의 raw cosine 이 이 값 미만인 이미지는 정밀 강도 0 으로 처리. default 0.1 (A1 실측 — 무관 이미지 SigLIP cosine ≈ 0.057 / 관련 이미지 0.117~0.138 사이). SigLIP 한 모델 고정이라 글 임베딩 모델과 무관한 단일값이다. baselineFloorMode='off' 면 미사용.",
      default: 0.1,
      minimum: 0,
      maximum: 1,
    },
    resultFloor: {
      type: "object",
      title: "AI 검색 결과 하한선",
      description:
        "닮은 정도가 하한선에 못 미치는 결과를 AI 검색 응답에서 아예 뺀다. 위 baseline 칸들과 재는 척도는 같지만 하는 일이 다르다 — baseline 은 점수만 깎고 결과는 남기는데, 여기는 결과를 목록에서 버린다. 걸러진 뒤 남는 것이 없으면 0건으로 회신한다(찾은 것이 없다는 정직한 상태 — 관련 없는 글로 목록을 채우지 않는다). 몇 건이 걸러졌는지는 응답의 processing_info 로 항상 볼 수 있다. **대시보드 검색에는 적용되지 않는다** — 사람이 눈으로 훑을 때는 낮은 점수 결과도 단서가 되므로 화면 검색은 전체를 그대로 보여준다.",
      properties: {
        enabled: {
          type: "boolean",
          title: "AI 검색 하한선 사용",
          description:
            "켜 두는 것을 권한다 — 2026-08-03 실측에서 손 정답 회수 손실 0(검색 품질 지표가 소수점 6자리까지 그대로)이면서 무관한 꼬리 결과의 62% 가 걸러졌다. 끄면 AI 검색도 대시보드처럼 하한선 없이 전체를 회신한다.",
          default: true,
        },
        mode: {
          type: "string",
          title: "하한선 방식",
          description:
            "'absolute' (default) = 고정 하한값 하나로 자른다. 'off' = 자르지 않는다(사용 칸을 끈 것과 같은 동작). 'baselineMargin' = 검색어마다 결과 분포에서 기준선을 잡고 그보다 여유값만큼 위만 통과 — 이 방식은 2026-08-03 실측에서 absolute 에 졌고(검색어마다 분포 폭이 달라 정답이 몰린 검색에서 정답 한가운데를 자름) 현재 등록된 모델이 없어 고르면 명시적으로 멈춘다.",
          default: "absolute",
          enum: ["off", "absolute", "baselineMargin"] as const,
          "x-ui": { widget: "select" },
        },
        absolute: {
          type: "number",
          title: "하한값 (모델 연동)",
          description:
            "결과의 raw 닮음 점수가 이 값 미만이면 목록에서 버린다. default -1 = 모델 연동 (bge-m3 0.44, 2026-08-03 실측 확정 — 손 정답 최저값 0.4788 아래로 흔들림 여유 0.0388 을 둔 값). 0~1 값을 직접 넣으면 그 값이 우선한다 (사용자 오버라이드). 높이면 무관한 결과를 더 걷어내지만 0.4788 을 넘는 순간 진짜 정답을 잃기 시작한다.",
          default: -1,
          minimum: -1,
          maximum: 1,
        },
        margin: {
          type: "number",
          title: "기준선 여유값 (baselineMargin 방식 전용)",
          description:
            "'baselineMargin' 방식에서 검색어별 기준선 위로 얼마나 더 높아야 통과시킬지. default -1 = 미지정. 그 방식이 등록된 모델이 없어 현재 쓰이지 않는다 — 방식이 등록되는 시점에 함께 확정한다.",
          default: -1,
          minimum: -1,
          maximum: 1,
        },
      },
      required: ["enabled", "mode", "absolute", "margin"] as const,
    },
    indexModeLimit: {
      type: "integer",
      title: "AI 색인 검색 회신 건수",
      description:
        "AI 가 '목록만 먼저' 방식으로 검색할 때(responseMode='index') 한 번에 받아 갈 기억 수. 이 방식은 본문 대신 한 줄 미리보기와 id 만 회신하고, AI 가 그중 필요한 것만 골라 본문을 다시 받아 간다 — 건당 분량이 작아 일반 검색(최대 50건)보다 많이 보여줄 수 있다. default 40. 최대 100 — 이 값이 회신 분량의 상한을 정하므로 그 위로는 올릴 수 없다. 화면 검색과는 무관하다(대시보드는 늘 본문 포함 방식).",
      default: 40,
      minimum: 1,
      maximum: 100,
    },
  },
  required: [
    "mergeSimThreshold",
    "conflictCheckMin",
    "conflictSameMax",
  ] as const,
} as const satisfies GroupSchema;

export const rerankerGroup = {
  type: "object",
  title: "리랭커 (검색 결과 재정렬)",
  description:
    "RRF 검색 상위 후보를 작은 cross-encoder 모델로 다시 점수 매겨 재정렬하는 검색 코어 단계 (Phase 6b R5 / spec 11.3.1). 검색을 가로지르는 별도 관심사라 top-level 그룹으로 둔다 (search 그룹 = RRF 임계값 스칼라 / 6a extractor 그룹 = top-level 선례 정합). default ON — T7 검색 평가 harness measured-win 정착 (flat nDCG +0.1074 / enriched +0.1594 / recall 불변) + 사용자 결정. 모델 미가용 시 RRF 한 단계로 자동 강등.",
  properties: {
    enabled: {
      type: "boolean",
      title: "리랭커 가동",
      description:
        "true (default) = 상위 후보를 cross-encoder 로 재정렬. false = RRF 결과 그대로 회신 (재정렬 0). default ON 은 T7 검색 평가 harness measured-win (nDCG flat +0.1074 / enriched +0.1594) + 사용자 결정 — 첫 가동 시 모델 로드 (~13s / 수백 MB) 비용을 더 나은 정렬 품질로 받아들임.",
      default: true,
    },
    model: {
      type: "string",
      title: "리랭커 모델",
      description:
        "cross-encoder 재정렬 모델 식별자. default = onnx-community/bge-reranker-v2-m3-ONNX (Task 4 ONNX 가용성 확인 / @huggingface/transformers AutoModelForSequenceClassification + dtype q8 로 A1 ARM64 가동 가능 / 다국어 적합).",
      default: "onnx-community/bge-reranker-v2-m3-ONNX",
    },
    topK_input: {
      type: "integer",
      title: "재정렬 입력 후보 수",
      description:
        "운영 최종 점수 (중립 RRF + cue 가중치 / search-tuning.ts 상수) 상위 N 후보를 재정렬 입력으로 회수 (spec 11.1.1). default 30.",
      default: 30,
      minimum: 1,
    },
    topK_output: {
      type: "integer",
      title: "재정렬 출력 결과 수",
      description:
        "재정렬 후 상위 N 결과만 회신. default 5. topK_input 보다 작거나 같게 둔다.",
      default: 5,
      minimum: 1,
    },
    maxPairTokens: {
      type: "integer",
      title: "재정렬 쌍 최대 토큰 수",
      description:
        "(질의, 글) 한 쌍을 리랭커에 넣을 때의 최대 토큰 수. 넘으면 글 뒷부분을 자른다. default 512. 바꾸면 서버 재시작 뒤 반영된다.",
      default: 512,
      minimum: RERANKER_MAX_PAIR_TOKENS_MIN,
      maximum: RERANKER_MAX_PAIR_TOKENS_MAX,
    },
    host: {
      type: "string",
      title: "리랭커 가동 위치",
      description:
        "리랭커 모델 가동 위치. 'local' = 로컬 cross-encoder (LLM 대화 호출 0 / graceful degradation 정신). 현 단계 후보는 'local' 한 갈래.",
      default: "local",
      enum: ["local"] as const,
      "x-ui": { widget: "select" },
    },
  },
  required: [
    "enabled",
    "model",
    "topK_input",
    "topK_output",
    "maxPairTokens",
    "host",
  ] as const,
} as const satisfies GroupSchema;

export const valueDecayGroup = {
  type: "object",
  title: "메모리 가치 평가 (시간 감쇠)",
  description:
    "retriever + 메모리 자동 정리 주기가 공유하는 시간 감쇠 그룹 (Phase 5.7.1 W1 — search 그룹에서 이전).",
  properties: {
    importanceDecay: {
      type: "number",
      title: "중요도 시간 감쇠 계수",
      description: "검색 가중치 합산에 쓸 importance 감쇠 계수.",
      default: 0.7,
      minimum: 0,
      maximum: 1,
    },
    recencyHalfLifeDays: {
      type: "number",
      title: "최근성 반감기 (일)",
      description:
        "retriever + 메모리 자동 정리 주기가 공유하는 최근성 반감기 (일).",
      default: 30,
      minimum: 1,
    },
    importanceHalfLifeDays: {
      type: "number",
      title: "중요도 반감기 (일)",
      description:
        "retriever + 메모리 자동 정리 주기가 공유하는 중요도 반감기 (일).",
      default: 90,
      minimum: 1,
    },
  },
  required: [
    "importanceDecay",
    "recencyHalfLifeDays",
    "importanceHalfLifeDays",
  ] as const,
} as const satisfies GroupSchema;

export const assetsGroup = {
  type: "object",
  title: "자산 보관 (문서·이미지 원본)",
  description:
    "원본 파일과 canonical .md 를 보관하는 디렉토리 (Phase 14a / 공통 인프라 spec 단락 1). content-addressed sha256 파일 저장.",
  properties: {
    dir: {
      type: "string",
      title: "자산 디렉토리",
      description:
        "원본·canonical 자산이 저장되는 디렉토리. 사용자 PC·A1 모두 data/assets 자연 정합. env BARA_ASSET_DIR 로 재정의 가능.",
      default: "data/assets",
    },
  },
  required: ["dir"] as const,
} as const satisfies GroupSchema;

export const imagesGroup = {
  type: "object",
  title: "이미지 자산 보존",
  description:
    "이미지 입력 시 원본 보존 갈래 + 한도 + 미리보기 양식 (Phase 11a T4). smart (default) = 작은 이미지 원본 그대로, 큰 이미지 사본. original = 한도 무관 원본 그대로. resized = 한도 무관 사본 (정지=축소, 움직이는=첫프레임 PNG + 손실 경고).",
  properties: {
    preserveMode: {
      type: "string",
      title: "보존 모드",
      description:
        "'smart' (default) / 'original' / 'resized'. smart = 작은 정지 ≤passthroughMaxMb + ≤passthroughMaxPx 원본 그대로 / 초과 사본. 작은 움직이는 ≤animatedPassthroughMaxMb 원본 그대로 / 초과 첫프레임 PNG + 손실 경고.",
      default: "smart",
      enum: ["smart", "original", "resized"] as const,
      "x-ui": { widget: "select" },
    },
    passthroughMaxMb: {
      type: "number",
      title: "smart 정지 통과 한도 (MB)",
      description:
        "smart 모드에서 정지 이미지 원본 그대로 통과 허용 한도 (MB). 초과 시 사본 흐름 진입. default 5.",
      default: 5,
      minimum: 0,
    },
    passthroughMaxPx: {
      type: "integer",
      title: "smart 정지 통과 한도 (px)",
      description:
        "smart 모드에서 정지 이미지 원본 그대로 통과 허용 가로/세로 (px). 초과 시 사본 흐름 진입. default 2048.",
      default: 2048,
      minimum: 1,
    },
    animatedPassthroughMaxMb: {
      type: "number",
      title: "smart 움직이는 통과 한도 (MB)",
      description:
        "smart 모드에서 움직이는 이미지 (GIF/APNG) 원본 그대로 통과 허용 한도 (MB). 초과 시 첫프레임 PNG fallback + 움직임 손실 경고. default 15.",
      default: 15,
      minimum: 0,
    },
    searchCopyMaxPx: {
      type: "integer",
      title: "사본 가로/세로 한도 (px)",
      description:
        "resized 모드 + smart 사본 흐름에서 사본 이미지 가로/세로 한도 (px). default 2048.",
      default: 2048,
      minimum: 1,
    },
    searchCopyFormat: {
      type: "string",
      title: "사본 형식",
      description:
        "사본 형식 갈래. 11a 안 'auto' 한 갈래 — jimp 알파 검사 결과 투명 있으면 PNG, 없으면 JPEG.",
      default: "auto",
      enum: ["auto"] as const,
      "x-ui": { widget: "select" },
    },
    previewMaxPx: {
      type: "integer",
      title: "미리보기 한도 (px)",
      description:
        "미리보기 가로/세로 한도 (px). 보존 모드 무관 — 항상 PNG 사본. default 512.",
      default: 512,
      minimum: 1,
    },
    searchSimilarityBoost: {
      type: "number",
      title: "이미지 유사도 검색 가중치",
      description:
        "이미지 유사도(SigLIP image_vec) 채널 전용 검색 가중치 (image-search-foundation Task 7 / c-C1). 1.0 = 중립(가중치 없음) — 유사도 1위 이미지가 연결성 높은 딴 항목에 합산으로 밀릴 수 있다. 1.0 보다 크면 '유사 우선, 연결 보조' — 유사도가 맞는 이미지를 순위에 더 싣는다. 글 노드는 이 채널 기여가 0 이라 값을 올려도 글 검색 결과는 바뀌지 않는다. default 2.5 (T7 측정 확정 — crossover 2.0 위로 약 4% 안정 격차를 둬 연결성 높은 딴 항목을 확실히 넘되 과하지 않은 균형점). 너무 높이면 덜 닮은 이미지까지 글을 밀어낸다.",
      default: 2.5,
      minimum: 1,
    },
    autoConceptLink: {
      type: "object",
      title: "이미지 자동 개념 연결 (SigLIP)",
      description:
        "이미지 업로드 시 그 이미지의 SigLIP 임베딩과 기존 개념의 SigLIP 임베딩을 cosine 비교해, 닮음이 threshold 이상인 *기존* 개념과 자동으로 잇는다 (image-search-foundation Task 5 / b-B3). 없으면 잇지 않고 새 개념을 만들지 않는다. 닮은 개념이 생기면 그 개념이 글·해시태그로 검색될 때 이미지도 연결검색에 합류한다.",
      properties: {
        enabled: {
          type: "boolean",
          title: "자동 개념 연결 켜기",
          description:
            "true (default) 면 업로드 시 SigLIP 자동 개념 연결을 시도한다. false 면 이미지는 image_vec·손 태그·VLM 캡션으로만 검색된다 (정직한 비활성).",
          default: true,
        },
        threshold: {
          type: "number",
          title: "연결 cosine 임계값",
          description:
            "이미지↔개념 SigLIP cosine 이 이 값 이상이면 연결한다. default 0.10 (A1 실측 변별 경계 — 관련 개념 0.10~0.14 vs 무관 0.04~0.05). 낮추면 무관 개념까지 잇고, 높이면 약한 변별 개념을 놓친다.",
          default: 0.1,
          minimum: 0,
          maximum: 1,
        },
      },
      required: ["enabled", "threshold"] as const,
    },
  },
  required: [
    "preserveMode",
    "passthroughMaxMb",
    "passthroughMaxPx",
    "animatedPassthroughMaxMb",
    "searchCopyMaxPx",
    "searchCopyFormat",
    "previewMaxPx",
    "searchSimilarityBoost",
    "autoConceptLink",
  ] as const,
} as const satisfies GroupSchema;

export const chunkingGroup = {
  type: "object",
  title: "청크 분해",
  description:
    "문서 본문을 청크로 나누는 전략 + token 한도 (Phase 14 spec 단락 3.2). default 문단 양식 — 사용자 결정 부담 0.",
  properties: {
    strategy: {
      type: "string",
      title: "청크 전략",
      description:
        "'paragraph' (default / 빈 줄 기준) / 'heading' (Markdown 헤딩).",
      default: "paragraph",
      enum: ["paragraph", "heading"] as const,
      "x-ui": { widget: "select" },
    },
    tokenCap: {
      type: "number",
      title: "청크 token 한도",
      description:
        "한 청크 token budget 상한. 초과 시 더 잘게 분리. default 2000.",
      default: 2000,
      minimum: 1,
    },
    minChunkTokens: {
      type: "number",
      title: "짧은 청크 병합 하한",
      description:
        "이 token 미만의 짧은 청크는 이웃과 합쳐 과분할을 막는다. default 64 (≈ 한국어 32 글자 — 헤딩 고아 조각은 합치고 한 문장 분량은 보존). 0 이면 병합 끔.",
      default: 64,
      minimum: 0,
    },
    // Phase 14b T2 (14.5) — 검색 결과로 한 청크만 나오면 맥락이 끊기므로,
    // 같은 문서의 인접 청크를 함께 묶어 보여준다. 그 묶음 누적 token 상한.
    // 배치 결정: 청크 token budget 가닥(chunk content token)이라 같은 문서
    // 청크를 다루는 chunking 그룹이 의미상 정합 — search 그룹은 유사도
    // 임계값 스칼라 모음이라 token budget 가닥과 섞으면 어긋난다. 14a 가
    // tokenCap 을 chunking 에 둔 선례 정합(둘 다 청크 content 의 token 한도).
    maxContextTokens: {
      type: "number",
      title: "인접 청크 묶기 token 한도",
      description:
        "검색 결과 청크 + 같은 문서 인접 청크를 묶어 보여줄 때의 누적 token 상한. 넘기 직전 멈춘다. default 2000 (spec 7.1).",
      default: 2000,
      minimum: 0,
    },
  },
  required: ["strategy", "tokenCap"] as const,
} as const satisfies GroupSchema;

export const securityGroup = {
  type: "object",
  title: "입력 byte 상한",
  description:
    "글·자산 입력의 byte 한도. GB 급 거대 입력이 들어와 프로세스를 죽이는 것만 막고 정상 글·이미지·문서는 통과시킨다. 자산 상한 64 MiB 는 이미지 한도(animatedPassthroughMaxMb 15 MB) x 1.33(base64 팽창 = 19.95 MB) 이상으로 여유를 둔 값이다.",
  properties: {
    maxTextBytes: {
      type: "number",
      title: "글 입력 byte 상한",
      description:
        "한 건의 글 본문이 넘으면 안 되는 byte 한도. default 8 MiB (8 x 1024 x 1024). 정상 글은 한참 아래라 통과하고, 비정상 거대 입력만 거른다.",
      default: 8 * 1024 * 1024,
      minimum: 1024,
    },
    maxAssetBytes: {
      type: "number",
      title: "자산 입력 byte 상한",
      description:
        "이미지·문서 한 건이 넘으면 안 되는 byte 한도. default 64 MiB (64 x 1024 x 1024). 이미지 통과 한도(15 MB) x 1.33 base64 팽창 + 여유 이상이라 정상 자산은 통과한다.",
      default: 64 * 1024 * 1024,
      minimum: 1024,
    },
  },
  required: ["maxTextBytes", "maxAssetBytes"] as const,
} as const satisfies GroupSchema;
