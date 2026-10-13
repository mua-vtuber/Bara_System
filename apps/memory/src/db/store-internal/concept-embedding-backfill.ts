/**
 * concept-embedding-backfill.ts — 옛 개념 행에 embedding_text + concept_vec
 * 채우기 (장수 DB / 1.1a 진입 시 1회). 멱등 — 이미 concept_vec 가 있는 개념은
 * 건너뛴다. 채운 개념 수를 반환한다.
 */
import type { Database } from "bun:sqlite";
import type { Embedder } from "../../embedding/types.ts";
import type { ConceptNodeRow } from "./row-types.ts";

/**
 * concept_vec 가 없는 개념 행 전체에 embedding_text 를 합성하고 임베딩을 채운다.
 * embedding_text = name + ko_name + ko_aliases + en_aliases + description 합성,
 * 모두 비면 name fallback(name 은 NOT NULL 이라 항상 존재). dim mismatch 는
 * 구체 에러 throw — silent fallback 금지.
 */
export async function backfillConceptEmbeddings(
  db: Database,
  embedder: Embedder,
): Promise<number> {
  const rows = db
    .query(
      `SELECT cn.rowid AS rid, cn.* FROM concept_nodes cn
       WHERE cn.rowid NOT IN (SELECT concept_rowid FROM concept_vec)`,
    )
    .all() as Array<ConceptNodeRow & { rid: number }>;

  let count = 0;
  for (const r of rows) {
    const text =
      [r.name, r.ko_name ?? "", r.ko_aliases ?? "", r.en_aliases ?? "", r.description ?? ""]
        .filter((p) => p && String(p).trim())
        .join(" ")
        .trim() || r.name;
    const vec = await embedder.embed(text);
    if (vec.length !== embedder.dimension) {
      throw new Error(
        `backfillConceptEmbeddings dim mismatch: got ${vec.length}, expected ${embedder.dimension} (concept_id=${r.concept_id})`,
      );
    }
    db.run("UPDATE concept_nodes SET embedding_text = ? WHERE rowid = ?", [text, r.rid]);
    db.run("INSERT OR REPLACE INTO concept_vec(concept_rowid, embedding) VALUES (?, ?)", [
      r.rid,
      vec,
    ]);
    count++;
  }
  return count;
}
