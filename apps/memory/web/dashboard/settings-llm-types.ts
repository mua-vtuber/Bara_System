/**
 * dashboard/settings-llm-types.ts — 설정 LLM 슬롯 값 타입·핸들·디스크 읽기 헬퍼.
 *
 * settings-llm-section.ts 에서 떼어낸 LLM 세 슬롯의 디스크 값 타입(extractor /
 * cleanup / vision)·렌더 핸들 인터페이스·값 읽기 헬퍼(readSlotCommon·readLlmGroup)
 * 를 모은다. 800줄 한계 안에 들어가도록 controls·section 모듈과 책임을 가른 것일 뿐,
 * 로직은 옮기기 전과 동일하다.
 */

import {
  isLlmProvider,
  LLM_API_KEY_FIELDS,
  type LlmApiKeyField,
  type LlmProvider,
} from "../../src/llm/provider-registry";
import { readRetryPolicyValue, type RetryPolicyValue } from "./settings-llm-retry-fields";

// 공급자 값 정의는 서버와 같은 공급자 표 한 곳(src/llm/provider-registry.ts) — 다시 내보내기만 한다.
export type { LlmProvider };

/** 한 슬롯 공통 디스크 값 — extractor / cleanup 공통 칸. */
export interface LlmSlotCommonValue {
  enabled: boolean;
  provider: LlmProvider;
  ollamaUrl: string;
  ollamaModel: string;
  anthropicApiKey: string;
  anthropicModel: string;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiApiKey: string;
  /** OpenAI(GPT) 키 — 서버가 가려 보내므로 화면에서는 늘 "". */
  gptApiKey: string;
  gptModel: string;
  /** Google(Gemini) 키 — 서버가 가려 보내므로 화면에서는 늘 "". */
  geminiApiKey: string;
  geminiModel: string;
  /**
   * 이 슬롯에서 서버에 키가 저장돼 있는 키 칸들(서버 응답 `$secretsSet` 에서 읽음). 값은 오지 않고
   * 여부만 온다 — "저장된 키가 있습니다" 안내와 저장된 키로 모델 목록을 부를지 판단에 쓴다.
   */
  savedKeyFields: readonly LlmApiKeyField[];
}

/** 의미 추출 슬롯 backfill sub-object — Phase 5.7.1 W1 정착 (3 칸). */
export interface LlmExtractorBackfillValue extends RetryPolicyValue {
  intervalMin: number;
  batchSize: number;
  minImportance: number;
}

/** 의미 추출 슬롯 디스크 값 — schema 의 llm.extractor 그대로 (W1 정착 후). */
export interface LlmExtractorValue extends LlmSlotCommonValue {
  mode: "immediate" | "backfill";
  backfill: LlmExtractorBackfillValue;
}

/** 데이터 정리 슬롯 디스크 값 — schema 의 llm.cleanup 그대로. */
export interface LlmCleanupValue extends LlmSlotCommonValue {
  intervalDays: number;
}

/**
 * 이미지 캡션 (VLM) 슬롯 backfill sub-object.
 *
 * extractor-vision-unified-clock-scheduler Task 4·6 — 캡션 시점(즉시/주기)·주기
 * 분은 의미추출 AI 공통 설정(llm.extractor 권위)을 따른다. 그래서 vision 에는
 * batchSize 한 칸만 남는다. minImportance 도 제외 — 이미지는 importance 부적합.
 */
export interface LlmVisionBackfillValue extends RetryPolicyValue {
  batchSize: number;
}

/** 이미지 캡션 (VLM) 슬롯 디스크 값 — schema 의 llm.vision 그대로 (Phase 11b T11 + Phase 11e T9 + Task 4). */
export interface LlmVisionValue extends LlmSlotCommonValue {
  /** ON = SigLIP 임베딩 OK 라도 VLM 캡션 강제 요청 / OFF = SigLIP 가용 시 건너뜀. */
  forceCall: boolean;
  /** 한 캡션 호출에 활용할 max_tokens 한도. */
  tokenCap: number;
  /** VLM 에 넘길 캡션 요청 글. 빈 문자열이면 caption-flow 의 한국어 검색용 default. */
  captionPrompt: string;
  /**
   * 한 사이클 일괄 캡션 설정 (Task 4·6). 동작 방식(mode)·주기(intervalMin)는
   * 의미추출 AI 공통 설정(llm.extractor 권위)을 따르므로 vision 에 없다.
   */
  backfill: LlmVisionBackfillValue;
}

/** llm 그룹 — extractor / cleanup / vision 세 슬롯을 담는 형태 (Phase 11b T11). */
export interface LlmGroupValue {
  extractor: LlmExtractorValue;
  cleanup: LlmCleanupValue;
  vision: LlmVisionValue;
}

/** 한 슬롯 공통 칸 읽기 헬퍼 — schema default 가 채워야 정상. */
function readSlotCommon(
  obj: Record<string, unknown>,
  slotPath: string,
  secretsSet: ReadonlySet<string>,
): LlmSlotCommonValue {
  const provider = obj.provider;
  if (!isLlmProvider(provider)) {
    throw new Error(
      `${slotPath}.provider 값이 enum 밖 — "${String(provider)}". schema 정합 검토 필요.`,
    );
  }
  const enabled = obj.enabled;
  if (typeof enabled !== "boolean") {
    throw new Error(
      `${slotPath}.enabled 값이 boolean 아님 — "${String(enabled)}". schema default 채움 검토 필요.`,
    );
  }
  return {
    enabled,
    provider,
    ollamaUrl: typeof obj.ollamaUrl === "string" ? obj.ollamaUrl : "",
    ollamaModel: typeof obj.ollamaModel === "string" ? obj.ollamaModel : "",
    anthropicApiKey:
      typeof obj.anthropicApiKey === "string" ? obj.anthropicApiKey : "",
    anthropicModel:
      typeof obj.anthropicModel === "string" ? obj.anthropicModel : "",
    openaiBaseUrl:
      typeof obj.openaiBaseUrl === "string"
        ? obj.openaiBaseUrl
        : "http://127.0.0.1:1234/v1",
    openaiModel: typeof obj.openaiModel === "string" ? obj.openaiModel : "",
    openaiApiKey:
      typeof obj.openaiApiKey === "string" ? obj.openaiApiKey : "",
    gptApiKey: readRequiredString(obj, slotPath, "gptApiKey"),
    gptModel: readRequiredString(obj, slotPath, "gptModel"),
    geminiApiKey: readRequiredString(obj, slotPath, "geminiApiKey"),
    geminiModel: readRequiredString(obj, slotPath, "geminiModel"),
    savedKeyFields: LLM_API_KEY_FIELDS.filter((field) => secretsSet.has(`${slotPath}.${field}`)),
  };
}

/**
 * 서버 응답의 `$secretsSet`(값이 저장된 비밀 칸 경로 목록)을 읽는다. 서버는 GET·PUT 응답에 항상
 * 이 칸을 붙이므로 없으면 비정상 — 빈 목록으로 덮지 않고 멈춘다.
 */
function readSecretsSet(value: Record<string, unknown>): ReadonlySet<string> {
  const raw = value.$secretsSet;
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    throw new Error(
      "메모리 설정 응답에 $secretsSet(저장된 키 경로 목록)이 없다 — 서버 maskSecrets 응답 형식 검토 필요.",
    );
  }
  return new Set(raw as string[]);
}

/** schema default 가 반드시 채우는 문자열 칸 — 없으면 칸 이름을 대며 멈춘다(빈 값으로 덮지 않음). */
function readRequiredString(
  obj: Record<string, unknown>,
  slotPath: string,
  field: string,
): string {
  const value = obj[field];
  if (typeof value !== "string") {
    throw new Error(
      `${slotPath}.${field} 가 문자열 아님 — "${String(value)}". schema default 채움 검토 필요.`,
    );
  }
  return value;
}

/**
 * 메모리 settings 의 llm 두 슬롯 값을 안전하게 추출한다. schema default 가 모든
 * 필드를 채워 주므로 keys 누락은 비정상 — 명시 throw (silent fallback 0).
 */
export function readLlmGroup(value: Record<string, unknown>): LlmGroupValue {
  const llm = value.llm;
  if (!llm || typeof llm !== "object") {
    throw new Error(
      "메모리 설정에 llm 그룹이 없다 — schema default 가 채워야 정상. 디스크 파일 검토 필요.",
    );
  }
  const llmObj = llm as Record<string, unknown>;
  const secretsSet = readSecretsSet(value);

  const extractorObj = llmObj.extractor;
  if (!extractorObj || typeof extractorObj !== "object") {
    throw new Error(
      "메모리 설정에 llm.extractor 슬롯이 없다 — Phase 5.6 W5 마이그레이션 검토 필요.",
    );
  }
  const cleanupObj = llmObj.cleanup;
  if (!cleanupObj || typeof cleanupObj !== "object") {
    throw new Error(
      "메모리 설정에 llm.cleanup 슬롯이 없다 — Phase 5.6 W5 마이그레이션 검토 필요.",
    );
  }
  const visionObj = llmObj.vision;
  if (!visionObj || typeof visionObj !== "object") {
    throw new Error(
      "메모리 설정에 llm.vision 슬롯이 없다 — Phase 11b T11 마이그레이션 검토 필요.",
    );
  }

  const extractorCommon = readSlotCommon(
    extractorObj as Record<string, unknown>,
    "llm.extractor",
    secretsSet,
  );
  const extractorRec = extractorObj as Record<string, unknown>;
  const mode = extractorRec.mode;
  if (mode !== "immediate" && mode !== "backfill") {
    throw new Error(
      `llm.extractor.mode 값이 enum 밖 — "${String(mode)}". schema 정합 검토 필요.`,
    );
  }

  // Phase 5.7.1 W1 정착 — backfill 3 칸이 sub-object 안. spec section 2.3 + plan
  // section 2.1 정합. 옛 한 칸 입력 (backfillIntervalMin) 흐름은 migration helper
  // (W3) 가 sub-object 안으로 이전 — 본 시점 디스크 형태 = sub-object 박힘.
  const backfillRaw = extractorRec.backfill;
  if (!backfillRaw || typeof backfillRaw !== "object") {
    throw new Error(
      "llm.extractor.backfill sub-object 없다 — Phase 5.7.1 W1 schema 또는 W3 migration 검토 필요.",
    );
  }
  const backfillObj = backfillRaw as Record<string, unknown>;
  const backfillIntervalMin = backfillObj.intervalMin;
  if (typeof backfillIntervalMin !== "number") {
    throw new Error(
      "llm.extractor.backfill.intervalMin 이 number 아님 — schema default 채움 검토 필요.",
    );
  }
  const backfillBatchSize = backfillObj.batchSize;
  if (typeof backfillBatchSize !== "number") {
    throw new Error(
      "llm.extractor.backfill.batchSize 가 number 아님 — schema default 채움 검토 필요.",
    );
  }
  const backfillMinImportance = backfillObj.minImportance;
  if (typeof backfillMinImportance !== "number") {
    throw new Error(
      "llm.extractor.backfill.minImportance 가 number 아님 — schema default 채움 검토 필요.",
    );
  }

  const cleanupCommon = readSlotCommon(
    cleanupObj as Record<string, unknown>,
    "llm.cleanup",
    secretsSet,
  );
  const cleanupRec = cleanupObj as Record<string, unknown>;
  const intervalDays = cleanupRec.intervalDays;
  if (typeof intervalDays !== "number") {
    throw new Error(
      `llm.cleanup.intervalDays 가 number 아님 — schema default 채움 검토 필요.`,
    );
  }

  // Phase 11b T11 — vision 슬롯 + 추가 칸 (forceCall + tokenCap) 추출.
  const visionCommon = readSlotCommon(
    visionObj as Record<string, unknown>,
    "llm.vision",
    secretsSet,
  );
  const visionRec = visionObj as Record<string, unknown>;
  const forceCall = visionRec.forceCall;
  if (typeof forceCall !== "boolean") {
    throw new Error(
      `llm.vision.forceCall 가 boolean 아님 — "${String(forceCall)}". schema default 채움 검토 필요.`,
    );
  }
  const tokenCap = visionRec.tokenCap;
  if (typeof tokenCap !== "number") {
    throw new Error(
      `llm.vision.tokenCap 가 number 아님 — "${String(tokenCap)}". schema default 채움 검토 필요.`,
    );
  }

  // Phase 11e T9 — 캡션 프롬프트 글 (G2-4 / DCL D5). 빈 문자열 default 정상 —
  // caption-flow 가 빈 값이면 한국어 검색용 default 프롬프트로 채운다.
  const captionPrompt = visionRec.captionPrompt;
  if (typeof captionPrompt !== "string") {
    throw new Error(
      `llm.vision.captionPrompt 가 string 아님 — "${String(captionPrompt)}". schema default 채움 검토 필요.`,
    );
  }

  // Task 4·6 — vision backfill sub-object 는 batchSize 한 칸만. 캡션 시점(mode)·
  // 주기 분(intervalMin)은 의미추출 AI 공통 설정(llm.extractor 권위)을 따르므로
  // vision 에 없다. minImportance 도 제외 (이미지 importance 부적합).
  const visionBackfillRaw = visionRec.backfill;
  if (!visionBackfillRaw || typeof visionBackfillRaw !== "object") {
    throw new Error(
      "llm.vision.backfill sub-object 없다 — Task 4 schema 검토 필요.",
    );
  }
  const visionBackfillObj = visionBackfillRaw as Record<string, unknown>;
  const visionBackfillBatchSize = visionBackfillObj.batchSize;
  if (typeof visionBackfillBatchSize !== "number") {
    throw new Error(
      "llm.vision.backfill.batchSize 가 number 아님 — schema default 채움 검토 필요.",
    );
  }

  return {
    extractor: {
      ...extractorCommon,
      mode,
      backfill: {
        intervalMin: backfillIntervalMin,
        batchSize: backfillBatchSize,
        minImportance: backfillMinImportance,
        ...readRetryPolicyValue(backfillObj, "llm.extractor.backfill"),
      },
    },
    cleanup: {
      ...cleanupCommon,
      intervalDays,
    },
    vision: {
      ...visionCommon,
      forceCall,
      tokenCap,
      captionPrompt,
      backfill: {
        batchSize: visionBackfillBatchSize,
        ...readRetryPolicyValue(visionBackfillObj, "llm.vision.backfill"),
      },
    },
  };
}

/**
 * 한 슬롯 섹션의 payload — 활성 갈래의 필드 + provider + enabled + 슬롯별 추가
 * 칸만 박힘.
 *
 * **비활성 갈래의 옛 4 필드는 본 payload 에 안 박힘 → mergeShallowGroups +
 * mergeLlmSlots 가 Object.assign 으로 슬롯 단위 얕은 머지를 하므로 디스크의 옛
 * 값이 그대로 살아남는다** (apps/memory/src/settings/memory-settings.ts
 * mergeLlmSlots). 본 "갈래 외 필드 보존" 정신은 명시 동작 — silent fallback
 * 아님.
 *
 * 활성 갈래 필드는 옛 값과 같아도 박힌 채 전송 (collectChangedFields 와 다른
 * 정책) — 슬롯 안 갈래 분기 자체로 이미 변경 의도 명시.
 */
export interface LlmSlotSectionHandle {
  /** 슬롯 섹션 root DOM. */
  element: HTMLElement;
  /** 현재 입력 상태의 PUT body payload 의 한 슬롯 부분 반환. */
  getPayload: () => Record<string, unknown>;
  /** 옛 값과 비교해 변경 여부 — submit 시 슬롯을 통째로 보낼지 결정. */
  isChanged: () => boolean;
}

/** 세 슬롯을 함께 다루는 핸들 — 메모리 탭 submit 흐름에서 활용 (Phase 11b T11). */
export interface LlmSectionHandle {
  /** "의미추출 AI" 한 섹션 컨테이너 (텍스트·이미지 모델 + 공통 동작방식 + 타입별 설정 5블록). */
  semanticElement: HTMLElement;
  /** 데이터 정리 AI 슬롯 root DOM (의미추출 AI 섹션 밖 별 섹션). */
  cleanupElement: HTMLElement;
  /** 세 슬롯 중 변경된 슬롯만 payload 에 추가하여 반환. 변경 0 이면 빈 객체. */
  getChangedSlotsPayload: () => Record<string, unknown>;
  /** 어느 슬롯이라도 변경되었는지. */
  isChanged: () => boolean;
}

/**
 * 공통 동작방식 (3) 블록 핸들 (Task 6).
 *
 * 즉시/주기 라디오 + 주기 분 입력 1개. payload·isChanged 는 extractor 권위
 * (llm.extractor.mode / llm.extractor.backfill.intervalMin) 에 합류한다 — vision
 * payload 에는 mode·intervalMin 이 안 들어간다.
 *
 * 한 라디오 쌍이 텍스트·이미지 batchSize 가시성 둘 다 제어하므로, backfill 갈래일
 * 때만 보여야 할 외부 블록(텍스트 전용·이미지 전용 batchSize)을 registerBackfillTarget
 * 으로 등록한다. mode 토글 시 등록된 모든 대상의 display 를 한꺼번에 갱신한다.
 */
export interface CommonModeBlockHandle {
  /** (3) 동작방식 블록 root DOM. */
  element: HTMLElement;
  /** 현재 선택이 'backfill' 인지. */
  isBackfillSelected: () => boolean;
  /** backfill 갈래일 때만 보여야 할 외부 블록 등록 (텍스트·이미지 batchSize). 즉시 1회 갱신. */
  registerBackfillTarget: (el: HTMLElement) => void;
  /** mode·intervalMin 부분 payload 반환 (extractor 슬롯에 머지). */
  getPayload: () => Record<string, unknown>;
  /** mode 또는 intervalMin 이 옛 값과 다른지. */
  isChanged: () => boolean;
}

/**
 * extractor / vision 모델 블록 + 타입별 설정 블록을 분리 반환하는 핸들 (Task 6).
 *
 * 모델 블록 = 켜기 체크박스 + provider + 모델 (createSlotCommonControls 의 section).
 * 타입별 설정 블록 = 슬롯 전용 칸 (extractor: batchSize + minImportance / vision:
 * captionPrompt + forceCall + tokenCap + batchSize). backfill 갈래일 때만 보이는
 * 칸은 commonMode.registerBackfillTarget 으로 가시성을 공통 라디오에 묶는다.
 */
export interface LlmSlotBlocksHandle {
  /** (1)/(2) 모델 블록 — 헤딩 + 켜기 체크박스 + provider + 모델. */
  modelBlock: HTMLElement;
  /** (4)/(5) 타입별 설정 블록. */
  detailBlock: HTMLElement;
  /** 현재 입력 상태의 PUT body payload 의 한 슬롯 부분 반환. */
  getPayload: () => Record<string, unknown>;
  /** 옛 값과 비교해 변경 여부. */
  isChanged: () => boolean;
}

/**
 * 한 슬롯 (extractor / cleanup) 공통 컨트롤 — enabled 토글 + provider 드롭다운 +
 * 갈래 동적 폼 (Ollama / Anthropic) + Ollama 모델 자동 fetch (Phase 5.7.1 W5 —
 * spec section 5.1 옵션 (나) 흡수, list-ollama-models 액션 정합).
 *
 * Phase 5.6 W7 — 한
 * 페이지에 두 슬롯이 동시 박히므로 input id 충돌 회피 위해 slotKey prefix
 * 활용.
 *
 *   - enabled 토글 = 슬롯 LLM 사용 여부. enabled=false 면 config 카드 숨김 +
 *     디스크 옛 값 보존 (사용자가 다시 켤 때 옛 입력 복원).
 *   - provider 드롭다운 = 갈래 명시. ollama / anthropic 두 갈래.
 *   - 갈래 전환 = display:none 으로 비활성 폼 숨김 (form-state 보존, silent
 *     데이터 손실 0).
 *   - Ollama 모델 = 페이지 진입 시점에 자동 fetch (Phase 5.7.1 W5 옵션 (나)).
 *     provider=ollama 슬롯만 호출 — anthropic 갈래는 호출 0. fetch 실패 시
 *     명시 toast ("Ollama 미가동") + 옛 디스크 값 fallback (silent fallback 아님).
 *     옛 "모델 목록 갱신" 버튼 + 핸들러 = Phase 5.7.1 W5 폐기 (본인 손가락 절약).
 *
 * @param slotKey 슬롯 식별 (input id prefix). 'extractor' 또는 'cleanup'.
 * @param current 옛 디스크 값 (form 초기 채움).
 * @param original 옛 디스크 값 (변경 감지 비교 기준).
 */
