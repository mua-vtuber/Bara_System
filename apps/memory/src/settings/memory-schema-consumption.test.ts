/**
 * 설정 노출=소비 정합 테스트 (P3 G4-a)
 *
 * 권위: docs/decisions/2026-07-03-structure-cleanup-spec.md (G4-a)
 *
 * MEMORY_SCHEMA 의 모든 leaf 키가 src/(비-test) 코드에서 최소 1회 참조되는지 자동
 * 검사한다. 화면(설정 폼)에는 노출되는데 코드가 안 읽는 "죽은 노브"가 다시 생기는
 * 것을 구조적으로 막는다. 죽은 노브는 사용자에게 "이 값을 바꾸면 동작이 바뀐다"는
 * 거짓 약속을 하므로(값이 아무 데도 안 흐름) 정직성 결함이다.
 *
 * ## 검사 방법
 *
 * 1. MEMORY_SCHEMA 를 재귀 순회해 leaf 키(더 이상 하위 properties 가 없는 필드)를
 *    모은다. sub-object(예: llm.extractor.backfill)는 통과하고 그 안의 스칼라
 *    필드만 leaf 로 센다.
 * 2. 각 leaf 키 이름이 src/ 의 비-test .ts 파일 중 하나 이상에서 단어 경계(\b) 로
 *    등장하는지 grep 한다. 스키마 정의 파일 자체(memory-schema*.ts·memory-defaults.ts)
 *    는 소비처로 안 친다 — 정의는 소비가 아니다.
 * 3. 어느 파일에서도 안 나오면 죽은 노브 후보. allowlist(예약 근거)에 없으면 실패.
 *
 * ## 한계 — 이 테스트가 못 잡는 것 (과신 금지)
 *
 * - **키 등장 여부만 본다.** leaf 키 이름이 코드 어딘가에 텍스트로 나오면 통과다.
 *   mentionBoost 처럼 default 가 상수와 우연히 같아 settings 값이 실제로는 안
 *   흐르는 경우(과거 G3-d 결함)는 못 잡는다 — 그건 별도 통합 테스트 몫이다.
 * - **공통 이름은 오탐(통과) 방향으로만 흐른다.** enabled·batchSize·threshold·model·
 *   host 같은 이름은 여러 그룹이 공유해, A 그룹의 enabled 가 죽어도 B 그룹의 enabled
 *   참조가 A 를 "살아있음"으로 통과시킬 수 있다. 즉 이 테스트는 "확실히 죽은(어디에도
 *   안 나오는) 노브"만 잡고, "이름은 겹치나 이 그룹에선 안 쓰는" 미묘한 죽음은 못
 *   잡는다. 그래도 완전히 죽은 노브(고유 이름)의 재발은 확실히 막는다.
 *
 * 데이터 fixture 만 사용(mock 객체 0) — 실제 스키마 + 실제 소스 파일을 읽어 검사한다.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { MEMORY_SCHEMA } from "./memory-schema.ts";

type SchemaNode = {
  type?: string;
  properties?: Record<string, SchemaNode>;
};

/** MEMORY_SCHEMA 를 재귀 순회해 leaf 키(하위 properties 없는 필드)를 모은다. */
function collectLeafKeys(
  node: SchemaNode,
  path: string[],
  out: Array<{ leaf: string; dotPath: string }>,
): void {
  if (node.type === "object" && node.properties) {
    for (const [key, child] of Object.entries(node.properties)) {
      collectLeafKeys(child, [...path, key], out);
    }
    return;
  }
  const leaf = path[path.length - 1];
  if (leaf !== undefined) {
    out.push({ leaf, dotPath: path.join(".") });
  }
}

/** src/ 안 비-test .ts 파일 경로를 모은다. */
function collectSrcFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSrcFiles(full, out);
      continue;
    }
    if (![".ts", ".tsx"].includes(extname(entry))) continue;
    // *.test.ts 전부 제외(*.int.test.ts·*.e2e.test.ts 등 포함).
    if (/\.test\.ts$/.test(entry)) continue;
    if (full.replace(/\\/g, "/").includes("/test-utils/")) continue;
    out.push(full);
  }
}

const SRC = join(import.meta.dir, "..");

// 스키마 정의 파일 — 여기 등장은 소비가 아니라 정의라 소비처로 안 친다.
const SCHEMA_DEF_FILES = new Set(
  [
    "settings/memory-schema.ts",
    "settings/memory-schema-groups-pipeline.ts",
    "settings/memory-schema-groups-retrieval.ts",
    "settings/memory-schema-groups-documents.ts",
    "settings/memory-schema-types.ts",
    "settings/memory-defaults.ts",
  ].map((p) => join(SRC, ...p.split("/"))),
);

/**
 * "예약된 설정" allowlist — 화면엔 있으나 아직 소비 코드가 없는 leaf 를, 어느 spec
 * 에서 Deferred/예약인지 근거와 함께 등록한다. allowlist 는 fallback 이 아니라
 * "죽음 vs 예약"을 가르는 명시 장치다(spec G4-a). 근거 없이 넣지 말 것.
 *
 * 현재 비어 있음 — G1-e 가 chunking 죽은 칸(fixedSizeTokens·semanticThreshold)을
 * 이미 제거해, 실측(아래 테스트)에서 죽은 노브 0. 미래에 미구현 전략용 예약 leaf 를
 * 추가하면 그때 근거 주석과 함께 여기 등록한다. dotPath(그룹 경로 포함)로 적어
 * 공통 이름 오탐을 피한다.
 */
const RESERVED_LEAF_ALLOWLIST = new Set<string>([
  // 예: "chunking.fixedSizeTokens", // <spec> 에서 Deferred — 미구현 전략용 예약.
]);

describe("MEMORY_SCHEMA 설정 노출=소비 정합 (P3 G4-a)", () => {
  const leaves: Array<{ leaf: string; dotPath: string }> = [];
  collectLeafKeys(MEMORY_SCHEMA as unknown as SchemaNode, [], leaves);

  const srcFiles: string[] = [];
  collectSrcFiles(SRC, srcFiles);
  const contents = new Map<string, string>();
  for (const f of srcFiles) contents.set(f, readFileSync(f, "utf-8"));

  /** 한 leaf 키가 비-스키마-정의 src 파일에서 단어 경계로 등장하는가. */
  function isLeafConsumed(leaf: string): boolean {
    const re = new RegExp(`\\b${leaf}\\b`);
    for (const [file, content] of contents) {
      if (SCHEMA_DEF_FILES.has(file)) continue;
      if (re.test(content)) return true;
    }
    return false;
  }

  test("스키마 leaf 를 최소 하나는 모았다 (순회 sanity)", () => {
    // 순회가 통째로 비면 검사가 무의미하므로 하한을 둔다. 현 스키마는 100+ leaf.
    expect(leaves.length).toBeGreaterThan(50);
  });

  test("모든 leaf 키가 src/(비-test) 에서 소비된다 (allowlist 예외)", () => {
    const dead: string[] = [];
    for (const { leaf, dotPath } of leaves) {
      if (RESERVED_LEAF_ALLOWLIST.has(dotPath)) continue;
      if (!isLeafConsumed(leaf)) {
        dead.push(dotPath);
      }
    }
    // 죽은 노브가 발견되면 dotPath 목록을 그대로 실패 메시지에 노출(정직한 실패).
    expect(dead).toEqual([]);
  });

  test("allowlist 항목은 실제 leaf 여야 한다 (죽은 allowlist 방지)", () => {
    // allowlist 에 넣어둔 dotPath 가 스키마에 실재하는 leaf 인지 확인 — 스키마를
    // 고쳐 leaf 가 사라졌는데 allowlist 에 남는 드리프트를 잡는다.
    const leafDotPaths = new Set(leaves.map((l) => l.dotPath));
    for (const reserved of RESERVED_LEAF_ALLOWLIST) {
      expect(leafDotPaths.has(reserved)).toBe(true);
    }
  });

  test("검사 로직 자체 검증 — 존재하지 않는 leaf 이름은 죽음으로 판정된다 (red/green 실증)", () => {
    // spec G4 Completion Criteria — "죽은 설정을 실제로 잡는지" 실증. 스키마에 없는
    // 가짜 고유 이름은 소비처가 없어 죽음으로 판정돼야 한다. 이 케이스가 통과해야
    // 위 "모든 leaf 소비" 테스트의 초록이 "검사가 안 도는 위양성"이 아님을 보증한다.
    const fakeUniqueLeaf = "zzz_nonexistent_knob_xyz_9f3a";
    expect(isLeafConsumed(fakeUniqueLeaf)).toBe(false);
    // 반대로 확실히 소비되는 고유 이름은 살아있음으로 판정.
    expect(isLeafConsumed("mergeSimThreshold")).toBe(true);
  });
});
