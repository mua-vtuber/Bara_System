/**
 * test-utils/schema-snapshot.ts — 빈 DB 스키마 스냅샷(설계 2026-10-02 마이그레이션 압축 6절)을 만들고 읽는 도구.
 * 테스트·개발 도구 전용: 제품 코드가 import 하지 않는다. 쓰는 곳은 db/schema-snapshot.test.ts(대조),
 * scripts/write-schema-snapshot.ts(파일 쓰기), 그리고 두 DB 의 DDL 을 맞대는 시험들(collectSchemaObjects).
 *
 * 스냅샷 파일(schema-snapshot.txt)은 지금 코드가 빈 DB 를 열 때 만드는 모양 전체를 한 줄씩 적는다.
 *   - 머리: 다시 쓰는 명령, baseline-version(BASELINE_VERSION), baseline-sql-sha256(기준 스키마 SQL 파일 넷을
 *     BASELINE_SCHEMA_FILES 순서로 LF 로 맞춰 이은 내용의 sha256 — 기준 스키마 동결 문지기), current-version.
 *   - [objects]: 표·가상 표·뷰·색인·트리거를 (종류, 이름) 순으로 "종류<TAB>이름<TAB>정규화 DDL" 한 줄씩.
 *     SQLite 내부 객체(sqlite_%)와 가상 표 부속 그림자 표(PRAGMA table_list 의 shadow)는 뺀다 —
 *     SQLite·sqlite-vec 의 내부 구현이라 우리가 정의한 스키마가 아니다.
 *   - [rows]: 행이 있는 보통 표(schema_version 제외)의 행을 "표<TAB>JSON" 한 줄씩.
 * 시험은 이 파일을 스스로 만들지 않는다 — 없으면 쓰기 명령을 담아 실패한다.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BASELINE_SCHEMA_DIR, BASELINE_SCHEMA_FILES, BASELINE_VERSION } from "../db/baseline-schema.ts";
import { CURRENT_SCHEMA_VERSION, openMemoryDatabase } from "../db/migrations.ts";
import { DEFAULT_EMBEDDING_DIM } from "../db/vec-dimension-guard.ts";

/** 스냅샷 파일 위치 — 시험과 쓰기 도구가 같은 경로를 본다. */
export const SCHEMA_SNAPSHOT_FILE = join(import.meta.dir, "schema-snapshot.txt");

/** 스냅샷을 다시 쓰는 명령. 머리 주석과 실패 문구에 그대로 들어간다. */
export const SCHEMA_SNAPSHOT_WRITE_COMMAND = "cd apps/memory && bun run scripts/write-schema-snapshot.ts";

/** 머리의 키 이름. */
export const SCHEMA_SNAPSHOT_HEADER_KEYS = {
  baselineVersion: "baseline-version",
  baselineSqlSha256: "baseline-sql-sha256",
  currentVersion: "current-version",
} as const;

/** 쓰기 도구가 기준 스키마 sha256 변경을 받아들이는 인자 — 압축 단계(이번과 다음 압축)에서만 쓴다. */
export const SCHEMA_SNAPSHOT_REBASELINE_FLAG = "--rebaseline";

const OBJECTS_SECTION = "[objects]";
const ROWS_SECTION = "[rows]";
const FIELD_SEPARATOR = "\t";

/** [rows] 에서 빼는 표 — 버전 기록은 머리의 current-version 이 맡고, applied_at 시각은 실행마다 달라진다. */
const ROWS_EXCLUDED_TABLES: ReadonlySet<string> = new Set(["schema_version"]);

/** [objects] 줄의 종류와 그 정렬 순서. */
const KIND_ORDER = ["table", "virtual-table", "view", "index", "trigger"] as const;
export type SnapshotObjectKind = (typeof KIND_ORDER)[number];

/** PRAGMA table_list 의 type → 스냅샷 종류. shadow 는 스냅샷에서 빼므로 따로 표시한다. */
const TABLE_LIST_KINDS: Readonly<Record<string, SnapshotObjectKind | "shadow">> = {
  table: "table",
  virtual: "virtual-table",
  view: "view",
  shadow: "shadow",
};

/** sqlite_master 한 객체의 스냅샷 — 종류(table/index/trigger/view)와 정규화한 DDL 본문. */
export interface SchemaObject {
  /** sqlite_master.type — 'table'(가상 테이블 포함) · 'index' · 'trigger' · 'view'. */
  type: string;
  /** normalizeDdl 을 거친 DDL 본문. sqlite_master.sql 이 NULL 이면 빈 문자열. */
  normalizedSql: string;
}

/**
 * DDL 본문을 표준화하는 순수 함수. 같은 의미의 DDL 이 띄어쓰기·줄바꿈·인라인 주석만
 * 다를 때 동일 문자열로 모은다 — 가짜 drift 차단. 의미 있는 차이(칸 추가/삭제·트리거
 * 본문·제약·UNIQUE 등)는 그대로 남겨 진짜 drift 가 잡히게 한다.
 *
 * 표준화 단계:
 *   1) 줄 끝 `--` 주석 제거. 이 스키마의 sqlite_master DDL 에는 문자열 리터럴 안에
 *      `--` 가 0건임을 실측 확인했다(작은따옴표 짝 스캔). 그래서 줄 단위 `--` 제거가
 *      문자열 내용을 건드리지 않는다 — 새 타입을 더할 때 칸 default 문자열에 `--` 를
 *      넣지 않는 한 안전하다(넣으면 이 가정이 깨지니, 그때 이 함수를 보강한다).
 *   2) 단순 식별자를 감싼 큰따옴표 제거(`"works"` → `works`). SQLite 는 테이블을
 *      재작성하는 마이그레이션의 `ALTER TABLE … RENAME TO` 부작용으로 sqlite_master 에
 *      테이블 이름을 따옴표로 감싼 형태로 적는다(예: works=v21·entity_relation_edges=v27
 *      재작성). 따옴표 없는 정의와 같은 테이블인데 인용 양식만 달라 가짜 drift 가 된다.
 *      내부가 일반 식별자(`[A-Za-z_][A-Za-z0-9_]*`)인 따옴표만 벗긴다 — 공백·특수문자를
 *      담은 따옴표 식별자(이 스키마엔 0건)는 의미가 달라질 수 있어 건드리지 않는다.
 *   3) 모든 공백 시퀀스(스페이스·탭·줄바꿈)를 단일 스페이스로 접고 앞뒤를 자른다.
 *   4) 괄호·콤마 둘레 공백을 없앤다 — 멀티라인 칸 선언과 한 줄/들여쓰기 선언이 같은
 *      모양으로 수렴한다.
 *
 * 주의: 칸 default 값 등 문자열 리터럴(작은따옴표) 안의 공백은 단계 3 이 함께 접는다.
 * 이 스키마의 리터럴(`'{}'`·`'pending'`·`'active'` 등)은 내부 공백이 없어 영향이 없다.
 * 내부 공백을 가진 default 리터럴을 새로 둘 때는 이 한계를 다시 본다(현재 0건).
 */
export function normalizeDdl(sql: string): string {
  // CRLF → LF 정규화(체크아웃 EOL 무관 결과). Windows 체크아웃에서는 sqlite_master
  // 가 CRLF 로 적은 DDL 을 돌려주는데, split("\n") 뒤 각 줄 끝에 \r 이 남아
  // /--.*$/ 의 `$`(줄 끝 앵커)가 `\r` 뒤로 밀려 인라인 주석 제거가 어긋난다.
  const lfNormalized = sql.replace(/\r\n/g, "\n");
  const noComments = lfNormalized
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  const unquoted = noComments.replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, "$1");
  const collapsed = unquoted.replace(/\s+/g, " ").trim();
  return collapsed.replace(/\s*([(),])\s*/g, "$1");
}

/**
 * 한 DB 의 sqlite_master 를 객체 이름 → {종류·정규화 sql} 맵으로 모은다. SQLite 가
 * 자동으로 만드는 내부 객체(`sqlite_%`)는 뺀다. fts5/vec0 가상 테이블의 부속 그림자
 * 테이블도 이 맵에는 들어간다(스냅샷 렌더는 excludeNames 로 뺀다).
 *
 * @param excludeNames 대조에서 뺄 객체 이름 집합.
 */
export function collectSchemaObjects(
  db: Database,
  excludeNames: ReadonlySet<string> = new Set(),
): Map<string, SchemaObject> {
  const rows = db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all() as Array<{ type: string; name: string; sql: string | null }>;
  const out = new Map<string, SchemaObject>();
  for (const r of rows) {
    if (excludeNames.has(r.name)) continue;
    out.set(r.name, { type: r.type, normalizedSql: normalizeDdl(r.sql ?? "") });
  }
  return out;
}

/** 스냅샷 원본 DB — 운영과 같은 openMemoryDatabase 로 빈 :memory: DB 를 연다(마이그레이션까지 적용). */
export function openSnapshotSourceDatabase(embeddingDim: number = DEFAULT_EMBEDDING_DIM): Database {
  return openMemoryDatabase(":memory:", { embeddingDim });
}

interface SnapshotObjectLine {
  kind: SnapshotObjectKind;
  name: string;
  ddl: string;
}

/** main 스키마의 표 이름 → 종류(PRAGMA table_list). 모르는 type 은 추측하지 않고 멈춘다. */
function readTableKinds(db: Database): Map<string, SnapshotObjectKind | "shadow"> {
  const rows = db.prepare("PRAGMA main.table_list").all() as Array<{ name: string; type: string }>;
  const kinds = new Map<string, SnapshotObjectKind | "shadow">();
  for (const row of rows) {
    const kind = TABLE_LIST_KINDS[row.type];
    if (kind === undefined) {
      throw new Error(`스키마 스냅샷: PRAGMA table_list 가 모르는 종류 '${row.type}' 를 돌려줬습니다(표 ${row.name}).`);
    }
    kinds.set(row.name, kind);
  }
  return kinds;
}

function snapshotKindOf(
  name: string,
  masterType: string,
  tableKinds: Map<string, SnapshotObjectKind | "shadow">,
): SnapshotObjectKind {
  if (masterType === "index" || masterType === "trigger") return masterType;
  if (masterType === "table" || masterType === "view") {
    const kind = tableKinds.get(name);
    if (kind === undefined || kind === "shadow") {
      throw new Error(`스키마 스냅샷: sqlite_master 의 ${masterType} '${name}' 가 PRAGMA table_list 에 없습니다.`);
    }
    return kind;
  }
  throw new Error(`스키마 스냅샷: sqlite_master 가 모르는 종류 '${masterType}' 를 돌려줬습니다(객체 ${name}).`);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function collectSnapshotObjects(db: Database): SnapshotObjectLine[] {
  const tableKinds = readTableKinds(db);
  const shadowNames = new Set([...tableKinds].filter(([, kind]) => kind === "shadow").map(([name]) => name));
  const lines: SnapshotObjectLine[] = [];
  for (const [name, obj] of collectSchemaObjects(db, shadowNames)) {
    lines.push({ kind: snapshotKindOf(name, obj.type, tableKinds), name, ddl: obj.normalizedSql });
  }
  return lines.sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || compareText(a.name, b.name),
  );
}

/** 한 행을 JSON 한 줄로. JSON 으로 그대로 옮길 수 없는 값(BLOB·bigint)은 추측해 바꾸지 않고 멈춘다. */
function rowToJson(table: string, row: Record<string, unknown>): string {
  for (const [column, value] of Object.entries(row)) {
    if (value instanceof Uint8Array || typeof value === "bigint") {
      throw new Error(`스키마 스냅샷: 시작 행 ${table}.${column} 의 값(BLOB 또는 큰 정수)은 JSON 한 줄로 적을 수 없습니다.`);
    }
  }
  return JSON.stringify(row);
}

function collectSnapshotRows(db: Database, objects: SnapshotObjectLine[]): string[] {
  const lines: string[] = [];
  for (const obj of objects) {
    if (obj.kind !== "table" || ROWS_EXCLUDED_TABLES.has(obj.name)) continue;
    const quoted = `"${obj.name.replace(/"/g, '""')}"`;
    const rows = db.prepare(`SELECT * FROM ${quoted}`).all() as Array<Record<string, unknown>>;
    for (const row of rows) lines.push([obj.name, rowToJson(obj.name, row)].join(FIELD_SEPARATOR));
  }
  // WITHOUT ROWID 표도 있어 rowid 순서를 쓸 수 없다 — 줄 글자 순으로 고정한다(표 이름이 앞이라 표끼리 모인다).
  return lines.sort(compareText);
}

/** 몸통([objects] + [rows]). 시험은 이 문자열을 파일의 몸통과 글자까지 대조한다. */
export function renderSchemaSnapshotBody(db: Database): string {
  const objects = collectSnapshotObjects(db);
  const objectLines = objects.map((o) => [o.kind, o.name, o.ddl].join(FIELD_SEPARATOR));
  const rowLines = collectSnapshotRows(db, objects);
  return [OBJECTS_SECTION, ...objectLines, "", ROWS_SECTION, ...rowLines].join("\n") + "\n";
}

/**
 * 기준 스키마 SQL 파일 넷을 BASELINE_SCHEMA_FILES 순서로 LF 로 맞춰 이은 내용의 sha256(hex). 파일을 한 글자라도
 * 고치면 값이 바뀌어, 스냅샷 시험과 쓰기 도구가 "기준 스키마는 동결"을 지킨다.
 */
export function baselineSchemaSha256(): string {
  const hash = createHash("sha256");
  for (const file of BASELINE_SCHEMA_FILES) {
    hash.update(readFileSync(join(BASELINE_SCHEMA_DIR, file), "utf8").replace(/\r\n/g, "\n"), "utf8");
  }
  return hash.digest("hex");
}

/**
 * 머리. baseline-version 은 기준 스키마 번호(BASELINE_VERSION), baseline-sql-sha256 은 그 SQL 파일들의 지문,
 * current-version 은 v48+ 마이그레이션까지 더한 최고 번호(CURRENT_SCHEMA_VERSION)다.
 */
export function renderSchemaSnapshotHeader(): string {
  return [
    `# 생성 파일 — 손으로 고치지 않는다. 다시 쓰기: ${SCHEMA_SNAPSHOT_WRITE_COMMAND}`,
    `${SCHEMA_SNAPSHOT_HEADER_KEYS.baselineVersion}: ${BASELINE_VERSION}`,
    `${SCHEMA_SNAPSHOT_HEADER_KEYS.baselineSqlSha256}: ${baselineSchemaSha256()}`,
    `${SCHEMA_SNAPSHOT_HEADER_KEYS.currentVersion}: ${CURRENT_SCHEMA_VERSION}`,
  ].join("\n") + "\n";
}

/** 파일 전체(머리 + 빈 줄 + 몸통). 쓰기 도구가 이 문자열을 그대로 쓴다. */
export function renderSchemaSnapshot(db: Database): string {
  return `${renderSchemaSnapshotHeader()}\n${renderSchemaSnapshotBody(db)}`;
}

export interface ParsedSchemaSnapshot {
  header: Map<string, string>;
  body: string;
}

/** 파일 글을 머리(키: 값)와 몸통으로 가른다. 형식이 어긋나면 어디가 어긋났는지 담아 멈춘다. */
export function parseSchemaSnapshot(text: string, source: string): ParsedSchemaSnapshot {
  const lf = text.replace(/\r\n/g, "\n");
  const split = lf.indexOf("\n\n");
  if (split < 0 || !lf.startsWith(`${OBJECTS_SECTION}\n`, split + 2)) {
    throw new Error(
      `스키마 스냅샷 파일 형식이 어긋났습니다('${source}'): 머리 뒤 빈 줄 다음에 ${OBJECTS_SECTION} 줄이 있어야 합니다. ` +
        `${SCHEMA_SNAPSHOT_WRITE_COMMAND} 로 다시 쓰세요.`,
    );
  }
  const header = new Map<string, string>();
  for (const line of lf.slice(0, split).split("\n")) {
    if (line.startsWith("#")) continue;
    const sep = line.indexOf(": ");
    if (sep < 0) {
      throw new Error(`스키마 스냅샷 파일 머리 줄 형식이 어긋났습니다('${source}'): '${line}'`);
    }
    header.set(line.slice(0, sep), line.slice(sep + 2));
  }
  return { header, body: lf.slice(split + 2) };
}

/**
 * 쓰기 도구용 — 스냅샷 파일 머리에 적힌 baseline-sql-sha256. 파일이 아직 없거나 그 줄이 없으면 null(적힌 지문이 없다는
 * 사실 그대로다 — 쓰기 도구는 이때도 지금 지문과 다르다고 보고 --rebaseline 없이는 쓰지 않는다).
 */
export function readRecordedBaselineSha256(path: string = SCHEMA_SNAPSHOT_FILE): string | null {
  if (!existsSync(path)) return null;
  return readSchemaSnapshotFile(path).header.get(SCHEMA_SNAPSHOT_HEADER_KEYS.baselineSqlSha256) ?? null;
}

/** 스냅샷 파일을 읽는다. 파일이 없으면 만들지 않고 쓰기 명령을 담아 멈춘다. */
export function readSchemaSnapshotFile(path: string = SCHEMA_SNAPSHOT_FILE): ParsedSchemaSnapshot {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `스키마 스냅샷 파일이 없습니다: '${path}'. 시험은 이 파일을 스스로 만들지 않습니다 — ` +
          `${SCHEMA_SNAPSHOT_WRITE_COMMAND} 로 만들고 git diff 로 내용을 확인한 뒤 커밋하세요.`,
      );
    }
    throw err;
  }
  return parseSchemaSnapshot(text, path);
}

export interface SnapshotBodyDiff {
  /** "종류 이름" — 지금 DB 에만 있는 객체. */
  added: string[];
  /** "종류 이름" — 파일에만 있는 객체. */
  removed: string[];
  /** "종류 이름" — 양쪽에 있지만 정규화 DDL 이 다른 객체. */
  changed: string[];
  /** "표 JSON" — 지금 DB 에만 있는 시작 행. */
  rowsAdded: string[];
  /** "표 JSON" — 파일에만 있는 시작 행. */
  rowsRemoved: string[];
}

function parseBodyLines(body: string): { objects: Map<string, string>; rows: Set<string> } {
  const objects = new Map<string, string>();
  const rows = new Set<string>();
  let section: string | null = null;
  for (const line of body.split("\n")) {
    if (line === OBJECTS_SECTION || line === ROWS_SECTION) {
      section = line;
      continue;
    }
    if (line === "") continue;
    const fields = line.split(FIELD_SEPARATOR);
    if (section === OBJECTS_SECTION && fields.length === 3) {
      objects.set(`${fields[0]} ${fields[1]}`, fields[2]!);
    } else if (section === ROWS_SECTION && fields.length === 2) {
      rows.add(`${fields[0]} ${fields[1]}`);
    } else {
      throw new Error(`스키마 스냅샷 몸통 줄 형식이 어긋났습니다(구역 ${section ?? "없음"}): '${line}'`);
    }
  }
  return { objects, rows };
}

/** 두 몸통(기대 = 파일, 실제 = 지금 DB)의 차이를 객체 이름 단위로 모은다. */
export function diffSnapshotBodies(expected: string, actual: string): SnapshotBodyDiff {
  const e = parseBodyLines(expected);
  const a = parseBodyLines(actual);
  const sorted = (items: Iterable<string>): string[] => [...items].sort(compareText);
  return {
    added: sorted([...a.objects.keys()].filter((k) => !e.objects.has(k))),
    removed: sorted([...e.objects.keys()].filter((k) => !a.objects.has(k))),
    changed: sorted([...a.objects].filter(([k, ddl]) => e.objects.has(k) && e.objects.get(k) !== ddl).map(([k]) => k)),
    rowsAdded: sorted([...a.rows].filter((r) => !e.rows.has(r))),
    rowsRemoved: sorted([...e.rows].filter((r) => !a.rows.has(r))),
  };
}

/** 대조 실패 문구 — 더해진·빠진·바뀐 객체 이름과 쓰기 명령을 담는다. */
export function formatSnapshotMismatch(diff: SnapshotBodyDiff): string {
  const list = (items: string[]): string => (items.length === 0 ? "없음" : items.join(", "));
  const nameDiffCount =
    diff.added.length + diff.removed.length + diff.changed.length + diff.rowsAdded.length + diff.rowsRemoved.length;
  return [
    "지금 코드가 만드는 빈 DB 모양이 스키마 스냅샷 파일과 다릅니다.",
    `더해진 객체: ${list(diff.added)}`,
    `빠진 객체: ${list(diff.removed)}`,
    `바뀐 객체: ${list(diff.changed)}`,
    `더해진 시작 행: ${list(diff.rowsAdded)}`,
    `빠진 시작 행: ${list(diff.rowsRemoved)}`,
    ...(nameDiffCount === 0 ? ["객체·행 차이는 없지만 줄 순서나 형식이 다릅니다."] : []),
    `의도한 변경이면 ${SCHEMA_SNAPSHOT_WRITE_COMMAND} 로 다시 쓰고, git diff 로 의도한 줄만 바뀐 것을 확인해 같은 커밋에 넣으세요.`,
  ].join("\n");
}
