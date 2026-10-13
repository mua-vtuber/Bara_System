/**
 * routes/ingest-file-tags.ts — POST /ingest 파일 공통 해시태그 wiring.
 *
 * 대시보드는 `#고양이` 를 hashtags 배열에 `"고양이"` 로 보낸다. 봇/테스트처럼
 * `"#고양이"` 를 보내는 호출자도 있으므로, 서버 경계에서 둘을 같은 입력으로
 * 정규화한 뒤 이미지·문서 파일 노드에 동일하게 태그/분류를 붙인다.
 */

import type { SqliteMemoryStore } from "../../db/store.ts";
import type { MemoryApiDeps } from "../types.ts";
import { parseTags } from "../../memory/tag-extractor.ts";
import { wireHashtagEntitiesSafe } from "../../memory/hashtag-entity-wiring.ts";
import { wireEntityPlacementSafe } from "../../memory/entity-placement-wiring.ts";

export function hashtagListToContent(hashtags: string[]): string {
  return hashtags
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`))
    .join(" ");
}

async function wireFlatTags(
  store: SqliteMemoryStore,
  nodeIds: number[],
  content: string,
): Promise<void> {
  const flatTags = parseTags(content).tags;
  if (flatTags.length === 0) return;

  const conceptIds: string[] = [];
  for (const tag of flatTags) {
    conceptIds.push(await store.findOrCreateTagConcept(tag));
  }

  for (const nodeId of nodeIds) {
    for (const conceptId of conceptIds) {
      await store.addNodeConceptEdge(
        nodeId,
        conceptId,
        "tag",
        "hashtag",
        nodeId,
      );
    }
  }
}

export async function wireFileHashtagsToNodes(
  store: SqliteMemoryStore,
  nodeIds: number[],
  hashtags: string[],
  trigger: MemoryApiDeps["autoCleanupTrigger"],
  label: string,
): Promise<void> {
  if (nodeIds.length === 0 || hashtags.length === 0) return;

  const content = hashtagListToContent(hashtags);
  if (content.length === 0) return;

  await wireFlatTags(store, nodeIds, content);

  const now = new Date();
  for (const nodeId of nodeIds) {
    await wireHashtagEntitiesSafe(
      store,
      nodeId,
      content,
      trigger,
      label,
      now,
    );
    await wireEntityPlacementSafe(
      store,
      nodeId,
      content,
      trigger,
      label,
      null,
    );
  }
}
