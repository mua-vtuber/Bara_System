/**
 * 메모리 저장 진입점에서 작성자의 사람 신원 자동 upsert + authored_by 엣지.
 *
 * 1.0b — 사람 신원은 persons 테이블(TEXT id). author(display name) +
 * metadata.user_id(영구 ID) 가 둘 다 있을 때 findOrCreatePerson 으로 사람을
 * 보장하고, 자산 글 → 사람 node_person_edges relation='authored_by' 추가.
 *
 * Attribution 둘 중 하나라도 없으면(author 빈 문자열, user_id 누락) no-op —
 * 사람 신원을 추적할 수 없는 경우 강제로 person 을 만들지 않는다.
 * Discord 작성자는 attribution으로만 보존한다. 사람 엔티티는 본문 #사람 선언 등
 * 의미 입력으로 만들며, 작성 사실만으로 새 사람이나 authored_by 연결을 만들지 않는다.
 *
 * autoLinkMentions(본문 매칭) 와 별개 — 이 helper 는 *작성자* 추적,
 * autoLinkMentions 는 *본문에 언급된* 개념 추적.
 */

import type { Person } from "./types.ts";
import { isAttributionOnlyPlatform } from "./attribution-platform.ts";

export interface PersonLinkStore {
  findOrCreatePerson(args: {
    displayName: string;
    userId: string;
    source?: string;
  }): Promise<Person>;
  addNodePersonEdge(
    nodeId: number,
    personId: string,
    relation: "mentions" | "authored_by",
    provenance: "system",
    sourceNodeId: number,
  ): Promise<boolean>;
}

export interface LinkAuthorArgs {
  /** 방금 저장된 자산 글 노드 id */
  nodeId: number;
  /** Attribution display name — 빈 문자열이면 no-op */
  author?: string;
  /** 원래 입력 플랫폼. 추출 과정에서 metadata.source가 바뀌어도 출처를 보존한다. */
  platform?: string;
  /** 메모리 metadata — `user_id`, `source` 추출 */
  metadata?: Record<string, unknown>;
}

export interface LinkAuthorResult {
  /** 만들거나 찾은 사람 id (no-op 시 null) */
  personId: string | null;
  /** authored_by 엣지가 새로 추가됐는지 (이미 있으면 false) */
  edgeAdded: boolean;
}

export async function linkAuthorPerson(
  store: PersonLinkStore,
  args: LinkAuthorArgs,
): Promise<LinkAuthorResult> {
  // 원문·첨부는 source, LLM 추출물은 platform으로 Discord 출처를 식별한다.
  // 기존 사람/엣지는 건드리지 않고 새 작성자 자동 연결만 생략한다.
  const isAttributionOnly = [args.platform, args.metadata?.platform, args.metadata?.source]
    .some((value) => typeof value === "string" && isAttributionOnlyPlatform(value.trim()));
  if (isAttributionOnly) return { personId: null, edgeAdded: false };

  const author = args.author?.trim();
  const userId =
    typeof args.metadata?.user_id === "string"
      ? args.metadata.user_id.trim()
      : "";
  if (!author || !userId) {
    return { personId: null, edgeAdded: false };
  }

  const source =
    typeof args.metadata?.source === "string"
      ? args.metadata.source
      : undefined;

  const person = await store.findOrCreatePerson({
    displayName: author,
    userId,
    source,
  });

  const added = await store.addNodePersonEdge(
    args.nodeId,
    person.personId,
    "authored_by",
    "system",
    args.nodeId,
  );
  return { personId: person.personId, edgeAdded: added };
}
