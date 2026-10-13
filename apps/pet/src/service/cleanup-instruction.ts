import { serviceError } from "./errors.ts";
import { messages } from "../ui/messages.ts";

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The stages whose instruction the server sends with the candidates (`shared.instruction`): one source for the
 * server's own cycle and the Pet, so the cleanup AI is asked the same question either way. */
export const SERVER_INSTRUCTION_STAGES = ["entityRegister", "regexStrengthen"] as const;
export type ServerInstructionStage = (typeof SERVER_INSTRUCTION_STAGES)[number];

export function hasServerInstruction(stage: string): stage is ServerInstructionStage {
  return (SERVER_INSTRUCTION_STAGES as readonly string[]).includes(stage);
}

/** What the model answers when it has nothing for the candidate, said in the stage's own terms. */
const NO_FINDING_CASE: Record<ServerInstructionStage, string> = {
  entityRegister: "If the memo has no target and no date",
  regexStrengthen: "If there is no rule to propose",
};

/** The instruction the server sent with the candidates. A server that sends none (an older one) stops the
 * stage instead of falling back to a short instruction of the Pet's own. */
export function serverInstruction(stage: ServerInstructionStage, shared: unknown): string {
  const instruction = record(shared)?.instruction;
  if (typeof instruction !== "string" || instruction.length === 0) throw serviceError("MCP_RESPONSE", messages.cleanupService.instructionMissing[stage]);
  return instruction;
}

/** The server's instruction wrapped for the `claude`/`codex` CLI, whose answer schema is {finding, payloadJson}. */
export function cliStageInstruction(stage: ServerInstructionStage, shared: unknown): string {
  return `${serverInstruction(stage, shared)}\n\nAnswer with finding and payloadJson. payloadJson encodes the one JSON object described above. ${NO_FINDING_CASE[stage]}, return finding:false,payloadJson:'{}'.`;
}

/** The server's instruction wrapped for an Ollama or OpenAI-compatible model, which answers {finding, payload}. */
export function chatStageInstruction(stage: ServerInstructionStage, shared: unknown): string {
  return `${serverInstruction(stage, shared)}\n\nReturn only JSON: {finding:boolean,payload:object}. payload is the one JSON object described above. If nothing, finding:false and payload:{}.`;
}
