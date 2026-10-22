/**
 * mcp/tools-capture.ts — 대화 중 능동 저장 4종 (spec 5.2).
 * 즉시 저장(검토 큐 미경유 — 사용자 결정). 1차 방어선 = description 호출 시점 지침
 * (descriptions.ts), 2차 방어선 = 분류 태그(한글 4단어, D-2)로 대시보드 골라보기·삭제.
 * 저장 경로는 store_memory 와 같은 saveTextInput — 청크·regex atomic·immediate 추출
 * 등 기존 저장 규칙을 그대로 탄다. 태그는 hashtags 인자(원본 노드 metadata.tags).
 *
 * REST 재노출 원칙(T4 fix 선례, tools-memory.ts store_memory) — 저장 성공 경로는
 * REST 저장(memories-crud.ts)과 같은 조건·같은 이벤트로 GRAPH_CHANGED 를 emit 한다.
 * author 는 requireAdapterId(ctx) 로만 기록한다 — 자기신고 author 입력 칸 없음.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { saveSharedMemoryInput, memoryEvidenceSchema, MemoryEvidenceError } from "../server-internal/shared-memory-write.ts";
import { canUseMcpTool } from "./access.ts";
import { readMemoryVisibility } from "../memory/shared-memory-read.ts";
import { applyWriteGuard, SecretDetectedError } from "../server-internal/write-guard/write-guard.ts";
import { PreparedExtractionMismatchError } from "../server-internal/save-input.ts";
import { DuplicateMemoryError } from "../server-internal/write-guard/duplicate-check.ts";
import { EVENT_TYPES } from "../server-internal/event-bus.ts";
import { notifyMemoSaved } from "../server-internal/memo-saved-cleanup.ts";
import type { MemoryType } from "../memory/types.ts";
import { PROFILE_FACETS } from "../server-internal/profile.ts";
import { TOOL_DESCRIPTIONS } from "./descriptions.ts";
import { TOOL_ANNOTATIONS } from "./annotations.ts";
import {
  hashtagWarningDetails, hashtagWarningFields, prepareHashtagCheck, projectPlanForSave,
} from "./hashtag-warning-fields.ts";
import {
  MCP_SOURCE,
  requireAdapterId,
  toolError,
  toolJson,
  type McpToolContext,
} from "./server.ts";

/**
 * 도구 이름 → 분류 태그(D-2 한글 확정) + memoryType 매핑(spec 5.2 표) 단일 출처.
 * 태그 4종은 memory/context-assembler.ts 의 CAPTURE_TAG_SET 과 같은 어휘여야 한다 —
 * 그쪽이 이 태그를 읽어 [관련 기억] 표지의 <유형> 칸을 채운다. 역import 금지 규칙
 * (memory 층은 mcp 층을 참조하지 않는다) 때문에 값이 양쪽에 따로 적혀 있고, 어긋남은
 * mcp/server.test.ts 의 동기 감시 테스트가 잡는다.
 */
export const CAPTURE_TOOLS = [
  { name: "save_decision", tag: "결정", memoryType: "fact", duplicateCheck: true },
  { name: "save_idea", tag: "아이디어", memoryType: "insight", duplicateCheck: true },
  { name: "save_question", tag: "질문", memoryType: undefined, duplicateCheck: true },
  // save_preference 는 유사-중복 검사에서 제외한다(T16 결정 D-A 확정 — 도구
  // 단위 면제는 이 한 종뿐). 선호는 같은 취향을 여러 번, 조금씩 다른 말로
  // 반복해서 말하는 것 자체가 신호다 — "이거 싫다고 했잖아"가 세 번 나오면
  // 그 세 번이 강도를 뜻한다. 중복이라고 막으면 그 반복 신호가 통째로 사라져,
  // 마지막 한 번만 남고 "얼마나 강하게 원하는가"를 잃는다. 나머지 3종(결정·
  // 아이디어·질문)은 같은 내용의 반복이 신호가 아니라 잡음이라 검사 대상이다.
  { name: "save_preference", tag: "선호", memoryType: "preference", duplicateCheck: false },
] as const satisfies ReadonlyArray<{
  name: keyof typeof TOOL_DESCRIPTIONS;
  tag: string;
  memoryType: MemoryType | undefined;
  /** 유사-중복 검사 적용 여부. false = 그 도구의 저장 경로는 KNN 검사를 아예 안 돈다. */
  duplicateCheck: boolean;
}>;

export function registerCaptureTools(server: McpServer, ctx: McpToolContext): void {
  const { deps } = ctx;
  for (const tool of CAPTURE_TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: TOOL_DESCRIPTIONS[tool.name],
        annotations: TOOL_ANNOTATIONS[tool.name],
        inputSchema: {
          content: z.string().min(1),
          project: z.string().optional(),
          evidence: memoryEvidenceSchema.optional(),
          // force 칸은 검사를 도는 3종에만 노출한다 — save_preference 는 검사
          // 자체를 안 돌아 우회할 것이 없으므로 칸을 두면 거짓 손잡이가 된다.
          ...(tool.duplicateCheck ? { force: z.boolean().optional().describe("true only to override a DUPLICATE refusal for a genuinely distinct memory.") } : {}),
          // T25(spec H) — facet 은 save_preference 한 종에만 노출한다(닫힌 zod
          // enum — get_profile 조회 입력과 같은 PROFILE_FACETS 단일 출처를 공유).
          // 나머지 3종은 preference 트랙이 아니므로 이 칸을 둘 이유가 없다.
          ...(tool.name === "save_preference" ? { facet: z.enum(PROFILE_FACETS).optional().describe(`Preference category (${PROFILE_FACETS.join(" | ")}). Set it when the category is clear; omit it when unsure.`) } : {}),
        },
      },
      async (args) => {
        if (!canUseMcpTool(ctx.scope, tool.name)) return toolError("FORBIDDEN", `${tool.name} is not allowed by this token`);
        try {
          const adapterId = requireAdapterId(ctx);
          const settings = deps.getSettings?.();
          const facet = (args as { facet?: (typeof PROFILE_FACETS)[number] }).facet;
          // 해시태그 경고는 저장 경로와 같은 관문을 지난 글로 본다(비밀값이면 저장과 같은 오류로 끝난다).
          const hashtagCheck = await prepareHashtagCheck(deps.store, applyWriteGuard(args.content, settings?.writeGuard), args.project);
          const saved = await saveSharedMemoryInput(deps.store, {
            content: args.content,
            source: MCP_SOURCE,
            author: adapterId,
            memoryType: tool.memoryType,
            hashtags: [tool.tag],
            projectId: args.project ?? null,
            // T25(spec H) — facet 이 metadata.facet 으로 저장돼야 get_profile 이
            // 그 값을 읽어 닫힌 facet 아래 묶는다. save_preference 외 도구는
            // facet 이 항상 undefined 라 extraMetadata 자체가 안 실린다.
            extraMetadata: facet !== undefined ? { facet } : undefined,
            chunking: settings?.chunking
              ? {
                  tokenCap: settings.chunking.tokenCap,
                  minChunkTokens: settings.chunking.minChunkTokens,
                }
              : undefined,
            extractor: deps.extractor,
            extractorSettings: settings?.llm.extractor,
            regexL0: deps.regexL0,
            regexEnabled: settings?.extractor?.regex?.enabled === true,
            trigger: deps.autoCleanupTrigger,
            // T15(결정 D-C) — 저장 관문 토글. 능동 저장 4종도 예외 없이 같은
            // 관문을 지난다(도구별 면제 없음). 미주입이면 관문이 가동(fail-safe).
            writeGuard: settings?.writeGuard,
            // T16(결정 D-A) — 유사-중복 검사. save_preference 만 도구 단위로
            // 제외한다(enabled:false — 반복 자체가 신호라 보존, CAPTURE_TOOLS
            // 주석 참조). 나머지 3종은 설정값을 그대로 따르고 force 로 우회 가능.
            duplicateCheck: tool.duplicateCheck
              ? settings?.writeGuard?.duplicateCheck
              : { enabled: false },
            force: (args as { force?: boolean }).force === true,
          }, args.evidence, projectPlanForSave(hashtagCheck));
          if (saved.kind !== "memory" || saved.originNodeId === null) {
            // 글 기억이 안 생긴 까닭(예: 쉼표가 빠져 본문이 태그 값에 먹힘)을 경고가 말해 주면 함께 싣는다.
            return toolError(
              "INTERNAL",
              `${tool.name} 저장 실패: 글 저장 경로가 memory 노드를 만들지 못했다 (kind=${saved.kind})`,
              hashtagWarningDetails(hashtagCheck, saved.kind),
            );
          }
          deps.autoCleanupTrigger?.emit("external-sdk-write");
          notifyMemoSaved(deps, saved);
          // memories-crud.ts 저장 성공 경로와 같은 조건·같은 이벤트(T4 fix 선례) —
          // 능동 저장 4종도 REST 저장과 똑같이 대시보드 라이브 그래프를 갱신시킨다.
          deps.eventBus?.emit(EVENT_TYPES.GRAPH_CHANGED, { reason: "memory-added" });
          const visible = readMemoryVisibility(deps.store).allowedIds;
          return toolJson({
            id: saved.originNodeId, tag: tool.tag, current: visible === undefined || visible.has(saved.originNodeId),
            ...hashtagWarningFields(hashtagCheck, "memory"),
          });
        } catch (e) {
          if (e instanceof MemoryEvidenceError) return toolError(e.code, e.message, e.details);
          // WP-B1-08 — 준비한 즉시 추출 결과를 쓸 수 없게 된 요청(아무것도 저장 안 함) — REST 409 와 같은
          // CONFLICT code 와 재전송 안내 메시지.
          if (e instanceof PreparedExtractionMismatchError) return toolError(e.code, e.message);
          // T15 — 비밀값 거부는 보낸 본문 문제라 SECRET_DETECTED 로 구분해 회신.
          if (e instanceof SecretDetectedError) {
            const payload = e.toPayload();
            return toolError(payload.code, payload.message, payload.details);
          }
          // T16 — 유사-중복 거부(REST 409 와 같은 봉투). save_preference 는
          // 검사를 안 돌아 이 갈래로 오지 않는다.
          if (e instanceof DuplicateMemoryError) {
            const payload = e.toPayload();
            return toolError(payload.code, payload.message, payload.details);
          }
          return toolError(
            "INTERNAL",
            `${tool.name} 저장 실패: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      },
    );
  }
}
