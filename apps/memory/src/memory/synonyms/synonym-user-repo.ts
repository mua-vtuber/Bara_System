/**
 * synonym-user-repo.ts — synonym_user_entries CRUD (웨이브3 동의어 설정 탭 항목12 B1).
 *
 * 대시보드 동의어 설정 탭에서 손으로 추가하는 동의어 쌍(term ↔ synonym)을 DB 에
 * 보존한다. RegexUserRepo(regex-l0/user-repo.ts)를 본보기로 미러한 단순 CRUD —
 * bun:sqlite Database 를 주입받아 prepared statement 로 처리한다.
 *
 * 보존 정책:
 *   - entry_id = 'syn_user_' + crypto.randomUUID()
 *     (RegexUserRepo 의 'rpat_user_'/'rbst_user_' prefix+UUID 선례 재사용).
 *   - created_at = nowKst() TEXT datetime (다른 코어 테이블과 한 양식으로 통일).
 *     lexicographic 비교가 곧 시간 순서라 ORDER BY created_at 정렬을 유지한다.
 *   - addEntry 는 UNIQUE(term, synonym, lang) 충돌을 멱등 처리한다 — 같은 쌍을 다시
 *     추가하면 새 행을 만들지 않고 기존 행 id 를 돌려준다(중복 등록 무해 통과).
 */
import type { Database } from "bun:sqlite";
import { nowKst } from "../../db/store-internal/helpers.ts";

/** addEntry 입력 — entry_id/created_at 은 repo 가 채운다. */
export interface AddSynonymInput {
  /** 원본 용어(예: '고양이'). */
  term: string;
  /** 동의어(예: '냥이'). */
  synonym: string;
  /** 미지정 시 'ko'. */
  lang?: string;
}

/** listEntries 반환 — DB 식별자/타임스탬프를 더한 view(camelCase). */
export interface SynonymUserEntryView {
  entryId: string;
  term: string;
  synonym: string;
  lang: string;
  createdAt: string;
}

/** synonym_user_entries 행 형태(snake_case). */
interface SynonymEntryRow {
  entry_id: string;
  term: string;
  synonym: string;
  lang: string;
  created_at: string;
}

/**
 * synonym_user_entries 전담 CRUD.
 * RegexUserRepo 와 같은 양식 — Database 주입 + prepared statement.
 */
export class SynonymUserRepo {
  constructor(private readonly db: Database) {}

  private newEntryId(): string {
    return `syn_user_${crypto.randomUUID()}`;
  }

  /**
   * 동의어 쌍 추가. UNIQUE(term, synonym, lang) 가 이미 있으면 새 행을 만들지 않고
   * 기존 행 entry_id 를 돌려준다(멱등 — 같은 쌍 재등록 무해). entry_id 반환.
   */
  addEntry(input: AddSynonymInput): string {
    const lang = input.lang && input.lang.length > 0 ? input.lang : "ko";

    const existing = this.db
      .prepare(
        "SELECT entry_id FROM synonym_user_entries WHERE term = ? AND synonym = ? AND lang = ?",
      )
      .get(input.term, input.synonym, lang) as { entry_id: string } | null;
    if (existing) return existing.entry_id;

    const id = this.newEntryId();
    const now = nowKst();
    this.db
      .prepare(
        `INSERT INTO synonym_user_entries
           (entry_id, term, synonym, lang, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.term, input.synonym, lang, now);

    return id;
  }

  /** 동의어 쌍 목록. created_at 오름차순(추가 순서)으로 돌려준다. */
  listEntries(): SynonymUserEntryView[] {
    const rows = this.db
      .prepare("SELECT * FROM synonym_user_entries ORDER BY created_at ASC")
      .all() as SynonymEntryRow[];
    return rows.map((r) => ({
      entryId: r.entry_id,
      term: r.term,
      synonym: r.synonym,
      lang: r.lang,
      createdAt: r.created_at,
    }));
  }

  /** 동의어 쌍 삭제. 없는 id 면 0 행 변경(에러 아님 — 멱등 삭제). */
  deleteEntry(id: string): void {
    this.db.prepare("DELETE FROM synonym_user_entries WHERE entry_id = ?").run(id);
  }
}
