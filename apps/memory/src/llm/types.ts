/**
 * LLM 클라이언트 공통 계약.
 *
 * Phase 2.1 시점의 두 어댑터(Ollama, Anthropic)가 같은 시그니처를 따르도록
 * 강제한다. 추출·답변 생성·reflection 등 다양한 호출 지점이 이 인터페이스
 * 하나만 알면 되도록 표면적을 작게 유지.
 *
 * 스트리밍은 Phase 2.1에선 미사용 — reflector(2.4)에서 필요해지면 별도
 * `streamChat` 메서드로 추가한다. 지금은 non-streaming 한 메서드만.
 */

/** 단일 채팅 메시지. role은 OpenAI/Ollama/Anthropic 모두가 이해하는 3종. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** chat() 호출 옵션. 전부 옵셔널 — 어댑터별 기본값 사용. */
export interface LlmChatOptions {
  /** 0.0~1.0. 낮을수록 결정적. 추출 작업은 0.1~0.3 권장. */
  temperature?: number;

  /** 최대 출력 토큰 수. 클라이언트가 별도 한도를 가질 수 있음. */
  maxOutputTokens?: number;

  /**
   * JSON 응답 모드. 서버가 지원하면 강제, 아니면 무시.
   * Ollama: `format: "json"` 옵션 사용.
   * Anthropic: 프롬프트 가이드만 (네이티브 JSON 모드 없음).
   */
  jsonMode?: boolean;

  /**
   * JSON Schema. Ollama 0.5+ 의 structured output을 활용해 응답 형태를
   * 강하게 제약한다 — 단순 "JSON이어야 함" (jsonMode)을 넘어 "배열인지
   * 객체인지, 어떤 필드를 가져야 하는지"까지 모델한테 강제 가능.
   *
   * 2026-05-15 32B 모델이 jsonMode만으로는 `{}` 빈 객체를 뱉어서 도입.
   *
   * Ollama: `format` 필드에 객체로 그대로 전달.
   * Anthropic: 미지원, 무시 (프롬프트 가이드로만 따름).
   *
   * jsonMode와 jsonSchema 모두 주면 jsonSchema가 우선.
   */
  jsonSchema?: Record<string, unknown>;

  /**
   * AbortController 신호. 봇이 죽거나 SIGTERM 받으면 진행 중인 LLM
   * 호출 빨리 끊을 수 있게. 클라이언트가 fetch에 그대로 전달.
   */
  signal?: AbortSignal;

  /**
   * Ollama think 토글. false 면 모델 추론(thinking)을 제거한다.
   * 미지정 시 송신 안 함 = 모델 기본 동작 (qwen instruct 계열은 추론 없음).
   *
   * Ollama 전용 칸 — Anthropic 어댑터는 think 개념이 없어 무시한다.
   * temperature·maxOutputTokens 와 같은 옵션 전달 패턴 (정의 시에만 body 송신).
   */
  think?: boolean;
}

/**
 * 메모리 추출 / 답변 생성 / reflection 등 모든 LLM 사용 지점이 의존하는
 * 단일 인터페이스.
 *
 * 구현체는 두 가지:
 *   - `OllamaClient`: HTTP /api/chat. 로컬 무료, 본인 PC와 동거.
 *   - `AnthropicClient`: Messages API. Claude API 키 필요.
 *
 * 둘 다 같은 입력을 받아 어시스턴트 응답 본문 문자열을 돌려준다.
 * SDK 차이(시스템 메시지 분리, 메시지 array 포맷 차이)는 각 어댑터가
 * 흡수한다.
 */
export interface LlmClient {
  /** 어댑터 이름 (로그·메트릭용). 예: "ollama:llama3.1:8b", "anthropic:claude-sonnet-4-6". */
  readonly name: string;

  /**
   * 메시지 시퀀스를 보내고 어시스턴트의 응답 본문을 받는다.
   * 시스템 메시지는 시퀀스의 첫 항목으로 넣으면 어댑터가 알아서 처리.
   * 실패 시 throw (호출자가 fallback·재시도 결정).
   */
  chat(
    messages: readonly ChatMessage[],
    options?: LlmChatOptions,
  ): Promise<string>;
}

/**
 * `chatDetailed()` 회신 — 응답 본문에 더해 종료 사유·토큰 사용량을 함께 담는다.
 *
 * 데이터 정리 AI 효율 가동(2026-07-11 spec 4.A-1)에서 도입. 유료 강모델 연결
 * 시 max_tokens 잘림 재호출·비용 관측·예산 판정의 입력이 되는 관측치라
 * `chat()` 문자열 반환만으로는 표현할 수 없어 별도 결과 타입으로 분리했다.
 */
export interface LlmChatResult {
  /** 어시스턴트 응답 본문. `chat()` 이 돌려주던 값과 동일. */
  text: string;

  /**
   * provider 원문 종료 사유를 3값으로 정규화한 것.
   *   - "stop": 정상 종료(EOS 등).
   *   - "max_tokens": 출력 토큰 한도에 걸려 잘림.
   *   - "other": 위 두 경우가 아니거나 provider 가 사유를 안 주는 경우.
   * provider 가 종료 사유를 아예 안 주면(Ollama 무응답 등) "other" — 모델
   * 회신이 있는데 사유를 지어내지 않는다.
   */
  stopReason: "stop" | "max_tokens" | "other";

  /**
   * 토큰 사용량. provider 가 안 주면 null — 0 으로 위장하지 않는다(No-fallback 원칙).
   * 캐시 읽기/쓰기 토큰 포함 필수 — Anthropic 프롬프트 캐싱이 켜져 있으면
   * input/output 만으로는 실비용을 오표기한다. 캐시를 안 쓰는 provider(Ollama 등)는
   * cacheReadTokens/cacheWriteTokens 를 0 으로 채운다(그 provider 에 캐시라는
   * 개념 자체가 없다는 사실 표현이지, 누락값 은폐가 아니다).
   */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  } | null;
}

/**
 * 관측 가능 LLM 클라이언트 — `LlmClient` 를 바꾸지 않고 확장하는 별도 인터페이스.
 *
 * `LlmClient` 코어는 외부 fork 가 그대로 컴파일해 쓰는 구조라 여기에 새 필수
 * 메서드를 얹으면 외부 구현체를 깬다. 대신 cleanup 슬롯처럼 관측이 필요한
 * 경로만 이 인터페이스를 요구한다. 3 클라이언트(Anthropic/Ollama/OpenAI-compatible)
 * 전부가 구현하며, 기존 `chat()` 은 `chatDetailed(...).text` 위임 wrapper로
 * 남아 있어 기존 소비처는 0줄 변경으로 그대로 동작한다.
 */
export interface ObservableLlmClient extends LlmClient {
  chatDetailed(
    messages: readonly ChatMessage[],
    options?: LlmChatOptions,
  ): Promise<LlmChatResult>;
}
