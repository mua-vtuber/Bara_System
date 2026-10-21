import { MEMORY_EDIT_ERROR_CODES, QUESTION_MAX_CHARS, type Answer, type Capture, type Memory, type RequestContext, type SaveInput, type SaveResult } from "../shared/contracts.ts";
import { AiClient } from "./ai.ts";
import { MemoryClient } from "./client.ts";
import { ConfigStore } from "./config.ts";
import { ServiceError } from "./errors.ts";
import { messages } from "../ui/messages.ts";
import { validateSaveInput, validateText } from "./validation.ts";

export function searchOnlyAnswer(memories: Memory[], audience?: string): Answer {
  return { text: memories.length ? messages.assistant.foundMemories : messages.assistant.noMemories, sources: memories, generated: false,
    outcome: memories.length ? "found" : "notFound", ...(audience ? { audience } : {}) };
}

/** The answer for a parsed model reply. No source id means the model found nothing in the memories that answers
 * the question: that is not an error, and its free text (possibly ungrounded) is not shown; a fixed message is. */
export function groundedAnswerResult(generated: { text: string; sourceIds: number[] }, memories: Memory[], audience?: string): Answer {
  const audienceField = audience ? { audience } : {};
  if (generated.sourceIds.length === 0) return { text: messages.assistant.noGroundedAnswer, sources: [], generated: false, outcome: "notFound", ...audienceField };
  const sourceIds = new Set(generated.sourceIds);
  return { text: generated.text, sources: memories.filter((memory) => sourceIds.has(memory.id)), generated: true, outcome: "found", ...audienceField };
}

export class Assistant {
  private readonly ai: AiClient;
  constructor(private readonly config: ConfigStore, private readonly client: MemoryClient) { this.ai = new AiClient(config); }

  async ask(question: string, ctx: RequestContext, expectedAudience?: string): Promise<Answer> {
    const query = validateText(question, messages.fieldLabels.question, QUESTION_MAX_CHARS);
    ctx.progress("search");
    const found = await this.client.search(query, ctx, expectedAudience);
    const memories = found.results.map((hit) => hit.memory);
    if (memories.length === 0) return searchOnlyAnswer([], found.audience);
    const settings = await this.config.load();
    if (settings.ai.provider === "none") return searchOnlyAnswer(memories, found.audience);
    ctx.progress("answer");
    try {
      const generated = await this.ai.answer(query, memories, ctx);
      return groundedAnswerResult(generated, memories, found.audience);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const code = error instanceof ServiceError ? error.code : undefined;
      return { text: messages.feedback.answerFailed(code), sources: memories, generated: false, outcome: "aiFailed", audience: found.audience };
    }
  }

  async save(input: SaveInput, ctx: RequestContext): Promise<SaveResult> {
    try { validateSaveInput(input); }
    catch { return this.client.save(input, ctx); } // local rejection, before model or HTTP
    const saved = await this.client.save(input, ctx);
    // The server's write guard must accept the note before any model can see it.
    if (saved.state !== "saved" || !saved.memory || !saved.audience || input.kind !== undefined || !input.autoClassify || ctx.signal.aborted) return saved;
    // No answer AI chosen is the user's setting, not a failure: the note is saved and nothing is classified,
    // the same way `ask` answers from the search alone. A provider without a model still reports why below.
    if ((await this.config.load()).ai.provider === "none") return saved;
    let kindApplied: Capture | undefined;
    try {
      const allowed = await this.client.allowedCaptureKinds(ctx, saved.audience);
      ctx.progress("classify");
      const kind = await this.ai.classify(saved.memory.content, allowed, ctx);
      if (!kind) return { ...saved, classification: { outcome: "undecided" } }; // AI explicitly withheld judgment; not a failure
      const capture: Capture = { kind, source: "ai" };
      kindApplied = capture;
      const memory = await this.client.update({ id: saved.memory.id, audience: saved.audience, expectedRevision: saved.memory.revision, capture }, ctx);
      return { ...saved, memory, capture, classification: { outcome: "applied", capture } };
    } catch (error) {
      if (ctx.signal.aborted) throw error; // cancellation is not a classification failure
      // The server accepted the classification PATCH and only the read-back after it failed: the
      // classification did apply, so it is reported as applied (with the pre-classification memory
      // snapshot `saved.memory`), never as a failed classification.
      if (error instanceof ServiceError && error.code === MEMORY_EDIT_ERROR_CODES.rereadFailed && kindApplied)
        return { ...saved, capture: kindApplied, classification: { outcome: "applied", capture: kindApplied } };
      // A confirmed write remains saved; only classification failed, and the caller sees why.
      // Non-ServiceError exceptions carry no public-facing message, so never show their raw text to the user.
      return { ...saved, classification: { outcome: "failed", reason: error instanceof ServiceError ? error.publicMessage : messages.feedback.classificationFailedGeneric } };
    }
  }
}
