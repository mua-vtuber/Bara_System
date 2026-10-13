/**
 * Read-only relation integrity checker.
 *
 * The CLI opens file DBs with `{ readonly: true }` and never runs migrations,
 * repair SQL, deletes, or writes. `:memory:` is allowed only as an anonymous
 * smoke-test target because Bun cannot open it in read-only mode. Missing
 * relation tables are reported as skipped instead of failures.
 */

import { Database } from "bun:sqlite";
import { applyBusyTimeout } from "../db/connection-pragmas.ts";
import {
  checkRelationName,
  standardNamesForRelationColumn,
} from "../memory/relation-policy.ts";
import {
  RELATION_TABLE_SPECS,
  endpointKindFromId,
  hasRelationTable,
  relationSpecByTable,
  type RelationEndpointSpec,
  type RelationFkPolicy,
  type RelationTableName,
  type RelationTableSpec,
} from "../memory/relation-registry.ts";

export type RelationFindingSeverity = "critical" | "high" | "medium" | "low";
export type RelationTableFkPolicy = RelationFkPolicy;

export interface RelationFinding {
  severity: RelationFindingSeverity;
  table: string;
  fkPolicy?: RelationTableFkPolicy;
  check: string;
  message: string;
  row?: Record<string, unknown>;
}

export interface RelationTableSummary {
  table: RelationTableName;
  fkPolicy: RelationTableFkPolicy;
  rowCount: number;
  checkedColumns: string[];
}

export interface RelationCheckReport {
  ok: boolean;
  dbPath: string;
  schemaVersion: number | null;
  checkedTables: string[];
  skippedTables: string[];
  rowCounts: Record<string, number>;
  tableSummaries: RelationTableSummary[];
  summary: {
    findings: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    checkedTables: number;
    skippedTables: number;
    totalRows: number;
  };
  findings: RelationFinding[];
}

interface EndpointRef {
  type: string;
  id: string;
}

type Row = Record<string, unknown>;
type RelationColumn = "relation" | "role";

function countRows(db: Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return row.count;
}

function readSchemaVersion(db: Database): number | null {
  if (!hasRelationTable(db, "schema_version")) return null;
  const row = db
    .prepare("SELECT MAX(version) AS v FROM schema_version")
    .get() as { v: number | null };
  return row.v;
}

function allRows(db: Database, sql: string): Row[] {
  return db.prepare(sql).all() as Row[];
}

function addFinding(
  findings: RelationFinding[],
  finding: RelationFinding,
): void {
  findings.push({
    fkPolicy: relationSpecByTable(finding.table)?.fkPolicy,
    ...finding,
  });
}

function endpointExists(db: Database, ref: EndpointRef): boolean {
  if (ref.type === "memory") {
    if (!hasRelationTable(db, "knowledge_nodes")) return false;
    return (
      db.prepare("SELECT 1 AS ok FROM knowledge_nodes WHERE id = ?").get(ref.id) !==
      null
    );
  }
  if (ref.type === "concept") {
    if (!hasRelationTable(db, "concept_nodes")) return false;
    return (
      db.prepare("SELECT 1 AS ok FROM concept_nodes WHERE concept_id = ?")
        .get(ref.id) !== null
    );
  }
  if (ref.type === "person") {
    if (!hasRelationTable(db, "persons")) return false;
    return (
      db.prepare("SELECT 1 AS ok FROM persons WHERE person_id = ?").get(ref.id) !==
      null
    );
  }
  if (!hasRelationTable(db, "entities")) return false;
  return (
    db
      .prepare("SELECT 1 AS ok FROM entities WHERE type_name = ? AND entity_id = ?")
      .get(ref.type, ref.id) !== null
  );
}

function entityEndpointExists(db: Database, id: string): boolean {
  if (!hasRelationTable(db, "entities")) return false;
  return db.prepare("SELECT 1 AS ok FROM entities WHERE entity_id = ?").get(id) !== null;
}

function endpointId(row: Row, endpoint: RelationEndpointSpec): string {
  const value = row[endpoint.idColumn];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
}

function endpointType(row: Row, endpoint: RelationEndpointSpec): string {
  const rule = endpoint.kindRule;
  if (rule.kind === "fixed") return rule.value;
  if (rule.kind === "id_prefix") return endpointKindFromId(endpointId(row, endpoint));
  if (rule.kind === "type_column") {
    const value = row[rule.column];
    return typeof value === "string" && value.trim() ? value.trim() : "unknown";
  }
  return "entity";
}

function endpointExistsForSpec(
  db: Database,
  row: Row,
  endpoint: RelationEndpointSpec,
): boolean {
  const id = endpointId(row, endpoint);
  const rule = endpoint.kindRule;
  if (!id) return false;
  if (rule.kind === "id_prefix") {
    const type = endpointKindFromId(id);
    return (type === "concept" || type === "person") && endpointExists(db, { type, id });
  }
  if (rule.kind === "entity_type_lookup") {
    return entityEndpointExists(db, id);
  }
  return endpointExists(db, { type: endpointType(row, endpoint), id });
}

function userRelationNames(db: Database): Set<string> {
  const names = new Set<string>();
  if (!hasRelationTable(db, "relation_name_user_entries")) return names;
  const rows = allRows(
    db,
    "SELECT relation_name FROM relation_name_user_entries",
  ) as Array<{ relation_name?: unknown }>;
  for (const row of rows) {
    if (typeof row.relation_name !== "string") continue;
    const relation = row.relation_name.trim();
    if (relation.length > 0) names.add(relation);
  }
  return names;
}

function checkRelationValues(
  db: Database,
  spec: RelationTableSpec,
  extraEntityRelationNames: ReadonlySet<string>,
  findings: RelationFinding[],
): void {
  const column = spec.relationColumn.name as RelationColumn;
  const allowed = standardNamesForRelationColumn(
    spec.tableName,
    column,
    extraEntityRelationNames,
  );
  const rows = allRows(
    db,
    `SELECT DISTINCT ${column} AS value FROM ${spec.tableName}`,
  ) as Array<{ value: unknown }>;
  for (const row of rows) {
    const check = checkRelationName(row.value, allowed);
    if (check.ok) continue;
    addFinding(findings, {
      severity: "medium",
      table: spec.tableName,
      check: `${column}-policy`,
      message:
        check.reason === "non_standard"
          ? `${column} '${check.relation}' is not standard for ${spec.tableName}`
          : `${column} is ${check.reason}`,
      row: { [column]: row.value },
    });
  }
}

function checkDuplicateTuple(
  db: Database,
  spec: RelationTableSpec,
  findings: RelationFinding[],
): void {
  const columnList = spec.duplicateTupleColumns.join(", ");
  for (const row of allRows(
    db,
    `SELECT ${columnList}, COUNT(*) AS count
       FROM ${spec.tableName}
      GROUP BY ${columnList}
     HAVING COUNT(*) > 1`,
  )) {
    addFinding(findings, {
      severity: "high",
      table: spec.tableName,
      check: "duplicate-tuple",
      message: `duplicate ${spec.tableName} tuple`,
      row,
    });
  }
}

function relationCheckColumns(spec: RelationTableSpec): string[] {
  const columns = [
    spec.source.idColumn,
    spec.target.idColumn,
    spec.relationColumn.name,
  ];
  for (const endpoint of [spec.source, spec.target]) {
    const rule = endpoint.kindRule;
    if (rule.kind === "type_column") columns.push(rule.column);
  }
  return [...new Set(columns)];
}

function checkEndpointsAndSelfLoops(
  db: Database,
  spec: RelationTableSpec,
  findings: RelationFinding[],
): void {
  const columns = relationCheckColumns(spec).join(", ");
  for (const row of allRows(db, `SELECT ${columns} FROM ${spec.tableName}`)) {
    const sourceOk = endpointExistsForSpec(db, row, spec.source);
    const targetOk = endpointExistsForSpec(db, row, spec.target);
    if (!sourceOk || !targetOk) {
      addFinding(findings, {
        severity: "critical",
        table: spec.tableName,
        check: "orphan-endpoint",
        message: `${spec.tableName} row has a missing source or target endpoint`,
        row,
      });
    }
    if (
      endpointType(row, spec.source) === endpointType(row, spec.target) &&
      endpointId(row, spec.source) === endpointId(row, spec.target)
    ) {
      addFinding(findings, {
        severity: "high",
        table: spec.tableName,
        check: "self-loop",
        message: `${spec.tableName} row points to the same endpoint`,
        row,
      });
    }
  }
}

export function checkRelations(
  db: Database,
  dbPath = ":memory:",
): RelationCheckReport {
  const checkedTables: string[] = [];
  const skippedTables: string[] = [];
  const rowCounts: Record<string, number> = {};
  const tableSummaries: RelationTableSummary[] = [];
  const findings: RelationFinding[] = [];
  const extraEntityRelationNames = userRelationNames(db);

  for (const spec of RELATION_TABLE_SPECS) {
    if (!hasRelationTable(db, spec.tableName)) {
      skippedTables.push(spec.tableName);
      continue;
    }
    checkedTables.push(spec.tableName);
    const rowCount = countRows(db, spec.tableName);
    rowCounts[spec.tableName] = rowCount;
    tableSummaries.push({
      table: spec.tableName,
      fkPolicy: spec.fkPolicy,
      rowCount,
      checkedColumns: [spec.relationColumn.name],
    });
  }

  for (const spec of RELATION_TABLE_SPECS) {
    if (!checkedTables.includes(spec.tableName)) continue;
    checkRelationValues(db, spec, extraEntityRelationNames, findings);
    checkEndpointsAndSelfLoops(db, spec, findings);
    checkDuplicateTuple(db, spec, findings);
  }

  const summary = {
    findings: findings.length,
    critical: findings.filter((f) => f.severity === "critical").length,
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
    checkedTables: checkedTables.length,
    skippedTables: skippedTables.length,
    totalRows: Object.values(rowCounts).reduce((sum, count) => sum + count, 0),
  };
  return {
    ok: summary.critical === 0 && summary.high === 0,
    dbPath,
    schemaVersion: readSchemaVersion(db),
    checkedTables,
    skippedTables,
    rowCounts,
    tableSummaries,
    summary,
    findings,
  };
}

function parseArgs(argv: string[]): { dbPath: string; format: "json" | "text" } {
  let dbPath = process.env.MEMORY_DB_PATH ?? "data/bara.sqlite";
  let format: "json" | "text" = "text";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--db" && argv[i + 1]) {
      dbPath = argv[++i]!;
    } else if (arg === "--format" && argv[i + 1]) {
      const value = argv[++i]!;
      if (value === "json" || value === "text") format = value;
      else throw new Error(`unsupported --format: ${value}`);
    } else if (!arg.startsWith("-")) {
      dbPath = arg;
    }
  }
  return { dbPath, format };
}

function printText(report: RelationCheckReport): void {
  console.log(`relation check: ${report.ok ? "ok" : "issues"}`);
  console.log(`db: ${report.dbPath}`);
  console.log(`schemaVersion: ${report.schemaVersion ?? "unknown"}`);
  console.log(`checked: ${report.checkedTables.join(", ") || "(none)"}`);
  console.log(`skipped: ${report.skippedTables.join(", ") || "(none)"}`);
  console.log(`rows: ${report.summary.totalRows}`);
  for (const table of report.tableSummaries) {
    console.log(
      `  ${table.table}: ${table.rowCount} rows, ${table.fkPolicy}, columns ${table.checkedColumns.join(", ")}`,
    );
  }
  console.log(
    `findings: ${report.summary.findings} ` +
      `(critical ${report.summary.critical}, high ${report.summary.high}, ` +
      `medium ${report.summary.medium}, low ${report.summary.low})`,
  );
  for (const f of report.findings) {
    console.log(`[${f.severity}] ${f.table}/${f.check}: ${f.message}`);
    if (f.row) console.log(`  ${JSON.stringify(f.row)}`);
  }
}

if (import.meta.main) {
  const { dbPath, format } = parseArgs(Bun.argv.slice(2));
  const db =
    dbPath === ":memory:"
      ? new Database(dbPath)
      : new Database(dbPath, { readonly: true });
  // 동시성 계약(P1-C W6): read-only 연결도 서버 가동 중 붙을 수 있으므로 busy_timeout 을
  // 건다. busy_timeout 은 연결별 런타임 설정이라 지속되지 않아(파일 미기록) 이 연결이
  // 각자 걸어야 한다. WAL 모드는 이미 파일에 지속 기록돼 있어 read-only 연결이 그 모드로
  // 자동 연결되므로 여기선 busy_timeout 만 배선한다(WAL/synchronous 는 read-only 무의미).
  applyBusyTimeout(db);
  try {
    const report = checkRelations(db, dbPath);
    if (format === "json") console.log(JSON.stringify(report, null, 2));
    else printText(report);
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    db.close();
  }
}
