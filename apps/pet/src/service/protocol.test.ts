import { describe, expect, test } from "bun:test";
import { messages } from "../ui/messages.ts";
import { parseFrame, publicError, FRAME_LIMIT } from "./protocol.ts";

describe("native protocol boundary", () => {
  test("accepts only known public operations with a bounded request identity", () => {
    expect(parseFrame('{"id":"r-1","method":"memory.search","params":{"query":"기억"}}')).toEqual({
      id: "r-1", method: "memory.search", params: { query: "기억" },
    });
    expect(() => parseFrame('{"id":"r-1","method":"vault.get","params":{}}')).toThrow();
    expect(() => parseFrame('{"id":"a\\nb","method":"status","params":{}}')).toThrow();
  });
  test("owner dashboard links are private native calls", () => {
    const frame = '{"id":"r-1","method":"dashboard.link","params":{"review":true}}';
    expect(() => parseFrame(frame)).toThrow();
    expect(parseFrame(frame, true)).toEqual({ id: "r-1", method: "dashboard.link", params: { review: true } });
  });
  test("vault replies cannot be confused with renderer requests", () => {
    expect(parseFrame('{"hostReply":{"id":"h-1","result":null}}', true)).toEqual({ hostReply: { id: "h-1", result: null } });
    expect(() => parseFrame('{"hostReply":{"id":"h-1","result":"secret"}}')).toThrow();
    expect(() => parseFrame('{"hostReply":{"id":"h-1"}}', true)).toThrow();
  });
  test("rejects non-object, malformed and oversized messages", () => {
    for (const line of ["null", "[]", "{", '{"id":"x","method":"status"}', " ".repeat(FRAME_LIMIT + 1)]) {
      expect(() => parseFrame(line)).toThrow();
    }
  });
  test("unexpected native errors never expose credentials or raw message", () => {
    expect(publicError(new Error("Bearer abc123 private http://user:password@host"))).toEqual({
      code: "INTERNAL", message: messages.rpc.internal,
    });
    expect(publicError({ code: "SERVER_OFFLINE", publicMessage: "메모리 서버에 연결하지 못했습니다." })).toEqual({
      code: "SERVER_OFFLINE", message: "메모리 서버에 연결하지 못했습니다.",
    });
  });
});
