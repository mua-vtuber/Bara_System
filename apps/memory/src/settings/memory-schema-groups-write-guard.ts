/**
 * memory-schema-groups-write-guard.ts — 저장 관문 그룹 schema (T15 / 결정 D-C).
 *
 * 사용자 글이 DB 로 들어가기 직전 거치는 관문의 손잡이. 두 칸이고 둘 다
 * default ON 이다 — 비밀값 저장은 되돌리기 어려운 사고이고(secretRejection),
 * 같은 사실이 문장만 바뀐 채 쌓이는 것도 시간이 지날수록 걷어내기 어렵다
 * (duplicateCheck / T16 결정 D-A). 끄는 선택은 사용자가 명시적으로 해야 한다.
 */

import type { GroupSchema } from "./memory-schema-types.ts";

export const writeGuardGroup = {
  type: "object",
  title: "저장 관문",
  description:
    "기억을 저장하기 직전에 거치는 검사. 실수로 들어온 비밀값이 DB 에 영구히 남는 것을 막는다.",
  properties: {
    secretRejection: {
      type: "boolean",
      title: "비밀값 저장 거부",
      description:
        "API 키·토큰·개인키처럼 보이는 문자열이 본문에 있으면 저장을 거부한다. 켜 두는 것을 권한다 — 한 번 저장된 비밀값은 청크·추출 자식·수정 이력까지 퍼져 지우기 어렵고, 이후 검색 결과로 다시 흘러나온다. 검사 결과에는 어떤 종류가 몇 글자 걸렸는지만 남고 값 자체는 어디에도 기록하지 않는다.",
      default: true,
    },
    duplicateCheck: {
      type: "object",
      title: "비슷한 기억 중복 저장 차단",
      description:
        "이미 있는 기억과 거의 같은 글이 다시 들어오면 저장을 막고 기존 기억을 알려준다. 글자가 완전히 같은 재입력은 이 검사 전에 흡수되므로 여기 걸리지 않는다 — 토씨만 바꿔 같은 사실을 다시 저장하는 경우가 대상이다. 막힌 쪽은 기존 기억을 고치거나, 그래도 따로 남기려면 force 를 켜서 다시 보낼 수 있다.",
      properties: {
        enabled: {
          type: "boolean",
          title: "중복 저장 차단 사용",
          description:
            "켜 두는 것을 권한다 — 같은 사실이 문장만 바뀐 채 여러 벌 쌓이면 검색 결과가 같은 내용으로 채워지고, 나중에 어느 것이 최신인지 가릴 수 없게 된다. 끄면 비슷한 글도 전부 따로 저장된다.",
          default: true,
        },
        threshold: {
          type: "number",
          title: "중복으로 볼 닮은 정도 (모델 연동)",
          description:
            "두 글의 닮은 정도가 이 값 이상이면 중복으로 보고 저장을 막는다. default -1 = 모델 연동 (bge-m3 0.89, 2026-08-03 실측 95쌍 확정 — 별개 기억을 잘못 막는 일이 0 이 되는 지점). 0~1 값을 직접 넣으면 그 값이 우선한다 (사용자 오버라이드). 낮추면 서로 다른 기억까지 막히고, 높이면 사실상 같은 글이 통과한다.",
          default: -1,
          minimum: -1,
          maximum: 1,
        },
      },
      required: ["enabled", "threshold"] as const,
    },
  },
  required: ["secretRejection", "duplicateCheck"] as const,
} as const satisfies GroupSchema;
