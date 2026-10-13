/**
 * LLM 어댑터 공통 상수.
 *
 * Ollama HTTP 호출(글 추출용 OllamaClient + 이미지 캡션용 OllamaVisionProvider)이
 * 같은 기본값을 공유하도록 단일 출처로 모은다. caller 가 settings 값을 넘기면 그쪽이
 * 우선이고, 미지정 시에만 이 default 가 안전망으로 쓰인다.
 */

/**
 * Ollama 호출 한 번에 허용할 기본 타임아웃(ms). caller 가 settings.llm.*.timeoutMs 를
 * 넘기면 그 값이 우선이고, 미지정 시 안전망. 120초 = 32B + CPU 오프로드 첫 호출이
 * 20초까지, GPU 없는 A1 CPU 캡션 1장이 100~209초까지 갈 수 있어 잡은 여유선이다.
 */
export const DEFAULT_OLLAMA_TIMEOUT_MS = 120_000;

/**
 * Ollama 모델 컨텍스트 윈도우(토큰) 기본값. system prompt + 5 few-shot pair + 실제
 * 입력이 약 2500~3500 토큰이라 모델별 기본 num_ctx(2048~4096)면 잘릴 수 있어 8192 로
 * 여유를 둔다. env OLLAMA_NUM_CTX 또는 opts.numCtx 로 덮어쓸 수 있다.
 */
export const DEFAULT_OLLAMA_NUM_CTX = 8192;

// ─────────────────────────────────────────────────────────────────────────────
// 고정 주소 API 공급자 (2026-10-11 llm-api-providers spec 5.3)
//
// Anthropic·OpenAI·Google 은 주소를 설정으로 받지 않는다. 화면에서 방금 입력한 키를 모델 목록 조회에
// 쓸 수 있게 했으므로, 그 키가 남이 정한 주소로 새는 길을 막으려고 주소는 이 상수만 쓴다. 클라이언트·
// 목록 함수의 baseUrl 인자는 테스트가 로컬 대역 서버를 가리킬 때만 넘긴다(운영 배선은 넘기지 않음).
// ─────────────────────────────────────────────────────────────────────────────

/** OpenAI API 주소(/chat/completions, /models 앞까지). */
export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

/** Google Gemini 공식 REST API 주소(/models 앞까지). */
export const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** Anthropic API 주소(/v1/models 앞까지). */
export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";

/** Anthropic REST 호출에 싣는 anthropic-version 헤더 값. */
export const ANTHROPIC_API_VERSION = "2023-06-01";

/** 모델 목록 페이지 반복 상한 — 넘으면 비정상으로 보고 오류로 알린다. */
export const MODEL_LIST_MAX_PAGES = 10;

/** 모델 목록 한 번 호출의 시간 한도(ms). */
export const MODEL_LIST_TIMEOUT_MS = 15_000;

/** 모델 목록 한 페이지 크기(Anthropic limit·Gemini pageSize 최대값). */
export const MODEL_LIST_PAGE_SIZE = 1000;
