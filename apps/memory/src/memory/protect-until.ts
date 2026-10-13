/**
 * 한국어 시간 표현 → 보호 만료 ISO 날짜 변환.
 *
 * 본인이 메모에 미래 시간을 적으면 그 시점 전까진 evolver 휴지통 후보에서
 * 자동 제외하기 위한 메타데이터 protectUntil의 자동 추출.
 *
 * 정확도가 아니라 보수성이 우선 — 매칭 실패 시 null 반환 (보호 안 적용,
 * 일반 점수 흐름 그대로). 정규식 못 잡는 자연어 표현은 LLM 옵션 fallback
 * (extractor 안에서 처리, 이 모듈은 정규식만).
 */

/** ISO 날짜 (YYYY-MM-DD) 만 반환 — 시간 단위 정밀도 불필요. */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 가장 가까운 미래의 해당 (월, 일) — 올해 이미 지났으면 내년. */
function nextOccurrenceOfMonthDay(
  month: number,
  day: number,
  now: Date,
): Date {
  const currentYear = now.getFullYear();
  // Date 생성자: month는 0-indexed, 따라서 month-1
  let target = new Date(currentYear, month - 1, day, 23, 59, 59);
  if (target.getTime() <= now.getTime()) {
    target = new Date(currentYear + 1, month - 1, day, 23, 59, 59);
  }
  return target;
}

/** 해당 월 마지막 날 23:59. month는 1-indexed 입력. */
function lastDayOfMonth(year: number, month: number): Date {
  // month는 1-indexed, new Date(year, 다음달인덱스, 0) = 그 달 마지막 날
  return new Date(year, month, 0, 23, 59, 59);
}

/** 한 텍스트에서 모든 시간 표현 매칭 후 가장 먼 미래 날짜 선택. */
export function extractProtectUntil(
  text: string,
  now: Date = new Date(),
): string | null {
  const candidates: Date[] = [];

  // 1. YYYY년 + 옵션 M월 + 옵션 D일
  const yearRegex = /(\d{4})\s*년(?:\s*(\d{1,2})\s*월(?:\s*(\d{1,2})\s*일)?)?/g;
  for (const m of text.matchAll(yearRegex)) {
    const year = parseInt(m[1]!, 10);
    if (year < now.getFullYear() || year > 2100) continue;
    const month = m[2] ? parseInt(m[2], 10) : 12;
    const day = m[3] ? parseInt(m[3], 10) : undefined;
    if (month < 1 || month > 12) continue;
    if (day !== undefined && (day < 1 || day > 31)) continue;
    const d = day
      ? new Date(year, month - 1, day, 23, 59, 59)
      : lastDayOfMonth(year, month);
    if (d.getTime() > now.getTime()) candidates.push(d);
  }

  // 2. M월 (D일) — 연도 미지정. YYYY년 패턴이 텍스트에 있으면 본 패턴 스킵.
  if (!/\d{4}\s*년/.test(text)) {
    const monthRegex = /(\d{1,2})\s*월(?:\s*(\d{1,2})\s*일)?/g;
    for (const m of text.matchAll(monthRegex)) {
      const month = parseInt(m[1]!, 10);
      if (month < 1 || month > 12) continue;
      const day = m[2] ? parseInt(m[2], 10) : undefined;
      if (day !== undefined && (day < 1 || day > 31)) continue;
      const target = day
        ? nextOccurrenceOfMonthDay(month, day, now)
        : (() => {
            let year = now.getFullYear();
            const last = lastDayOfMonth(year, month);
            if (last.getTime() <= now.getTime()) {
              return lastDayOfMonth(year + 1, month);
            }
            return last;
          })();
      candidates.push(target);
    }
  }

  // 3. "내년" → 내년 12-31
  if (/내년|다음\s*해/.test(text)) {
    candidates.push(new Date(now.getFullYear() + 1, 11, 31, 23, 59, 59));
  }

  // 4. "내달" / "다음 달" → 다음 달 마지막 날
  if (/내달|다음\s*달/.test(text)) {
    const nextMonth = now.getMonth() + 1; // 0-indexed 현재 월 → +1 = 다음 달 0-indexed
    const year = now.getFullYear() + (nextMonth >= 12 ? 1 : 0);
    const month = nextMonth >= 12 ? nextMonth - 12 : nextMonth;
    candidates.push(lastDayOfMonth(year, month + 1)); // +1 because lastDayOfMonth expects 1-indexed
  }

  // 5. "다음 주" → 7일 후
  if (/다음\s*주/.test(text)) {
    candidates.push(new Date(now.getTime() + 7 * 24 * 3600 * 1000));
  }

  if (candidates.length === 0) return null;

  // 가장 먼 미래 선택 (보수적 보호)
  candidates.sort((a, b) => b.getTime() - a.getTime());
  return toIsoDate(candidates[0]!);
}
