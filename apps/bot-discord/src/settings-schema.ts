/**
 * 디스코드 봇 어댑터 설정 JSON Schema (Phase 5.7.1 / W2 정합).
 *
 * spec section 5 약속 — 메모리 코어가 이 schema 를 읽어 설정 폼을 자동
 * 렌더한다. schema 정의 + 디폴트 + 단위 검증 helper 한 벌로 구성.
 *
 * Phase 5.7.1 W2 정리: 옛 12 칸 → 8 칸 (autoExtract / activeMode /
 * ollamaUrl / ollamaModel 4 칸 삭제). autoExtract 갈래는 5.7.2 single-path
 * 정착 시점에 코드 흐름까지 제거. activeMode + ollama* 는 Phase 10 능동 모드
 * 재 신설 시점까지 보류.
 *
 * 권위: docs/decisions/2026-05-21-phase5.7.1-settings-reorg-spec.md section 2.5/2.6 +
 *       docs/decisions/2026-05-21-phase5.7.1-settings-reorg-plan.md section 3
 */

// ─────────────────────────────────────────────────────────────────────────────
// 타입 — schema 정합
// ─────────────────────────────────────────────────────────────────────────────

/** UI 위젯 힌트 (memory-schema.ts 패턴 정합). */
type UiWidgetHint =
  | { widget: "password" }
  | {
      widget: "dynamic-enum";
      actionId: string;
      labelField: string;
      valueField: string;
    };

/** 한 필드의 schema 항목. */
interface FieldSchema {
  type: "string" | "number" | "integer" | "boolean" | "array";
  title: string;
  description: string;
  default?: unknown;
  pattern?: string;
  format?: "uri";
  minimum?: number;
  maximum?: number;
  items?: {
    type: "string";
    "x-ui"?: {
      widget: "dynamic-enum";
      actionId: string;
      labelField: string;
      valueField: string;
    };
  };
  "x-ui"?: UiWidgetHint;
}

/**
 * 봇 어댑터 설정 본체 (Phase 5.7.1 W2 정합, 8 필드).
 *
 * 옛 4 필드 (autoExtract / activeMode / ollamaUrl / ollamaModel) 삭제.
 * Phase 5.7.2 single-path + Phase 10 능동 모드 신규 시점에 재 검토.
 */
export interface BotSettings {
  discordToken: string;
  ownerId: string;
  applicationId: string;
  guildId: string;
  memoryApiUrl: string;
  activeChannels: string[];
  evolverNotify: boolean;
  evolverPollIntervalMin: number;
  sseReconnectDelayMs: number;
  scheduleRemindersEnabled: boolean;
  scheduleReminderPollIntervalMin: number;
  scheduleReminderDateOnlyTime: string;
}

/** 마스킹 출력 메타. */
export type BotSettingsWithMask = BotSettings & { $masked?: string[] };

/** 검증 결과. */
export interface BotValidationResult {
  ok: boolean;
  errors: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON Schema (Draft 2020-12)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 디스코드 봇 어댑터 설정 schema (Phase 5.7.1 W2 정합, 8 필드).
 *
 * 옛 process.env.DISCORD_APPLICATION_ID / DISCORD_GUILD_ID / MEMORY_API_URL
 * 모두 settings 로 이전 완료. autoExtract / activeMode / ollamaUrl /
 * ollamaModel 4 칸 = 5.7.1 W2 단계에서 삭제.
 * password 마스킹 = discordToken / dynamic-enum = activeChannels item.
 */
export const botSettingsSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  title: "디스코드 봇 설정",
  description:
    "디스코드 봇 어댑터의 설정 항목. 옛 process.env.* (DISCORD_*) 대체.",
  properties: {
    applicationId: {
      type: "string",
      title: "디스코드 애플리케이션 ID",
      description:
        "Discord Developer Portal 의 애플리케이션 ID (숫자 전용). 슬래시 커맨드 등록 시 필수. 미입력 시 슬래시 등록을 건너뜀.",
      default: "",
      pattern: "^\\d*$",
    },
    discordToken: {
      type: "string",
      title: "디스코드 봇 토큰",
      description:
        "Discord Developer Portal 에서 발급한 봇 토큰. 이 값은 패스워드 위젯으로 마스킹된다.",
      default: "",
      "x-ui": { widget: "password" },
    },
    ownerId: {
      type: "string",
      title: "디스코드 사용자 ID",
      description:
        "본인 디스코드 사용자 ID (숫자 전용). 봇이 이 ID 외 사용자는 무시한다.",
      default: "",
      pattern: "^\\d+$",
    },
    guildId: {
      type: "string",
      title: "디스코드 길드(서버) ID",
      description:
        "슬래시 커맨드를 등록할 길드(서버) ID (숫자 전용). 입력 시 길드 한정 등록 (즉시 반영). 미입력 시 글로벌 등록 (최대 1시간 지연).",
      default: "",
      pattern: "^\\d*$",
    },
    memoryApiUrl: {
      type: "string",
      title: "메모리 API 주소",
      description:
        "메모리 코어 HTTP API 엔드포인트. 봇이 메모리를 저장·조회할 때 이 주소를 사용한다.",
      default: "http://127.0.0.1:3001",
      format: "uri",
    },
    activeChannels: {
      type: "array",
      title: "활성 채널 목록",
      description:
        "봇이 활동할 디스코드 채널 id 목록. list-channels 액션이 후보를 자동 채운다.",
      default: [],
      items: {
        type: "string",
        "x-ui": {
          widget: "dynamic-enum",
          actionId: "list-channels",
          labelField: "name",
          valueField: "id",
        },
      },
    },
    evolverNotify: {
      type: "boolean",
      title: "메모리 정리 사이클 알림 받기",
      description:
        "메모리 정리 사이클(evolver — 자동 청소·재구성) 결과 요약을 DM 으로 받을지 여부. 디폴트 false (옵트인).",
      default: false,
    },
    evolverPollIntervalMin: {
      type: "integer",
      title: "정리 결과 알림 확인 주기 (분)",
      description:
        "메모리 자동 정리가 끝났는지 몇 분마다 확인할지 (현재는 폴링 흐름 — Phase 7.4 정착 시 메모리가 직접 알림 push). 보통 그대로 두면 됨.",
      default: 60,
      minimum: 1,
    },
    sseReconnectDelayMs: {
      type: "integer",
      title: "정리 제안 알림 재연결 대기 (밀리초)",
      description:
        "메모리가 보내는 정리 제안 알림 줄이 끊겼을 때 몇 밀리초 뒤 다시 연결할지. 보통 그대로 두면 됨 (기본 3초).",
      default: 3000,
      minimum: 100,
    },
    scheduleRemindersEnabled: {
      type: "boolean",
      title: "일정 알림 받기",
      description:
        "메모리 일정 후보를 봇이 주기적으로 읽어 하루 전과, 시각이 있는 일정은 2시간 전에 DM 으로 알린다.",
      default: false,
    },
    scheduleReminderPollIntervalMin: {
      type: "integer",
      title: "일정 알림 확인 주기 (분)",
      description:
        "디스코드 봇이 메모리 일정 후보를 몇 분마다 확인할지. 알림 중복은 봇 로컬 장부로 막는다.",
      default: 5,
      minimum: 1,
    },
    scheduleReminderDateOnlyTime: {
      type: "string",
      title: "날짜만 있는 일정의 하루 전 알림 시각",
      description:
        "시각이 없는 일정의 하루 전 알림을 보낼 로컬 시각(HH:MM). 시각이 있는 일정은 일정 시각 기준 하루 전과 2시간 전을 쓴다.",
      default: "09:00",
      pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
    },
  },
  required: ["discordToken", "ownerId"] as const,
  /**
   * evolverNotify=true 일 때만 evolverPollIntervalMin 노출 (spec section 5
   * dependentSchemas 약속). 폼 렌더러가 이 약속을 읽어 조건부 표시.
   */
  dependentSchemas: {
    evolverNotify: {
      if: {
        properties: { evolverNotify: { const: true } },
        required: ["evolverNotify"],
      },
      then: {
        required: ["evolverPollIntervalMin"],
      },
    },
    scheduleRemindersEnabled: {
      if: {
        properties: { scheduleRemindersEnabled: { const: true } },
        required: ["scheduleRemindersEnabled"],
      },
      then: {
        required: [
          "scheduleReminderPollIntervalMin",
          "scheduleReminderDateOnlyTime",
        ],
      },
    },
  },
} as const satisfies {
  $schema: string;
  type: "object";
  title: string;
  description: string;
  properties: Record<string, FieldSchema>;
  required: readonly string[];
  dependentSchemas: Record<
    string,
    {
      if?: {
        properties?: Record<string, { const?: unknown; type?: string }>;
        required?: readonly string[];
      };
      then?: {
        properties?: Record<string, FieldSchema>;
        required?: readonly string[];
      };
      else?: {
        properties?: Record<string, FieldSchema>;
        required?: readonly string[];
      };
    }
  >;
};

/** schema 의 default 값만 추출한 plain object (Phase 5.7.1 W2 정합, 8 필드). */
export const BOT_DEFAULTS: BotSettings = {
  discordToken: "",
  ownerId: "",
  applicationId: "",
  guildId: "",
  memoryApiUrl: "http://127.0.0.1:3001",
  activeChannels: [],
  evolverNotify: false,
  evolverPollIntervalMin: 60,
  sseReconnectDelayMs: 3000,
  scheduleRemindersEnabled: false,
  scheduleReminderPollIntervalMin: 5,
  scheduleReminderDateOnlyTime: "09:00",
};

/** 패스워드 위젯이 박힌 필드의 키 목록 (마스킹 helper 가 활용). */
export const BOT_PASSWORD_FIELDS = ["discordToken"] as const;

/** schema 의 최상위 필드 키 목록 (Phase 5.7.1 W2 정합, 8 항목). */
export const BOT_FIELD_KEYS = [
  "discordToken",
  "ownerId",
  "applicationId",
  "guildId",
  "memoryApiUrl",
  "activeChannels",
  "evolverNotify",
  "evolverPollIntervalMin",
  "sseReconnectDelayMs",
  "scheduleRemindersEnabled",
  "scheduleReminderPollIntervalMin",
  "scheduleReminderDateOnlyTime",
] as const;

export type BotFieldKey = (typeof BOT_FIELD_KEYS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// helper — defaults / validate / mask
// ─────────────────────────────────────────────────────────────────────────────

/** 디폴트 값 deep clone 반환 (호출자가 안전히 수정 가능). */
export function getBotDefaults(): BotSettings {
  return structuredClone(BOT_DEFAULTS);
}

/**
 * loopback host 판별 (D4). memoryApiUrl scheme 제약이 "이 주소가 같은 PC 인가"를
 * 가리는 데 쓴다. 코어 auth-gate.ts 의 isLoopback(주소 문자열 판정)과 목적은 같다.
 *
 * URL.hostname 을 받는데, IPv6 는 WHATWG URL 규격상 대괄호를 유지한 `[::1]` 로
 * 온다(예: `new URL("http://[::1]:3001").hostname === "[::1]"`). 그래서 대괄호
 * 유무 두 형태를 모두 인정한다.
 */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/**
 * memoryApiUrl 의 scheme 제약을 검증한다 (D4, 순수 함수).
 *
 * - loopback host(127.0.0.1 / localhost / ::1) → http·https 둘 다 허용.
 * - 비-loopback host → https 만 허용. 평문 http 로 원격 코어에 붙으면 기억이
 *   네트워크에 평문 노출되므로 막는다.
 *
 * 반환값: 위반이면 에러 문자열, 통과면 null. URL 파싱 실패는 여기서 다루지
 * 않는다 — 이미 schema 의 format:uri 검증(validateField)이 그 케이스를 잡으므로
 * 중복 에러를 내지 않게 파싱 실패는 조용히 통과시킨다(같은 값에 두 에러 회피).
 */
export function validateMemoryApiUrlScheme(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // format:uri 검증이 이 케이스를 잡는다 — 여기서 중복 에러 내지 않는다.
    return null;
  }
  const scheme = parsed.protocol;
  if (scheme !== "http:" && scheme !== "https:") {
    return "memoryApiUrl: http 또는 https 주소만 허용됩니다";
  }
  if (scheme === "http:" && !isLoopbackHost(parsed.hostname)) {
    return "memoryApiUrl: 비-loopback 주소는 https 만 허용됩니다 (평문 http 는 기억 유출 위험)";
  }
  return null;
}

/**
 * BotSettings 후보 unknown 을 schema 와 대조해 검증.
 * type / required / pattern / format(uri) / minimum / array items 다룸.
 * memory-settings 와 같은 톤 — 외부 ajv 미사용.
 */
export function validateBotSettings(value: unknown): BotValidationResult {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return { ok: false, errors: ["root: 객체 필요"] };
  }
  const root = value as Record<string, unknown>;

  // required
  for (const key of botSettingsSchema.required) {
    if (!(key in root)) {
      errors.push(`${key}: 필수 필드 누락`);
    }
  }

  // 필드별 검증
  for (const [fieldKey, fieldValue] of Object.entries(root)) {
    const fieldSchema = (
      botSettingsSchema.properties as Record<string, FieldSchema | undefined>
    )[fieldKey];
    if (!fieldSchema) continue;
    validateField(fieldKey, fieldValue, fieldSchema, errors);
  }

  // memoryApiUrl scheme 제약 (D4) — 비어있지 않은 문자열일 때만 검사.
  // format:uri 가 이미 파싱 가능성을 검증하므로, 여기선 scheme·host 정책만 본다.
  if (typeof root.memoryApiUrl === "string" && root.memoryApiUrl.length > 0) {
    const schemeError = validateMemoryApiUrlScheme(root.memoryApiUrl);
    if (schemeError !== null) {
      errors.push(schemeError);
    }
  }

  // evolverNotify=true → evolverPollIntervalMin 필수 (dependentSchemas 효과)
  if (root.evolverNotify === true) {
    if (typeof root.evolverPollIntervalMin !== "number") {
      errors.push(
        "evolverPollIntervalMin: evolverNotify=true 일 때 필수 (number)",
      );
    }
  }

  if (root.scheduleRemindersEnabled === true) {
    if (typeof root.scheduleReminderPollIntervalMin !== "number") {
      errors.push(
        "scheduleReminderPollIntervalMin: scheduleRemindersEnabled=true 일 때 필수 (number)",
      );
    }
    if (typeof root.scheduleReminderDateOnlyTime !== "string") {
      errors.push(
        "scheduleReminderDateOnlyTime: scheduleRemindersEnabled=true 일 때 필수 (string)",
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateField(
  path: string,
  value: unknown,
  schema: FieldSchema,
  errors: string[],
): void {
  // type
  if (schema.type === "string" && typeof value !== "string") {
    errors.push(`${path}: string 필요`);
    return;
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    errors.push(`${path}: boolean 필요`);
    return;
  }
  if (
    (schema.type === "number" || schema.type === "integer") &&
    typeof value !== "number"
  ) {
    errors.push(`${path}: number 필요`);
    return;
  }
  if (schema.type === "integer" && !Number.isInteger(value as number)) {
    errors.push(`${path}: integer 필요`);
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path}: 배열 필요`);
      return;
    }
    if (schema.items?.type === "string") {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] !== "string") {
          errors.push(`${path}[${i}]: string 필요`);
        }
      }
    }
    return;
  }
  // pattern
  if (schema.pattern && typeof value === "string" && value.length > 0) {
    if (!new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: 정규식 ${schema.pattern} 와 미일치`);
    }
  }
  // format: uri
  if (schema.format === "uri" && typeof value === "string" && value.length > 0) {
    try {
      new URL(value);
    } catch {
      errors.push(`${path}: uri 형식 불일치`);
    }
  }
  // minimum / maximum
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: ${schema.minimum} 이상 필요`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: ${schema.maximum} 이하 필요`);
    }
  }
}

/**
 * 패스워드 필드를 빈 문자열로 가리고 `$masked` 메타를 첨부 (spec section 5.3).
 */
export function maskBotSecrets(settings: BotSettings): BotSettingsWithMask {
  const cloned = structuredClone(settings);
  const masked: string[] = [];
  for (const key of BOT_PASSWORD_FIELDS) {
    if (typeof cloned[key] === "string") {
      cloned[key] = "";
      masked.push(key);
    }
  }
  return { ...cloned, $masked: masked };
}
