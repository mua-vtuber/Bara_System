export interface NumericColumnInput {
  key: string;
  label: string;
  dataType?: string;
}

export interface NumericColumn {
  key: string;
  label: string;
}

export type ComputeOp = "count" | "sum" | "avg";
export type AvgDivisor = "count" | "day" | "week" | "month" | "year";

export interface BuildComputePayloadInput {
  op?: ComputeOp | string;
  concept?: string;
  project?: string;
  since?: string;
  until?: string;
  place?: string;
  field?: string;
  divisor?: AvgDivisor | string;
}

export interface ComputePayloadOpts {
  kind?: string;
  concept?: string;
  project?: string;
  since?: string;
  until?: string;
  place?: string;
  field?: string;
  avgDivisor?: string;
}

export interface ComputeDescription {
  header: string;
  headline: string;
  notes: string[];
}

export interface ComputeChoice {
  value: string;
  label: string;
}

export type ComputeElementFactory = (
  tag: "div" | "span",
  props?: Record<string, unknown>,
  ...children: Array<Node | string | null>
) => HTMLElement;

export const COMPUTE_TEXT: {
  ops: ComputeChoice[];
  opLabel: string;
  divisors: ComputeChoice[];
  divisorLabel: string;
  computeButton: string;
  computing: string;
  headerByKind: {
    count: string;
    sum: string;
    avg: string;
    [key: string]: string;
  };
  countUnit: string;
  avgPrefixByDivisor: {
    count: string;
    day: string;
    week: string;
    month: string;
    year: string;
    [key: string]: string;
  };
  noNumericField: string;
  numericFieldAbsent: string;
  noReadableValue: string;
  sortLabel: string;
  sortRelevance: string;
  sortTime: string;
  noDate: string;
  timelineEmpty: string;
  excludedNote(n: number): string;
  errorByApiMessage: Record<string, string>;
  errorFallback(raw: string): string;
};

export function filterNumericColumns(cols: unknown): NumericColumn[];
export function buildComputePayloadOpts(input?: BuildComputePayloadInput): ComputePayloadOpts;
export function describeComputeResult(data: unknown): ComputeDescription;
export function buildComputeResultNodes(
  data: unknown,
  el: ComputeElementFactory,
): HTMLElement[];
export function buildComputeTimelineNodes(
  items: unknown,
  el: ComputeElementFactory,
): HTMLElement[];
export function localizeComputeError(message: unknown): string;
