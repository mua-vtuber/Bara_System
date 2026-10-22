/**
 * mcp/usage-guide.ts — get_usage_guide 가 돌려주는 사용 안내 문안 단일 출처
 * (2026-10-21 mcp-usage-and-guidance spec 12.2).
 *
 * 서버 지침(instructions.ts)은 세션마다 전량 실리므로 500 단어 아래로 줄였고, 거기서 뺀 자세한 사용법을
 * 여기 둔다. AI 는 첫 저장 전에 한 번 부른다. 소비자가 클라이언트 AI 라 영어다. 1,200 단어 미만
 * (usage-guide.test.ts 가 감시).
 *
 * 문안 속 값은 글자로 박지 않고 단일 출처에서 끼워 넣는다:
 *   - assertionKind 값: SHARED_MEMORY_ASSERTION_KINDS
 *   - save_preference facet 값: PROFILE_FACETS
 *   - 프로젝트 키·그 밖의 예약 키: loadReservedKeys()(갈래별 영어 설명은 RESERVED_KIND_DESCRIPTIONS)
 *   - 해시태그 경고 코드별 설명: HASHTAG_WARNING_GUIDE
 *
 * 정직성 계약(instructions.ts 와 같음): 여기 적힌 동작은 실제 코드와 같아야 한다. 근거:
 *   - 사슬 읽기: memory/parsers/*, memory/tag-extractor.ts, entity-placement-loop-internal/chain-structure.ts
 *   - 프로젝트 사슬이 project 인자를 덮어씀: memory/project-hashtag-resolver.ts(setNodeProjectId), 첫 선언만 씀
 *   - 태그만 남은 글이 엔티티 선언으로 처리됨: memory/entity-input-plan.ts(planEntityInput)
 *   - 범위 해석: memory/project-scope-resolver.ts
 *
 * 읽기 전용 토큰에는 3절(사슬 읽기)과 4절(범위)만 싣는다 — 쓸 수 없는 도구를 권하지 않는다.
 */

import type { TokenScope } from "../federation/sse-tokens.ts";
import { SHARED_MEMORY_ASSERTION_KINDS } from "../memory/shared-memory-contract.ts";
import { PROFILE_FACETS } from "../server-internal/profile.ts";
import { HASHTAG_WARNING_CODES } from "../memory/hashtag-chain-check.ts";
import { HASHTAG_WARNING_GUIDE } from "../memory/hashtag-chain-messages.ts";
import {
  loadReservedKeys,
  requireSingleReservedKey,
  reservedKeyNamesOfKind,
  type NodeFieldColumn,
  type ReservedKeyDef,
  type ReservedKeyMap,
  type ReservedKind,
} from "../memory/parsers/hashtag-reserved-keys.ts";

/**
 * 예약 키 갈래별 영어 설명 — 안내 3절의 "Other reserved keys" 목록에 쓴다. node_field 는 칸마다 뜻이 달라
 * (시작·끝) 이 표 대신 NODE_FIELD_COLUMN_DESCRIPTIONS 를 쓴다.
 */
export const RESERVED_KIND_DESCRIPTIONS: Record<Exclude<ReservedKind, "node_field">, string> = {
  entity_person: "declares a person",
  entity_project: "declares a project",
  attribute: "a fact about the declared person",
  place: "a place",
  alias: "an alias of the declared person or project",
};

/** 글 칸 예약 키(node_field)의 칸별 설명 — 칸이 늘면 Record 라 컴파일이 설명 누락을 막는다. */
export const NODE_FIELD_COLUMN_DESCRIPTIONS: Record<NodeFieldColumn, string> = {
  event_at: "the event start date of this memory",
  event_until: "the event end date of this memory",
};

/** 예약 키 하나의 설명. node_field 인데 칸 지정이 없으면 설정 결함이라 이름을 대며 던진다. */
export function reservedKeyDescription(name: string, def: ReservedKeyDef): string {
  if (def.kind !== "node_field") return RESERVED_KIND_DESCRIPTIONS[def.kind];
  if (def.nodeColumn === undefined) {
    throw new Error(`예약 키 '${name}' 가 node_field 갈래인데 대상 칸(nodeColumn) 지정이 없음`);
  }
  return NODE_FIELD_COLUMN_DESCRIPTIONS[def.nodeColumn];
}

const RESERVED_KIND_ORDER: readonly ReservedKind[] = [
  "entity_person", "attribute", "node_field", "place", "alias",
];

function otherReservedKeys(keys: ReservedKeyMap): string {
  const parts: string[] = [];
  for (const kind of RESERVED_KIND_ORDER) {
    // 같은 설명을 가진 키끼리 한 덩어리로 — node_field 는 칸(시작·끝)마다 갈린다.
    const byDescription = new Map<string, string[]>();
    for (const name of reservedKeyNamesOfKind(keys, kind)) {
      const description = reservedKeyDescription(name, keys[name]!);
      byDescription.set(description, [...(byDescription.get(description) ?? []), name]);
    }
    for (const [description, names] of byDescription) parts.push(`${names.join(", ")} (${description})`);
  }
  return parts.join("; ");
}

function saveToolSection(): string {
  return `WHICH SAVE TOOL
- save_decision: a choice now in force. Include the reasons and the alternatives actually compared. A decision not to pursue something is also a decision: record what was ruled out and why, so it is not proposed again as new.
- save_idea: a possibility not chosen yet. If the user says "later", write the reason and the condition for revisiting that the user stated. Do not invent a missing reason or condition.
- save_question: something asked and left unresolved.
- save_preference: a standing rule about how the user wants work done. Set facet (${PROFILE_FACETS.join(", ")}) when the category is clear. Repeating a preference is a signal, so it is not refused as a duplicate; replaying the same source event does not count twice.
- store_memory: other durable facts and lessons.
Proposal status: when you record whether something is an idea, a plan, adopted, deferred or rejected, state it in the body after the classification chain, for example "Status: deferred". Record the user's stated position, not one you inferred. The server's own status (active, disputed, superseded, retracted) is separate: active does not mean adopted.
When a saved idea is later adopted or rejected, save the decision and put the idea's id in evidence.evidenceRefs. Evidence must be in the same project as the new memory or have no project; a project's id, name and older memories stored under its plain name count as the same project.
The server already records which client wrote each memory; a marker tag for AI-written memories is the user's choice, not required here.`;
}

function lessonSection(): string {
  return `LESSONS
Write a lesson with four labeled parts:
Symptom: what was observed, quoting exact error text.
Cause: the verified root cause; mark an unverified guess as a guess.
Fix: what changed, and where.
Context: project, versions, environment.
Future searches match the symptom, so quote error messages exactly.`;
}

function chainSection(keys: ReservedKeyMap, writeCapable: boolean): string {
  const projectKey = requireSingleReservedKey(keys, "entity_project");
  // 읽기 전용에는 사실 문장만 싣는다 — 쓰는 법 조언은 쓸 수 있는 토큰에만(spec 20.7 m3).
  const lines = writeCapable
    ? [
      `- Examples: #${projectKey}:<category>, #<category>:<project name>, <body> for a project memory; #<area>:<topic>, <body> otherwise.`,
      "- A colon tag is #key:value. Use letters, digits and underscore in keys; avoid hyphens, which two parsers read differently.",
      "- A value ends at the next comma, line break or '#'. Spaces inside a value are kept, so close every tag with a comma or line break before the body.",
      '- If nothing but colon tags remains, the input can be stored as entity declarations instead of memory text. store_memory then answers with type "entity_patch"; the save_* tools answer with an error. Put a comma before the body to avoid this.',
    ]
    : [
      "- A colon tag is #key:value. A hyphen in a key is read differently by the two tag parsers.",
      "- A value ends at the next comma, line break or '#'. Spaces inside a value are kept.",
    ];
  lines.push(
    "- When a value reappears as the next key (#A:B, #B:C), the server reads one path A > B > C and treats the last value as the thing being described.",
    `- #${projectKey}:... is the reserved project key. The last value of its chain names the project: an existing project's name or alias means that project, a new name creates one, and a name matching several projects attaches and creates nothing. The memory is attached to that project, replacing any project argument. A chain that ends on a category (for example #${projectKey}:<category> alone) creates no project. Only the first project chain is attached to the memory; later project chains can still create project entries.`,
    `- Other reserved keys: ${otherReservedKeys(keys)}. Any other key is a free classification label.`,
    "- A tag without a colon (#word) is a plain tag. English letters are lowercased.",
  );
  if (writeCapable) {
    lines.push(
      "- update_memory keeps existing hashtags and cannot change them. To fix tags, save a corrected memory and retract_memory the misread one.",
      '- Reuse names from "classifications" in this response. Prefer an existing name over a new near-synonym.',
    );
  }
  return ["CLASSIFICATION CHAIN (how this server reads hashtags)", ...lines].join("\n");
}

function scopeSection(): string {
  return `PROJECT SCOPE
scope.projectId accepts a project name, an alias or a projectId from "projects" in this response. Older memories stored under a plain name are included with the project of the same name or alias. An unknown or ambiguous value fails with UNKNOWN_PROJECT or AMBIGUOUS_PROJECT; it never returns an empty result instead. A projectId of null means memories with no project only.`;
}

function evidenceSection(): string {
  return `EVIDENCE FIELDS
assertionKind: one of ${SHARED_MEMORY_ASSERTION_KINDS.join(", ")}. Use user_statement only for what the user said.
sourceEventId: an id for the event the memory came from. Reuse it across clients for the same event.
claimKey: separates different claims made in one event.
sessionRef: your session reference, when you have one.
evidenceRefs: ids of memories this one builds on.
validFrom / validUntil: when the fact holds.
Copying a memory is not independent confirmation. Never invent a source or confirmation.`;
}

function warningSection(): string {
  const codes = HASHTAG_WARNING_CODES.map((code) => `- ${code}: ${HASHTAG_WARNING_GUIDE[code]}`);
  return [
    "HASHTAG WARNINGS",
    "A save response may include hashtagWarnings. Each item has code, tag (as you wrote it), readAs (how the server read it) and message. The save is not undone.",
    ...codes,
  ].join("\n");
}

function disputeSection(): string {
  return `RESOLVING A DISPUTE
Similar facts or preferences about the same subject are flagged, not replaced: the newer memory becomes disputed, a conflict candidate linked to the older one. Ask the user which holds, then either supersede_memory the older one with the disputed replacement, which also makes it active, or retract_memory the disputed one to keep the older.`;
}

/**
 * scope 별 안내 문안. 읽기 전용은 사슬 읽기(쓰기 도구 줄 제외)와 범위 두 절만. reservedKeys 는 테스트가
 * 다른 묶음을 넣는 통로이고 운영은 기본값(loadReservedKeys())을 쓴다.
 */
export function buildUsageGuideText(
  scope: TokenScope | undefined,
  reservedKeys: ReservedKeyMap = loadReservedKeys(),
): string {
  const writeCapable = scope !== "read-only";
  const sections = writeCapable
    ? [saveToolSection(), lessonSection(), chainSection(reservedKeys, true), scopeSection(),
      evidenceSection(), warningSection(), disputeSection()]
    : [chainSection(reservedKeys, false), scopeSection()];
  return ["BARA USAGE GUIDE", ...sections.map((section, i) => `${i + 1}. ${section}`)].join("\n\n");
}
