/**
 * event-bus.test.ts — EVENT_TYPES 카탈로그 + EventBus 발행/구독 통합 검증.
 *
 * mock 0 — 실제 SQLite(in-memory) + 실 EventRepository 로 검증한다
 * (CLAUDE.md "DB 의존 모듈은 실제 구현체와 통합 검증", 프로젝트 정책 "Mock 객체 금지").
 * EventBus 자체에 기존 단위 테스트가 없어, 그래프 라이브 연출 타입을 더하면서
 * 카탈로그 정합과 발행 흐름을 같이 본다.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { EventRepository, type EventRecord } from "../db/store-internal/event-repository.ts";
import { EVENT_TYPES, EventBus } from "./event-bus.ts";

describe("EVENT_TYPES — 그래프 라이브 연출 타입(Phase 2)", () => {
  it("세 타입이 snake_case 문자열로 존재한다", () => {
    expect(EVENT_TYPES.GRAPH_CHANGED).toBe("graph_changed");
    expect(EVENT_TYPES.GRAPH_MERGE).toBe("graph_merge");
    expect(EVENT_TYPES.GRAPH_EMERGE).toBe("graph_emerge");
  });

  it("기존 타입은 그대로 보존된다", () => {
    expect(EVENT_TYPES.CLEANUP_PROPOSALS_READY).toBe("cleanup_proposals_ready");
    expect(EVENT_TYPES.RELATIONS_DISCOVERED).toBe("relations_discovered");
  });
});

describe("EventBus — 그래프 라이브 타입 발행/구독", () => {
  let db: Database;
  let bus: EventBus;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
    bus = new EventBus(new EventRepository(db));
  });
  afterEach(() => {
    db.close();
  });

  it("graph_changed 를 발행하면 구독자가 같은 type·payload 를 받는다", () => {
    const received: EventRecord[] = [];
    bus.subscribe("test-adapter", (record) => received.push(record));

    bus.emit(EVENT_TYPES.GRAPH_CHANGED, { reason: "memory-added" });

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("graph_changed");
    expect(received[0]!.payload).toEqual({ reason: "memory-added" });
  });

  it("graph_merge·graph_emerge payload 모양이 그대로 흘러 적재된다", () => {
    const repo = new EventRepository(db);
    bus.emit(EVENT_TYPES.GRAPH_MERGE, { from: "concept:1", into: "concept:2" });
    bus.emit(EVENT_TYPES.GRAPH_EMERGE, { nodeId: "concept:9", fromSources: ["7", "8"] });

    const stored = repo.listSince(0);
    expect(stored).toHaveLength(2);
    expect(stored[0]!.type).toBe("graph_merge");
    expect(stored[0]!.payload).toEqual({ from: "concept:1", into: "concept:2" });
    expect(stored[1]!.type).toBe("graph_emerge");
    expect(stored[1]!.payload).toEqual({ nodeId: "concept:9", fromSources: ["7", "8"] });
  });
});
