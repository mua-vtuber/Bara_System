/**
 * classify-vocab-override-repo.ts — classify_vocab_overrides CRUD
 * (엔티티 관리 통합 S5 · 가림표 층/tombstone).
 *
 * 기본 사전(yaml)·코드 10종이 준 동의어·하위분류·라벨은 파일/코드라 화면에서 못 지운다.
 * 사용자가 "이 값 끄기"를 누르면 이 테이블에 "이 (종류, slot, 값)은 끔" 한 줄을 남기고,
 * 분류 어휘 병합(mergeConceptVocab)이 그 행을 읽어 결과에서 그 값을 뺀다(위에 덮어 숨김).
 *
 * ClassifyVocabUserRepo(classify-vocab-user-repo.ts)를 본보기로 미러한 단순 CRUD —
 * bun:sqlite Database 를 주입받아 prepared statement 로 처리한다. 사용자 추가(더하기)와
 * 끄기(빼기)는 반대 방향 자료라 별 테이블·별 repo 로 둔다(spec §6.2 — user_entries 에
 * kind 칸을 더하지 않는다).
 *
 * 보존 정책:
 *   - override_id = 'cvocab_ovr_' + crypto.randomUUID()
 *     (ClassifyVocabUserRepo 의 'cvocab_user_' prefix+UUID 선례 미러).
 *   - kind = 'tombstone' 고정(끔). 칸은 두어 미래 'override'(덮음) 확장 자리를 남긴다.
 *   - created_at 은 DB default(datetime('now','localtime')) 가 채운다 —
 *     classify_vocab_user_entries 가 nowKst() 를 코드로 채우는 것과 달리, 이 테이블은
 *     schema/마이그레이션 양쪽이 같은 DEFAULT 표현을 둬 두 통로 수렴을 단순화했다.
 *   - addOverride 는 UNIQUE(type_name, slot, value) 충돌을 멱등 처리한다 — 같은 행을
 *     다시 끄면 새 행을 만들지 않고 기존 행 id 를 돌려준다(중복 끄기 무해 통과).
 */
import type { Database } from "bun:sqlite";

/** 끌 수 있는 칸 — 가림표 대상은 동의어·하위분류·라벨 세 칸만(columns·item_synonym·column_types 제외). */
export type ClassifyVocabOverrideSlot = "synonyms" | "subcategories" | "attributes";

/** addOverride 입력 — override_id/created_at 은 repo·DB 가 채운다. */
export interface AddClassifyVocabOverrideInput {
  /** 배치 타입 이름(예: 'work'·'creature'). PlacementTypeName 문자열. */
  typeName: string;
  /** 어느 칸을 끄는지 — synonyms | subcategories | attributes. */
  slot: ClassifyVocabOverrideSlot;
  /** 끌 대상 값(yaml·코드 10종이 준 단어). */
  value: string;
}

/** listOverrides 반환 — DB 식별자/타임스탬프를 더한 view(camelCase). */
export interface ClassifyVocabOverrideView {
  overrideId: string;
  typeName: string;
  slot: ClassifyVocabOverrideSlot;
  value: string;
  kind: string;
  createdAt: string;
}

/** classify_vocab_overrides 행 형태(snake_case). */
interface ClassifyVocabOverrideRow {
  override_id: string;
  type_name: string;
  slot: string;
  value: string;
  kind: string;
  created_at: string;
}

/**
 * classify_vocab_overrides 전담 CRUD.
 * ClassifyVocabUserRepo 와 같은 양식 — Database 주입 + prepared statement.
 */
export class ClassifyVocabOverrideRepo {
  constructor(private readonly db: Database) {}

  private newOverrideId(): string {
    return `cvocab_ovr_${crypto.randomUUID()}`;
  }

  /**
   * 가림표 행 추가(끄기). UNIQUE(type_name, slot, value) 가 이미 있으면 새 행을 만들지
   * 않고 기존 행 override_id 를 돌려준다(멱등 — 같은 값 다시 끄기 무해). override_id 반환.
   * created_at·kind 는 DB default 가 채운다(INSERT 칸에서 뺀다).
   */
  addOverride(input: AddClassifyVocabOverrideInput): string {
    const existing = this.db
      .prepare(
        "SELECT override_id FROM classify_vocab_overrides WHERE type_name = ? AND slot = ? AND value = ?",
      )
      .get(input.typeName, input.slot, input.value) as { override_id: string } | null;
    if (existing) return existing.override_id;

    const id = this.newOverrideId();
    this.db
      .prepare(
        `INSERT INTO classify_vocab_overrides (override_id, type_name, slot, value)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, input.typeName, input.slot, input.value);

    return id;
  }

  /**
   * 가림표 행 삭제(되살리기) — (type_name, slot, value) 로 지운다. 없는 행이면 0 행
   * 변경(에러 아님 — 멱등 삭제). 화면이 끈 값을 다시 켤 때 같은 세 토큰으로 호출한다.
   */
  removeOverride(typeName: string, slot: ClassifyVocabOverrideSlot, value: string): void {
    this.db
      .prepare(
        "DELETE FROM classify_vocab_overrides WHERE type_name = ? AND slot = ? AND value = ?",
      )
      .run(typeName, slot, value);
  }

  /** 가림표 행 삭제(되살리기) — override_id 로 지운다. 없는 id 면 0 행 변경(멱등). */
  removeOverrideById(id: string): void {
    this.db
      .prepare("DELETE FROM classify_vocab_overrides WHERE override_id = ?")
      .run(id);
  }

  /** 가림표 행 목록. created_at 오름차순(끈 순서)으로 돌려준다. */
  listOverrides(): ClassifyVocabOverrideView[] {
    const rows = this.db
      .prepare("SELECT * FROM classify_vocab_overrides ORDER BY created_at ASC")
      .all() as ClassifyVocabOverrideRow[];
    return rows.map((r) => ({
      overrideId: r.override_id,
      typeName: r.type_name,
      slot: r.slot as ClassifyVocabOverrideSlot,
      value: r.value,
      kind: r.kind,
      createdAt: r.created_at,
    }));
  }
}
