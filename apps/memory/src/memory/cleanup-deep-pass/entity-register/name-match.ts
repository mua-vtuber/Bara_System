/**
 * entity-register/name-match.ts — 이름 비교(spec 4.1 1·3번, 4.2, 4.3). 순수 함수만.
 * 모든 비교는 NFC 후 한다(spec 4.1). 소문자화는 영문 이름 대소문자 차이만 흡수한다.
 */
import { toNfc } from "../../nfc.ts";
import type { EntityRegisterProfile } from "../../lang/language-profile.ts";
import type { NameIndexEntry } from "./types.ts";

export function normalizeName(raw: string): string {
  return toNfc(raw).trim();
}

export function nameKey(raw: string): string {
  return normalizeName(raw).toLowerCase();
}

/** 한글 완성형 음절(가~힣)의 받침 유무. 한글이 아니면 false. */
const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;
const FINAL_CONSONANT_SLOTS = 28;
export function hasFinalConsonant(ch: string): boolean {
  const code = ch.codePointAt(0);
  if (code === undefined || code < HANGUL_FIRST || code > HANGUL_LAST) return false;
  return (code - HANGUL_FIRST) % FINAL_CONSONANT_SLOTS !== 0;
}

export function entryNames(entry: NameIndexEntry): string[] {
  return [entry.name, ...entry.aliases];
}

function suffixAllowed(base: string, suffix: string, profile: EntityRegisterProfile): boolean {
  if (!profile.finalConsonantSuffixes.includes(suffix)) return true;
  const last = base.slice(-1);
  return last.length > 0 && hasFinalConsonant(last);
}

/** 이름 끝 호칭 분리(spec 4.2). 긴 끝말부터 본다(로더가 정렬). 앞부분이 minChars 미만이면 null. */
export function splitHonorific(
  name: string,
  profile: EntityRegisterProfile,
  minChars: number,
): { base: string; suffix: string } | null {
  const n = normalizeName(name);
  for (const suffix of profile.honorificSuffixes) {
    if (!n.endsWith(suffix)) continue;
    const base = n.slice(0, n.length - suffix.length);
    if (base.length < minChars) continue;
    if (!suffixAllowed(base, suffix, profile)) continue;
    return { base, suffix };
  }
  return null;
}

export function exactMatches(entries: readonly NameIndexEntry[], name: string): NameIndexEntry[] {
  const key = nameKey(name);
  return entries.filter((e) => entryNames(e).some((n) => nameKey(n) === key));
}

function isAffixPair(a: string, b: string, minChars: number): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short === long) return true;
  return short.length >= minChars && (long.startsWith(short) || long.endsWith(short));
}

function isSuffixPair(a: string, b: string, profile: EntityRegisterProfile): boolean {
  return profile.honorificSuffixes.some(
    (s) => (a + s === b && suffixAllowed(a, s, profile)) || (b + s === a && suffixAllowed(b, s, profile)),
  );
}

/**
 * 비슷한 기존 이름(spec 4.3). 같은 이름은 exactMatches 몫이라 빼고 본다. 받침 끝말("이")이
 * 붙은 이름은 그 끝말을 뗀 이름으로도 앞·뒷부분 비교를 한다(몽룡이 ↔ 이몽룡).
 */
export function similarMatches(
  entries: readonly NameIndexEntry[],
  name: string,
  profile: EntityRegisterProfile,
  minChars: number,
): NameIndexEntry[] {
  const key = nameKey(name);
  const variants = [key];
  const split = splitHonorific(name, profile, minChars);
  if (split && profile.finalConsonantSuffixes.includes(split.suffix)) variants.push(nameKey(split.base));
  return entries.filter((e) =>
    entryNames(e).some((raw) => {
      const other = nameKey(raw);
      if (other === key) return false;
      return variants.some((v) => isAffixPair(v, other, minChars)) || isSuffixPair(key, other, profile);
    }),
  );
}
