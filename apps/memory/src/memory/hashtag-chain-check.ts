/**
 * memory/hashtag-chain-check.ts — 저장된 글의 해시태그를 서버가 어떻게 읽었는지 되짚어 경고를 만든다
 * (2026-10-21 mcp-usage-and-guidance spec 12.4, P18).
 *
 * 저장은 그대로 하고, 의도와 다르게 읽혔을 법한 태그만 알려 AI 가 고칠 수 있게 한다. 판정은 저장
 * 파이프라인이 쓰는 바로 그 파서·판정 함수를 다시 불러서 한다 — 정규식이나 값 경계 규칙을 여기에
 * 복사하지 않는다(경고가 말하는 읽기 = 실제 읽기):
 *   - scanClassificationKeys(콜론 태그와 값 경계), parseTags·isHashtagKeyChar(콜론 없는 태그),
 *   - traceChainLeaf(사슬 순회), parseHashtagEntities·decideProjectDeclaration(프로젝트 선언),
 *   - store.findProjectByNameOrAlias(애매한 프로젝트 이름).
 *
 * 평범한 메모 보장: "해시태그 자리"(글 맨 앞, 또는 바로 앞 글자가 공백·쉼표·줄바꿈)에 `#` + 키 글자가
 * 하나도 없으면 바로 빈 배열이다. 그래서 `C#`, URL 조각(`page#intro`)만 있는 글은 경고하지 않는다.
 * 콜론 없는 태그만 있는 글(`#AI기록, 본문`, `이슈 #42 해결`)은 모든 경우가 콜론 태그나 하이픈을
 * 요구하므로 경고가 나오지 않는다.
 *
 * memory 층이라 mcp 층을 참조하지 않는다. 응답 칸 조립(상한·오류 칸)은 mcp/hashtag-warning-fields.ts.
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import { traceChainLeaf } from "./entity-placement-loop-internal/chain-structure.ts";
import {
  HASHTAG_WARNING_MESSAGES,
  type HashtagSavedAs,
} from "./hashtag-chain-messages.ts";
import {
  decideProjectDeclaration,
  planProjectAttachment,
  type ProjectAttachmentPlan,
} from "./project-attachment-plan.ts";
import { scanClassificationKeys, type ClassificationKeyMatch } from "./parsers/classification-tag.ts";
import { parseHashtagEntities } from "./parsers/hashtag-entity-parser.ts";
import { loadReservedKeys, type ReservedKeyMap } from "./parsers/hashtag-reserved-keys.ts";
import { isHashtagKeyChar, parseTags } from "./tag-extractor.ts";

export const HASHTAG_WARNING_CODES = [
  "BODY_ABSORBED", "HYPHEN_SPLIT", "EMPTY_VALUE", "CHAIN_CYCLE",
  "EXTRA_PROJECT_CHAIN", "PROJECT_NOT_CREATED", "PROJECT_AMBIGUOUS", "PROJECT_ARGUMENT_OVERRIDDEN",
] as const;
export type HashtagWarningCode = (typeof HASHTAG_WARNING_CODES)[number];

export interface HashtagWarning {
  code: HashtagWarningCode;
  /** 적힌 그대로의 태그 조각(앞뒤 공백 제거, 길면 잘라 "..." 표시). */
  tag: string;
  /** 서버가 읽은 방식. */
  readAs: string;
  /** 영어 안내 문장(hashtag-chain-messages.ts 단일 출처). */
  message: string;
}

/** tag 칸에 싣는 조각의 최대 글자 수 — 넘으면 자르고 TAG_EXCERPT_ELLIPSIS 를 붙인다. */
export const HASHTAG_TAG_EXCERPT_MAX = 120;
const TAG_EXCERPT_ELLIPSIS = "...";

export interface HashtagCheckContext {
  savedAs: HashtagSavedAs;
}

/** `#` 가 해시태그 자리인지 — 글 맨 앞이거나 바로 앞 글자가 공백·쉼표·줄바꿈. */
function isHashtagPosition(text: string, index: number): boolean {
  return index === 0 || /[\s,]/u.test(text[index - 1]!);
}

/** 해시태그 자리에 `#` + 키 글자가 하나라도 있는지 — 없으면 평범한 메모다. */
function hasHashtagAtPosition(text: string): boolean {
  for (let i = text.indexOf("#"); i !== -1; i = text.indexOf("#", i + 1)) {
    if (isHashtagPosition(text, i) && isHashtagKeyChar(text[i + 1])) return true;
  }
  return false;
}

function excerpt(fragment: string): string {
  const trimmed = fragment.trim();
  return trimmed.length > HASHTAG_TAG_EXCERPT_MAX
    ? trimmed.slice(0, HASHTAG_TAG_EXCERPT_MAX) + TAG_EXCERPT_ELLIPSIS
    : trimmed;
}

function tagFragment(content: string, match: ClassificationKeyMatch): string {
  return content.slice(match.index, match.valueEnd);
}

class WarningList {
  readonly items: HashtagWarning[] = [];
  constructor(private readonly ctx: HashtagCheckContext, private readonly keys: ReservedKeyMap) {}

  add(code: HashtagWarningCode, fragment: string, readAs: string, key?: string, colon = true): void {
    const reservedKey = key !== undefined && this.keys[key] !== undefined;
    const message = HASHTAG_WARNING_MESSAGES[code]({ savedAs: this.ctx.savedAs, reservedKey, colon });
    this.items.push({ code, tag: excerpt(fragment), readAs, message });
  }
}

function checkBodyAbsorbed(content: string, colon: ClassificationKeyMatch[], out: WarningList): void {
  if (colon.length === 0 || parseTags(content).cleanContent.trim().length > 0) return;
  for (const match of colon) {
    if (!/\s/u.test(match.value)) continue;
    out.add("BODY_ABSORBED", tagFragment(content, match),
      `key "${match.rawCategory}", value "${match.value}"`, match.rawCategory);
  }
}

function checkHyphenSplit(content: string, colon: ClassificationKeyMatch[], out: WarningList): void {
  for (let i = content.indexOf("#"); i !== -1; i = content.indexOf("#", i + 1)) {
    if (!isHashtagPosition(content, i)) continue;
    let keyEnd = i + 1;
    while (isHashtagKeyChar(content[keyEnd])) keyEnd += 1;
    if (keyEnd === i + 1 || content[keyEnd] !== "-" || !isHashtagKeyChar(content[keyEnd + 1])) continue;
    const colonMatch = colon.find((match) => match.index === i);
    let end = keyEnd;
    if (colonMatch !== undefined) {
      end = colonMatch.valueEnd;
    } else {
      while (content[end] === "-" || isHashtagKeyChar(content[end])) end += 1;
    }
    const fragment = content.slice(i, end);
    // 콜론 없는 태그 파서가 이 조각을 실제로 어떻게 읽는지 — 태그 하나와 본문에 남는 글자.
    const plain = parseTags(fragment);
    const plainRead = `tag "${plain.tags[0] ?? ""}", text "${plain.cleanContent}" left in body`;
    out.add("HYPHEN_SPLIT", fragment, colonMatch !== undefined
      ? `colon reader: key "${colonMatch.rawCategory}"; plain reader: ${plainRead}`
      : `plain ${plainRead}`, undefined, colonMatch !== undefined);
  }
}

function checkEmptyValue(content: string, colon: ClassificationKeyMatch[], out: WarningList): void {
  for (const match of colon) {
    if (match.value.length > 0) continue;
    out.add("EMPTY_VALUE", content.slice(match.index, match.valueStart),
      `key "${match.rawCategory}", empty value`, match.rawCategory);
  }
}

function checkChainCycle(content: string, colon: ClassificationKeyMatch[], out: WarningList): void {
  const reported = new Set<string>();
  for (const match of colon) {
    if (match.value.length === 0 || reported.has(match.rawCategory.trim().toLowerCase())) continue;
    const trace = traceChainLeaf(match.value, content);
    if (!trace.cycle) continue;
    for (const key of trace.keys) reported.add(key);
    out.add("CHAIN_CYCLE", tagFragment(content, match),
      `chain returns to key "${trace.leaf}"; read as value "${trace.leaf}"`);
  }
}

function projectMatches(content: string, keys: ReservedKeyMap): ClassificationKeyMatch[] {
  // parseHashtagEntities 와 같은 순서·같은 조건(값 있는 태그, 예약 키 갈래 entity_project).
  return scanClassificationKeys(content)
    .filter((match) => match.value.length > 0 && keys[match.rawCategory]?.kind === "entity_project");
}

/**
 * 저장 *전에* 부른다 — 이 글의 프로젝트 사슬 끝 이름이 지금 프로젝트 둘 이상과 겹치는지.
 * 판정은 저장 경로와 같은 planProjectAttachment 의 not_attached/ambiguous 다.
 *
 * 저장 전에 보는 이유: 저장 경로가 쓰는 판정을 같은 순간의 프로젝트 목록으로 보기 위해서다. 타입 배치도
 * 같은 이름·별칭 조회를 써서 애매한 이름으로 행을 만들지 않으므로(2026-10-22 수정) 저장 뒤에 봐도 보통은
 * 같지만, 저장 사이에 다른 쓰기가 별칭을 바꿀 수 있다. 조회 실패는 그대로 던진다.
 */
export async function checkProjectAmbiguityBeforeSave(content: string, store: SqliteMemoryStore): Promise<boolean> {
  if (!hasHashtagAtPosition(content)) return false;
  const plan = await planProjectAttachment(store, content);
  return plan.kind === "not_attached" && plan.reason === "ambiguous";
}

export interface HashtagAnalysisContext extends HashtagCheckContext {
  /** 저장 전에 계산한 프로젝트 붙이기 계획(planProjectAttachment) — 애매함 판정에 쓴다. */
  projectPlan: ProjectAttachmentPlan;
  /** 사슬이 다른 프로젝트의 project 인자를 덮어쓰면 그 인자 값(predictWriteProject). 아니면 null. */
  overriddenArgument: string | null;
}

/**
 * 저장이 끝난 글(쓰기 관문을 지난 글)을 다시 읽어 경고 목록을 만든다. 경고가 없으면 빈 배열.
 * store 를 보지 않는다 — 프로젝트 판정은 저장 전에 계산한 계획(ctx.projectPlan)을 쓴다.
 */
export function analyzeHashtagChain(content: string, ctx: HashtagAnalysisContext): HashtagWarning[] {
  if (!hasHashtagAtPosition(content)) return [];
  const keys = loadReservedKeys();
  const out = new WarningList(ctx, keys);
  const colon = scanClassificationKeys(content).filter((match) => isHashtagPosition(content, match.index));

  checkBodyAbsorbed(content, colon, out);
  checkHyphenSplit(content, colon, out);
  checkEmptyValue(content, colon, out);
  checkChainCycle(content, colon, out);

  const declarations = parseHashtagEntities(content, keys).projectDeclarations;
  const projectTags = projectMatches(content, keys);
  if (projectTags.length !== declarations.length) {
    throw new Error(
      `hashtag-chain-check: 프로젝트 태그 자리 ${projectTags.length}개와 파서의 프로젝트 선언 ${declarations.length}개가 다름`,
    );
  }
  for (let i = 1; i < declarations.length; i += 1) {
    out.add("EXTRA_PROJECT_CHAIN", tagFragment(content, projectTags[i]!),
      `used "${declarations[0]}"; ignored "${declarations[i]}"`);
  }
  const decision = decideProjectDeclaration(content, declarations);
  if (decision === null) return out.items;
  const firstFragment = tagFragment(content, projectTags[0]!);
  const plan = ctx.projectPlan;
  if (!decision.create) {
    out.add("PROJECT_NOT_CREATED", firstFragment, `project chain ends on "${decision.projectName}"`);
  } else if (plan.kind === "not_attached" && plan.reason === "ambiguous") {
    out.add("PROJECT_AMBIGUOUS", firstFragment,
      `project name "${decision.projectName}" matches more than one project; no project attached`);
  } else if (ctx.overriddenArgument !== null && (plan.kind === "existing" || plan.kind === "new")) {
    out.add("PROJECT_ARGUMENT_OVERRIDDEN", firstFragment,
      `project argument "${ctx.overriddenArgument}" replaced by chain project "${plan.name}"`);
  }
  return out.items;
}
