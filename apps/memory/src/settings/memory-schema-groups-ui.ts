import type { GroupSchema } from "./memory-schema-types.ts";

export const uiGroup = {
  type: "object",
  title: "화면",
  description: "대시보드와 그래프처럼 브라우저 화면의 기본 동작을 정한다.",
  properties: {
    startPage: {
      type: "string",
      title: "첫 화면",
      description:
        "/ 또는 /web/index.html 로 들어왔을 때 처음 열 화면. 대시보드는 /web/dashboard.html 로 직접 열 수 있다.",
      default: "dashboard",
      enum: ["dashboard", "graph"] as const,
      "x-ui": { widget: "select" },
    },
  },
  required: ["startPage"] as const,
} as const satisfies GroupSchema;
