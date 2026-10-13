import type { Database } from "bun:sqlite";
import type { ArchivedNode } from "../../memory/types.ts";
import { rowToNode } from "./helpers.ts";
import type { KnowledgeNodeRow } from "./row-types.ts";

export interface ArchivePageOptions { since?: string; limit?: number; cursor?: string }
export interface ArchivePage { archive: ArchivedNode[]; total: number; nextCursor: string | null }
interface ArchiveCursor { at: string; id: number }
export class InvalidArchiveCursor extends Error {}

function decodeCursor(value: string): ArchiveCursor {
  try {
    if (value.length > 500 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof decoded.at !== "string" || decoded.at.length === 0 || decoded.at.length > 64 ||
        !Number.isSafeInteger(decoded.id) || decoded.id < 1) throw new Error();
    return { at: decoded.at, id: decoded.id };
  } catch {
    throw new InvalidArchiveCursor("휴지통 조회 위치가 올바르지 않습니다. 목록을 새로 불러오세요.");
  }
}

/** 삭제·복구로 앞 페이지가 바뀌어도 읽지 않은 항목이 밀리지 않는 안정된 순서. */
export function readArchivePage(db: Database, options: ArchivePageOptions = {}): ArchivePage {
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
  const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (options.since) { clauses.push("archived_at >= ?"); params.push(options.since); }
  const where = () => clauses.length ? " WHERE " + clauses.join(" AND ") : "";
  const total = (db.query("SELECT COUNT(*) AS count FROM knowledge_nodes_archive" + where()).get(...params) as {count: number}).count;
  if (cursor) {
    clauses.push("(archived_at < ? OR (archived_at = ? AND id < ?))");
    params.push(cursor.at, cursor.at, cursor.id);
  }
  const rows = db.query("SELECT * FROM knowledge_nodes_archive" + where() +
    " ORDER BY archived_at DESC, id DESC LIMIT ?").all(...params, limit + 1) as (KnowledgeNodeRow & { archived_at: string })[];
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    archive: visible.map((row) => ({ ...rowToNode(row), archivedAt: row.archived_at })),
    total,
    nextCursor: rows.length > limit && last
      ? Buffer.from(JSON.stringify({ at: last.archived_at, id: last.id })).toString("base64url") : null,
  };
}
