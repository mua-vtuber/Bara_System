/**
 * classify-vocab-user-repo.ts — classify_vocab_user_entries CRUD (분류 어휘 DB 단계1).
 *
 * 대시보드 "분류 어휘" 설정 탭에서 손으로 추가하는 분류 어휘 행을 DB 에 보존한다.
 * 검색 동의어의 SynonymUserRepo(synonyms/synonym-user-repo.ts)를 본보기로 미러한
 * 단순 CRUD — bun:sqlite Database 를 주입받아 prepared statement 로 처리한다.
 *
 * 검색 동의어는 (term, synonym, lang) 2차원 쌍이지만, 분류 어휘는 (타입, 칸, 값)
 * 3차원이다 — `type_name`(어느 종류)·`slot`(synonyms|subcategories)·`value`(단어).
 *
 * 보존 정책:
 *   - entry_id = 'cvocab_user_' + crypto.randomUUID()
 *     (SynonymUserRepo 의 'syn_user_' prefix+UUID 선례 미러).
 *   - created_at = nowKst() TEXT datetime (다른 코어 테이블과 한 양식으로 통일).
 *     lexicographic 비교가 곧 시간 순서라 ORDER BY created_at 정렬을 유지한다.
 *   - addEntry 는 UNIQUE(type_name, slot, value) 충돌을 멱등 처리한다 — 같은 행을
 *     다시 추가하면 새 행을 만들지 않고 기존 행 id 를 돌려준다(중복 등록 무해 통과).
 */
import type { Database } from "bun:sqlite";
import { nowKst } from "../../db/store-internal/helpers.ts";

/**
 * 항목 동의어 저장 양식 구분자. value 안에 `대표키\t동의어` 두 토큰을 담는다.
 * tab 은 한국어·해시태그 키에 안 나오는 문자라 토큰 충돌이 0 이다(D3).
 */
export const ITEM_SYNONYM_SEPARATOR = "\t";

/**
 * `대표키\t동의어` 두 토큰을 갈라 검증한다. tab 이 없거나 어느 토큰이 비면
 * 식별자를 담은 명시 에러를 던진다(silent skip 금지). 양쪽 토큰은 trim 한다.
 */
export function parseItemSynonymValue(value: string): { canonical: string; alias: string } {
  const idx = value.indexOf(ITEM_SYNONYM_SEPARATOR);
  if (idx < 0) {
    throw new Error(
      `item_synonym: value '${value}' 에 tab 구분자가 없음 — '대표키\\t동의어' 두 토큰이어야 한다`,
    );
  }
  const canonical = value.slice(0, idx).trim();
  const alias = value.slice(idx + 1).trim();
  if (!canonical || !alias) {
    throw new Error(
      `item_synonym: 대표키·동의어 두 토큰 중 빈 토큰이 있음 (받음: 대표키='${canonical}', 동의어='${alias}')`,
    );
  }
  return { canonical, alias };
}

/**
 * 사용자 편집 대상 칸. 단계1 은 synonyms·subcategories 둘이었고, 단계2 가
 * attributes(정보 항목·라벨)·item_synonym(항목 동의어)을 더했다.
 * 단계3 T8 이 columns(칸 어휘·is_column=1 색인 속성·D15)를 더한다 — 새 종류는 칸·라벨
 * 둘 다 자유 추가 가능(D8). 단계6b 가 column_types(칸 datatype 표지·`칸키\t(number|date)` 두
 * 토큰)를 더한다 — 칸 어휘가 아니라 별 datatype 맵 입력이라 어휘 칸에 안 펼친다.
 * slot 은 schema 상 자유 TEXT 라 새 slot 값을 더해도 테이블 모양이 안 바뀐다(v24 그대로·DDL 0).
 *
 * (2026-06-27 콜론 사슬 구조 배치 spec §6-B·단계1 D2) 옛 seeds slot 은 제거했다 — 종류
 * 씨앗(일반명사 자동 배치 어휘)이 사라졌다. 빈 DB 시작이라 옛 seeds 행은 없다.
 */
export type ClassifyVocabSlot =
  | "synonyms"
  | "subcategories"
  | "attributes"
  | "columns"
  | "column_types"
  | "item_synonym";

/** addEntry 입력 — entry_id/created_at 은 repo 가 채운다. */
export interface AddClassifyVocabInput {
  /** 배치 타입 이름(예: 'work'·'creature'). PlacementTypeName 문자열. */
  typeName: string;
  /** 어느 칸인지 — synonyms(타입 지시 동의어) | subcategories(하위 갈래). */
  slot: ClassifyVocabSlot;
  /** 등록 단어(예: '창작물'·'소설'). */
  value: string;
}

/** listEntries 반환 — DB 식별자/타임스탬프를 더한 view(camelCase). */
export interface ClassifyVocabUserEntryView {
  entryId: string;
  typeName: string;
  slot: ClassifyVocabSlot;
  value: string;
  createdAt: string;
}

/** classify_vocab_user_entries 행 형태(snake_case). */
interface ClassifyVocabEntryRow {
  entry_id: string;
  type_name: string;
  slot: string;
  value: string;
  created_at: string;
}

/**
 * classify_vocab_user_entries 전담 CRUD.
 * SynonymUserRepo 와 같은 양식 — Database 주입 + prepared statement.
 */
export class ClassifyVocabUserRepo {
  constructor(private readonly db: Database) {}

  private newEntryId(): string {
    return `cvocab_user_${crypto.randomUUID()}`;
  }

  /**
   * 분류 어휘 행 추가. UNIQUE(type_name, slot, value) 가 이미 있으면 새 행을 만들지
   * 않고 기존 행 entry_id 를 돌려준다(멱등 — 같은 행 재등록 무해). entry_id 반환.
   */
  addEntry(input: AddClassifyVocabInput): string {
    // item_synonym 은 value 에 '대표키\t동의어' 두 토큰을 담는다 — tab 없거나 빈
    // 토큰이면 명시 에러(silent skip 금지). 다른 slot 은 단어 그대로라 검증 안 한다.
    if (input.slot === "item_synonym") {
      parseItemSynonymValue(input.value);
    }

    const existing = this.db
      .prepare(
        "SELECT entry_id FROM classify_vocab_user_entries WHERE type_name = ? AND slot = ? AND value = ?",
      )
      .get(input.typeName, input.slot, input.value) as { entry_id: string } | null;
    if (existing) return existing.entry_id;

    const id = this.newEntryId();
    const now = nowKst();
    this.db
      .prepare(
        `INSERT INTO classify_vocab_user_entries
           (entry_id, type_name, slot, value, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.typeName, input.slot, input.value, now);

    return id;
  }

  /** 분류 어휘 행 목록. created_at 오름차순(추가 순서)으로 돌려준다. */
  listEntries(): ClassifyVocabUserEntryView[] {
    const rows = this.db
      .prepare("SELECT * FROM classify_vocab_user_entries ORDER BY created_at ASC")
      .all() as ClassifyVocabEntryRow[];
    return rows.map((r) => ({
      entryId: r.entry_id,
      typeName: r.type_name,
      slot: r.slot as ClassifyVocabSlot,
      value: r.value,
      createdAt: r.created_at,
    }));
  }

  /** 한 행을 entry_id 로 찾아 돌려준다(없으면 undefined). 짝 삭제 라우트가 지우려는 행의
   *  slot·type_name·value 를 보고 column_types 짝을 함께 지울지 가른다(S8 길 B). */
  getEntry(id: string): ClassifyVocabUserEntryView | undefined {
    const r = this.db
      .prepare("SELECT * FROM classify_vocab_user_entries WHERE entry_id = ?")
      .get(id) as ClassifyVocabEntryRow | null;
    if (!r) return undefined;
    return {
      entryId: r.entry_id,
      typeName: r.type_name,
      slot: r.slot as ClassifyVocabSlot,
      value: r.value,
      createdAt: r.created_at,
    };
  }

  /**
   * 한 종류의 한 칸 키(columns slot value)에 대응하는 column_types 행 entry_id 를 찾는다
   * (S8 길 B 짝 삭제). column_types value 는 '칸키\tdatatype' 두 토큰이라, 첫 토큰(tab 앞)을
   * 소문자 비교해 칸 키와 맞는 행을 고른다(buildColumnTypeMap 파싱과 같은 규칙). 없으면
   * undefined(글자형 칸은 column_types 행이 애초에 없다 — no-op).
   */
  findColumnTypeEntryId(typeName: string, columnKey: string): string | undefined {
    const target = columnKey.trim().toLowerCase();
    const rows = this.db
      .prepare(
        "SELECT entry_id, value FROM classify_vocab_user_entries WHERE type_name = ? AND slot = 'column_types'",
      )
      .all(typeName) as { entry_id: string; value: string }[];
    for (const r of rows) {
      const sep = r.value.indexOf(ITEM_SYNONYM_SEPARATOR);
      const key = (sep < 0 ? r.value : r.value.slice(0, sep)).trim().toLowerCase();
      if (key === target) return r.entry_id;
    }
    return undefined;
  }

  /** 분류 어휘 행 삭제. 없는 id 면 0 행 변경(에러 아님 — 멱등 삭제). */
  deleteEntry(id: string): void {
    this.db
      .prepare("DELETE FROM classify_vocab_user_entries WHERE entry_id = ?")
      .run(id);
  }
}
