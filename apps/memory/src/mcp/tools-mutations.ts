import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  updateSharedMemory, retractSharedMemory, supersedeSharedMemory, SharedMemoryMutationError,
} from "../memory/shared-memory-mutations.ts";
import { extractHashtagTokens, hasHashtagSyntax } from "../memory/tag-extractor.ts";
import { applyWriteGuard, SecretDetectedError } from "../server-internal/write-guard/write-guard.ts";
import {
  contentWithPreservedTags, UNEDITABLE_SOURCE_TYPES, rewireEditedNodeContent,
} from "../server-internal/routes/memories-shared.ts";
import { EVENT_TYPES } from "../server-internal/event-bus.ts";
import { TOOL_DESCRIPTIONS } from "./descriptions.ts";
import { TOOL_ANNOTATIONS } from "./annotations.ts";
import { canUseMcpTool } from "./access.ts";
import { withMemoryMutationLock } from "../memory/shared-memory-mutation-lock.ts";
import { requireAdapterId, toolError, toolJson, type McpToolContext } from "./server.ts";

const mutationInput = {
  id: z.number().int().positive(), expectedRevision: z.number().int().nonnegative(),
  requestId: z.string().trim().min(1).max(200), reason: z.string().max(2000).optional(),
};

export function registerMutationTools(server: McpServer, ctx: McpToolContext): void {
  for (const name of ["update_memory", "retract_memory", "supersede_memory"] as const) {
    server.registerTool(name, {
      description: TOOL_DESCRIPTIONS[name], annotations: TOOL_ANNOTATIONS[name],
      inputSchema: {
        ...mutationInput,
        ...(name === "update_memory" ? { content: z.string().trim().min(1) } : {}),
        ...(name === "supersede_memory" ? { replacementId: z.number().int().positive() } : {}),
      },
    }, async (args) => {
      if (!canUseMcpTool(ctx.scope, name)) return toolError("FORBIDDEN", `${name} is not allowed by this token`);
      return withMemoryMutationLock(ctx.deps.store, async () => {
      try {
        const { store } = ctx.deps;
        const common = {
          nodeId: args.id, expectedRevision: args.expectedRevision, requestId: args.requestId,
          actor: requireAdapterId(ctx), reason: args.reason === undefined ? undefined : applyWriteGuard(args.reason, ctx.deps.getSettings?.().writeGuard),
        };
        let outcome;
        let warnings: string[] = [];
        if (name === "update_memory") {
          const content = applyWriteGuard((args as { content: string }).content, ctx.deps.getSettings?.().writeGuard);
          if (hasHashtagSyntax(content)) return toolError("INVALID_INPUT", "Edit the body without hashtags; existing tags are preserved");
          const existing = await store.getNode(args.id);
          if (!existing) return toolError("NOT_FOUND", `memory ${args.id} not found`);
          if (UNEDITABLE_SOURCE_TYPES.has(existing.sourceType)) {
            return toolError("INVALID_INPUT", "Edit a text memory; binary/document assets are not directly editable");
          }
          outcome = await updateSharedMemory(store, {
            ...common, content: contentWithPreservedTags(content, extractHashtagTokens(existing.content)),
          });
          if (!outcome.replayed) warnings = await rewireEditedNodeContent(store, ctx.deps, args.id, outcome.node.content);
        } else if (name === "supersede_memory") {
          outcome = await supersedeSharedMemory(store, { ...common, replacementId: (args as { replacementId: number }).replacementId });
        } else {
          outcome = await retractSharedMemory(store, common);
        }
        if (!outcome.replayed) ctx.deps.eventBus?.emit(EVENT_TYPES.GRAPH_CHANGED, { reason: "memory-edited", nodeId: args.id });
        return toolJson({ ...outcome, warnings });
      } catch (e) {
        if (e instanceof SharedMemoryMutationError) return toolError(e.code, e.message, {
          ...(e.currentRevision !== undefined ? { currentRevision: e.currentRevision } : {}),
          ...(e.nodeId !== undefined ? { nodeId: e.nodeId } : {}),
        });
        if (e instanceof SecretDetectedError) {
          const payload = e.toPayload();
          return toolError(payload.code, payload.message, payload.details);
        }
        return toolError("INTERNAL", `Memory mutation failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      });
    });
  }
}
