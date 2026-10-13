/**
 * 저장 위치 두 칸 설명 — "메모리 파일 위치"(db.path)와 "원본 파일 저장 위치"(assets.dir)는 한 쌍이라 함께 옮겨야 한다.
 * 한쪽만 바꾸면 다음 시작 때 서버가 짝 확인(S1·S2)으로 멈추므로, 두 칸 모두 그 사실을 설명에 적는다(빈 설명 금지).
 * 실제 서버 스키마(MEMORY_SCHEMA)를 대시보드 화면용 스키마로 바꾼 결과를 본다.
 */

import "../../test-setup-dom";
import { describe, expect, test } from "bun:test";
import { MEMORY_SCHEMA } from "../../src/settings/memory-schema";
import { createMemorySectionSchema } from "./settings";
import { STORAGE_LOCATION_LABELS as L } from "./settings-storage-labels";

type SchemaInput = Parameters<typeof createMemorySectionSchema>[0];

function fieldOf(section: "basic" | "advanced", group: string, key: string): Record<string, unknown> {
  const schema = createMemorySectionSchema(MEMORY_SCHEMA as unknown as SchemaInput, section);
  const groupNode = (schema.properties?.[group] ?? {}) as Record<string, unknown>;
  const field = ((groupNode.properties ?? {}) as Record<string, unknown>)[key];
  if (!field) throw new Error(`${section} 설정에 ${group}.${key} 칸이 없다`);
  return field as Record<string, unknown>;
}

describe("저장 위치 두 칸 — 한 쌍이라 함께 옮긴다는 설명", () => {
  test("기본 설정의 메모리 파일 위치(db.path)는 원본 파일 저장 위치와 한 쌍임을 설명한다", () => {
    const field = fieldOf("basic", "db", "path");
    expect(field.title).toBe(L.dbPathTitle);
    expect(field.description).toBe(L.dbPathDescription);
    expect(L.dbPathDescription).toContain(L.assetsDirTitle);
  });

  test("고급 설정의 원본 파일 저장 위치(assets.dir)는 메모리 파일 위치와 한 쌍임을 설명한다", () => {
    const field = fieldOf("advanced", "assets", "dir");
    expect(field.title).toBe(L.assetsDirTitle);
    expect(field.description).toBe(L.assetsDirDescription);
    expect(L.assetsDirDescription).toContain(L.dbPathTitle);
  });
});
