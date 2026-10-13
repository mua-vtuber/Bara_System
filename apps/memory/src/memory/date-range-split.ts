/**
 * date-range-split.ts — `#날짜:` 값 안 `~` 기간 분할 단일 출처(결정 5).
 * 값은 S1(방식 ②)이 이미 쉼표/`#`/줄 끝까지 통째로 읽어 넘긴다 — 여기선 첫 `~`로
 * 한 번만 가른다. 앞=시작·뒤=끝. `~` 없으면 end=null(정직한 단일 날짜).
 * 날짜 문자열 → ISO 변환은 호출처(event-date.ts)가 따로 한다.
 */
export interface DateRange {
  start: string;
  end: string | null;
}

export function splitDateRange(value: string): DateRange {
  const idx = value.indexOf("~");
  if (idx === -1) return { start: value.trim(), end: null };
  return {
    start: value.slice(0, idx).trim(),
    end: value.slice(idx + 1).trim(),
  };
}
