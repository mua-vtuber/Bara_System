/**
 * dashboard/settings-document-ocr-labels.ts — 설정 › 메모리 › 문서 처리 화면 문구 (2026-10-11 document-ocr spec 11장).
 * i18n-ready 로 한 곳에 모은다. 공급자 이름 셋·키·모델·목록 문구는 settings-llm-labels.ts 를 재사용한다.
 */

import type { DocumentOcrApiProvider } from "../../src/settings/document-ocr-api-providers";
import { LLM_PROVIDER_LABELS } from "./settings-llm-labels";

/** "API 업체" 드롭다운 문구 — 업체 표 순서는 DOCUMENT_OCR_API_PROVIDERS 가 정한다. */
export const DOCUMENT_OCR_API_PROVIDER_LABELS: Readonly<Record<DocumentOcrApiProvider, string>> = {
  anthropic: LLM_PROVIDER_LABELS.anthropic,
  openai: LLM_PROVIDER_LABELS.openai,
  google: LLM_PROVIDER_LABELS.google,
  openai_compatible: "OpenAI 호환 (주소 직접 입력)",
  http_file_api: "파일 업로드 API",
};

export const DOCUMENT_OCR_LABELS = {
  panelTitle: "스캔 문서 읽기",
  modeLabel: "읽는 방법",
  modeManual: "직접 붙여넣기",
  modeLocal: "서버에 설치된 AI로 처리",
  modeApi: "AI API 사용",
  modePcCompanion: "내 PC 보조 프로그램 사용",
  manualTitle: "직접 붙여넣기",
  manualNote: "문서 목록에서 OCR 결과 Markdown을 직접 붙여 넣는다.",
  localTitle: "서버에 설치된 AI",
  localProviderLabel: "선택 AI",
  localOllama: "Ollama",
  localLmStudio: "LM Studio",
  modelLabel: "모델",
  modelLoading: "모델 목록 불러오는 중",
  modelNone: "설치된 모델 없음",
  modelLoadFailed: "모델 목록을 가져오지 못함",
  modelListFailedToast: (provider: string, message: string) => `${provider} 모델 목록을 가져오지 못함: ${message}`,
  apiTitle: "AI API 사용",
  apiProviderLabel: "API 업체",
  imageOnlyNote:
    "AI에는 쪽마다 그림으로 바꿔 보냅니다. docx 처럼 그림으로 바꿀 수 없는 문서는 내 PC 보조 프로그램을 쓰세요.",

  // OpenAI 호환 폼
  compatUrlLabel: "API 주소",
  compatUrlPlaceholder: "https://…/v1",
  compatUrlHint:
    "OpenAI 형식(/chat/completions)을 받는 서버의 기본 주소입니다. /chat/completions 앞까지만 적으세요. 예: LM Studio 는 http://127.0.0.1:1234/v1",
  compatKeyLabel: "API 키",
  compatKeyEmptyHint: "인증이 필요 없는 서버는 비워 둡니다.",

  // 파일 업로드 API 폼
  httpEndpointLabel: "API 주소",
  httpEndpointPlaceholder: "https://…",
  httpModelLabel: "모델",
  httpModelHint: "비워 두면 업체 기본값을 씁니다.",
  httpKeyLabel: "API 키",
  httpKeyPlaceholder: "저장된 키 유지",

  // 보조 프로그램 패널
  pcTitle: "내 PC 보조 프로그램",
  pcServerAddress: "서버 주소",
  pcWorkerId: "보조 프로그램 ID",
  pcPollSeconds: "확인 간격(초)",
  pcCommandSource: "명령 사용 방식",
  pcCommandLocal: "PC 쪽 명령만",
  pcCommandServer: "서버 설정 명령 허용",
  pcCommandJson: "실행 명령(JSON)",
  pcCommandNote: '외부 OCR 프로그램을 실행할 때 쓰는 명령 배열이다. 예: ["python","ocr.py","{input}","{output}"].',
  pcAllowedStatuses: "자동 처리 상태",
  tokenChecking: "PC 문서 처리 프로그램의 연결 승인 상태 확인 중...",
  tokenIssued: "PC 문서 처리 프로그램의 연결이 승인되었습니다.",
  tokenPending: "PC 문서 처리 프로그램의 연결 승인 대기 중입니다.",
  tokenNone: "PC 문서 처리 프로그램에 발급된 연결 토큰이 없습니다.",
  tokenFailed: (message: string) => `토큰 상태 확인 실패: ${message}`,

  // 공통 처리 칸
  scheduleTitle: "스캔 문서 읽기 설정",
  intervalLabel: "처리 간격(분)",
  batchLabel: "한 번에 처리할 문서 수",
  leaseLabel: "작업 보관 시간(초)",
  timeoutLabel: "한 쪽 처리 제한 시간(ms)",
  maxOutputLabel: "한 쪽 최대 출력 길이(토큰)",
  maxOutputHint:
    "글이 많은 쪽이 이 길이에서 잘리면 저장하지 않고 실패로 남깁니다. 실패하면 값을 올리세요. 생각하는 모델은 생각에도 이 길이를 씁니다.",
  pageEdgeLabel: "쪽 그림 크기(긴 변, 픽셀)",
  pageEdgeHint: "크면 작은 글씨를 잘 읽지만 AI 입력이 늘어납니다.",
  pagesPerCycleLabel: "한 번에 읽을 최대 쪽 수",
  pagesPerDayLabel: "하루 최대 쪽 수",
  pagesPerDayHint: "실패한 호출도 셉니다. 이 수에 닿으면 다음 날 이어서 처리합니다.",
  advancedSummary: "고급 — 재시도",
  maxAttemptsLabel: "쪽 최대 시도 횟수",
  retryDelayLabel: "재시도 대기(분)",
  breakerLabel: "연속 일시 실패 시 멈출 횟수",
  ollamaReserveLabel: "입력 여유 토큰",
  ollamaReserveHint: "Ollama 에 주는 문맥 길이 = 출력 길이 + 이 값. 너무 작으면 그림 일부가 잘려 들어갈 수 있습니다.",

  save: "저장",
  savedApplied: "저장했습니다. 문서 OCR 은 서버를 다시 켜지 않아도 바로 적용됩니다.",
  readFailed: (message: string) => `문서 처리 설정을 읽지 못했습니다: ${message}`,

  // 서버 처리 상태 (settings-document-ocr-status.ts)
  statusTitle: "서버 처리 상태",
  statusOff: (reason: string) => `서버 자동 처리 꺼짐 — ${reason}`,
  statusIdle: (next: string, n: number, cap: number) => `다음 처리: ${next} · 오늘 ${n}/${cap}쪽`,
  statusRunning: (title: string, k: number, n: number) => `처리 중… (${title} ${k}/${n}쪽)`,
  statusRunningNoDoc: "처리 중…",
  statusConfigError: (reason: string) => `설정 문제로 멈춤 — ${reason}`,
  statusError: (reason: string) => `처리 중 오류로 멈춤 — ${reason}`,
  statusDailyCap: (cap: number) => `오늘 한도(${cap}쪽)에 닿아 내일 이어서 처리합니다.`,
  statusQueue: (w: number, t: number) => `재시도 대기 ${w}건 · 자동 재시도 멈춤 ${t}건`,
  statusNotProcessable: (reason: string, n: number) => `서버 처리 대상 아님: ${reason} ${n}건`,
  statusAbsorbed: (n: number) => `같은 파일이 이미 있어 그 문서와 함께 쓰는 기록 ${n}건 (따로 읽지 않음)`,
  statusLegacyMerged: (n: number) => `예전 버전에서 잘못 합쳐진 기록 ${n}건 · 다시 올려 주세요`,
  absorbedBadge: "같은 파일 · 다른 문서와 함께 씀",
  legacyMergedBadge: "예전 버전에서 잘못 합쳐짐 · 다시 올려 주세요",
  statusLoadFailed: (message: string) => `처리 상태를 불러오지 못했습니다: ${message}`,
  statusLastCycle: (applied: number, failed: number, calls: number, blank: number, stoppedBy: string) =>
    `마지막 처리: 문서 ${applied}건 적용 · ${failed}건 실패 · 쪽 호출 ${calls}번${blank > 0 ? ` · 빈 쪽 ${blank}개` : ""} (멈춘 이유: ${stoppedBy})`,
  statusLoading: "처리 상태를 불러오는 중…",
  refresh: "새로 고침",

  // 문서 카드
  rerunOnServer: "서버에서 다시 읽기",
  blankPages: (n: number) => `빈 쪽 ${n}개 — 글이 없는 쪽으로 읽었습니다.`,
  rerunRunning: "서버에서 읽는 중…",
  rerunDone: "서버에서 다시 읽었습니다.",
  rerunPartial: "일부 쪽만 읽었습니다 — 다음 처리 때 이어서 읽습니다.",
  rerunFailed: (message: string) => `서버에서 다시 읽지 못했습니다: ${message}`,
} as const;

/** 상태 화면의 "멈춘 이유" 문구. */
export const DOCUMENT_OCR_STOPPED_BY_LABELS: Readonly<Record<string, string>> = {
  done: "모두 처리",
  no_candidates: "처리할 문서 없음",
  page_cap: "한 번에 읽을 쪽 수에 닿음",
  daily_cap: "하루 쪽 수에 닿음",
  circuit_breaker: "일시 실패가 이어져 멈춤",
  config_error: "설정 문제",
  aborted: "서버 정지·설정 변경으로 끊음",
  error: "예상하지 못한 오류",
};
