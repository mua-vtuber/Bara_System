import type { EntitiesRepository } from "../db/store-internal/entities-repository.ts";
import {
  ENTITY_TYPE_METAS,
  columnDataTypeOf,
} from "../db/store-internal/entity-type-registry.ts";
import type { EntityTypeRegistryDb } from "../db/store-internal/entity-type-registry-db.ts";
import type { MemoryNode, Person } from "./types.ts";
import {
  getColumnDataType,
  getTypeColumns,
  type PlacementTypeName,
} from "./concept-type-vocabulary.ts";
import { extractEventDateTime } from "./event-date.ts";
import { SCHEDULE_HIDDEN_KEY, SCHEDULE_OCCURRENCE_KEY, SCHEDULE_SOURCE_NODE_KEY } from "./cleanup-deep-pass/entity-register/constants.ts";

export type DateOccurrenceKind = "event" | "birthday" | "column_date";
export type DateOccurrenceRole = "event" | "birthday" | "expiration" | "generic";

export interface DateOccurrenceTarget {
  nodeId: string;
  type: string;
  id: string | number;
  label: string;
}

export interface DateOccurrenceSource {
  type: "event" | "person" | "entity";
  id: string | number;
}

export interface DateOccurrence {
  kind: DateOccurrenceKind;
  date: string;
  dateTime?: string;
  endDateTime?: string;
  columnKey?: string;
  role: DateOccurrenceRole;
  title: string;
  target: DateOccurrenceTarget;
  source: DateOccurrenceSource;
  originalDateText?: string;
}

export interface DateOccurrenceWindow {
  today: string;
  until: string;
  pastSince: string;
  days: number;
  pastDays: number;
}

export interface DateOccurrenceResponse {
  upcoming: DateOccurrence[];
  past: DateOccurrence[];
  window: DateOccurrenceWindow;
  generatedAt: string;
}

export interface DateOccurrenceOptions {
  now?: Date;
  days?: number;
  pastDays?: number;
  kinds?: ReadonlySet<DateOccurrenceKind>;
  column?: string;
  q?: string;
  limit?: number;
}

export interface DateOccurrenceDeps {
  getAllNodes(limit?: number): Promise<MemoryNode[]>;
  listPersons(options?: { limit?: number }): Promise<Person[]>;
  entitiesRepo: EntitiesRepository;
  entityTypeRegistryDb: EntityTypeRegistryDb;
}

interface ParsedDateValue {
  date: string;
  dateTime?: string;
}

interface DateColumnDescriptor {
  typeName: string;
  columnKey: string;
  attrKey: string;
  role: DateOccurrenceRole;
}

const DEFAULT_DAYS = 90;
const DEFAULT_PAST_DAYS = 90;
const DEFAULT_LIMIT = 80;

const ISO_DATE_TIME =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::\d{2})?)?/;
const KO_YMD = /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/;
const KO_MD = /(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/;
const SLASH_MD = /(?<!\d)(\d{1,2})\s*\/\s*(\d{1,2})(?!\d)/;

function clampPositive(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(0, Math.min(Math.trunc(value), max));
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDays(base: Date, days: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isoFromParts(year: number, month: number, day: number): string | null {
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() + 1 !== month || d.getDate() !== day) {
    return null;
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function isValidMonthDay(month: number, day: number): boolean {
  return isoFromParts(2024, month, day) !== null;
}

function parseIsoDateTime(raw: string): ParsedDateValue | null {
  const match = ISO_DATE_TIME.exec(raw.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = isoFromParts(year, month, day);
  if (!date) return null;
  const hour = match[4] !== undefined ? Number(match[4]) : null;
  const minute = match[5] !== undefined ? Number(match[5]) : null;
  if (hour === null || minute === null) return { date };
  if (hour > 23 || minute > 59) return null;
  return { date, dateTime: `${date}T${pad2(hour)}:${pad2(minute)}` };
}

function hasInvalidAbsoluteDate(raw: string): boolean {
  const iso = ISO_DATE_TIME.exec(raw.trim());
  if (iso && !isoFromParts(Number(iso[1]), Number(iso[2]), Number(iso[3]))) return true;
  const ymd = KO_YMD.exec(raw);
  if (ymd && !isoFromParts(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]))) return true;
  const md = KO_MD.exec(raw);
  if (md && !isValidMonthDay(Number(md[2]), Number(md[3]))) return true;
  const slash = SLASH_MD.exec(raw);
  if (slash && !isValidMonthDay(Number(slash[1]), Number(slash[2]))) return true;
  return false;
}

export function parseDateColumnValue(raw: string, now: Date): ParsedDateValue | null {
  const text = raw.trim();
  if (!text) return null;
  const iso = parseIsoDateTime(text);
  if (iso) return iso;
  if (hasInvalidAbsoluteDate(text)) return null;
  const parsed = extractEventDateTime(text, now);
  if (!parsed) return null;
  const parsedIso = parseIsoDateTime(parsed);
  return parsedIso ?? null;
}

function parseBirthdayParts(raw: string): { month: number; day: number } | null {
  const text = raw.trim();
  if (!text) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) {
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    return isValidMonthDay(month, day) ? { month, day } : null;
  }
  const ko = KO_MD.exec(text);
  if (ko) {
    const month = Number(ko[2]);
    const day = Number(ko[3]);
    return isValidMonthDay(month, day) ? { month, day } : null;
  }
  const slash = /^(\d{1,2})\s*\/\s*(\d{1,2})$/.exec(text);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    return isValidMonthDay(month, day) ? { month, day } : null;
  }
  return null;
}

function annualDateInYear(year: number, month: number, day: number): string | null {
  return isoFromParts(year, month, day);
}

function birthdayDatesInWindow(
  month: number,
  day: number,
  window: DateOccurrenceWindow,
): { upcoming: string | null; past: string | null } {
  const todayYear = Number(window.today.slice(0, 4));
  let upcoming: string | null = null;
  let past: string | null = null;
  for (let year = todayYear - 1; year <= todayYear + 5; year += 1) {
    const date = annualDateInYear(year, month, day);
    if (!date) continue;
    if (date >= window.today && date <= window.until && (upcoming === null || date < upcoming)) {
      upcoming = date;
    }
    if (date < window.today && date >= window.pastSince && (past === null || date > past)) {
      past = date;
    }
  }
  return { upcoming, past };
}

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

function roleForColumn(columnKey: string, attrKey: string): DateOccurrenceRole {
  return columnKey === "유통기한" || attrKey === "expires_at" ? "expiration" : "generic";
}

function dateColumnDescriptors(registry: EntityTypeRegistryDb): DateColumnDescriptor[] {
  const descriptors: DateColumnDescriptor[] = [];
  for (const meta of ENTITY_TYPE_METAS) {
    for (const [columnKey, facadeKey] of Object.entries(meta.columnLabels)) {
      if (columnDataTypeOf(meta.typeName, columnKey) !== "date") continue;
      const attrKey = camelToSnake(facadeKey);
      descriptors.push({
        typeName: meta.typeName,
        columnKey,
        attrKey,
        role: roleForColumn(columnKey, attrKey),
      });
    }
  }
  for (const type of registry.listUserEntityTypes()) {
    for (const columnKey of getTypeColumns(type.typeName as PlacementTypeName)) {
      if (getColumnDataType(type.typeName, columnKey) !== "date") continue;
      descriptors.push({
        typeName: type.typeName,
        columnKey,
        attrKey: columnKey,
        role: roleForColumn(columnKey, columnKey),
      });
    }
  }
  return descriptors;
}

function truncate(text: string, max = 80): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

function sourceTypeToTargetType(sourceType: string): string {
  if (sourceType === "document_chunk" || sourceType === "document") return sourceType;
  if (sourceType === "image_asset") return "image";
  if (sourceType === "image_caption") return "image_caption";
  return "memory";
}

function occurrenceMatchesQuery(occ: DateOccurrence, q: string | undefined): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    occ.title,
    occ.target.label,
    occ.columnKey ?? "",
    occ.originalDateText ?? "",
  ].join(" ").toLowerCase();
  return haystack.includes(needle);
}

function inWindow(date: string, window: DateOccurrenceWindow, section: "upcoming" | "past"): boolean {
  return section === "upcoming"
    ? date >= window.today && date <= window.until
    : date < window.today && date >= window.pastSince;
}

const ROLE_PRIORITY: Record<DateOccurrenceRole, number> = {
  event: 0,
  expiration: 1,
  birthday: 2,
  generic: 3,
};

function sortUpcoming(a: DateOccurrence, b: DateOccurrence): number {
  const timeA = a.dateTime ?? a.date;
  const timeB = b.dateTime ?? b.date;
  if (timeA !== timeB) return timeA.localeCompare(timeB);
  const roleDiff = ROLE_PRIORITY[a.role] - ROLE_PRIORITY[b.role];
  if (roleDiff !== 0) return roleDiff;
  return a.title.localeCompare(b.title, "ko");
}

function sortPast(a: DateOccurrence, b: DateOccurrence): number {
  const timeA = a.dateTime ?? a.date;
  const timeB = b.dateTime ?? b.date;
  if (timeA !== timeB) return timeB.localeCompare(timeA);
  const roleDiff = ROLE_PRIORITY[a.role] - ROLE_PRIORITY[b.role];
  if (roleDiff !== 0) return roleDiff;
  return a.title.localeCompare(b.title, "ko");
}

function applyFilters(
  occ: DateOccurrence,
  options: Required<Pick<DateOccurrenceOptions, "kinds">> & Pick<DateOccurrenceOptions, "column" | "q">,
): boolean {
  if (!options.kinds.has(occ.kind)) return false;
  if (options.column && occ.columnKey !== options.column) return false;
  return occurrenceMatchesQuery(occ, options.q);
}

export async function buildDateOccurrences(
  deps: DateOccurrenceDeps,
  options: DateOccurrenceOptions = {},
): Promise<DateOccurrenceResponse> {
  const now = options.now ?? new Date();
  const todayDate = startOfDay(now);
  const days = clampPositive(options.days, DEFAULT_DAYS, 365);
  const pastDays = clampPositive(options.pastDays, DEFAULT_PAST_DAYS, 365);
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? DEFAULT_LIMIT), 200));
  const kinds = options.kinds ?? new Set<DateOccurrenceKind>(["event", "birthday", "column_date"]);
  const window: DateOccurrenceWindow = {
    today: toIsoDate(todayDate),
    until: toIsoDate(addDays(todayDate, days)),
    pastSince: toIsoDate(addDays(todayDate, -pastDays)),
    days,
    pastDays,
  };

  const upcoming: DateOccurrence[] = [];
  const past: DateOccurrence[] = [];

  if (kinds.has("event")) {
    const nodes = await deps.getAllNodes(10000);
    // 원본 메모에서 일정이 만들어졌으면 달력에는 일정 제목만 띄운다(2026-10-10 spec 5장 "달력").
    // 일정 노드가 휴지통에 가면 getAllNodes 에 없으므로 메모가 다시 보인다.
    const scheduledSources = new Set<number>();
    for (const node of nodes) {
      const source = node.metadata[SCHEDULE_SOURCE_NODE_KEY];
      if (node.eventAt && node.metadata[SCHEDULE_OCCURRENCE_KEY] === true && typeof source === "number") {
        scheduledSources.add(source);
      }
    }
    for (const node of nodes) {
      if (!node.eventAt) continue;
      if (scheduledSources.has(node.id)) continue;
      // 사용자가 "일정 아님" 으로 표시한 메모 — 일정 목록에서만 뺀다(event_at 은 시간 검색을 위해 그대로 둔다).
      if (node.metadata[SCHEDULE_HIDDEN_KEY] === true) continue;
      const parsed = parseDateColumnValue(node.eventAt, now);
      if (!parsed) continue;
      const title = truncate(node.content);
      const occ: DateOccurrence = {
        kind: "event",
        date: parsed.date,
        ...(parsed.dateTime ? { dateTime: parsed.dateTime } : {}),
        ...(node.eventUntil
          ? (() => {
              const end = parseDateColumnValue(node.eventUntil!, now);
              return end?.dateTime ? { endDateTime: end.dateTime } : {};
            })()
          : {}),
        role: "event",
        title,
        target: {
          nodeId: `node:${node.id}`,
          type: sourceTypeToTargetType(node.sourceType),
          id: node.id,
          label: title,
        },
        source: { type: "event", id: node.id },
        originalDateText: node.eventAt,
      };
      if (!applyFilters(occ, { kinds, column: options.column, q: options.q })) continue;
      if (inWindow(occ.date, window, "upcoming")) upcoming.push(occ);
      else if (inWindow(occ.date, window, "past")) past.push(occ);
    }
  }

  if (kinds.has("birthday")) {
    for (const person of await deps.listPersons({ limit: 5000 })) {
      if (!person.birthday) continue;
      const parts = parseBirthdayParts(person.birthday);
      if (!parts) continue;
      const dates = birthdayDatesInWindow(parts.month, parts.day, window);
      for (const [section, date] of [["upcoming", dates.upcoming], ["past", dates.past]] as const) {
        if (!date) continue;
        const occ: DateOccurrence = {
          kind: "birthday",
          date,
          role: "birthday",
          title: `${person.displayName} 생일`,
          target: {
            nodeId: `person:${person.personId}`,
            type: "person",
            id: person.personId,
            label: person.displayName,
          },
          source: { type: "person", id: person.personId },
          originalDateText: person.birthday,
        };
        if (!applyFilters(occ, { kinds, column: options.column, q: options.q })) continue;
        if (section === "upcoming") upcoming.push(occ);
        else past.push(occ);
      }
    }
  }

  if (kinds.has("column_date")) {
    const descriptors = dateColumnDescriptors(deps.entityTypeRegistryDb);
    const byKey = new Map(descriptors.map((d) => [`${d.typeName}\t${d.attrKey}`, d]));
    for (const row of deps.entitiesRepo.listColumnValues(descriptors, { limit: 10000 })) {
      const descriptor = byKey.get(`${row.typeName}\t${row.attrKey}`);
      if (!descriptor) continue;
      const parsed = parseDateColumnValue(row.attrValue, now);
      if (!parsed) continue;
      const label = row.koName?.trim() || row.name;
      const occ: DateOccurrence = {
        kind: "column_date",
        date: parsed.date,
        ...(parsed.dateTime ? { dateTime: parsed.dateTime } : {}),
        columnKey: descriptor.columnKey,
        role: descriptor.role,
        title: `${label} ${descriptor.columnKey}`,
        target: {
          nodeId: `entity:${row.typeName}:${row.entityId}`,
          type: row.typeName,
          id: row.entityId,
          label,
        },
        source: { type: "entity", id: row.entityId },
        originalDateText: row.attrValue,
      };
      if (!applyFilters(occ, { kinds, column: options.column, q: options.q })) continue;
      if (inWindow(occ.date, window, "upcoming")) upcoming.push(occ);
      else if (inWindow(occ.date, window, "past")) past.push(occ);
    }
  }

  return {
    upcoming: upcoming.sort(sortUpcoming).slice(0, limit),
    past: past.sort(sortPast).slice(0, limit),
    window,
    generatedAt: now.toISOString(),
  };
}
