/**
 * memory-schema-groups-entity-register.ts — 항목·일정 자동 등록(2026-10-10 spec)의 설정 스키마 조각.
 *
 * memory-schema-groups-pipeline.ts 가 이미 800줄을 넘어(1073줄) 새 블록은 이 파일에 두고
 * 그쪽은 끼우기만 한다. 사용자에게 보이는 제목·설명은 이 스키마가 단일 출처다.
 */
import { ENTITY_REGISTER_BATCH_SIZE_MAX } from "../memory/cleanup-deep-pass/stage-constants";

export const cleanupTriggerSchema = {
  type: "string",
  enum: ["interval", "on_save"],
  title: "정리 시점",
  description:
    "interval = 정리 주기(일)마다. on_save = 그에 더해 메모를 저장한 직후 그 메모 하나를 항목·일정 자동 등록과 사람 연결 단계로 정리한다. 정규식 강화·요약은 계속 주기대로 돈다.",
  default: "interval",
} as const;

export const entityRegisterSchemaBlock = {
  type: "object",
  title: "항목·일정 자동 등록 손잡이",
  description:
    "태그 없는 메모에서 정리 AI 가 찾은 사람·장소·작품 등 항목과 일정을 등록한다. 확실한 것은 코드 검사로 바로 반영하고 애매한 것은 정리 제안으로 보낸다.",
  properties: {
    enabled: {
      type: "boolean",
      title: "항목·일정 자동 등록 단계 가동",
      description: "정리 AI 스위치와 함께 켜진다. 가동 슬롯(llm.cleanup.enabled)과 함께 켜져야 돈다.",
      default: false,
    },
    autoApply: {
      type: "boolean",
      title: "확실한 것은 바로 반영",
      description: "false 면 기존 항목 연결·새 항목·확실한 일정도 전부 정리 제안으로 보낸다.",
      default: true,
    },
    batchSize: {
      type: "integer",
      title: "한 번에 보낼 메모 수",
      description: `한 호출에 함께 보내는 메모 수. 잠정 10 — 평가로 확정한다. 최대 ${ENTITY_REGISTER_BATCH_SIZE_MAX}개: 그보다 크면 첫 호출부터 출력 한도 상한에 닿아 잘림이 나도 메모 하나씩 다시 보내는 수밖에 없다.`,
      default: 10,
      minimum: 1,
      maximum: ENTITY_REGISTER_BATCH_SIZE_MAX,
    },
  },
  required: ["enabled", "autoApply", "batchSize"] as const,
} as const;

export const entityRegisterAllocationSchema = {
  type: "number",
  title: "항목·일정 자동 등록 배분",
  description: "항목·일정 자동 등록 단계 예산 비율. 기본 0.2(2026-10-10 사용자 결정).",
  default: 0.2,
  minimum: 0,
  maximum: 1,
} as const;
