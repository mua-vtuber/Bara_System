/**
 * Memory Core Settings Schema — 수집·추출·정리 파이프라인 그룹 (C2/schema 분해 2026-06-27).
 *
 * memory-schema.ts MEMORY_SCHEMA.properties 의 앞쪽 7 그룹을 그대로 떼어낸 파일.
 * 입력이 들어와 의미로 분해되고 정리되는 흐름 순서의 그룹 — db / llm /
 * extractor(정규식 Level 0) / metadataInfer / cleanupDeepPass / autoCleanup /
 * trashManagement. 각 그룹은 `as const satisfies GroupSchema` 로, 옛 통째
 * `as const satisfies {...}` 와 동일한 리터럴 타입을 유지한다 (default 리터럴·enum
 * 튜플 보존). 뒤쪽 7 그룹은 memory-schema-groups-retrieval.ts 에 있다.
 */

import type { GroupSchema } from "./memory-schema-types.ts";
import {
  cleanupTriggerSchema,
  entityRegisterAllocationSchema,
  entityRegisterSchemaBlock,
} from "./memory-schema-groups-entity-register.ts";
import { BACKFILL_RETRY_REQUIRED, extractorBackfillRetryProperties, visionBackfillRetryProperties } from "./memory-schema-groups-backfill-retry.ts";
import { EXTRACTOR_OUTPUT_LIMIT_REQUIRED, extractorOutputLimitProperties } from "./memory-schema-groups-extractor-output.ts";
import { METADATA_INFER_OUTPUT_LIMIT_REQUIRED, metadataInferOutputLimitProperties } from "./memory-schema-groups-metadata-infer-output.ts";
import { llmApiProviderFields } from "./memory-schema-groups-llm-providers.ts";
import { LLM_PROVIDERS } from "../llm/provider-registry.ts";

export const dbGroup = {
  type: "object",
  title: "메모리 코어 (DB + 임베딩 + HTTP)",
  description:
    "SQLite 파일 위치 + 임베딩 모델 + memory-api HTTP 바인딩. Phase 5.7.1 W1 — 옛 embedding 그룹 흡수.",
  properties: {
    path: {
      type: "string",
      title: "DB 파일 경로",
      description:
        "메모리 데이터베이스 파일 위치. 절대 경로 권장. 본인 PC는 Windows 형식 (D:/...), A1 Linux 는 절대 경로 (/home/...).",
      default: "data/bara.sqlite",
    },
    port: {
      type: "integer",
      title: "HTTP 포트",
      description: "memory-api 가 listen 할 TCP 포트.",
      default: 3001,
      minimum: 1,
      maximum: 65535,
    },
    host: {
      type: "string",
      title: "바인드 호스트",
      description:
        "memory-api 바인드 주소. 외부 노출 금지 정신 = 디폴트 127.0.0.1.",
      default: "127.0.0.1",
    },
    embeddingModel: {
      type: "string",
      title: "임베딩 모델",
      description:
        "모듈이 글·개념 의미를 숫자 벡터로 바꿀 때 쓰는 모델. bge-m3 (디폴트, 1024-dim) 는 A1 실측에서 무관한 글과 진짜 관련 글의 닮음 점수를 확실히 갈라 검색 정답을 1위로 올린다.",
      default: "bge-m3",
      enum: ["bge-m3"] as const,
    },
  },
  required: ["path"] as const,
} as const satisfies GroupSchema;

export const llmGroup = {
  type: "object",
  title: "LLM (의미 추출 + 데이터 정리 + 이미지 캡션)",
  description:
    "세 LLM 슬롯 — 의미 추출 (extractor) + 데이터 정리 (cleanup) + 이미지 캡션 (vision / VLM). 각 슬롯 독립 토글 + provider + 모델/키 칸 (Phase 5.6 W5 + Phase 11b T11 + spec section 8 + 11b).",
  properties: {
    // ── Slot 1 — 의미 추출 (extractor) ─────────────────────────────────
    extractor: {
      type: "object",
      title: "의미 추출 AI",
      description:
        "메시지 본문에서 atomic 메모리·중요도를 추출하는 슬롯. spec section 4.1.",
      properties: {
        enabled: {
          type: "boolean",
          title: "의미 추출 가동",
          description:
            "false 면 LLM 호출 0 — 태그 + 임베딩 + 멘션 정규식 만으로 그래프 가동.",
          default: true,
        },
        provider: {
          type: "string",
          title: "처리 방법",
          description:
            "글 의미 추출에 사용할 실행 경로. 실행 가능: 서버 Ollama, LM Studio 같은 OpenAI-compatible 서버, Anthropic Claude·OpenAI GPT·Google Gemini API.",
          // graceful-degradation 정합 — 로컬 우선 default (사용자 결정 2026-06-01).
          // 사용자가 settings 파일에 저장한 provider 값은 deep merge 가 그대로 보존.
          default: "ollama",
          enum: LLM_PROVIDERS,
          "x-ui": { widget: "select" },
        },
        ollamaUrl: {
          type: "string",
          title: "Ollama URL",
          description: "로컬 Ollama HTTP 엔드포인트.",
          default: "http://127.0.0.1:11434",
          format: "uri",
        },
        ollamaModel: {
          type: "string",
          title: "Ollama 모델",
          description:
            "Ollama 로 호출할 모델 태그. 모듈이 설치된 모델 목록을 list-ollama-models 액션으로 자동 제안. default qwen3:4b-instruct (Apache 2.0·상업 안전·non-thinking). 옛 exaone3.5 가족은 NC(비상업) 라이선스라 외부 배포 default 에서 제거. thinking 변형 qwen3:4b (instruct 아님) 은 빈 응답 함정이라 쓰지 않는다.",
          default: "qwen3:4b-instruct",
          "x-ui": {
            widget: "dynamic-enum",
            actionId: "list-ollama-models",
            labelField: "name",
            valueField: "id",
          },
        },
        anthropicApiKey: {
          type: "string",
          title: "Anthropic API 키",
          description:
            "Anthropic Claude API 키 (sk-ant-... 형식). 미설정 시 Anthropic 경로 비활성.",
          default: "",
          "x-ui": { widget: "password" },
        },
        anthropicModel: {
          type: "string",
          title: "Claude 모델",
          description: "Anthropic Claude API 호출에 쓸 모델 식별자.",
          default: "claude-haiku-4-5",
        },
        openaiBaseUrl: {
          type: "string",
          title: "OpenAI 호환 Base URL",
          description:
            "LM Studio 같은 OpenAI-compatible 서버의 base URL. 기본값은 LM Studio 로컬 서버.",
          default: "http://127.0.0.1:1234/v1",
          format: "uri",
        },
        openaiModel: {
          type: "string",
          title: "OpenAI 호환 모델",
          description:
            "OpenAI-compatible /chat/completions 에 넘길 모델 식별자. LM Studio 에 설치된 모델 이름을 그대로 쓴다.",
          default: "qwen3:4b-instruct",
        },
        openaiApiKey: {
          type: "string",
          title: "OpenAI 호환 API 키",
          description:
            "OpenAI-compatible 서버 인증 키. LM Studio 로컬 서버처럼 키가 필요 없으면 비워 둔다.",
          default: "",
          "x-ui": { widget: "password" },
        },
        ...llmApiProviderFields,
        ...extractorOutputLimitProperties,
        mode: {
          type: "string",
          title: "추출 시점",
          description:
            "'immediate' = raw 도착 즉시 추출, 'backfill' = 정해진 주기로 옛 메시지 묶어 일괄 추출 (옛 autoExtract=false 의미 흡수).",
          default: "backfill",
          enum: ["immediate", "backfill"] as const,
          "x-ui": { widget: "select" },
        },
        minImportance: {
          type: "number",
          title: "추출 importance 디폴트",
          description:
            "추출된 atomic 노드의 기본 importance 점수 (옛 extractor.importance 흡수).",
          default: 0.3,
          minimum: 0,
          maximum: 1,
        },
        // extractor-a1-2.4b-transition T1 (IN-1) — ollama 형식 강제 토글.
        forceJsonFormat: {
          type: "boolean",
          title: "ollama 형식 강제",
          description:
            "ollama 형식 강제(jsonSchema/jsonMode)를 켤지 정하는 토글. 현 운영 default 모델은 qwen3:4b-instruct (옛 exaone3.5:2.4b 에서 교체 — 2026-06-13 라이선스 정리). OFF 가 default 인데, qwen3:4b-instruct 에서 형식 강제 OFF 품질은 아직 재측정되지 않았다 (근거 미재확인 — 옛 exaone 2.4b 의 '형식 강제 OFF 가 정상 추출 8/8' 측정은 다른 모델 기준이다). 큰 모델(32B / instruct-2507)이 구조화 출력 보장을 필요로 할 때만 ON 으로 켠다. OFF 여도 응답이 깨지면 1회 재요청으로 안전망을 둔다.",
          default: false,
        },
        // extractor-a1-2.4b-transition T1 (IN-1) — ollama 추출 호출 한도(ms).
        timeoutMs: {
          type: "integer",
          title: "추출 호출 한도 (ms)",
          description:
            "ollama 추출 한 번의 호출 한도(ms). 900000ms = 15분. GPU 없는 A1 CPU에서 가벼운 모델 추출이 옛 고정 120초(120000ms)를 넘겨 끊기던 흠을 푸는 칸이다. 한도를 넘기면 조용히 빠지지 않고 loud하게 끊어 실패로 기록한다. OllamaClient timeoutMs와 같은 ms 단위라 변환 없이 그대로 전달된다.",
          default: 900000,
          minimum: 1,
        },
        // Phase 5.7.1 W1 — mode='backfill' 갈래 3 칸 sub-object (옛 backfillIntervalMin +
        // 옛 extractor.backfillBatchSize + 옛 extractor.backfillMinImportance 흡수).
        backfill: {
          type: "object",
          title: "정해진 주기로 추출 (사이클 가동)",
          description:
            "mode='backfill' 갈래의 일괄 처리 설정. mode='immediate' 갈래에서는 가동 안 함.",
          properties: {
            intervalMin: {
              type: "number",
              title: "추출 주기 (분)",
              description:
                "mode='backfill' 갈래의 일괄 처리 주기. 본인 정착 값 = 30분.",
              default: 30,
              minimum: 1,
            },
            batchSize: {
              type: "integer",
              title: "한 번에 처리할 메시지 개수",
              description:
                "한 주기에 처리할 미분해 raw 노드 최대 개수. 옛 BACKFILL_BATCH_SIZE 흡수.",
              default: 10,
              minimum: 1,
            },
            minImportance: {
              type: "number",
              title: "처리 대상 최소 중요도",
              description:
                "이 점수 미만의 raw 노드는 정해진 주기 추출에서 건너뜀. 옛 BACKFILL_MIN_IMPORTANCE 흡수.",
              default: 0,
              minimum: 0,
              maximum: 1,
            },
            ...extractorBackfillRetryProperties,
          },
          required: ["intervalMin", "batchSize", "minImportance", ...BACKFILL_RETRY_REQUIRED] as const,
        },
      },
      required: ["enabled", "provider", ...EXTRACTOR_OUTPUT_LIMIT_REQUIRED] as const,
    },
    // ── Slot 2 — 데이터 정리 (cleanup) ─────────────────────────────────
    cleanup: {
      type: "object",
      title: "데이터 정리 AI",
      description:
        "그래프 정리 (중복 merge / edge 제안 / 가치 낮은 노드 archive) 슬롯. spec section 4.2 + section 6 API 계약. default OFF — 본인 명시 활성화 + cleanup API 구현 (Phase 5.7+) 후 가동.",
      properties: {
        enabled: {
          type: "boolean",
          title: "데이터 정리 가동",
          description:
            "false (default) = cleanup 자동 가동 안 함. 본인 명시 활성화 전까지 0 호출.",
          default: false,
        },
        provider: {
          type: "string",
          title: "처리 방법",
          description:
            "데이터 정리에 사용할 실행 경로. 실행 가능: 서버 Ollama, LM Studio 같은 OpenAI-compatible 서버, Anthropic Claude·OpenAI GPT·Google Gemini API.",
          default: "anthropic",
          enum: LLM_PROVIDERS,
          "x-ui": { widget: "select" },
        },
        ollamaUrl: {
          type: "string",
          title: "Ollama URL",
          description: "로컬 Ollama HTTP 엔드포인트.",
          default: "http://127.0.0.1:11434",
          format: "uri",
        },
        ollamaModel: {
          type: "string",
          title: "Ollama 모델",
          description:
            "정리 호출에 쓸 Ollama 모델. default 는 빈 태그 — cleanup 은 enabled:false 라 호출 0. 가동하려면 사용자가 큰 Apache 모델 태그를 직접 채운다. 빈 태그로 가동하면 loud fail (가짜 통과 없음). 옛 exaone3.5:32b 는 NC(비상업) 라이선스라 외부 배포 default 에서 제거. 구체 Apache 큰 모델 태그는 후속 실측으로 정한다.",
          default: "",
          "x-ui": {
            widget: "dynamic-enum",
            actionId: "list-ollama-models",
            labelField: "name",
            valueField: "id",
          },
        },
        anthropicApiKey: {
          type: "string",
          title: "Anthropic API 키",
          description: "Anthropic Claude API 키. 미설정 시 Anthropic 경로 비활성.",
          default: "",
          "x-ui": { widget: "password" },
        },
        anthropicModel: {
          type: "string",
          title: "Claude 모델",
          description: "Anthropic Claude API 호출에 쓸 모델 식별자.",
          default: "claude-sonnet-4-6",
        },
        openaiBaseUrl: {
          type: "string",
          title: "OpenAI 호환 Base URL",
          description:
            "LM Studio 같은 OpenAI-compatible 서버의 base URL. 기본값은 LM Studio 로컬 서버.",
          default: "http://127.0.0.1:1234/v1",
          format: "uri",
        },
        openaiModel: {
          type: "string",
          title: "OpenAI 호환 모델",
          description:
            "OpenAI-compatible /chat/completions 에 넘길 모델 식별자. 데이터 정리는 32B 이상 또는 API를 권장하며, 비워 두면 해당 경로는 loud fail 한다.",
          default: "",
        },
        openaiApiKey: {
          type: "string",
          title: "OpenAI 호환 API 키",
          description:
            "OpenAI-compatible 서버 인증 키. LM Studio 로컬 서버처럼 키가 필요 없으면 비워 둔다.",
          default: "",
          "x-ui": { widget: "password" },
        },
        ...llmApiProviderFields,
        intervalDays: {
          type: "number",
          title: "정리 주기 (일)",
          description: "cleanup 주기. default 7일.",
          default: 7,
          minimum: 1,
        },
        // 데이터 정리 AI 효율 가동 spec (2026-07-11) 4.A-8 — extractor.timeoutMs 선례 정합.
        requestTimeoutMs: {
          type: "integer",
          title: "정리 호출 한도 (ms)",
          description:
            "cleanup 한 번의 호출 한도(ms). 900000ms = 15분. extractor.timeoutMs 와 대칭이며 3 provider(Ollama·Anthropic·OpenAI-compatible) 전부에 균일 적용된다 — Ollama·OpenAI-compatible 은 기존 timeoutMs 전달 통로, Anthropic 은 SDK 요청 timeout 옵션. 한도를 넘기면 조용히 빠지지 않고 loud하게 끊어 실패로 기록한다.",
          default: 900000,
          minimum: 1,
        },
        trigger: cleanupTriggerSchema,
      },
      required: ["enabled", "provider"] as const,
    },
    // ── Slot 3 — 이미지 캡션 (vision / VLM) ───────────────────────────────
    //
    // Phase 11b T11 — 옛 두 슬롯 (extractor + cleanup) 양식 그대로 차용한
    // 3번째 슬롯. VLM 호출은 SigLIP 이미지 임베딩이 이미 정착된 위에 *추가*
    // 신호 통로 — default OFF (사용자가 의지 ON 시점). spec section 11b
    // (이미지 검색 + VLM 캡션 보강) 정합.
    vision: {
      type: "object",
      title: "이미지 캡션 AI (VLM)",
      description:
        "이미지 보고 글로 묘사하는 VLM 슬롯. SigLIP 이미지 임베딩 위에 추가 캡션 신호 통로 — default OFF. 사용자가 명시 ON 시점부터 가동.",
      properties: {
        enabled: {
          type: "boolean",
          title: "이미지 캡션 가동",
          description:
            "false (default) = VLM 호출 0. SigLIP 임베딩만으로 이미지 검색 가동. true = 입력 이미지마다 VLM 캡션 묘사 생성.",
          default: false,
        },
        provider: {
          type: "string",
          title: "처리 방법",
          description:
            "이미지 설명에 사용할 실행 경로. 실행 가능: 서버 Ollama, LM Studio 같은 OpenAI-compatible 서버, Anthropic Claude·OpenAI GPT·Google Gemini API. Phase 11c hotfix (2026-05-30) — default 'ollama' 양식 정합 ([[phase11-14-design-decisions-progress-2026-05-22]] 결정 = Qwen3-VL 4B / 로컬 Ollama 가족 정합).",
          default: "ollama",
          enum: LLM_PROVIDERS,
          "x-ui": { widget: "select" },
        },
        ollamaUrl: {
          type: "string",
          title: "Ollama URL",
          description: "로컬 Ollama HTTP 엔드포인트.",
          default: "http://127.0.0.1:11434",
          format: "uri",
        },
        ollamaModel: {
          type: "string",
          title: "Ollama 모델",
          description:
            "VLM 호출에 활용할 Ollama 모델 태그 (예: qwen3-vl:4b-instruct). 모듈이 설치된 모델 목록을 list-ollama-models 액션으로 자동 제안. default qwen3-vl:4b-instruct (Apache 2.0·상업 안전·non-thinking). 실측: A1-급 CPU(num_gpu:0)에서 로드 3초·캡션 웜 7초로 정상이고, 짧고 정확한 출력 덕에 2b 와 전체 시간이 비슷하다. 옛 경고(로드 8분·빈 응답)는 thinking 변형 qwen3-vl:4b/:2b 한정 — 그 변형은 설치하지 않는다. Ollama 0.12.7+ 필요(qwen3-vl 네이티브 지원). 옛 qwen2.5vl 가족은 NC(비상업) 라이선스라 외부 배포 default 에서 제거.",
          default: "qwen3-vl:4b-instruct",
          "x-ui": {
            widget: "dynamic-enum",
            actionId: "list-ollama-models",
            labelField: "name",
            valueField: "id",
          },
        },
        anthropicApiKey: {
          type: "string",
          title: "Anthropic API 키",
          description:
            "Anthropic Claude API 키 (sk-ant-... 형식). 미설정 시 Anthropic 경로 비활성.",
          default: "",
          "x-ui": { widget: "password" },
        },
        anthropicModel: {
          type: "string",
          title: "Claude 모델",
          description: "Anthropic Claude vision 모델 식별자.",
          default: "claude-haiku-4-5",
        },
        openaiBaseUrl: {
          type: "string",
          title: "OpenAI 호환 Base URL",
          description:
            "LM Studio 같은 OpenAI-compatible vision 서버의 base URL. 기본값은 LM Studio 로컬 서버.",
          default: "http://127.0.0.1:1234/v1",
          format: "uri",
        },
        openaiModel: {
          type: "string",
          title: "OpenAI 호환 VLM 모델",
          description:
            "OpenAI-compatible /chat/completions 에 넘길 VLM 모델 식별자. LM Studio 에 설치된 vision 모델 이름을 그대로 쓴다.",
          default: "qwen3-vl:4b-instruct",
        },
        openaiApiKey: {
          type: "string",
          title: "OpenAI 호환 API 키",
          description:
            "OpenAI-compatible 서버 인증 키. LM Studio 로컬 서버처럼 키가 필요 없으면 비워 둔다.",
          default: "",
          "x-ui": { widget: "password" },
        },
        ...llmApiProviderFields,
        forceCall: {
          type: "boolean",
          title: "VLM 강제 호출",
          description:
            "ON = SigLIP 이미지 임베딩 OK 라도 VLM 캡션 강제 요청. OFF (default) = SigLIP 임베딩 가용 시 VLM 건너뜀 (token 절약 흐름).",
          default: false,
        },
        tokenCap: {
          type: "integer",
          title: "한 캡션 max_tokens 한도",
          description:
            "한 캡션 호출에 활용할 max_tokens 한도. anthropic 가족 200~400 자연 / ollama 가족 500~1000 자연. default 2000.",
          default: 2000,
          minimum: 1,
        },
        // ollama 캡션 호출 한도(ms) — extractor.timeoutMs 선례 정합.
        timeoutMs: {
          type: "integer",
          title: "캡션 호출 한도 (ms)",
          description:
            "ollama 캡션 한 번의 호출 한도(ms). 360000ms = 6분. GPU 없는 A1 CPU에서 qwen2.5vl:3b 캡션 1장이 100~209초까지 가, 옛 고정 120초(120000ms)로는 매번 끊겼다. 한도를 넘기면 조용히 빠지지 않고 loud하게 끊어 실패로 기록한다. OllamaVisionProvider timeoutMs와 같은 ms 단위라 변환 없이 그대로 전달된다.",
          default: 360000,
          minimum: 1,
        },
        // Phase 11e G2-4 — 캡션 프롬프트 글 노출 (spec §10.5 D5). 빈 문자열
        // default 면 caption-flow 가 개정된 한국어 검색용 default 프롬프트 사용.
        // 사용자가 보관소 성격(만화·일러스트)에 맞춰 직접 조정 가능.
        captionPrompt: {
          type: "string",
          title: "캡션 프롬프트",
          description:
            "VLM 에 넘길 캡션 요청 글. 비우면 개정된 한국어 검색용 default 사용 (인물·사물·배경·분위기·그림체를 명사 위주 2~3문장). 만화·일러스트 보관소 성격에 맞춰 직접 조정 가능.",
          default: "",
        },
        // extractor-vision-unified-clock-scheduler Task 4 — 캡션 시점(즉시/주기)·
        // 주기 분은 의미추출 AI 공통 설정(llm.extractor 권위)을 따른다. 옛 vision.mode +
        // vision.backfill.intervalMin 칸은 single source of truth 어긋남이라 제거.
        backfill: {
          type: "object",
          title: "한 사이클 캡션 설정",
          description:
            "캡션 사이클당 처리 설정. 캡션 시점(즉시/주기)·주기 분은 의미추출 AI 공통 설정(extractor 권위)을 따른다.",
          properties: {
            batchSize: {
              type: "integer",
              title: "한 번에 캡션할 이미지 개수",
              description:
                "한 주기에 캡션할 미캡션 (has_caption_auto=0) 이미지 최대 개수. created_at ASC (먼저 들어온 것부터). default 10.",
              default: 10,
              minimum: 1,
            },
            ...visionBackfillRetryProperties,
          },
          required: ["batchSize", ...BACKFILL_RETRY_REQUIRED] as const,
        },
      },
      required: ["enabled", "provider"] as const,
    },
  },
  required: ["extractor", "cleanup", "vision"] as const,
} as const satisfies GroupSchema;

export const extractorGroup = {
  type: "object",
  title: "정규식 추출 (Level 0)",
  description:
    "LLM 호출 없이 정규식 양식 + booster 사전으로 입력에서 1차 후보를 추출하는 Level 0 추출기 (spec 7.3). 옛 llm.extractor (의미 추출 AI) 와 별 그룹 — 이쪽은 LLM 0 가동.",
  properties: {
    regex: {
      type: "object",
      title: "정규식 Level 0",
      description:
        "정규식 1차 추출 가동 토글 + 매치 언어 선택 + 사용자 추가 양식/booster 합류 토글.",
      properties: {
        enabled: {
          type: "boolean",
          title: "정규식 추출 가동",
          description:
            "true (default) = 입력 도착 시점 정규식 양식 + booster 로 1차 후보 추출. false = 정규식 추출기 0 가동 (LLM 슬롯·태그·임베딩만 가동 — 정직한 토글 OFF).",
          default: true,
        },
        langs: {
          type: "array",
          title: "매치 언어",
          description:
            "정규식 양식·booster 를 가동할 언어 목록. 'ko' = 한국어 default, 'en' = 영어 default, 'ja' = 일본어 (만화·애니 자산). 이 목록에 든 언어 양식만 캐시에 올라간다.",
          default: ["ko", "en"],
          items: {
            type: "string",
            enum: ["ko", "en", "ja"] as const,
          },
          "x-ui": { widget: "multi-select" },
        },
        userPatternsEnabled: {
          type: "boolean",
          title: "사용자 추가 양식 합류",
          description:
            "true (default) = 대시보드에서 손으로 추가한 정규식 양식을 builtin/yaml 위에 합류. false = builtin/yaml 양식만 가동.",
          default: true,
        },
        userBoostersEnabled: {
          type: "boolean",
          title: "사용자 추가 booster 합류",
          description:
            "true (default) = 대시보드에서 손으로 추가한 booster 단어를 builtin/yaml 위에 합류. false = builtin/yaml booster 만 가동.",
          default: true,
        },
      },
      required: [
        "enabled",
        "langs",
        "userPatternsEnabled",
        "userBoostersEnabled",
      ] as const,
    },
  },
  required: ["regex"] as const,
} as const satisfies GroupSchema;

export const metadataInferGroup = {
  type: "object",
  title: "맥락 추론 메타 전파 (갈래 2)",
  description:
    "같은 사람이 비슷한 시간에 적은 메모를 한 사건(세션)으로 묶어, 장소·시각이 비어 있는 메모에 같은 사건의 다른 메모 값을 채울 제안을 만든다. 자동 적용 0 — 전부 검토 게이트(수락/거절). 가동 주기는 의미 추출(extractor) 주기를 따른다 — 추출 한 사이클이 끝나면 이어서 한 번 돈다(별도 주기 없음). LLM 미가용·의미 추출 OFF 면 자연히 안 돈다.",
  properties: {
    enabled: {
      type: "boolean",
      title: "맥락 추론 메타 전파 가동",
      description:
        "true (default) = 의미 추출 사이클 끝마다 익은(닫힌) 세션 중 장소·시각이 섞인 세션을 LLM 에 물어 빈 칸 채움 제안 생성. 산출이 전부 검토 게이트라 오판도 거절될 뿐 안전. false = 0 가동(정직한 토글 OFF).",
      default: true,
    },
    sessionGapMinutes: {
      type: "number",
      title: "세션 간격 (분)",
      description:
        "이 분(分)보다 더 떨어진 메모는 다른 사건(세션)으로 끊는다. 또 마지막 메모로부터 이 시간이 지나야 '닫힌 세션'으로 보고 평가한다(진행 중 세션은 다음 주기로 미룸). default 180(3시간).",
      default: 180,
      minimum: 1,
    },
    batchSize: {
      type: "integer",
      title: "한 사이클 후보 메모 개수",
      description:
        "한 사이클에 줍는 후보 메모 최대 개수. 이미 제안을 만든 메모는 빠진다. default 200.",
      default: 200,
      minimum: 1,
    },
    ...metadataInferOutputLimitProperties,
  },
  required: ["enabled", "sessionGapMinutes", "batchSize", ...METADATA_INFER_OUTPUT_LIMIT_REQUIRED] as const,
} as const satisfies GroupSchema;

export const cleanupDeepPassGroup = {
  type: "object",
  title: "정규식 강화 깊은 패스",
  description:
    "강한 cleanup LLM 이 '정규식이 놓친 글'을 묶어 새 정규식 양식을 제안하는 깊은 패스 (Phase 7 / spec section 8·10). 가동 토글·provider·모델·주기는 llm.cleanup 슬롯 권위 — 이 그룹은 강화 단계 고유 손잡이(후보 수·과매치 컷)만 담는다. 전부 검토 게이트라 자동 데이터 0.",
  properties: {
    regexStrengthen: {
      type: "object",
      title: "정규식 강화 손잡이",
      description:
        "한 사이클 후보 수 + 과매치율 컷 임계 + 과매치 표본 크기. 며칠 써보고 '제안이 너무 적다/헐렁하다' 싶으면 임계를 한 줄 조정 (spec section 10).",
      properties: {
        enabled: {
          type: "boolean",
          title: "정규식 강화 깊은 패스 가동",
          description:
            "false (default) = 깊은 패스 0 가동. 강한 모델은 API 비용(사용자 부담)이라 켜는 시점을 사용자가 고른다 (spec section 8 default OFF — 갈래2가 ollama 무료라 ON 이었던 것과 다른 판단). true = cleanup 주기마다 '놓친 글'을 묶어 새 정규식 양식 제안.",
          default: false,
        },
        batchSize: {
          type: "integer",
          title: "한 사이클 후보 글 개수",
          description:
            "한 사이클에 줍는 후보('정규식이 놓친 글') 최대 개수. default 50.",
          default: 50,
          minimum: 1,
        },
        overmatchThreshold: {
          type: "number",
          title: "과매치율 컷 임계",
          description:
            "제안된 정규식이 표본 글에서 이 비율을 넘게 매치하면 너무 헐렁한 양식으로 보고 탈락시킨다. 0~1 사이. default 0.3 (spec section 10). 낮추면 더 빡빡하게 거르고, 높이면 헐렁한 양식도 통과시킨다.",
          default: 0.3,
          minimum: 0,
          maximum: 1,
        },
        overmatchSampleSize: {
          type: "integer",
          title: "과매치 표본 글 개수",
          description:
            "과매치율을 잴 때 쓰는 표본 글 개수. default 100. 클수록 정확하나 검사 비용이 늘고, 작으면 빠르나 변동이 커진다.",
          default: 100,
          minimum: 1,
        },
      },
      required: [
        "enabled",
        "batchSize",
        "overmatchThreshold",
        "overmatchSampleSize",
      ] as const,
    },
    summary: {
      type: "object",
      title: "요약 단계 손잡이",
      description:
        "청크요약 atomic 임계 + 후보 수 + 관계 엣지 confidence 임계 + 첫 문단 fallback 길이 + 요약 검색 채널 default (Phase 7 요약 단계 / spec section 6·10). 며칠 써보고 '관계 엣지가 너무 적다/많다' 싶으면 relationConfidenceThreshold 를 한 줄 조정.",
      properties: {
        enabled: {
          type: "boolean",
          title: "요약 단계 가동",
          description:
            "false (default) = 요약 단계 0 가동. 강한 모델은 API 비용(사용자 부담)이라 켜는 시점을 사용자가 고른다 (spec section 6 default OFF — 첫 단계와 같은 판단). 가동 슬롯(llm.cleanup.enabled)과 함께 켜져야 사이클이 돈다.",
          default: false,
        },
        atomicThreshold: {
          type: "integer",
          title: "청크요약 atomic 임계",
          description:
            "한 청크에 달린 atomic(분해된 의미 조각) 수가 이 값 이상이면 요약 후보로 줍는다. default 4 (spec section 3.1 옛 D4). 낮추면 더 많은 청크를 요약하고, 높이면 큰 청크만 요약한다.",
          default: 4,
          minimum: 1,
        },
        batchSize: {
          type: "integer",
          title: "한 사이클 요약 후보 개수",
          description:
            "한 사이클에 줍는 요약 후보 청크 최대 개수. default 50.",
          default: 50,
          minimum: 1,
        },
        relationConfidenceThreshold: {
          type: "number",
          title: "관계 엣지 confidence 임계",
          description:
            "관계요약 행은 항상 저장하되, LLM 이 매긴 confidence 가 이 값 이상일 때만 llm_relation 엣지를 만든다. 0~1 사이. default 0.6 (plan 선택값 — spec section 10 '써봐야 안다'). 낮추면 더 많은 관계를 엣지로 잇고, 높이면 확실한 관계만 잇는다.",
          default: 0.6,
          minimum: 0,
          maximum: 1,
        },
        firstParagraphMaxChars: {
          type: "integer",
          title: "첫 문단 fallback 최대 글자 수",
          description:
            "LLM 이 청크요약을 못 만들 때(graceful) 첫 문단을 이 길이로 잘라 요약 자리에 채운다. default 300. generated_by 로 출처를 표시한다.",
          default: 300,
          minimum: 1,
        },
        searchChannelDefault: {
          type: "boolean",
          title: "요약 검색 채널 기본 가동",
          description:
            "검색 요청이 옵션을 안 주면 따르는 요약 텍스트 검색 채널 default. true (default) = 요약 문장도 검색 후보에 합류. 요약은 RRF 합산 후 후처리 옵션 채널이라 켜져 있어도 검색 코어는 불변.",
          default: true,
        },
      },
      required: [
        "enabled",
        "atomicThreshold",
        "batchSize",
        "relationConfidenceThreshold",
        "firstParagraphMaxChars",
        "searchChannelDefault",
      ] as const,
    },
    // ── 사람 연결 단계 손잡이 (데이터 정리 AI 효율 가동 spec 5.B-2 / DCL-1·DCL-7) ──
    //   옛 person_link 단계는 토글 없이 항상 돌고 batchSize 를 요약 슬롯에서 차용했다.
    //   이 그룹이 그 두 결함을 푼다 — enabled(현행 보존 default true) + 자기 batchSize +
    //   autoApply(conf>=0.9 자동 연결 게이트). autoApply 는 신규 설치 default false(제안
    //   게이트 경유가 안전 기본값), 기존 설치는 migrate-legacy-keys 가 true 로 채워 현행
    //   자동 동작을 보존한다(DCL-7).
    personLink: {
      type: "object",
      title: "사람 연결 단계 손잡이",
      description:
        "메모의 애매한 사람 언급을 강한 cleanup LLM 이 기존 사람으로 연결하는 단계. 가동 토글 + 한 사이클 후보 수 + 자동 연결 게이트. 자동 연결을 꺼도 단계는 돌고 산출이 전부 검토 제안(cleanup_proposals)으로 간다 — 기능 축소가 아니라 적용 게이트 위치 선택.",
      properties: {
        enabled: {
          type: "boolean",
          title: "사람 연결 단계 가동",
          description:
            "true (default) = cleanup 사이클마다 애매한 사람 언급을 기존 사람으로 연결 시도(현행 동작 보존, DCL-1). false = 이 단계 0 가동(정직한 토글 OFF). 가동 슬롯(llm.cleanup.enabled)과 함께 켜져야 사이클이 돈다.",
          default: true,
        },
        batchSize: {
          type: "integer",
          title: "한 사이클 사람 연결 후보 개수",
          description:
            "한 사이클에 줍는 사람 연결 후보 노드 최대 개수. default 50. 옛 요약 슬롯 차용을 해소한 자기 손잡이.",
          default: 50,
          minimum: 1,
        },
        autoApply: {
          type: "boolean",
          title: "높은 확신 자동 연결",
          description:
            "conf>=0.9 인 확실한 연결을 검토 없이 자동 반영할지. false (신규 설치 default) = 확실한 연결도 검토 제안(cleanup_proposals)으로 보내 사람이 승인. true (기존 설치 이관 보존) = conf>=0.9 는 자동 mentions 엣지. 낮은 확신(0.6~0.9)은 이 값과 무관하게 항상 제안으로 간다.",
          default: false,
        },
      },
      required: ["enabled", "batchSize", "autoApply"] as const,
    },
    // ── 렌즈 소비 단계 손잡이 (데이터 정리 AI 효율 가동 spec 6.C-2 / DCL-4) ──────
    //   렌즈가 정의된 종류의 기존 엔티티 중 구조화 칸이 빈 것을 강한 cleanup LLM 이
    //   렌즈 계약 안에서 채워 구조화 초안(cleanup_proposals kind=lens_draft)으로 만든다.
    //   유료 + 신규 동작이라 default OFF. 자동 적용은 0 — 다중 칸 동시 변경이라 오적용
    //   파급이 person_link 단일 연결보다 커, 확실한 초안도 전부 검토 게이트 경유(person_link
    //   의 conf>=0.9 자동 예외를 승계하지 않는다). approve 는 선행 정비된 공유 적용 함수
    //   (재검증 + 트랜잭션 + fingerprint 재대조) 경유.
    lensDraft: {
      type: "object",
      title: "렌즈 소비 단계 손잡이",
      description:
        "렌즈가 정의된 종류의 기존 엔티티 중 빈 칸을 강한 cleanup LLM 이 렌즈 계약 안에서 채워 구조화 초안(cleanup_proposals)으로 만드는 단계. 자동 적용은 없다 — 확실한 초안도 전부 검토 게이트 경유(다중 칸 동시 변경의 오적용 파급이 크다). 새 사람·엔티티 생성 금지, 관계 대상·사람은 기존 id 만, 렌즈 밖 키는 거부.",
      properties: {
        enabled: {
          type: "boolean",
          title: "렌즈 소비 단계 가동",
          description:
            "true = cleanup 사이클마다 빈 칸 엔티티에 렌즈 초안을 만든다. false (default) = 이 단계 0 가동(정직한 토글 OFF). 유료 강모델 + 신규 동작이라 default OFF — 명시로 켠다. 가동 슬롯(llm.cleanup.enabled)과 함께 켜져야 사이클이 돈다.",
          default: false,
        },
        batchSize: {
          type: "integer",
          title: "한 사이클 렌즈 초안 후보 개수",
          description:
            "한 사이클에 훑는 빈 칸 엔티티 최대 개수. default 20. 한 엔티티당 렌즈 계약 + 근거 노드가 함께 실려 다른 단계보다 배치가 작다.",
          default: 20,
          minimum: 1,
        },
      },
      required: ["enabled", "batchSize"] as const,
    },
    // ── 항목·일정 자동 등록 손잡이 (2026-10-10 spec) — 스키마 조각은 별 파일 ──────
    entityRegister: entityRegisterSchemaBlock,
    // ── 관계 발굴 자동 반영 손잡이 (데이터 정리 AI 효율 가동 spec 5.B-2) ──────────
    //   요약 단계 안 관계 발굴이 confidence 임계를 넘긴 관계를 llm_relation 개념 엣지로
    //   자동 반영할지. relation_summaries 행은 이 값과 무관하게 항상 저장된다(정리 자산).
    //   autoApply=false 면 엣지 자동 생성만 보류한다 — 관계는 요약 행으로 남고 그래프
    //   엣지로만 안 굳는다(적용 게이트 위치 선택, spec·plan 서술).
    relationDiscovery: {
      type: "object",
      title: "관계 발굴 자동 반영 손잡이",
      description:
        "요약 단계가 발굴한 개념 사이 관계를 llm_relation 그래프 엣지로 자동 반영할지. 관계요약 행은 이 값과 무관하게 항상 저장된다(검색·회상 자산). 자동 반영을 끄면 엣지 생성만 보류하고 요약 행은 유지한다.",
      properties: {
        autoApply: {
          type: "boolean",
          title: "관계 엣지 자동 반영",
          description:
            "true (기존 설치 이관 보존) = confidence 임계 통과 관계를 llm_relation 개념 엣지로 자동 반영(현행 동작). false (신규 설치 default) = 엣지 자동 생성 보류(관계요약 행은 저장 유지 — 자동 그래프 변경은 opt-in 이 안전 기본값).",
          default: false,
        },
      },
      required: ["autoApply"] as const,
    },
    // ── 신뢰성 손잡이 (데이터 정리 AI 효율 가동 spec 4.A-5 / 표) ──────────────
    //   실행층(CleanupLlmExecutor)이 소비하는 재시도·attempt·circuit breaker 값.
    //   index.ts 배선이 이 그룹에서 읽어 executor·cycle deps 로 넘긴다(하드코딩 0).
    reliability: {
      type: "object",
      title: "정리 실행 신뢰성 손잡이",
      description:
        "강한 cleanup LLM 호출의 재시도·attempt 상한·circuit breaker. 일시 오류(429/5xx/timeout)는 backoff 재시도로 스스로 복구하고, 결정적 실패는 attempt 를 누적해 상한에서 terminal 로 확정하며, provider 연속 실패가 임계를 넘으면 그 단계를 사이클 안에서 중단한다.",
      properties: {
        maxAttemptsPerTarget: {
          type: "integer",
          title: "대상별 결정적 실패 attempt 상한",
          description:
            "한 대상(글·청크·노드)의 결정적 실패(파싱·ID 검증·max_tokens 잘림)가 이 횟수만큼 쌓이면 terminal_failure 로 확정해 재과금을 끊는다. default 3.",
          default: 3,
          minimum: 1,
        },
        retryMaxPerCall: {
          type: "integer",
          title: "일시 오류 호출 재시도 상한",
          description:
            "한 호출이 일시 오류(429/5xx/네트워크/timeout)를 낼 때 backoff 로 재시도할 최대 횟수. default 2.",
          default: 2,
          minimum: 0,
        },
        retryBaseDelayMs: {
          type: "integer",
          title: "재시도 backoff 기준 지연 (ms)",
          description:
            "지수 backoff(base * 2^attempt) + jitter 의 밑이 되는 기준 지연(ms). Retry-After 헤더가 오면 그 값이 우선한다. default 2000.",
          default: 2000,
          minimum: 1,
        },
        circuitBreakerThreshold: {
          type: "integer",
          title: "circuit breaker 연속 실패 임계",
          description:
            "provider+단계 연속 일시 실패가 이 횟수에 도달하면 그 단계를 사이클 안에서 중단한다(장애 중 남은 후보 전부를 훑으며 과금·대기하는 낭비 차단). 성공 한 번이 카운터를 리셋한다. default 5.",
          default: 5,
          minimum: 1,
        },
        staleRunReclaimMs: {
          type: "integer",
          title: "죽은 run 회수 나이 문턱 (ms)",
          description:
            "사이클 도중 프로세스가 죽으면(SIGKILL·OOM·재부팅) run 원장 행이 'running' 으로 굳는다. 시작 후 이 시간을 넘겨도 running 인 행을 다음 사이클 시작 때 failed 로 회수해, 그 행이 쥔 idempotency 키가 영구 봉쇄되는 것을 막는다. 정상 사이클은 예산 상한(maxDurationMsPerCycle) 안에 끝나므로 그보다 넉넉히 잡는다. default 3600000(1시간) — doctor 정체 감지 문턱과 같은 값.",
          default: 3600000,
          minimum: 60000,
        },
      },
      required: [
        "maxAttemptsPerTarget",
        "retryMaxPerCall",
        "retryBaseDelayMs",
        "circuitBreakerThreshold",
        "staleRunReclaimMs",
      ] as const,
    },
    // ── 예산 4차원 + 단계별 배분 (spec 4.A-5) ────────────────────────────────
    //   유료 강모델 연결 시 사이클 지출을 4차원(호출 수·추정 입력·출력·시간) 상한
    //   안에 묶는다. stageAllocation 이 각 차원을 단계별 비율로 나눠 한 단계가 전
    //   예산을 소진해 뒤 단계를 굶기는 것을 막는다. **DCL-6**: 아래 수치는 잠정·
    //   보수적 — 후보량·문서 길이 분포가 보관소마다 달라 dryRun(run API) 실측 뒤
    //   확정한다. 지금은 안전하게 작게 잡아 폭주만 막는다.
    budget: {
      type: "object",
      title: "정리 사이클 예산 (4차원 + 단계별 배분)",
      description:
        "한 사이클의 지출 상한. 4차원(호출 수·추정 입력 토큰·출력 토큰·시간)을 걸고 stageAllocation 으로 단계별로 나눈다. 어느 차원이든 도달하면 그 단계 남은 후보를 다음 사이클로 이월하고 도달 차원·수치를 로그로 남긴다. 아래 수치는 잠정(DCL-6) — dryRun 실측 후 확정 예정.",
      properties: {
        maxCallsPerCycle: {
          type: "integer",
          title: "사이클 호출 수 상한",
          description:
            "한 사이클에 낼 수 있는 대상 LLM 호출 수 상한(재시도 제외). 호출 전 결정적 검사가 가능한 1차 가드. 잠정 default 50 — dryRun 실측 후 확정 예정(DCL-6).",
          default: 50,
          minimum: 1,
        },
        maxEstimatedInputTokensPerCycle: {
          type: "integer",
          title: "사이클 추정 입력 토큰 상한",
          description:
            "한 사이클 추정 입력 토큰 누적 상한. 입력이 지출 주축이라 호출 전 추정으로 검사한다. 잠정 default 500000 — dryRun 실측 후 확정 예정(DCL-6).",
          default: 500000,
          minimum: 1,
        },
        maxOutputTokensPerCycle: {
          type: "integer",
          title: "사이클 출력 토큰 상한",
          description:
            "한 사이클 출력 토큰 누적 상한. 호출 성공 뒤 사후 확정되며 초과 시 이후 호출을 차단한다. 잠정 default 100000 — dryRun 실측 후 확정 예정(DCL-6).",
          default: 100000,
          minimum: 1,
        },
        maxDurationMsPerCycle: {
          type: "integer",
          title: "사이클 시간 상한 (ms)",
          description:
            "한 사이클 최대 소요 시간(ms). 강모델 지연·재시도 폭주가 자정 격자를 침범하지 않게 막는다. 잠정 default 1800000(30분) — dryRun 실측 후 확정 예정(DCL-6).",
          default: 1800000,
          minimum: 1,
        },
        maxEstimatedInputTokensPerCall: {
          type: "integer",
          title: "호출당 입력 토큰 상한",
          description:
            "한 호출의 추정 입력 토큰 상한. 초과 대상은 자연 경계(청크·문단)로 분할 가능하면 분할하고, 불가하면 호출하지 않고 terminal_failure(input_over_cap)로 남긴다(A-6 소비). 잠정 default 30000 — dryRun 실측 후 확정 예정(DCL-6).",
          default: 30000,
          minimum: 1,
        },
        stageAllocation: {
          type: "object",
          title: "단계별 예산 배분 비율",
          description:
            "각 예산 차원을 단계별로 나누는 비율. 다섯 값의 합이 1.0 이어야 하며, 어긋나면 설정 로드 시 loud fail 한다. 정규식 강화가 후보 폭주로 전 예산을 소진해 요약·사람 연결·렌즈 초안을 굶기는 것을 막는다. 잠정 값(DCL-6).",
          properties: {
            regexStrengthen: {
              type: "number",
              title: "정규식 강화 배분",
              description: "정규식 강화 단계 예산 비율. 잠정 0.2(DCL-6).",
              default: 0.2,
              minimum: 0,
              maximum: 1,
            },
            summary: {
              type: "number",
              title: "요약·관계 배분",
              description:
                "요약(관계 발굴 포함) 단계 예산 비율. 잠정 0.2(DCL-6).",
              default: 0.2,
              minimum: 0,
              maximum: 1,
            },
            personLink: {
              type: "number",
              title: "사람 연결 배분",
              description: "사람 연결 단계 예산 비율. 잠정 0.2(DCL-6).",
              default: 0.2,
              minimum: 0,
              maximum: 1,
            },
            lensDraft: {
              type: "number",
              title: "렌즈 초안 배분",
              description: "렌즈 소비 단계 예산 비율. 잠정 0.2(DCL-6).",
              default: 0.2,
              minimum: 0,
              maximum: 1,
            },
            entityRegister: entityRegisterAllocationSchema,
          },
          required: [
            "regexStrengthen",
            "summary",
            "personLink",
            "lensDraft",
            "entityRegister",
          ] as const,
        },
      },
      required: [
        "maxCallsPerCycle",
        "maxEstimatedInputTokensPerCycle",
        "maxOutputTokensPerCycle",
        "maxDurationMsPerCycle",
        "maxEstimatedInputTokensPerCall",
        "stageAllocation",
      ] as const,
    },
  },
  // personLink·relationDiscovery·reliability·budget 은 required 에 넣지 않는다 — additive
  // 안전(옛 파일에 그룹이 없어도 deep merge 가 default 를 채우고 검증을 통과). 특히
  // personLink 부재는 migrate-legacy-keys 의 기존 설치 판별 신호이므로(DCL-7) required 에
  // 넣으면 안 된다. extractor.timeoutMs 선례 정합.
  required: ["regexStrengthen", "summary"] as const,
} as const satisfies GroupSchema;

export const autoCleanupGroup = {
  type: "object",
  title: "메모리 자동 정리",
  description:
    "데이터 변동 시점에 가치 점수 갱신 + 비슷한 노드 묶기 + 가치 낮은 노드 휴지통 이동.",
  properties: {
    enabled: {
      type: "boolean",
      title: "메모리 자동 정리 가동",
      description: "데이터 변동 시점 트리거 ON/OFF.",
      default: true,
    },
    throttleSeconds: {
      type: "number",
      title: "안전 간격 (초)",
      description:
        "마지막 가동 후 N초 안 신규 트리거는 silent skip — 본인 폭증 흐름 보호.",
      default: 30,
      minimum: 10,
      maximum: 300,
    },
    valueThreshold: {
      type: "number",
      title: "가치 임계값",
      description: "이 점수 미만 노드는 휴지통 후보. 보수적 시작 0.05.",
      default: 0.05,
      minimum: 0,
      maximum: 1,
    },
  },
  required: ["enabled"] as const,
} as const satisfies GroupSchema;

export const trashManagementGroup = {
  type: "object",
  title: "휴지통 관리",
  description:
    "매일 새벽 cron 가동 — 30일 지난 노드 영구 삭제 + 사전 알림 목록 생성.",
  properties: {
    enabled: {
      type: "boolean",
      title: "휴지통 관리 가동",
      description: "매일 새벽 cron ON/OFF.",
      default: true,
    },
    cronTime: {
      type: "string",
      title: "가동 시각 (HH:MM, KST)",
      description: "매일 가동 시각 — 예: 03:00. A1 백업 cron 과 정합.",
      default: "03:00",
      pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
    },
    retentionDays: {
      type: "number",
      title: "휴지통 보존일",
      description: "N일 지난 노드 영구 삭제.",
      default: 30,
      minimum: 1,
    },
    warningDays: {
      type: "number",
      title: "사전 경고 일수",
      description: "영구 삭제 N일 전 알림 목록 산출.",
      default: 7,
      minimum: 0,
    },
  },
  required: ["enabled"] as const,
} as const satisfies GroupSchema;

// P4 D1 — 서버 내장 백업 그룹. cron 시각은 settings.time.zone 기준(zone-aware 신규
// 계산 — trash cron 의 시스템 TZ 방식과 다름, backup-cron.ts 주석 참조).
export const backupGroup = {
  type: "object",
  title: "백업",
  description:
    "매일 새벽 서버가 스스로 DB 스냅샷(VACUUM INTO) + 설정·비밀값·토큰 + 자산 미러 백업을 뜬다.",
  properties: {
    enabled: {
      type: "boolean",
      title: "자동 백업 가동",
      description: "매일 백업 cron ON/OFF.",
      default: true,
    },
    cronTime: {
      type: "string",
      title: "가동 시각 (HH:MM, 설정 시간대)",
      description: "매일 백업 시각 — 예: 04:00. 휴지통 cron(03:00)과 시간 분리 권장.",
      default: "04:00",
      pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
    },
    retentionDays: {
      type: "number",
      title: "백업 보존일",
      description: "N일 지난 백업 회차 자동 삭제.",
      default: 7,
      minimum: 1,
    },
    dir: {
      type: "string",
      title: "백업 디렉토리",
      description: "백업 회차가 쌓이는 경로. 다른 디스크 경로 지정 가능.",
      default: "data/backups",
    },
  },
  required: ["enabled"] as const,
} as const satisfies GroupSchema;

// P3 G3-b — 애플리케이션 시간대 그룹. 저장 시각·상대 날짜('어제')·자정 anchor·보관
// 컷오프가 이 zone 하나를 따른다. default "Asia/Seoul" — 옛 KST 고정 동작과 byte
// 동일이라 회귀 0. 다른 나라에서 쓰는 사용자는 이 한 칸만 바꾸면 저장 시각 전체가
// 그 zone 으로 통일된다.
export const timeGroup = {
  type: "object",
  title: "시간대",
  description:
    "모듈이 저장 시각·상대 날짜·보관 컷오프를 계산할 때 기준으로 삼는 시간대. 한 곳만 바꾸면 저장 시각 전체가 그 나라 시간으로 통일된다.",
  properties: {
    zone: {
      type: "string",
      title: "기준 시간대 (IANA)",
      description:
        "IANA 시간대 이름(예: Asia/Seoul, UTC, America/New_York). 이 zone 으로 저장 시각·상대 날짜·보관 컷오프가 계산된다. 잘못된 이름은 부팅 시 loud 하게 실패한다(조용히 넘어가지 않음). default Asia/Seoul.",
      default: "Asia/Seoul",
    },
  },
  required: ["zone"] as const,
} as const satisfies GroupSchema;

// P3 G3-c — events 큐 보존정책 그룹. events 테이블은 알림을 영구 적재하는데 DELETE
// 경로가 없어 무한 성장했다. retentionDays 지난 events 를 trash cron 이 정리한다.
// 재연결(SSE 이어받기) 윈도우 보호를 위해 default 는 넉넉히 크게 잡는다. -1 sentinel =
// 무제한(정직한 비활성 — 삭제 안 함).
export const eventsGroup = {
  type: "object",
  title: "이벤트 큐 보존",
  description:
    "알림 이벤트(정리 제안 ready 등)를 담는 events 큐의 보존 기간. 오래된 이벤트를 매일 cron 이 정리해 무한 성장을 막는다. SSE 재연결 이어받기 윈도우를 보호하려 default 는 넉넉히 크다.",
  properties: {
    retentionDays: {
      type: "number",
      title: "이벤트 보존일",
      description:
        "N일 지난 이벤트를 영구 삭제한다. -1 이면 무제한(삭제 안 함). 너무 짧게 잡으면 오래 끊겼던 어댑터가 재연결할 때 이어받을 이벤트를 잃을 수 있으니, 재연결 윈도우보다 크게 둔다. default 90일.",
      default: 90,
      minimum: -1,
    },
  },
  required: ["retentionDays"] as const,
} as const satisfies GroupSchema;
