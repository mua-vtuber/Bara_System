/**
 * server-internal/save-input-entity-branches.ts — 글이 아닌 입력 두 갈래
 * (P3 G5-a 분해 — 옛 save-input.ts 에서 이동, 내용 무변경).
 *
 * planEntityInput 판정이 가른 entity_patch(본문 없는 `#타입:대상 #속성:값`)와
 * schedule_occurrence(본문 없는 `#일정:<내용> + 날짜`) 입력을 처리한다. 둘 다
 * 글 노드 대신(또는 일정명만으로) 엔티티/일정 wiring 이 본질인 갈래다.
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import type { NodeSourceRef } from "../memory/node-sources/source-ref.ts";
import { linkAuthorPerson } from "../memory/person-link.ts";
import {
  groupTypeDeclarations,
  excludeDirectInputDeclarations,
} from "../memory/type-declaration-grouping.ts";
import { wireHashtagConceptsSafe } from "../memory/hashtag-wiring.ts";
import { wireEntityPlacement } from "../memory/entity-placement-wiring.ts";
import { wireHashtagEntities } from "../memory/hashtag-entity-wiring.ts";
import {
  buildOriginMetadata,
  deriveTitle,
  resolveInputPlatform,
  saveOriginThenChunks,
} from "./save-input-plain.ts";
import type {
  EntityPatchSummary,
  SaveTextInputArgs,
  SaveTextInputResult,
} from "./save-input-types.ts";

function scheduleOccurrenceName(content: string): string | null {
  const groups = excludeDirectInputDeclarations(
    groupTypeDeclarations(content),
    content,
  );
  if (groups.length !== 1) return null;
  const scheduleGroups = groups.filter((g) => g.type === "schedule");
  if (scheduleGroups.length !== 1) return null;
  const values = scheduleGroups[0]!.declValues;
  if (values.length !== 1) return null;
  const name = values[0]!.trim();
  return name.length > 0 ? name : null;
}

/**
 * 본문 없는 `#일정:<내용> + #날짜/#일정시작/#일정종료` 입력은 엔티티 프로필이
 * 아니라 시간 검색 가능한 일정 발생이다. 노드 본문은 일정명으로 저장하고, 원문
 * 해시태그는 wiring 입력과 metadata.originalText 에만 보존한다.
 *
 * inputSource — 일정 원문의 직접 저장 출처(WP-B1-20T). 새 노드든 같은 일정명 노드에 흡수되든
 * 그 노드에 출처 행이 남는다.
 */
export async function saveScheduleOccurrence(
  store: SqliteMemoryStore,
  args: SaveTextInputArgs,
  inputSource: NodeSourceRef,
): Promise<SaveTextInputResult> {
  const scheduleName = scheduleOccurrenceName(args.content);
  if (scheduleName === null) {
    return saveOriginThenChunks(store, args, deriveTitle(args.content), false, inputSource);
  }

  const title = deriveTitle(scheduleName);
  const { id: originNodeId, reused } = await store.addNodeIdempotent({
    content: scheduleName,
    sourceType: "auto_capture",
    author: args.author,
    platform: args.source,
    memoryType: args.memoryType,
    importance: args.importance,
    project_id: args.projectId,
    metadata: buildOriginMetadata(
      {
        ...args,
        content: scheduleName,
        extraMetadata: {
          ...(args.extraMetadata ?? {}),
          originalText: args.content,
          scheduleOccurrence: true,
          extracted: 1,
          extractedTo: [],
        },
      },
      title,
    ),
    provenance: { kind: "source", source: inputSource },
  });

  // P0-A 입력 멱등성 — 같은 일정명이 이미 있으면 origin 이 재사용된다. 이어지는
  // author/hashtag/엔티티 wiring 은 첫 저장 때 이미 됐으므로 skip 하고 재사용 origin
  // 을 그대로 반환한다(spec §5.2 — 재사용 경로 wiring skip). 언급·출처 기록은
  // addNodeIdempotent 안에서 이미 됐다.
  if (reused) {
    return {
      kind: "memory",
      originNodeId,
      chunkNodeIds: [],
      nodeIds: [originNodeId],
      title,
      extracted: [],
      bumped: [],
      immediateExtractionRan: false,
      entities: [],
      warnings: [],
      cacheHit: true,
    };
  }

  await linkAuthorPerson(store, {
    nodeId: originNodeId,
    author: args.author,
    platform: resolveInputPlatform(args),
    metadata: { user_id: args.userId ?? "", source: args.source },
  });

  const warnings: string[] = [];
  const entities: EntityPatchSummary[] = [];

  await wireHashtagConceptsSafe(
    store,
    originNodeId,
    args.content,
    args.trigger,
    "saveTextInput",
  );

  const hashtagResult = await wireHashtagEntities(store, originNodeId, args.content, {
    trigger: args.trigger,
    provenance: "hashtag",
    now: new Date(),
  });
  for (const personId of hashtagResult.personIds) {
    entities.push({ typeName: "person", id: personId });
  }
  if (hashtagResult.projectId) {
    entities.push({ typeName: "project", id: hashtagResult.projectId });
  }
  warnings.push(...hashtagResult.warnings);

  const placementResult = await wireEntityPlacement(store, originNodeId, args.content, {
    trigger: args.trigger,
    provenance: "hashtag",
  });
  for (const entity of placementResult.entities ?? []) {
    if (
      !entities.some(
        (e) => e.typeName === entity.typeName && e.id === entity.id,
      )
    ) {
      entities.push(entity);
    }
  }
  warnings.push(...placementResult.warnings);

  if (
    entities.length > 0 ||
    hashtagResult.attributesApplied > 0 ||
    hashtagResult.labelsApplied > 0 ||
    placementResult.entityRowCreated ||
    placementResult.hierarchyEdges > 0 ||
    placementResult.relationEdges.length > 0
  ) {
    args.trigger?.emit("hashtag-concept-added");
  }

  return {
    kind: "memory",
    originNodeId,
    chunkNodeIds: [],
    nodeIds: [originNodeId],
    title,
    extracted: [],
    bumped: [],
    immediateExtractionRan: false,
    entities,
    warnings,
    cacheHit: false,
  };
}

/**
 * 엔티티 프로필 패치 갈래 — 본문 없이 `#타입:대상 #속성:값` 만 있는 입력은 글이 아니다.
 * 원본 knowledge_node 를 만들지 않고, 엔티티 row/속성/별명/관계/위계만 갱신한다.
 */
export async function saveEntityProfilePatch(
  store: SqliteMemoryStore,
  args: SaveTextInputArgs,
  title: string,
): Promise<SaveTextInputResult> {
  const warnings: string[] = [];
  const entities: EntityPatchSummary[] = [];

  const hashtagResult = await wireHashtagEntities(store, null, args.content, {
    trigger: args.trigger,
    provenance: "user_input",
  });
  for (const personId of hashtagResult.personIds) {
    entities.push({ typeName: "person", id: personId });
  }
  if (hashtagResult.projectId) {
    entities.push({ typeName: "project", id: hashtagResult.projectId });
  }
  warnings.push(...hashtagResult.warnings);

  const placementResult = await wireEntityPlacement(store, null, args.content, {
    trigger: args.trigger,
    provenance: "user_input",
  });
  for (const entity of placementResult.entities ?? []) {
    if (
      !entities.some(
        (e) => e.typeName === entity.typeName && e.id === entity.id,
      )
    ) {
      entities.push(entity);
    }
  }
  warnings.push(...placementResult.warnings);

  if (
    entities.length > 0 ||
    hashtagResult.attributesApplied > 0 ||
    hashtagResult.labelsApplied > 0 ||
    placementResult.entityRowCreated ||
    placementResult.hierarchyEdges > 0 ||
    placementResult.relationEdges.length > 0
  ) {
    args.trigger?.emit("hashtag-concept-added");
  }

  return {
    kind: "entity_patch",
    originNodeId: null,
    chunkNodeIds: [],
    nodeIds: [],
    title,
    extracted: [],
    bumped: [],
    immediateExtractionRan: false,
    entities,
    warnings,
    // entity_patch 는 origin 노드가 없어 흡수 대상이 아니다(정직한 false).
    cacheHit: false,
  };
}
