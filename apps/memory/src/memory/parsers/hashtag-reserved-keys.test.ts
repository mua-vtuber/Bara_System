/**
 * hashtag-reserved-keys.test.ts — 활용 단계2 ② node_field 갈래 검증.
 *
 * 직접 입력 칸 키(`#날짜`·`#일정시작`·`#일정종료`)가 새 node_field 갈래로
 * 등록되는지, 기존 갈래(entity_person·attribute)는 그대로 보존되는지 확인한다.
 * 순수 매핑 조회 — DB·임베딩·LLM 의존 0.
 */

import { describe, expect, test } from "bun:test";
import { loadReservedKeys } from "./hashtag-reserved-keys.ts";

describe("활용 단계2 ② node_field 갈래 — 직접 입력 칸 키", () => {
  test("#날짜·#일정시작 → event_at, #일정종료 → event_until", () => {
    const keys = loadReservedKeys();
    expect(keys["날짜"]).toEqual({ kind: "node_field", nodeColumn: "event_at" });
    expect(keys["일정시작"]).toEqual({
      kind: "node_field",
      nodeColumn: "event_at",
    });
    expect(keys["일정종료"]).toEqual({
      kind: "node_field",
      nodeColumn: "event_until",
    });
  });

  test("기존 사람 칸(attribute)·엔티티 키는 그대로 보존(회귀 0)", () => {
    const keys = loadReservedKeys();
    expect(keys["사람"]).toEqual({ kind: "entity_person" });
    expect(keys["생일"]).toEqual({ kind: "attribute", column: "birthday" });
  });
});

describe("활용 단계2 ③ place 갈래 — 직접 입력 장소 키", () => {
  test("#장소 → place 갈래(엔티티·대상 필드 없음)", () => {
    const keys = loadReservedKeys();
    expect(keys["장소"]).toEqual({ kind: "place" });
  });

  test("기존 갈래 보존(회귀 0) — node_field·attribute·entity", () => {
    const keys = loadReservedKeys();
    expect(keys["날짜"]).toEqual({
      kind: "node_field",
      nodeColumn: "event_at",
    });
    expect(keys["생일"]).toEqual({ kind: "attribute", column: "birthday" });
    expect(keys["사람"]).toEqual({ kind: "entity_person" });
  });
});
