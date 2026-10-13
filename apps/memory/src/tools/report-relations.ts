/**
 * Read-only relation inventory report.
 *
 * This tool summarizes the logical relation view without changing graph/search
 * consumers and without writing to the database.
 */

import { Database } from "bun:sqlite";
import {
  RELATION_TABLE_SPECS,
  hasRelationTable,
} from "../memory/relation-registry.ts";
import { streamRelationEdges } from "../memory/relation-reader.ts";

export interface RelationInventoryReport {
  dbPath: string;
  schemaVersion: number | null;
  totalEdges: number;
  tableRowCounts: Record<string, number>;
  layerCounts: Record<string, number>;
  relationCounts: Record<string, number>;
  sourceKindCounts: Record<string, number>;
  targetKindCounts: Record<string, number>;
  endpointPairCounts: Record<string, number>;
  skippedTables: string[];
}

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

function addCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function reportRelations(
  db: Database,
  dbPath = ":memory:",
): RelationInventoryReport {
  const tableRowCounts: Record<string, number> = {};
  const skippedTables: string[] = [];
  for (const spec of RELATION_TABLE_SPECS) {
    if (!hasRelationTable(db, spec.tableName)) {
      skippedTables.push(spec.tableName);
      continue;
    }
    tableRowCounts[spec.tableName] = countRows(db, spec.tableName);
  }

  const layerCounts: Record<string, number> = {};
  const relationCounts: Record<string, number> = {};
  const sourceKindCounts: Record<string, number> = {};
  const targetKindCounts: Record<string, number> = {};
  const endpointPairCounts: Record<string, number> = {};
  let totalEdges = 0;

  for (const edge of streamRelationEdges(db)) {
    totalEdges += 1;
    addCount(layerCounts, edge.layer);
    addCount(relationCounts, edge.relation);
    addCount(sourceKindCounts, edge.sourceKind);
    addCount(targetKindCounts, edge.targetKind);
    addCount(endpointPairCounts, `${edge.sourceKind}->${edge.targetKind}`);
  }

  return {
    dbPath,
    schemaVersion: readSchemaVersion(db),
    totalEdges,
    tableRowCounts,
    layerCounts,
    relationCounts,
    sourceKindCounts,
    targetKindCounts,
    endpointPairCounts,
    skippedTables,
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

function printCounts(title: string, counts: Record<string, number>): void {
  console.log(title);
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const [key, count] of entries) {
    console.log(`  ${key}: ${count}`);
  }
}

function printText(report: RelationInventoryReport): void {
  console.log("relation inventory report");
  console.log(`db: ${report.dbPath}`);
  console.log(`schemaVersion: ${report.schemaVersion ?? "unknown"}`);
  console.log(`totalEdges: ${report.totalEdges}`);
  printCounts("tables", report.tableRowCounts);
  printCounts("layers", report.layerCounts);
  printCounts("relations", report.relationCounts);
  printCounts("sourceKinds", report.sourceKindCounts);
  printCounts("targetKinds", report.targetKindCounts);
  printCounts("endpointPairs", report.endpointPairCounts);
  console.log(`skipped: ${report.skippedTables.join(", ") || "(none)"}`);
}

if (import.meta.main) {
  const { dbPath, format } = parseArgs(Bun.argv.slice(2));
  const db =
    dbPath === ":memory:"
      ? new Database(dbPath)
      : new Database(dbPath, { readonly: true });
  try {
    const report = reportRelations(db, dbPath);
    if (format === "json") console.log(JSON.stringify(report, null, 2));
    else printText(report);
  } finally {
    db.close();
  }
}
