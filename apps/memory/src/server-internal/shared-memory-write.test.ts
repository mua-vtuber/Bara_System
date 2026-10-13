import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { OllamaClient } from "../llm/ollama-client.ts";
import { MemoryExtractor } from "../memory/extractor.ts";
import { withMemoryMutationLock } from "../memory/shared-memory-mutation-lock.ts";
import { retractSharedMemory } from "../memory/shared-memory-mutations.ts";
import { readSharedMemory } from "../memory/shared-memory-contract.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";
import type { MemorySettings } from "../settings/memory-settings.ts";
import {
  startDelayedOllamaChatServer,
  type DelayedOllamaChatServer,
} from "../test-utils/delayed-ollama-chat-server.ts";
import { SecretDetectedError } from "./write-guard/write-guard.ts";
import {
  PreparedExtractionMismatchError, SERVER_OWNED_METADATA_KEYS, prepareImmediateExtraction, saveTextInput,
} from "./save-input.ts";
import * as evidenceService from "./shared-memory-write.ts";
import type { MemoryEvidenceInput } from "./shared-memory-write.ts";

let embedder: Bgem3Embedder;
let db: Database;
let store: SqliteMemoryStore;
beforeAll(async () => { embedder = new Bgem3Embedder(); await embedder.load(); });
beforeEach(() => { db = openMemoryDatabase(":memory:"); store = new SqliteMemoryStore(db, embedder); });
afterEach(() => db.close());

const save = (content: string, evidence?: MemoryEvidenceInput, author = "ai-a") =>
  evidenceService.saveSharedMemoryInput(store, {
    content, source: "mcp", author, duplicateCheck: { enabled: false },
  }, evidence);

test("a source retracted during dependent capture cannot leave an active inference", async () => {
  const source = await save("The user said they often work at night", { assertionKind: "user_statement" });
  const pending = save("The user may prefer working at night", {
    assertionKind: "ai_inference", evidenceRefs: [source.originNodeId!],
  });
  await retractSharedMemory(store, {
    nodeId: source.originNodeId!, expectedRevision: 0, requestId: "retract-during-capture", actor: "ai-b",
  });
  const dependent = await pending;
  expect(readSharedMemory((await store.getNode(source.originNodeId!))!.metadata).status).toBe("retracted");
  expect(readSharedMemory((await store.getNode(dependent.originNodeId!))!.metadata).status).toBe("retracted");
});

test("failed event recording cannot reinforce an absorbed memory before retry", async () => {
  const original = await save("Concise responses are preferred");
  const before = (await store.getNode(original.originNodeId!))!;
  db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON memory_source_events BEGIN SELECT RAISE(ABORT, 'event fixture failure'); END");
  await expect(save(before.content, { sourceEventId: "retry-event" })).rejects.toThrow("event fixture failure");
  expect((await store.getNode(before.id))!.mentionCount).toBe(before.mentionCount);
  expect((await store.getNode(before.id))!.importance).toBe(before.importance);
  db.exec("DROP TRIGGER fail_event");
  await save(before.content, { sourceEventId: "retry-event" });
  await save(before.content, { sourceEventId: "retry-event" }, "ai-b");
  expect((await store.getNode(before.id))!.mentionCount).toBe(before.mentionCount + 1);
});

test("failed reinforcement rolls back its event record so a retry can complete", async () => {
  const original = await save("Use precise source citations");
  db.exec("CREATE TRIGGER fail_bump AFTER UPDATE OF mention_count ON knowledge_nodes BEGIN SELECT RAISE(ABORT, 'bump fixture failure'); END");
  await expect(save("Use precise source citations", { sourceEventId: "bump-event" })).rejects.toThrow("bump fixture failure");
  expect(db.query("SELECT COUNT(*) AS count FROM memory_source_events").get()).toEqual({ count: 0 });
  expect((await store.getNode(original.originNodeId!))!.mentionCount).toBe(0);
  db.exec("DROP TRIGGER fail_bump");
  await save("Use precise source citations", { sourceEventId: "bump-event" });
  expect((await store.getNode(original.originNodeId!))!.mentionCount).toBe(1);
});

test("exact-content absorption retains original and new event evidence with each producer", async () => {
  const first = await save("Use TypeScript for this project", {
    assertionKind: "ai_inference", sourceEventId: "initial-event", claimKey: "language", sessionRef: "session-a",
  });
  const confirmation = await save("Use TypeScript for this project", {
    assertionKind: "user_statement", sourceEventId: "confirmation-event", claimKey: "language", sessionRef: "session-b",
  }, "ai-b");
  expect(confirmation.originNodeId).toBe(first.originNodeId);
  expect(evidenceService.listMemoryEvidence(store, first.originNodeId!).records).toEqual([
    expect.objectContaining({ sourceEventId: "initial-event", assertionKind: "ai_inference", producer: "ai-a", sessionRef: "session-a" }),
    expect.objectContaining({ sourceEventId: "confirmation-event", assertionKind: "user_statement", producer: "ai-b", sessionRef: "session-b" }),
  ]);
  expect(readSharedMemory((await store.getNode(first.originNodeId!))!.metadata).assertionKind).toBe("ai_inference");
});

test("paraphrased cross-client retries preserve the first evidence and do not reinforce", async () => {
  const first = await save("Respond in Korean", {
    assertionKind: "user_statement", sourceEventId: "language-event", claimKey: "response-language", sessionRef: "session-a",
  });
  const again = await save("The user prefers Korean answers", {
    assertionKind: "ai_inference", sourceEventId: "language-event", claimKey: "response-language", sessionRef: "session-b",
  }, "ai-b");
  expect(again.originNodeId).toBe(first.originNodeId);
  expect((await store.getNode(first.originNodeId!))!.mentionCount).toBe(0);
  expect(evidenceService.listMemoryEvidence(store, first.originNodeId!).records).toEqual([
    expect.objectContaining({ assertionKind: "user_statement", producer: "ai-a", sessionRef: "session-a" }),
  ]);
});

test("interrupted new-origin recording recovers its original evidence rather than retry claims", async () => {
  db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON memory_source_events BEGIN SELECT RAISE(ABORT, 'event fixture failure'); END");
  await expect(save("Keep the first original claim", {
    assertionKind: "user_statement", sourceEventId: "interrupted-event", sessionRef: "session-a",
  })).rejects.toThrow("event fixture failure");
  db.exec("DROP TRIGGER fail_event");
  const retry = await save("A different producer paraphrases it", {
    assertionKind: "ai_inference", sourceEventId: "interrupted-event", sessionRef: "session-b",
  }, "ai-b");
  expect((await store.getNode(retry.originNodeId!))!.mentionCount).toBe(0);
  expect(evidenceService.listMemoryEvidence(store, retry.originNodeId!).records).toEqual([
    expect.objectContaining({ assertionKind: "user_statement", producer: "ai-a", sessionRef: "session-a" }),
  ]);
});

test("inactive or cross-project references cannot support a new memory", async () => {
  const source = await save("This source is about to be withdrawn");
  await retractSharedMemory(store, {
    nodeId: source.originNodeId!, expectedRevision: 0, requestId: "withdraw-source", actor: "ai-a",
  });
  await expect(save("Unsupported new claim", { evidenceRefs: [source.originNodeId!] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  const other = await evidenceService.saveSharedMemoryInput(store, {
    content: "A private project fact", source: "mcp", projectId: "other", duplicateCheck: { enabled: false },
  });
  await expect(save("A global claim", { evidenceRefs: [other.originNodeId!] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

test("secret rejection covers new evidence strings, including replay attempts", async () => {
  const secret = "ghp_" + "x".repeat(40);
  for (const field of ["sourceEventId", "claimKey", "sessionRef"] as const) {
    await expect(save("An ordinary safe body", { sourceEventId: "safe-event", [field]: secret }))
      .rejects.toBeInstanceOf(SecretDetectedError);
  }
  const first = await save("An established safe event", { sourceEventId: "existing-event" });
  await expect(save("A safe paraphrase", { sourceEventId: "existing-event", sessionRef: secret }))
    .rejects.toBeInstanceOf(SecretDetectedError);
  expect((await store.getNode(first.originNodeId!))!.mentionCount).toBe(0);
});

test("a distinct event repeating withdrawn content records evidence without strengthening it", async () => {
  const first = await save("A withdrawn preference", { sourceEventId: "original-preference" });
  await retractSharedMemory(store, {
    nodeId: first.originNodeId!, expectedRevision: 0, requestId: "withdraw-preference", actor: "ai-a",
  });
  const after = await save("A withdrawn preference", { sourceEventId: "new-preference-event" }, "ai-b");
  expect(after.originNodeId).toBe(first.originNodeId);
  const node = (await store.getNode(first.originNodeId!))!;
  expect(node.mentionCount).toBe(0);
  expect(readSharedMemory(node.metadata).status).toBe("retracted");
  expect(evidenceService.listMemoryEvidence(store, node.id).records).toHaveLength(2);
});

// Each paragraph stays under the 60-token cap while the whole text does not: one chunk per paragraph.
const TRUSTED_PARAGRAPHS = [
  "배포 결정문의 첫 문단은 금요일 오후 창구를 정한 이유다.",
  "둘째 문단은 롤백 담당과 알림 경로를 운영팀 채널로 둔다.",
  "셋째 문단은 점검 목록을 배포 전날 저녁에 다시 본다고 정한다.",
];

test("trusted state travels in its own field to the origin and chunks; a free-form copy is replaced", async () => {
  const reference = await save("The operations team posts release notices weekly");
  const saved = await evidenceService.saveSharedMemoryInput(store, {
    content: TRUSTED_PARAGRAPHS.join("\n\n"), source: "mcp", author: "ai-a",
    duplicateCheck: { enabled: false }, chunking: { tokenCap: 60, minChunkTokens: 1 },
    extraMetadata: { note: "kept", sharedMemory: { status: "retracted", revision: 99, assertionKind: "observation" } },
  }, { assertionKind: "user_statement", sourceEventId: "trusted-long", evidenceRefs: [reference.originNodeId!] });
  const origin = (await store.getNode(saved.originNodeId!))!;
  expect(origin.metadata.note).toBe("kept");
  expect(origin.metadata.sharedMemory).toEqual({
    status: "active", revision: 0, assertionKind: "user_statement",
    sourceEventId: "trusted-long", evidenceRefs: [reference.originNodeId!],
  });
  expect(saved.chunkNodeIds).toHaveLength(TRUSTED_PARAGRAPHS.length);
  for (const id of saved.chunkNodeIds) {
    expect((await store.getNode(id))!.metadata.sharedMemory).toEqual({
      status: "active", revision: 0, assertionKind: "user_statement", sourceEventId: "trusted-long",
    });
  }
});

test("lineage keys in free-form metadata are rejected before anything is written", async () => {
  for (const [key, value] of [["extracted", 1], ["extractedTo", [1]]] as const) {
    await expect(evidenceService.saveSharedMemoryInput(store, {
      content: "A memory that claims extraction lineage", source: "mcp", author: "ai-a",
      duplicateCheck: { enabled: false }, extraMetadata: { [key]: value },
    })).rejects.toMatchObject({ code: "INVALID_INPUT", message: `metadata.${key} is managed by the server` });
  }
  expect(db.query("SELECT COUNT(*) AS count FROM knowledge_nodes").get()).toEqual({ count: 0 });
});

test("saveTextInput refuses server-owned extraMetadata keys as a programming error", async () => {
  for (const key of SERVER_OWNED_METADATA_KEYS) {
    await expect(saveTextInput(store, {
      content: "A direct caller passing a trusted key", source: "mcp",
      duplicateCheck: { enabled: false }, extraMetadata: { [key]: null },
    })).rejects.toThrow(`extraMetadata.${key}`);
  }
  expect(db.query("SELECT COUNT(*) AS count FROM knowledge_nodes").get()).toEqual({ count: 0 });
});

test("evidence reads omit malformed or credential-bearing historical ledger rows, honestly counted (WP-B1-16 / SA-8)", async () => {
  const first = await save("A safe evidence record", { sourceEventId: "valid-event" });
  const insert = db.query("INSERT INTO memory_source_events(event_key,node_id,evidence_json,created_at) VALUES (?,?,?,?)");
  insert.run("malformed-fixture", first.originNodeId!, "not-json", "2026-09-20 00:00:00");
  insert.run("credential-fixture", first.originNodeId!, JSON.stringify({
    sourceEventId: "ghp_" + "x".repeat(40), producer: "ai-a",
  }), "2026-09-20 00:00:00");
  const { records, omitted } = evidenceService.listMemoryEvidence(store, first.originNodeId!);
  expect(records).toHaveLength(1);
  expect(records[0]!.sourceEventId).toBe("valid-event");
  expect(JSON.stringify(records)).not.toContain("ghp_");
  // The omitted count says a row was dropped, but never what it held.
  expect(omitted).toEqual({ malformed: 1, unsafe: 1 });
  expect(JSON.stringify(omitted)).not.toContain("ghp_");
});

// ── WP-B1-08: immediate extraction calls the LLM outside the write lock ─────────────
// The LLM is a local Bun.serve answering in the Ollama /api/chat format after a delay; the
// real OllamaClient calls it. Storage is real SQLite with the real bge-m3 embedder.
const LLM_DELAY_MS = 3_000;
/** With the lock free, one bumpMention finishes far sooner than the LLM delay. */
const LOCK_WAIT_LIMIT_MS = 1_000;
/** Several clauses: a short single-meaning input skips the LLM (shouldSkipExtraction). */
const IMMEDIATE_TEXT = "나는 매일 아침 커피를 마신다. 나는 주말마다 북한산에 오른다. 나는 저녁마다 추리소설을 읽는다.";
const EXTRACTED_CHILD = "나는 매일 아침 커피를 마신다";

describe("saveSharedMemoryInput immediate extraction", () => {
  let llm: DelayedOllamaChatServer;
  let extractor: MemoryExtractor;
  beforeEach(() => {
    llm = startDelayedOllamaChatServer({
      delayMs: LLM_DELAY_MS,
      content: JSON.stringify([{ content: EXTRACTED_CHILD, memoryType: "fact", importance: 0.6 }]),
    });
    extractor = new MemoryExtractor(new OllamaClient({ baseUrl: llm.url, model: "test-model" }), store, embedder, {
      duplicateSim: 0.999,
    });
  });
  afterEach(() => llm.stop());

  const extractorSettings = () => ({
    ...structuredClone(MEMORY_DEFAULTS.llm.extractor), enabled: true, mode: "immediate",
  }) as MemorySettings["llm"]["extractor"];
  const saveImmediate = (content: string, evidence?: MemoryEvidenceInput, author = "ai-a") =>
    evidenceService.saveSharedMemoryInput(store, {
      content, source: "mcp", author, duplicateCheck: { enabled: false }, extractor, extractorSettings: extractorSettings(),
    }, evidence);
  const childIds = () => (db.query("SELECT id FROM knowledge_nodes WHERE source_type = 'llm_extract' ORDER BY id")
    .all() as Array<{ id: number }>).map((row) => row.id);
  const originIds = () => (db.query("SELECT id FROM knowledge_nodes WHERE source_type = 'auto_capture' ORDER BY id")
    .all() as Array<{ id: number }>).map((row) => row.id);

  test("other locked writes do not wait for the LLM, and the result is stored afterwards", async () => {
    const other = await store.addNode({ content: "잠금 작업 대상 기억", sourceType: "user_explicit" });
    const arrived = llm.nextRequest();
    let finished = false;
    const pending = saveImmediate(IMMEDIATE_TEXT, { sourceEventId: "lock-event" })
      .then((result) => { finished = true; return result; });
    await arrived;
    const start = performance.now();
    await withMemoryMutationLock(store, () => store.bumpMention(other));
    expect(performance.now() - start).toBeLessThan(LOCK_WAIT_LIMIT_MS);
    expect(finished).toBe(false);

    const saved = await pending;
    expect(saved.immediateExtractionRan).toBe(true);
    expect(saved.extracted).toEqual(childIds());
    expect(childIds()).toHaveLength(1);
    expect((await store.getNode(saved.originNodeId!))!.metadata).toMatchObject({
      extracted: 1, extractedTo: childIds(), sharedMemory: { sourceEventId: "lock-event", status: "active" },
    });
    expect(llm.requestCount()).toBe(1);
  }, 30_000);

  test("a resend with the same sourceEventId makes no LLM call, even with different text", async () => {
    const first = await saveImmediate(IMMEDIATE_TEXT, { sourceEventId: "resend-event" });
    expect(llm.requestCount()).toBe(1);
    const again = await saveImmediate(IMMEDIATE_TEXT, { sourceEventId: "resend-event" }, "ai-b");
    const paraphrased = await saveImmediate(
      "나는 아침마다 커피를 한 잔 마신다. 주말에는 북한산을 오르고 밤에는 추리소설을 읽는다.",
      { sourceEventId: "resend-event" },
    );
    expect(llm.requestCount()).toBe(1);
    expect(again.originNodeId).toBe(first.originNodeId);
    expect(paraphrased.originNodeId).toBe(first.originNodeId);
    expect(childIds()).toHaveLength(1);
  }, 30_000);

  test("a resend that commits while another delivery waits for the LLM discards the prepared result", async () => {
    const firstArrived = llm.nextRequest();
    const first = saveImmediate(IMMEDIATE_TEXT, { sourceEventId: "racing-event" });
    await firstArrived;
    // The first delivery has not recorded its event yet, so the second one also prepares.
    const secondArrived = llm.nextRequest();
    const second = saveImmediate(IMMEDIATE_TEXT, { sourceEventId: "racing-event" }, "ai-b");
    await secondArrived;
    const [a, b] = await Promise.all([first, second]);
    expect(llm.requestCount()).toBe(2);
    expect(b.originNodeId).toBe(a.originNodeId);
    expect(b.cacheHit).toBe(true);
    expect(originIds()).toEqual([a.originNodeId!]);
    expect(childIds()).toHaveLength(1);
    expect(evidenceService.listMemoryEvidence(store, a.originNodeId!).records).toHaveLength(1);
  }, 30_000);

  test("evidence withdrawn while the LLM runs is re-checked in the lock and nothing is stored", async () => {
    const source = await save("The user said they often work at night");
    const arrived = llm.nextRequest();
    const pending = saveImmediate(IMMEDIATE_TEXT, { assertionKind: "ai_inference", evidenceRefs: [source.originNodeId!] });
    await arrived;
    await retractSharedMemory(store, {
      nodeId: source.originNodeId!, expectedRevision: 0, requestId: "retract-during-llm", actor: "ai-b",
    });
    await expect(pending).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(originIds()).toEqual([source.originNodeId!]);
    expect(childIds()).toEqual([]);
  }, 30_000);

  test("a prepared result for different text is refused instead of stored", async () => {
    const prepared = await prepareImmediateExtraction(store, {
      content: IMMEDIATE_TEXT, source: "mcp", duplicateCheck: { enabled: false }, extractor, extractorSettings: extractorSettings(),
    });
    expect(prepared?.outcome.kind).toBe("extracted");
    await expect(saveTextInput(store, {
      content: `${IMMEDIATE_TEXT} 나는 밤마다 산책을 한다.`, source: "mcp", duplicateCheck: { enabled: false },
      extractor, extractorSettings: extractorSettings(), preparedExtraction: prepared,
    })).rejects.toBeInstanceOf(PreparedExtractionMismatchError);
    // The same text normalized differently (NFD) is a different body too.
    await expect(saveTextInput(store, {
      content: IMMEDIATE_TEXT.normalize("NFD"), source: "mcp", duplicateCheck: { enabled: false },
      extractor, extractorSettings: extractorSettings(), preparedExtraction: prepared,
    })).rejects.toBeInstanceOf(PreparedExtractionMismatchError);
    expect(db.query("SELECT COUNT(*) AS count FROM knowledge_nodes").get()).toEqual({ count: 0 });
    expect(llm.requestCount()).toBe(1);
  }, 30_000);

  test("an existing origin skips the LLM; if it vanishes before the write, the write stops without an LLM call", async () => {
    const existing = await store.addNode({ content: IMMEDIATE_TEXT, sourceType: "auto_capture" });
    const args = {
      content: IMMEDIATE_TEXT, source: "mcp", duplicateCheck: { enabled: false }, extractor, extractorSettings: extractorSettings(),
    };
    const prepared = await prepareImmediateExtraction(store, args);
    expect(prepared?.outcome.kind).toBe("existing_origin");
    await store.deleteNode(existing);
    await expect(saveTextInput(store, { ...args, preparedExtraction: prepared }))
      .rejects.toBeInstanceOf(PreparedExtractionMismatchError);
    expect(db.query("SELECT COUNT(*) AS count FROM knowledge_nodes").get()).toEqual({ count: 0 });
    expect(llm.requestCount()).toBe(0);
  }, 30_000);

  // ── WP-B1-08R Minor 1: a resend bet made outside the lock can go stale before the lock is held ──
  test("a resend detected outside the lock, whose original is deleted while the lock is held, is refused with 409/CONFLICT and calls the LLM zero times", async () => {
    const original = await saveImmediate(IMMEDIATE_TEXT, { sourceEventId: "stale-resend-event" });
    expect(llm.requestCount()).toBe(1);
    expect(childIds()).toHaveLength(1);

    // Hold the write lock so saveSharedMemoryInput's outside-the-lock resend check (which
    // finds the event recorded and skips prepareImmediateExtraction) runs, queues on the
    // lock, and only reaches saveSharedMemoryInputLocked after the original is deleted here.
    let releaseLock!: () => void;
    const gate = new Promise<void>((resolve) => { releaseLock = resolve; });
    const holder = withMemoryMutationLock(store, async () => {
      await gate;
      await store.deleteNode(original.originNodeId!);
    });

    const resendAttempt = saveImmediate(IMMEDIATE_TEXT, { sourceEventId: "stale-resend-event" }, "ai-b");
    await Bun.sleep(200); // let the outside-the-lock resend check finish and queue on the lock
    releaseLock();
    await holder;

    await expect(resendAttempt).rejects.toBeInstanceOf(PreparedExtractionMismatchError);
    await expect(resendAttempt).rejects.toMatchObject({ code: "CONFLICT" });
    expect(llm.requestCount()).toBe(1); // no second LLM call inside the lock
    expect(originIds()).toEqual([]); // the sole origin was deleted, and the resend created no new origin
    // WP-B1-20U 17.3: deleting the origin also deleted its sourceless child, and the resend stored no new child.
    expect(childIds()).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS count FROM memory_source_events").get()).toEqual({ count: 0 }); // cascaded with the deleted origin
  }, 30_000);
});
