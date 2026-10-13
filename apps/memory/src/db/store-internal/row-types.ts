/**
 * store-internal/row-types.ts — SQLite row 인터페이스 모음.
 *
 * knowledge_nodes / knowledge_edges / memory_revisions 테이블에서
 * bun:sqlite 가 반환하는 raw row 구조를 타입으로 정의한다.
 * store.ts 공개 타입이 아니라 내부 mapper 전용이므로 export 하되
 * store.ts 에서 `import type` 으로만 가져온다.
 */

export interface KnowledgeNodeRow {
  id: number;
  content: string;
  memory_type: string;
  source_type: string;
  importance: number;
  confidence: number;
  platform: string;
  author: string;
  created_at: string;
  updated_at?: string | null;
  last_accessed_at: string;
  access_count: number;
  mention_count: number;
  last_mentioned_at: string | null;
  metadata_json: string;
  /**
   * D7 감정 극성 라벨(기준 스키마 / default NULL). 입력 통로는
   * AddNodeArgs.polarity(1.1c T1). rowToNode 가 이 칸을 읽어 도메인 MemoryNode
   * 에 노출한다(1.1c T3) — polarity 한정 query 필터(spec 5.5)가 이 값을 거른다.
   */
  polarity?: string | null;
  /**
   * Phase 7 갈래 1 — 사건 발생 시각(기준 스키마 / default NULL). 입력
   * 통로는 AddNodeArgs.eventAt / NodeRepository.setEventAt. rowToNode 가 이 칸을
   * 읽어 도메인 MemoryNode.eventAt 에 노출한다 — 검색 시간 범위 필터(Task 5)가
   * COALESCE(event_at, created_at) 로 이 값을 거른다.
   */
  event_at?: string | null;
  /**
   * 활용 단계2 ① 칼럼(기준 스키마 / default NULL). 일정 종료 일시 —
   * NULL 이면 단일 시점. 입력 통로 = 직접 입력 칸(#일정종료) / setEventUntil.
   * archive 보존·복원이 이 값을 그대로 옮긴다(유실 차단). 검색 구간 겹침이
   * COALESCE(event_until, event_at, created_at) 끝 칼럼으로 이 값을 본다.
   */
  event_until?: string | null;
  /**
   * D6 임베딩 입력 본문(기준 스키마 / default NULL). archive 보존·복원이 이 값을
   * 그대로 옮긴다(1.2 T13 / spec 10.3 A-5). SELECT * 행에 항상 들어 있다.
   */
  embedding_text?: string | null;
  /** D8 다중 프로젝트 가르마(기준 스키마 / default NULL). archive 보존·복원 대상(A-5). */
  project_id?: string | null;
}

export interface EdgeRow {
  id: number;
  source_id: number;
  target_id: number;
  relation: string;
  weight: number;
  created_at: string;
}

export interface MemoryRevisionRow {
  id: number;
  old_node_id: number;
  new_node_id: number | null;
  revision_type: string;
  reason: string | null;
  similarity_score: number | null;
  old_content?: string | null;
  new_content?: string | null;
  editor?: string | null;
  edit_source?: string | null;
  created_at: string;
}

export interface ConceptNodeRow {
  concept_id: string;
  name: string;
  ko_name: string | null;
  ko_aliases: string | null;
  en_aliases: string | null;
  description: string | null;
  is_tag: number;
  is_classification_key: number;
  is_classification_value: number;
  tag_usage_count: number;
  classification_usage_count: number;
  search_blacklist: number;
  created_at: string;
  updated_at: string;
}

export interface PersonRow {
  person_id: string;
  display_name: string;
  aliases: string | null;
  external_refs: string | null;
  // 1.2 확장 칸(기준 스키마). 고유 사실 셋은 NULL 허용,
  // attributes_json 은 NOT NULL DEFAULT '{}' 라 항상 문자열이 온다.
  birthday: string | null;
  address: string | null;
  gender: string | null;
  attributes_json: string;
  embedding_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  project_id: string;
  name: string;
  summary: string | null;
  status: string;
  attributes_json: string;
  embedding_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectConceptEdgeRow {
  project_id: string;
  concept_id: string;
  role: string;
  created_at: string;
}

export interface NodeConceptEdgeRow {
  node_id: number;
  concept_id: string;
  role: string;
  created_at: string;
}

export interface NodePersonEdgeRow {
  node_id: number;
  person_id: string;
  relation: string;
  created_at: string;
}

export interface ConceptEdgeRow {
  source_concept_id: string;
  target_concept_id: string;
  relation: string;
  weight: number;
  created_at: string;
  updated_at: string;
}

// 분류 단계4 T5 — 신규 8 타입 전용 EntityRowBase·WorkRow~ScheduleRow 인터페이스는
// T4 가 8 repository 를 지우며 고아가 됐다(참조 0). 범용 본체 row 는 entities-repository.ts
// 의 EntityRow(파일 내부 타입)·UserEntity(view)가 단일 출처라 여기 정의를 제거했다.
