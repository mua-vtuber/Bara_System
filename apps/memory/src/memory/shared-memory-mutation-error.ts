export type SharedMemoryMutationErrorCode = "NOT_FOUND" | "CONFLICT" | "INVALID_INPUT";

/** Expected client errors shared by REST content edits and versioned mutations. */
export class SharedMemoryMutationError extends Error {
  override readonly name = "SharedMemoryMutationError";
  constructor(
    readonly code: SharedMemoryMutationErrorCode,
    message: string,
    readonly nodeId?: number,
    readonly currentRevision?: number,
  ) { super(message); }
}
