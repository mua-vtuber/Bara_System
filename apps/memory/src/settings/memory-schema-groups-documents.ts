/**
 * Memory Core Settings Schema — 문서 처리 그룹.
 *
 * 문서 OCR은 "어떤 AI 모델인가"보다 "어디서 실행되는가"가 운영 경계를 가른다.
 * A1/core 서버가 직접 모델을 들지 않는 흐름을 기본으로 두되, 로컬 설치·API·PC
 * companion 갈래를 같은 settings JSON 안에 명시한다.
 */

import type { GroupSchema } from "./memory-schema-types.ts";
import { DOCUMENT_OCR_API_PROVIDERS } from "./document-ocr-api-providers.ts";
import {
  documentOcrApiProviderFields,
  documentOcrRunLocalFields,
  documentOcrRunScheduleFields,
  documentOcrRunTopFields,
} from "./memory-schema-groups-documents-ocr-run.ts";

export const documentsGroup = {
  type: "object",
  title: "문서 처리",
  description:
    "문서 OCR 실행 위치와 companion 작업 설정. 수동, 로컬 AI, 외부 API, PC companion 흐름을 구분한다.",
  properties: {
    ocr: {
      type: "object",
      title: "문서 OCR",
      description:
        "스캔 PDF와 파싱 실패 문서를 어떻게 처리할지 정한다. 로컬 AI는 바라시스템이 같은 PC에서 실행될 때만 공식 지원한다.",
      properties: {
        mode: {
          type: "string",
          title: "실행 방식",
          description:
            "manual=수동 Markdown 붙이기, local=서버에 설치된 Ollama/LM Studio 사용, api=AI API 호출, pc_companion=서버 작업을 내 PC 프로그램이 가져가 처리.",
          default: "manual",
          enum: ["manual", "local", "api", "pc_companion"] as const,
          "x-ui": { widget: "select" },
        },
        resourceProfile: {
          type: "string",
          title: "자원 프로필",
          description:
            "OCR 실행자가 사용할 자원 성향. low_power=저전력, balanced=균형, gpu=GPU 사용 가능 환경.",
          default: "balanced",
          enum: ["low_power", "balanced", "gpu"] as const,
          "x-ui": { widget: "select" },
        },
        ...documentOcrRunTopFields,
        schedule: {
          type: "object",
          title: "처리 주기",
          description:
            "자동 처리 또는 companion lease 에 쓰는 주기와 한도. 수동 모드에서는 후보 목록 갱신 의미만 갖는다.",
          properties: {
            intervalMin: {
              type: "integer",
              title: "서버 처리 간격(분)",
              description:
                "서버 자동 처리(로컬 Ollama·LM Studio, AI API) 사이클 간격. 저장하면 바로 적용된다. default 30.",
              default: 30,
              minimum: 1,
            },
            batchSize: {
              type: "integer",
              title: "한 번에 처리할 문서 수",
              description:
                "한 사이클에서 자동 처리할 최대 문서 수. 무거운 OCR은 작게 둔다. default 1.",
              default: 1,
              minimum: 1,
              maximum: 50,
            },
            leaseSeconds: {
              type: "integer",
              title: "작업 임대 시간(초)",
              description:
                "PC companion 이 작업을 잡은 뒤 다른 worker 가 다시 가져가기 전까지 기다리는 시간. default 1800.",
              default: 1800,
              minimum: 60,
              maximum: 86400,
            },
            timeoutMs: {
              type: "integer",
              title: "한 쪽 처리 한도(ms)",
              description:
                "서버 자동 처리에서 한 쪽(파일 업로드 API 는 문서 1건) AI 호출의 처리 제한 시간. companion 명령 안내에도 쓴다. default 900000.",
              default: 900000,
              minimum: 1000,
            },
            ...documentOcrRunScheduleFields,
          },
          required: [
            "intervalMin",
            "batchSize",
            "leaseSeconds",
            "timeoutMs",
            "maxPagesPerCycle",
            "maxPagesPerDay",
          ] as const,
        },
        local: {
          type: "object",
          title: "로컬 AI",
          description:
            "바라시스템과 Ollama/LM Studio/로컬 명령이 같은 PC에서 실행될 때 쓰는 설정. 원격 서버가 PC의 로컬 AI에 직접 붙는 흐름은 지원하지 않는다.",
          properties: {
            provider: {
              type: "string",
              title: "서버 AI",
              description:
                "서버에 설치된 Ollama 또는 LM Studio 중 하나를 선택한다. command 는 내부 호환용 실행 명령 값이다.",
              default: "command",
              enum: ["ollama_vision", "lmstudio_vision", "command"] as const,
              "x-ui": { widget: "select" },
            },
            ollamaUrl: {
              type: "string",
              title: "Ollama URL",
              description: "로컬 Ollama 주소. 바라시스템과 같은 PC에서만 공식 지원.",
              default: "http://127.0.0.1:11434",
              format: "uri",
            },
            ollamaModel: {
              type: "string",
              title: "Ollama vision 모델",
              description:
                "OCR 또는 문서 이미지 이해에 쓸 Ollama vision 모델 태그. 비워두면 실행 시 명시 오류.",
              default: "qwen3-vl:4b-instruct",
            },
            lmstudioUrl: {
              type: "string",
              title: "LM Studio URL",
              description:
                "OpenAI-compatible 로컬 LM Studio endpoint. 바라시스템과 같은 PC에서만 공식 지원.",
              default: "http://127.0.0.1:1234/v1",
              format: "uri",
            },
            lmstudioModel: {
              type: "string",
              title: "LM Studio vision 모델",
              description:
                "LM Studio 로컬 vision 모델 이름. 비워두면 실행 시 명시 오류.",
              default: "",
            },
            commandJson: {
              type: "string",
              title: "로컬 명령 JSON",
              description:
                "외부 OCR 프로그램 argv JSON 배열. 예: [\"python\",\"ocr.py\",\"{input}\",\"{output}\"]. shell 을 거치지 않는다.",
              default: "",
            },
            ...documentOcrRunLocalFields,
          },
          required: [
            "provider",
            "ollamaUrl",
            "ollamaModel",
            "lmstudioUrl",
            "lmstudioModel",
            "commandJson",
            "ollamaInputTokenReserve",
          ] as const,
        },
        api: {
          type: "object",
          title: "외부 API",
          description:
            "로컬 또는 서버 어디서든 사용할 수 있는 OCR/VLM API 설정. API key 는 secret 파일로 분리 저장된다.",
          properties: {
            provider: {
              type: "string",
              title: "API 업체",
              description:
                "anthropic·openai·google·openai_compatible=쪽 그림을 AI 에 보내 읽음, http_file_api=문서 파일을 업로드하고 Markdown 응답을 받음.",
              default: "http_file_api",
              enum: DOCUMENT_OCR_API_PROVIDERS,
              "x-ui": { widget: "select" },
            },
            ...documentOcrApiProviderFields,
            endpointUrl: {
              type: "string",
              title: "파일 업로드 API 주소",
              description:
                "파일 업로드 API(http_file_api) 전용 주소. 서버가 문서 파일을 여기에 올린다. 비워두면 실행 시 명시 오류.",
              default: "",
              format: "uri",
            },
            model: {
              type: "string",
              title: "파일 업로드 API 모델",
              description:
                "파일 업로드 API 전용 모델 이름. 비워 두면 업체 기본값을 쓴다.",
              default: "",
            },
            apiKey: {
              type: "string",
              title: "파일 업로드 API 키",
              description:
                "파일 업로드 API 전용 인증 키. settings JSON 에 평문 저장하지 않고 secret 파일에 보관한다.",
              default: "",
              "x-ui": { widget: "password" },
            },
            responseFormat: {
              type: "string",
              title: "응답 형식",
              description:
                "파일 업로드 API 전용. markdown=응답 본문을 Markdown 으로 사용, json_markdown=JSON 의 markdown 필드를 사용.",
              default: "markdown",
              enum: ["markdown", "json_markdown"] as const,
              "x-ui": { widget: "select" },
            },
          },
          required: [
            "provider",
            "anthropicApiKey",
            "anthropicModel",
            "gptApiKey",
            "gptModel",
            "geminiApiKey",
            "geminiModel",
            "openaiBaseUrl",
            "openaiModel",
            "openaiApiKey",
            "endpointUrl",
            "model",
            "apiKey",
            "responseFormat",
          ] as const,
        },
        pcCompanion: {
          type: "object",
          title: "PC companion",
          description:
            "서버 바라시스템의 문서 작업을 PC 데이터 정리 프로그램/companion 이 pull 해서 처리하는 설정.",
          properties: {
            workerId: {
              type: "string",
              title: "Worker ID",
              description:
                "PC companion 이 claim 할 때 쓰는 식별자. 여러 PC를 돌리면 서로 다르게 둔다.",
              default: "pc-ocr",
            },
            pollSeconds: {
              type: "integer",
              title: "Poll 주기(초)",
              description:
                "작업이 없을 때 PC companion 이 다시 확인할 간격. default 30.",
              default: 30,
              minimum: 1,
              maximum: 3600,
            },
            commandSource: {
              type: "string",
              title: "명령 출처",
              description:
                "local=PC 환경변수/인자 명령만 사용, server=서버 설정 commandJson 을 내려줄 수 있음. PC 쪽 명시 opt-in 이 있어야 실행된다.",
              default: "local",
              enum: ["local", "server"] as const,
              "x-ui": { widget: "select" },
            },
            commandJson: {
              type: "string",
              title: "서버 제공 명령 JSON",
              description:
                "commandSource=server 일 때 내려줄 argv JSON 배열. PC companion 은 별도 opt-in 없이는 실행하지 않는다.",
              default: "",
            },
            allowedStatuses: {
              type: "array",
              title: "자동 처리 상태",
              description:
                "PC companion 이 자동으로 가져갈 parse 상태. 암호 문서는 자동 처리하지 않는다.",
              default: ["needs_ocr", "parse_failed", "ocr_failed"],
              items: {
                type: "string",
                enum: ["needs_ocr", "parse_failed", "ocr_failed"] as const,
              },
              "x-ui": { widget: "multi-select" },
            },
          },
          required: [
            "workerId",
            "pollSeconds",
            "commandSource",
            "commandJson",
            "allowedStatuses",
          ] as const,
        },
      },
      required: [
        "mode",
        "resourceProfile",
        "maxOutputTokensPerPage",
        "pageImage",
        "schedule",
        "reliability",
        "local",
        "api",
        "pcCompanion",
      ] as const,
    },
  },
  required: ["ocr"] as const,
} as const satisfies GroupSchema;
