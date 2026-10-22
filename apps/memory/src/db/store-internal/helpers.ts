/**
 * store-internal/helpers.ts — 공유 헬퍼 함수 모음.
 *
 * nowKst / nowInZone: 설정 시간대 기준 현재 시각 반환.
 * setTimeZone / getConfiguredTimeZone: 애플리케이션 전역 시간대 주입·조회.
 * pastCutoffInZone: 과거 컷오프 시각을 설정 시간대 문자열로 생성(저장값과 같은 zone).
 * rowToNode / rowToEdge / rowToMemoryRevision: SQLite raw row → 도메인 타입 변환.
 */

import type {
  ConceptEdge,
  ConceptEdgeRelation,
  ConceptNode,
  EdgeRelation,
  MemoryEdge,
  MemoryNode,
  MemoryRevision,
  MemoryType,
  Person,
  Polarity,
  Project,
  ProjectStatus,
  RevisionType,
  SourceType,
} from "../../memory/types.ts";
import type {
  ConceptEdgeRow,
  ConceptNodeRow,
  EdgeRow,
  KnowledgeNodeRow,
  MemoryRevisionRow,
  PersonRow,
  ProjectRow,
} from "./row-types.ts";

/**
 * 애플리케이션 전역 시간대 default. 설정(settings.time.zone)이 주입되기 전까지
 * 이 값이 저장 시각·상대 날짜·컷오프 계산의 기준이다. 옛 nowKst 동작(항상 KST)과
 * byte 동일한 default 라, setTimeZone 미호출 통로(테스트·부팅 전)는 회귀 0 이다.
 */
const DEFAULT_TIME_ZONE = "Asia/Seoul";

/**
 * 현재 애플리케이션 시간대. 부팅 시 index.ts 가 settings.time.zone 을 setTimeZone
 * 으로 한 번 주입한다. 저장 시각(nowInZone/nowKst)·상대 날짜 anchor·보관 컷오프가
 * 전부 이 단일 값을 읽어, "저장은 A zone·컷오프는 B zone" 같은 시간대 혼재를
 * 원천 차단한다. 미주입이면 DEFAULT_TIME_ZONE(KST).
 */
let configuredTimeZone: string = DEFAULT_TIME_ZONE;

/**
 * 시간대 문자열이 Intl 이 아는 IANA 이름인지 검증한다. 잘못된 zone 은 조용히
 * 넘기지 않고 loud 하게 throw 한다(정직한 실패 — silent fallback 금지). Intl 이
 * 미지원 zone 에 RangeError 를 던지는 성질을 그대로 활용한다.
 */
function assertValidTimeZone(zone: string): void {
  try {
    // 미지원 zone 이면 RangeError. 지원 zone 이면 부작용 없이 통과.
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new Error(
      `setTimeZone: 알 수 없는 시간대 "${zone}" — IANA 시간대 이름이어야 한다(예: "Asia/Seoul", "UTC", "America/New_York").`,
    );
  }
}

/**
 * 애플리케이션 전역 시간대를 설정한다. 부팅 시 index.ts 가 settings.time.zone 으로
 * 한 번 호출한다. 이후의 모든 nowInZone/nowKst/pastCutoffInZone 이 이 값을 따른다.
 * 잘못된 zone 문자열은 loud fail(assertValidTimeZone).
 */
export function setTimeZone(zone: string): void {
  assertValidTimeZone(zone);
  configuredTimeZone = zone;
}

/** 현재 설정된 애플리케이션 시간대(IANA 이름). 미주입이면 DEFAULT_TIME_ZONE. */
export function getConfiguredTimeZone(): string {
  return configuredTimeZone;
}

/**
 * 주어진 IANA 시간대 기준 현재 시각을 SQLite 호환 포맷("YYYY-MM-DD HH:MM:SS")으로 반환.
 *
 * 왜 SQLite의 datetime('now', 'localtime')을 안 쓰나:
 *   - Windows 네이티브 bun.exe가 WSL bash의 TZ 환경변수를 상속받지 않음
 *     (cmd → wsl → bun 경계에서 누락). 결과적으로 datetime('now', 'localtime')
 *     이 UTC로 떨어짐.
 *   - JS의 Intl 기반 toLocaleString은 OS/런타임/TZ 환경변수와 무관하게
 *     항상 명시한 timeZone을 따름 → portable + 결정론적.
 *
 * A1 Linux ARM 이전 시점에도 코드 그대로 동작 (Intl ICU는 모든 플랫폼 공통).
 * zone 미지정 시 설정 시간대(getConfiguredTimeZone)를 따른다.
 */
export function nowInZone(zone: string = configuredTimeZone): string {
  return new Date().toLocaleString("sv-SE", {
    timeZone: zone,
    hour12: false,
  });
}

/**
 * 설정 시간대 기준 현재 시각("YYYY-MM-DD HH:MM:SS"). nowInZone 의 얇은 래퍼로,
 * 옛 이름(nowKst)을 그대로 유지해 26개 소비처를 무변경으로 둔다. default 시간대가
 * KST 라 setTimeZone 미호출 시 옛 동작과 byte 동일(회귀 0). zone 을 바꾸면 그때부터
 * 저장 시각이 그 zone 을 따른다.
 */
export function nowKst(): string {
  return nowInZone();
}

/**
 * 설정 시간대 날짜("YYYY-MM-DD") — 하루 단위 집계(문서 OCR 하루 호출 수, MCP 도구 호출 횟수)의 기준 날짜 단일 출처.
 * now 를 주면 그 시각 문자열("YYYY-MM-DD HH:MM:SS")의 날짜 부분을 돌려준다.
 */
export function zoneDay(now: string = nowKst()): string {
  return now.slice(0, 10);
}

/**
 * 과거 컷오프 시각을 설정 시간대 기준 SQLite 문자열("YYYY-MM-DD HH:MM:SS")로 만든다.
 *
 * 저장 시각(archived_at·created_at)이 nowInZone 으로 같은 zone 에 적히므로, 보관·통계
 * 컷오프도 같은 zone 으로 만들어야 lexicographic 비교가 정확하다. 옛 코드는 컷오프를
 * `new Date(...).toISOString()`(UTC)으로 만들어 KST 저장값과 9시간 어긋났다(P3 G3-b
 * 실버그). 이 함수가 그 혼재를 없앤다 — 저장·컷오프가 한 zone.
 *
 * @param pastMs 컷오프 기준 시각(밀리초 UTC epoch). 보통 Date.now() - N*day.
 */
export function pastCutoffInZone(
  pastMs: number,
  zone: string = configuredTimeZone,
): string {
  return new Date(pastMs).toLocaleString("sv-SE", {
    timeZone: zone,
    hour12: false,
  });
}

export function rowToNode(row: KnowledgeNodeRow): MemoryNode {
  let metadata: Record<string, unknown> = {};
  if (row.metadata_json) {
    try {
      const parsed = JSON.parse(row.metadata_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt JSON should never happen because we always insert via
      // JSON.stringify, but if a hand-edited row appears, surface it with
      // an empty object rather than throwing.
      metadata = {};
    }
  }
  return {
    id: row.id,
    content: row.content,
    memoryType: row.memory_type as MemoryType,
    sourceType: row.source_type as SourceType,
    importance: row.importance,
    confidence: row.confidence,
    platform: row.platform,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
    lastAccessedAt: row.last_accessed_at,
    // Phase 7 갈래 1 — 사건 발생 시각(v11 event_at). null = 시각 미상 그대로 노출.
    // null ≠ 검색 실패 — 검색 시간 범위 필터(Task 5)가 COALESCE(event_at, created_at)
    // 로 거르므로 NULL 노드도 created_at 으로 자연 흐른다(누락 마스킹 아님).
    eventAt: row.event_at ?? null,
    // 활용 단계2 ① — 일정 종료 일시(v23 event_until). null = 단일 시점 그대로 노출.
    eventUntil: row.event_until ?? null,
    accessCount: row.access_count,
    mentionCount: row.mention_count,
    lastMentionedAt: row.last_mentioned_at,
    metadata,
    // D7 polarity(1.1c T3) — 라벨 없으면 NULL 그대로 노출한다. NULL ≠ 검색 실패:
    // polarity 한정 query 필터가 NULL 노드를 제외하는 것은 의도된 필터 의미지
    // 데이터 누락 마스킹이 아니다(plan 회귀 함정 4 / Mock Policy).
    polarity: (row.polarity ?? null) as Polarity | null,
    // project_id — 소속 프로젝트 없으면 NULL 그대로 노출(검색·RRF 무관·그래프
    // 표시 입력). 그래프 조립이 이 값으로 프로젝트 → 글 연결선을 그린다.
    projectId: row.project_id ?? null,
  };
}

export function rowToEdge(row: EdgeRow): MemoryEdge {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    relation: row.relation as EdgeRelation,
    weight: row.weight,
    createdAt: row.created_at,
  };
}

export function rowToMemoryRevision(row: MemoryRevisionRow): MemoryRevision {
  return {
    id: row.id,
    oldNodeId: row.old_node_id,
    newNodeId: row.new_node_id,
    revisionType: row.revision_type as RevisionType,
    reason: row.reason,
    similarityScore: row.similarity_score,
    oldContent: row.old_content ?? null,
    newContent: row.new_content ?? null,
    editor: row.editor ?? null,
    editSource: row.edit_source ?? null,
    createdAt: row.created_at,
  };
}

/** JSON array 칸을 string[] 로 안전 파싱. null/깨짐 → 빈 배열. */
function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed as string[];
    }
  } catch {
    // 깨진 JSON 은 빈 배열 — 손으로 편집된 행 방어.
  }
  return [];
}

/** JSON object 칸을 Record<string,string> 로 안전 파싱. null/깨짐 → 빈 객체. */
export function parseStringRecord(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    // 깨진 JSON 방어.
  }
  return {};
}

/**
 * JSON object 칸을 Record<string,unknown> 로 안전 파싱. null/깨짐/비객체 → 빈 객체.
 *
 * parseStringRecord 와 갈래가 다르다 — 값을 string 으로 강제하지 않고 원형 그대로
 * 보존한다(혈액형·MBTI 외 숫자·중첩 객체 같은 자유형 사실용). 빈 객체 {} 는 빈
 * JSON 칸의 정당한 default 이지 실패한 서비스를 가리는 것이 아니다(attributes_json
 * 은 NOT NULL DEFAULT '{}').
 */
function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 깨진 JSON 방어.
  }
  return {};
}

export function rowToConcept(row: ConceptNodeRow): ConceptNode {
  return {
    conceptId: row.concept_id,
    name: row.name,
    koName: row.ko_name,
    koAliases: parseStringArray(row.ko_aliases),
    enAliases: parseStringArray(row.en_aliases),
    description: row.description,
    isTag: Boolean(row.is_tag),
    isClassificationKey: Boolean(row.is_classification_key),
    isClassificationValue: Boolean(row.is_classification_value),
    tagUsageCount: row.tag_usage_count,
    classificationUsageCount: row.classification_usage_count,
    searchBlacklist: Boolean(row.search_blacklist),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToPerson(row: PersonRow): Person {
  return {
    personId: row.person_id,
    displayName: row.display_name,
    aliases: parseStringArray(row.aliases),
    externalRefs: parseStringRecord(row.external_refs),
    // 1.2 확장 — 고유 사실 셋은 NULL 그대로 노출(미상). NULL ≠ 검색 실패.
    birthday: row.birthday ?? null,
    address: row.address ?? null,
    gender: row.gender ?? null,
    attributes: parseJsonObject(row.attributes_json),
    embeddingText: row.embedding_text ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToProject(row: ProjectRow): Project {
  return {
    projectId: row.project_id,
    name: row.name,
    summary: row.summary,
    // status DB 칸은 TEXT 무제약 — 도메인 입력 통로(Task 4)가 ProjectStatus 로 검증한다.
    status: row.status as ProjectStatus,
    attributes: parseJsonObject(row.attributes_json),
    embeddingText: row.embedding_text ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 분류 단계4 T5 — 옛 신규 8 타입 전용 매퍼(rowToWork~rowToSchedule)·rowToEntityBase 는
// T4 가 8 repository 를 지우며 고아가 됐다(호출처 0). 범용 본체는 entities-repository.ts 의
// rowToUserEntity 한 매퍼가 10종을 한 통로로 변환하므로 여기서 제거했다. person·project
// 매퍼(rowToPerson 양식·아래)는 전용 통로를 유지해 그대로 남는다.

export function rowToConceptEdge(row: ConceptEdgeRow): ConceptEdge {
  return {
    sourceConceptId: row.source_concept_id,
    targetConceptId: row.target_concept_id,
    relation: row.relation as ConceptEdgeRelation,
    weight: row.weight,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
