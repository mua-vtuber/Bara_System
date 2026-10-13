import { describe, expect, test } from "bun:test";
import {
  readSharedMemory, validateSharedMemory, parseMemoryReadScope,
  matchesMemoryScope, isCurrentMemory,
  SHARED_MEMORY_DERIVED_SOURCE_TYPES, isDerivedSourceType,
  inheritSharedMemoryForDerived, readSharedMemoryForNode,
} from "./shared-memory-contract.ts";

describe("shared memory read contract", () => {
  test("legacy metadata is active unknown evidence at revision zero", () => {
    expect(readSharedMemory({})).toEqual({ status: "active", revision: 0, assertionKind: "unknown" });
    expect(isCurrentMemory({})).toBe(true);
  });
  test("scope distinguishes omitted, global, and project with optional global", () => {
    expect(matchesMemoryScope("B", undefined)).toBe(true);
    expect(matchesMemoryScope("B", { projectId: null })).toBe(false);
    expect(matchesMemoryScope(null, { projectId: null })).toBe(true);
    expect(matchesMemoryScope(null, { projectId: "A" })).toBe(false);
    expect(matchesMemoryScope(null, { projectId: "A", includeGlobal: true })).toBe(true);
    expect(matchesMemoryScope("B", { projectId: "A", includeGlobal: true })).toBe(false);
  });
  test("inactive and time-bounded evidence never passes as current", () => {
    for (const status of ["disputed", "superseded", "retracted"]) {
      expect(isCurrentMemory({ sharedMemory: { status } })).toBe(false);
    }
    const bounds = { validFrom: "2026-09-20T00:00:00Z", validUntil: "2026-09-21T00:00:00Z" };
    expect(isCurrentMemory({ sharedMemory: bounds }, "2026-09-20T12:00:00Z")).toBe(true);
    expect(isCurrentMemory({ sharedMemory: bounds }, "2026-09-19T12:00:00Z")).toBe(false);
    expect(isCurrentMemory({ sharedMemory: bounds }, "2026-09-21T00:00:00Z")).toBe(false);
  });
  test("new input is strict; corrupt persisted contract fails closed", () => {
    expect(() => parseMemoryReadScope({ projectId: 123 })).toThrow();
    expect(() => parseMemoryReadScope({ projectId: "A", extra: true })).toThrow();
    expect(() => validateSharedMemory({ status: "invented" })).toThrow();
    expect(() => validateSharedMemory({ evidenceRefs: [-1] })).toThrow();
    expect(() => validateSharedMemory({ validUntil: "yesterday" })).toThrow();
    expect(() => validateSharedMemory({ validFrom: "2026-09-21T00:00:00Z", validUntil: "2026-09-20T00:00:00Z" })).toThrow();
    expect(isCurrentMemory({ sharedMemory: { status: "invented" } })).toBe(false);
  });
});

describe("derived node evidence contract", () => {
  const parent = validateSharedMemory({
    assertionKind: "user_statement", revision: 3, sourceEventId: "event-1", claimKey: "claim-1",
    sessionRef: "session-1", evidenceRefs: [7, 9],
    validFrom: "2026-09-20T00:00:00Z", validUntil: "2026-10-20T00:00:00Z",
  });
  const { evidenceRefs: _declared, ...lifecycle } = parent;

  test("one list names every derived source type", () => {
    expect([...SHARED_MEMORY_DERIVED_SOURCE_TYPES].sort()).toEqual(["document_chunk", "image_caption", "llm_extract"]);
    for (const type of SHARED_MEMORY_DERIVED_SOURCE_TYPES) expect(isDerivedSourceType(type)).toBe(true);
    for (const type of ["auto_capture", "user_explicit", "reflection", "document", "image_asset"]) {
      expect(isDerivedSourceType(type)).toBe(false);
    }
  });

  test("a derived child inherits lifecycle and event identity but never the parent's evidenceRefs", () => {
    const chunk = inheritSharedMemoryForDerived(parent);
    expect(chunk).toEqual(lifecycle);
    expect("evidenceRefs" in chunk).toBe(false);
    const extracted = inheritSharedMemoryForDerived(parent, { revision: 0, assertionKind: "ai_inference" });
    expect(extracted).toEqual({ ...lifecycle, revision: 0, assertionKind: "ai_inference" });
    expect("evidenceRefs" in extracted).toBe(false);
    expect(parent.evidenceRefs).toEqual([7, 9]);
  });

  test("a derived row drops copied evidenceRefs while an authored row keeps its own", () => {
    const metadata = { sharedMemory: parent };
    for (const sourceType of SHARED_MEMORY_DERIVED_SOURCE_TYPES) {
      const state = readSharedMemoryForNode({ sourceType, metadata });
      expect(state).toEqual(lifecycle);
      expect("evidenceRefs" in state).toBe(false);
    }
    expect(readSharedMemoryForNode({ sourceType: "auto_capture", metadata })).toEqual(parent);
    expect(readSharedMemoryForNode({ sourceType: "document_chunk", metadata: {} })).toEqual(readSharedMemory({}));
    expect(readSharedMemoryForNode({ sourceType: "llm_extract", metadata: { sharedMemory: { status: "invented", evidenceRefs: [1] } } }))
      .toEqual({ status: "disputed", revision: 0, assertionKind: "unknown" });
  });
});
