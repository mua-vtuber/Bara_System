/**
 * server-internal/profile.ts — get_profile 내부 함수 (T25 / spec H).
 *
 * "통째 주입" 표면 — 검색이 아니다. 선호(memoryType='preference')는 질의와 의미
 * 유사하지 않은 경우가 많아 유사도 검색에 구조적으로 누락된다(spec H 현재 문제
 * 진술). 이 함수는 검색을 전혀 거치지 않고, `idx_kn_memory_type` 인덱스를 타는
 * 단순 SELECT 로 preference 트랙 전체를 facet 별로 묶어 그대로 회신한다
 * (임베딩 0 · LLM 0 · 유사도 검색 0 — spec H "동작 비용").
 *
 * facet 분류 원칙(spec H 목표):
 *   - 닫힌 enum(PROFILE_FACETS) 다섯 종. save_preference 저장 시점에 metadata.facet
 *     으로 기록된 값만 그 facet 아래 묶인다.
 *   - facet 미지정 저장분(이 필드 도입 전 기존 행 포함)은 `unclassified` 로 묶어
 *     정직 회신한다 — 추론으로 자동 분류하지 않는다(오분류가 조용한 규칙 누락을
 *     만든다는 spec H 의 명시적 금지). 기존 저장분의 facet 소급 분류는 cleanup
 *     제안 흐름의 후속 후보로만 남긴다(이 함수 범위 밖).
 *   - 회신 대상이 0건이면 에러가 아닌 설명 포함 성공 응답을 회신한다(spec H
 *     openhuman flavour 선례) — `{ facets: {}, note: ... }`. 문구는 원인별로
 *     갈린다(아래 WP-B1-16 단락).
 *
 * REST(GET /profile)·MCP(get_profile) 양쪽이 이 한 함수를 그대로 재노출한다
 * (doctor.ts 선례 — 두 표면이 항상 같은 문구·같은 순서를 갖는다는 계약이 이
 * 단일 출처에서 자동으로 나온다).
 *
 * WP-B1-16(SA-7) — 0건 문구의 원인 구분. 옛 동작은 저장 행이 아예 없을 때와
 * 가시성 필터로 전부 빠졌을 때를 구분하지 않고 똑같이 "no preferences stored
 * yet"을 돌려줬다(예: 유일한 선호를 철회하면 "보관된 선호가 없다"는 거짓 인상을
 * 준다 — 실은 있지만 지금 안 보이는 것). 이제 세 원인을 나눈다:
 *   1) 저장 행 자체가 0건 — NOTE_NONE_STORED(문구 불변, 기존 계약 유지).
 *   2) 저장 행은 있으나 가시성 필터(scope·활성 상태)로 전부 빠짐 —
 *      NOTE_NONE_CURRENT + omitted.outOfScope(다른 프로젝트 소속)·
 *      omitted.notCurrent(철회·대체 등 비활성) 건수. matchesMemoryScope 로
 *      두 원인을 나눈다 — scope 밖이면 outOfScope, scope 는 맞는데 비활성 상태라
 *      readMemoryVisibility 가 뺐으면 notCurrent.
 *   3) facet 지정 조회인데 그 facet 에 해당하는 항목이 없음 — 위 두 상태와
 *      달리 회신 대상 전체가 아니라 facet 하나만 비어 있는 것이므로
 *      noteForFacet(facet) 로 별도 문구를 만든다.
 */

import type { MemoryApiDeps } from "./types.ts";
import { rowToNode } from "../db/store-internal/helpers.ts";
import type { KnowledgeNodeRow } from "../db/store-internal/row-types.ts";
import type { MemoryType } from "../memory/types.ts";
import {
  matchesMemoryScope, readSharedMemoryForNode, type MemoryReadScope, type ResolvedMemoryScope,
  type SharedMemoryState,
} from "../memory/shared-memory-contract.ts";
import { resolveMemoryReadScope, scopeNoteFields } from "../memory/project-scope-resolver.ts";
import { readMemoryVisibility } from "../memory/shared-memory-read.ts";
import { listOpenConflicts, listOriginMarks, type OriginMarks } from "../memory/open-conflicts.ts";

/**
 * 이 표면이 통째 주입하는 선호 트랙 값. `MemoryType` 합집합에서 값을 가져와
 * SQL 리터럴 오기를 typecheck 가 잡게 한다 — cleanup-deep-pass 후보 검출기들의
 * EXCLUDED_MEMORY_TYPE 관례(값만 같고 참조는 각자 `MemoryType` 에서)와 같은
 * 양식이다(Task 28 minor 마감). 이름이 다른 이유: 저쪽은 후보 *배제* 값이고
 * 여기는 회신 *대상* 값이라 역할이 반대다 — 상수 공유가 아니라 관례 공유다.
 */
const PROFILE_MEMORY_TYPE: MemoryType = "preference";

/**
 * facet 닫힌 enum(spec H) — save_preference 저장 입력과 get_profile 조회 입력이
 * 공유하는 단일 출처. 여기서 값 하나를 늘리거나 줄이면 두 표면(저장·조회) 모두
 * 자동으로 같은 집합을 따른다.
 */
export const PROFILE_FACETS = [
  "directives",
  "anti_preferences",
  "communication",
  "workflow",
  "stack",
] as const;

export type ProfileFacet = (typeof PROFILE_FACETS)[number];

/** facet 미지정 저장분(기존 행 포함)이 묶이는 고정 버킷 이름. PROFILE_FACETS 와 겹치지 않는다. */
export const UNCLASSIFIED_FACET = "unclassified" as const;

/**
 * SA-7 문구 단일 출처. 세 원인이 서로 다른 문구를 써야 정직하다 — "저장분 자체가
 * 없다"와 "저장은 됐지만 지금 안 보인다"를 같은 문구로 뭉개면, 유일한 선호를
 * 철회한 사용자가 "선호를 저장한 적이 없다"는 잘못된 인상을 받는다.
 */
export const NOTE_NONE_STORED = "no preferences stored yet";
export const NOTE_NONE_CURRENT = "no current preferences in this scope";
export function noteForFacet(facet: ProfileFacet): string {
  return `no preferences for facet ${facet}`;
}

/**
 * 가시성 필터로 빠진 저장 행의 두 원인. matchesMemoryScope 로 나눈다 — scope 가
 * 요구하는 프로젝트(전역 포함 여부 포함)에 안 맞으면 outOfScope, scope 는 맞지만
 * readMemoryVisibility 가 비활성(철회·대체·유효기간 밖 등)으로 판단해 뺐으면
 * notCurrent. 둘 다 저장 행의 *내용* 은 절대 담지 않는다 — 개수만 센다.
 */
export interface ProfileOmitted {
  outOfScope: number;
  notCurrent: number;
}

/** get_profile 응답 한 항목 — 통째 주입 표면이므로 본문 전체를 담는다(검색 결과의 excerpt 와 다름). */
export interface ProfileEntry {
  id: number;
  content: string;
  createdAt: string;
  projectId: string | null;
  author: string;
  sharedMemory: SharedMemoryState;
  /**
   * WP-B1-10(SL-3 표시) — 아직 해소되지 않은 충돌 상대 기억의 id 목록. 상대 본문은 담지
   * 않는다(정직한 id 만 표시 — disputed 기억은 이 표면에도 본문으로 오르지 않는다).
   */
  conflicts: number[];
  /**
   * WP-B1-10R — 이 기억이 원문(auto_capture 등)일 때, 그 원문에서 추출된 자식의 열린 충돌·
   * 대체된 주장 표시(사용자 결정 2026-09-29 1안). 자식이 없거나 두 표시 모두 없으면 undefined.
   */
  originMarks?: OriginMarks;
}

/** get_profile 응답. facets 키는 지정된 facet(들) 또는 전체 다섯 종 + unclassified. */
export interface ProfileReport {
  facets: Partial<Record<ProfileFacet | typeof UNCLASSIFIED_FACET, ProfileEntry[]>>;
  /** 회신 대상 전체가 비었을 때만 채워지는 설명 문구(spec H). 그 외에는 필드 자체를 생략한다. */
  note?: string;
  /** note 가 NOTE_NONE_CURRENT 일 때만 동반 — 가시성 필터로 빠진 저장 행의 원인별 개수. */
  omitted?: ProfileOmitted;
}

/** metadata.facet 값이 닫힌 enum 안에 있는지 좁힌다. 그 외(오탈자·구버전 값 포함)는 전부 unclassified 로 간다. */
function isProfileFacet(value: unknown): value is ProfileFacet {
  return typeof value === "string" && (PROFILE_FACETS as readonly string[]).includes(value);
}

/**
 * getProfile 입력 — facet 생략 시 전 facet 회신(spec H). scope 는 해석이 끝난 범위만 받는다
 * (프로젝트 이름·옛 글자값 해석은 project-scope-resolver.ts, 2026-10-21 spec 10.2).
 */
export interface GetProfileArgs {
  facet?: ProfileFacet;
  scope: ResolvedMemoryScope;
  includeInactive?: boolean;
}

/** REST GET /profile·MCP get_profile 입력 — 밖에서 받은 그대로의 범위. */
export interface ProfileRequest {
  facet?: ProfileFacet;
  scope?: MemoryReadScope;
  includeInactive?: boolean;
}

/** 두 표면의 응답 — 실제로 적용한 범위와, 범위를 안 줬을 때의 안내 문구를 함께 싣는다. */
export type ProfileResponse = ProfileReport & { scope: ResolvedMemoryScope; scopeNote?: string };

/**
 * REST·MCP 공용 입구: 범위를 해석하고(기본값 = 프로젝트 없는 기억만, spec P16) getProfile 을
 * 부른다. 모르는·애매한 프로젝트는 ProjectScopeError 로 던진다 — 빈 결과로 가리지 않는다.
 */
export async function getProfileForRequest(deps: MemoryApiDeps, request: ProfileRequest): Promise<ProfileResponse> {
  // 프로젝트 범위를 주면 전역 선호도 함께 본다(includeGlobal 기본 true — 기존 계약).
  const requested = request.scope
    ? { ...request.scope, includeGlobal: request.scope.includeGlobal ?? true }
    : undefined;
  const scope = await resolveMemoryReadScope(deps.store, requested, "global");
  const report = getProfile(deps, {
    ...(request.facet ? { facet: request.facet } : {}), scope, includeInactive: request.includeInactive,
  });
  return { ...report, scope, ...scopeNoteFields(request.scope) };
}

/**
 * get_profile 본체. REST GET /profile · MCP get_profile 이 그대로 호출한다.
 *
 * 데이터 출처: memory_type='preference' 행 전체를 `idx_kn_memory_type` 인덱스로
 * 걸러 created_at DESC 로 읽는다(최근순 — spec H "response per facet: ordered
 * recent-first"). 그 외 검색·임베딩·유사도 계산은 전혀 돌지 않는다(D-D).
 *
 * 성장 가정: cap 없이 전량 회신한다 — 선호는 성격상 사용자당 수십~백여 건 규모를
 * 가정한 통째 주입 표면이기 때문. 이 가정을 넘는 규모가 실측되면 그때 facet 별
 * cap + 잘림 표시(정직 회신)를 재검토할 것 (T25 검토 Minor 반영).
 */
export function getProfile(deps: MemoryApiDeps, args: GetProfileArgs): ProfileReport {
  const scope = args.scope;
  const visibleIds = readMemoryVisibility(deps.store, scope, args.includeInactive).allowedIds;
  const db = deps.store.getRawDb();
  const rows = db
    .query(
      `SELECT * FROM knowledge_nodes WHERE memory_type = ? ORDER BY created_at DESC, id DESC`,
    )
    .all(PROFILE_MEMORY_TYPE) as KnowledgeNodeRow[];

  if (rows.length === 0) {
    return { facets: {}, note: NOTE_NONE_STORED };
  }

  const buckets = new Map<ProfileFacet | typeof UNCLASSIFIED_FACET, ProfileEntry[]>();
  // SA-7 — 가시성 필터로 빠진 저장 행을 원인별로 센다(내용은 담지 않는다).
  const omitted: ProfileOmitted = { outOfScope: 0, notCurrent: 0 };
  const visibleNodes = rows
    .map((row) => rowToNode(row))
    .filter((node) => {
      if (visibleIds && !visibleIds.has(node.id)) {
        if (matchesMemoryScope(node.projectId, scope)) omitted.notCurrent += 1;
        else omitted.outOfScope += 1;
        return false;
      }
      return true;
    });
  // WP-B1-10(SL-3 표시) — 표시 대상 전체를 한 번의 일괄 질의로 조회해 N+1을 피한다.
  const visibleIdList = visibleNodes.map((node) => node.id);
  const openConflicts = listOpenConflicts(db, visibleIdList);
  // WP-B1-10R — 원문(auto_capture 등)에 자식 계보 표시를 함께 싣는다(같은 일괄 질의 원칙).
  const originMarks = listOriginMarks(db, visibleIdList);
  for (const node of visibleNodes) {
    const rawFacet = node.metadata["facet"];
    const bucket: ProfileFacet | typeof UNCLASSIFIED_FACET = isProfileFacet(rawFacet)
      ? rawFacet
      : UNCLASSIFIED_FACET;
    const marks = originMarks.get(node.id);
    const entry: ProfileEntry = {
      id: node.id, content: node.content, createdAt: node.createdAt, projectId: node.projectId,
      author: node.author, sharedMemory: readSharedMemoryForNode(node),
      conflicts: openConflicts.get(node.id) ?? [],
      ...(marks ? { originMarks: marks } : {}),
    };
    const list = buckets.get(bucket);
    if (list) {
      list.push(entry);
    } else {
      buckets.set(bucket, [entry]);
    }
  }

  const facets: ProfileReport["facets"] = {};
  const wanted: ReadonlyArray<ProfileFacet | typeof UNCLASSIFIED_FACET> = args.facet
    ? [args.facet]
    : [...PROFILE_FACETS, UNCLASSIFIED_FACET];
  for (const key of wanted) {
    const list = buckets.get(key);
    if (list) facets[key] = list;
  }

  if (Object.keys(facets).length > 0) return { facets };
  // 회신 대상이 비었다 — 원인을 가른다. facet 을 지정했는데 그 facet 만 없는
  // 경우는 가시성과 무관하게(가시 항목이 있어도) 별도 문구를 쓴다: 전체가
  // 아니라 그 facet 하나가 빈 것이기 때문이다.
  if (args.facet) return { facets: {}, note: noteForFacet(args.facet) };
  if (omitted.outOfScope + omitted.notCurrent > 0) return { facets: {}, note: NOTE_NONE_CURRENT, omitted };
  return { facets: {}, note: NOTE_NONE_STORED };
}
