/**
 * server-internal/save-input-regex.ts — regex Level 0 atomic 저장·연결 헬퍼
 * (P3 G5-a 분해 — 옛 save-input.ts 에서 이동, 내용 무변경).
 *
 * plain 갈래(saveOriginThenChunks)와 immediate 추출 갈래가 같은 규칙으로
 * regex atomic 을 원본에 merged_into 한다(입력 통로 통합 D1).
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import type { NodeProvenance } from "../memory/node-sources/source-ref.ts";
import type { MemoryType } from "../memory/types.ts";
import type { RegexCandidate } from "../memory/regex-l0/extractor.ts";
import { scoreToImportance } from "../memory/regex-l0/score-decision.ts";
import { parseTags } from "../memory/tag-extractor.ts";
import type { SaveTextInputArgs } from "./save-input-types.ts";

/**
 * Task 6 — regex Level 0 atomic 저장 + raw(원본) 연결. memories.ts linkRegexAtomics
 * 헬퍼를 그대로 이식한다(입력 통로 통합 D1 — /memories·/ingest 글 둘 다 같은 규칙).
 *
 * 동작:
 *   - candidates 중 저장 대상(decision !== 'ignore' = metadata !== null) 만 추린다.
 *     ignore 후보(metadata===null)는 atomic 노드를 형성하지 않으므로 제외.
 *   - 각 후보를 atomic 노드로 store.addNode (importance=scoreToImportance(finalScore),
 *     polarity 칸 직접 기재, metadata=buildRegexMetadata 산출, sourceType=auto_capture).
 *     pending_review 후보도 *저장은 함* — metadata 에 이미 pending_review:true /
 *     auto_stored:false 들어있음(검색 비노출은 store 후처리 책임).
 *   - atomic 은 원문의 파생이다(provenance derived, merged_into / regex). 원본으로 가는 계보
 *     엣지는 저장소 흡수 규칙(node-absorption.ts)이 atomic 저장과 같은 트랜잭션에서 쓴다 —
 *     새 atomic 이든, 같은 본문의 기존 노드에 흡수됐든(그 노드 → 원본 엣지). 흡수한 노드가
 *     원본 자신이거나 원본의 계보 조상이면 엣지를 만들지 않는다(WP-B1-20T 설계 3.6). 원본 노드는
 *     항상 보존.
 *   - 중복 정합(사용자 결정 #3): store.addNode 의 content_hash 정확-중복 흡수(P0-A)가
 *     *정확히 같은* 정규화 내용의 atomic 을 한 노드로 합친다. 미세하게 다른(공백·표현)
 *     atomic 은 여전히 별 노드다 — 정확 중복만 흡수하고 근사(sim≥0.99)는 이번 범위
 *     밖이다(spec §9.3). 벡터 dedup(sim≥0.99 bump)은 extractor 의 atomic 저장 경로에만
 *     있고 addNode 에는 없다 — 별 dedup 단계 추가 안 함(content_hash 흡수로 충분).
 *
 * @returns 저장된 atomic 노드 id 배열 (ignore 제외).
 */
async function linkRegexAtomics(
  store: SqliteMemoryStore,
  originNodeId: number,
  candidates: RegexCandidate[],
  memoryType: MemoryType | undefined,
  projectId: string | null,
): Promise<number[]> {
  const provenance: NodeProvenance = {
    kind: "derived",
    parentId: originNodeId,
    relation: "merged_into",
    edgeProvenance: "regex",
  };
  const storedIds: number[] = [];
  for (const cand of candidates) {
    // ignore 후보는 metadata null — atomic 노드 형성 안 함(저장 대상 제외).
    if (cand.metadata === null) continue;
    const childId = await store.addNode({
      content: cand.extractedContent,
      sourceType: "auto_capture",
      importance: scoreToImportance(cand.finalScore),
      polarity: cand.polarity,
      // RegexMetadata 는 named-key interface 라 Record<string, unknown> 인덱스
      // 시그니처가 없다 — 객체 spread 로 plain object 화해 addNode metadata 칸에
      // 정합시킨다. spec 4.2 칸은 그대로 보존된다.
      metadata: { ...cand.metadata },
      memoryType,
      project_id: projectId,
      provenance,
    });
    storedIds.push(childId);
  }
  return storedIds;
}

/**
 * Task 6 — regex Level 0 단계를 한 번 가동해 후보를 추출한다. regexEnabled +
 * regexL0 가용 동시 만족 시에만. extract 는 순수(LLM/임베딩/네트워크 0, ~0.03ms).
 * 실패 시 구체 warn 후 빈 배열 회신 — regex 단계 실패가 원본 저장을 가로막지 않게
 * 한다(silent fallback 금지 정신 정합: 삼킴 안 함, 구체 로그 후 원본 저장 자연 진행).
 *
 * 양식 정밀화 spec §5.3(R3) — 추출 입력을 cleanContent(해시태그 제거)로 정제한다.
 * args.content 원문을 그대로 넘기면 `#나 한국어 응답을 선호한다` 같은 입력의 `#나` 가
 * 추출 조각에 섞인다. immediate LLM 갈래가 이미 쓰는 parseTags 를 그대로 재사용해 단일
 * 출처를 둔다. cleanContent 가 빈 문자열(`#만화` 만 입력 — 태그만 있는 글)이면 추출
 * 단계를 건너뛰고 빈 배열을 회신한다(태그만 있는 글은 atomic 조각 대상이 아니다).
 * 원본 노드 content 통째 저장은 이 정제와 무관하게 그대로다(불변식 A).
 */
export function extractRegexCandidates(args: SaveTextInputArgs): RegexCandidate[] {
  if (args.regexEnabled !== true || !args.regexL0) return [];
  try {
    const cleanContent = parseTags(args.content).cleanContent;
    if (cleanContent.length === 0) return [];
    return args.regexL0.extract(cleanContent).candidates;
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[saveTextInput] regex Level 0 추출 실패 (${errMsg}) — regex atomic 없이 원본 저장 진행`,
    );
    return [];
  }
}

/**
 * Task 6 — regex atomic 저장 + 원본 연결을 실패 격리해 가동한다. 후보 0이면 즉시 [].
 * 저장 실패 시 구체 warn 후 [] 회신 — regex 단계 실패가 원본 보존을 깨지 않게 한다.
 */
export async function linkRegexAtomicsSafe(
  store: SqliteMemoryStore,
  originNodeId: number,
  candidates: RegexCandidate[],
  memoryType: MemoryType | undefined,
  projectId: string | null,
): Promise<number[]> {
  if (candidates.length === 0) return [];
  try {
    return await linkRegexAtomics(
      store,
      originNodeId,
      candidates,
      memoryType,
      projectId,
    );
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[saveTextInput] regex atomic 저장 실패 (${errMsg}) — 원본 ${originNodeId} 는 보존, regex atomic 없이 진행`,
    );
    return [];
  }
}
