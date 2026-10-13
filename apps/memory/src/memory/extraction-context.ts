/**
 * extraction-context.ts — LLM 추출에 넘기는 시스템 확정 메타 envelope.
 *
 * LLM 이 보는 본문(cleanContent)만으로는 `#나, 스스로 ...` 같은 입력에서
 * 해시태그로 이미 확정된 의미가 사라져, "스스로" 같은 자기지시어를 새 사람으로
 * 오인할 수 있다. 이 파일은 기존 해시태그 파서 산출과 사람 alias 조회를 묶어
 * LLM 에는 context 로 전달하고, 적용 단계에는 잠금/차단 정책으로 전달한다.
 */

import { parseHashtagEntities } from "./parsers/hashtag-entity-parser.ts";
import { parseTags } from "./tag-extractor.ts";
import { resolveChainLeafValue } from "./entity-placement-loop.ts";

export interface ExtractionFieldLocks {
  person?: boolean;
  place?: boolean;
  eventDate?: boolean;
}

export interface ExplicitExtractionMetadata {
  tags: string[];
  persons: string[];
  projects: string[];
  projectAliases: string[];
  places: string[];
  eventDateTexts: string[];
}

export interface ExtractionContext {
  originalText: string;
  analysisText: string;
  explicitMetadata: ExplicitExtractionMetadata;
  lockedFields: ExtractionFieldLocks;
  blockedPersonNames: string[];
}

export interface ExtractionContextStore {
  findPersonByNameOrAlias(name: string): Promise<{
    person: { displayName: string; aliases?: string[] } | null;
    ambiguous: boolean;
  }>;
}

export const SELF_REFERENCE_PERSON_NAMES = [
  "나",
  "내",
  "내가",
  "나는",
  "난",
  "나를",
  "나의",
  "저",
  "제가",
  "저는",
  "전",
  "저를",
  "저의",
  "본인",
  "본인이",
  "본인은",
  "본인의",
  "자신",
  "자신이",
  "자신은",
  "자기",
  "자기가",
  "자기는",
  "스스로",
  "우리",
  "우리가",
  "우리는",
  "우린",
  "저희",
  "저희가",
  "저희는",
] as const;

export function normalizePersonNameForPolicy(name: string): string {
  return name.trim().replace(/\s+/g, "").toLowerCase();
}

export function isSelfReferencePersonName(name: string): boolean {
  const normalized = normalizePersonNameForPolicy(name);
  return SELF_REFERENCE_PERSON_NAMES.some(
    (self) => normalizePersonNameForPolicy(self) === normalized,
  );
}

export async function buildExtractionContext(
  store: ExtractionContextStore,
  originalText: string,
  analysisText?: string,
): Promise<ExtractionContext> {
  const tagResult = parseTags(originalText);
  const entities = parseHashtagEntities(originalText);
  const cleanAnalysisText =
    analysisText !== undefined
      ? analysisText
      : tagResult.cleanContent.length > 0
        ? tagResult.cleanContent
        : originalText;

  const persons = new UniqueTextList();
  const places = new UniqueTextList();
  const eventDateTexts = new UniqueTextList();
  const blockedPersonNames = new UniqueTextList();

  for (const self of SELF_REFERENCE_PERSON_NAMES) {
    blockedPersonNames.add(self);
  }

  const lockedFields: ExtractionFieldLocks = {};

  for (const person of entities.personDeclarations) {
    if (persons.add(person)) {
      blockedPersonNames.add(person);
    }
  }
  if (entities.personDeclarations.length > 0) {
    lockedFields.person = true;
  }

  const projects = new UniqueTextList();
  const projectAliases = new UniqueTextList();
  for (const project of entities.projectDeclarations) {
    const leaf = resolveChainLeafValue(project, originalText);
    if (projects.add(leaf)) {
      blockedPersonNames.add(leaf);
    }
  }
  if (entities.projectDeclarations.length > 0) {
    for (const alias of entities.aliases) {
      if (projectAliases.add(alias)) {
        blockedPersonNames.add(alias);
      }
    }
  }

  for (const place of entities.placeFields) {
    places.add(place);
  }
  if (entities.placeFields.length > 0) {
    lockedFields.place = true;
  }

  for (const field of entities.directFields) {
    if (field.column === "event_at" || field.column === "event_until") {
      eventDateTexts.add(field.value);
      lockedFields.eventDate = true;
    }
  }

  for (const tag of tagResult.tags) {
    if (isSelfReferencePersonName(tag)) {
      blockedPersonNames.add(tag);
      lockedFields.person = true;
    }

    const lookup = await store.findPersonByNameOrAlias(tag);
    if (lookup.person && !lookup.ambiguous) {
      persons.add(lookup.person.displayName);
      blockedPersonNames.add(lookup.person.displayName);
      blockedPersonNames.add(tag);
      for (const alias of lookup.person.aliases ?? []) {
        blockedPersonNames.add(alias);
      }
      lockedFields.person = true;
    }
  }

  return {
    originalText,
    analysisText: cleanAnalysisText,
    explicitMetadata: {
      tags: tagResult.tags,
      persons: persons.values(),
      projects: projects.values(),
      projectAliases: projectAliases.values(),
      places: places.values(),
      eventDateTexts: eventDateTexts.values(),
    },
    lockedFields,
    blockedPersonNames: blockedPersonNames.values(),
  };
}

class UniqueTextList {
  private readonly seen = new Set<string>();
  private readonly ordered: string[] = [];

  add(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return false;
    const key = normalizePersonNameForPolicy(trimmed);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.ordered.push(trimmed);
    return true;
  }

  values(): string[] {
    return [...this.ordered];
  }
}
