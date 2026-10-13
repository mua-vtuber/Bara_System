import { expect, test } from "bun:test";
import { CAUSE_MAX_CHARS, CAUSE_SCAN_MAX_CHARS, causeOf, stripAddressSecrets } from "../src/service/fetch-failure.ts";
import { messages } from "../src/ui/messages.ts";
import { ADDRESSES_SHAPE, caseLabel, spaced, timeInChildProcess, toLength, TWO_MB, UNBROKEN_SHAPES, type ChildTiming, type TimedCase } from "./fixtures/cause-scan-timing.ts";

// WP-PFIX-11: `causeOf` runs over text a server sent, up to a whole response (2 MB). Its search for addresses
// used to try every word boundary inside a long run of scheme characters, so one 120 KB sentence stopped the
// service for 8.5 s. These cases hold the search linear, and hold the cut that now comes first from leaving
// half an address in the sentence. Pure text in, text out: nothing here needs a listener or a fake.
// WP-PFIX-12: timed in this process, a search that turned quadratic again froze the test run instead of
// failing it (a regular expression cannot be interrupted). The 2 MB work is now timed in a child process
// (`fixtures/cause-scan-timing.ts`) that a deadline stops, and only then repeated here to check its results.

/** The work takes a few milliseconds on the development machine; one second leaves a slow CI machine a wide
 * margin and is still far below what the quadratic search needed (8.5 s at 120 KB, hours at 2 MB). */
const TIME_LIMIT_MS = 1_000;
/** The child process, its start-up included, ends well within a second. Ten seconds leaves a slow CI machine
 * a wide margin, and still ends a search that turned quadratic as a failure within seconds. */
const CHILD_DEADLINE_MS = 10_000;
/** Longer than the deadline, so the deadline, and not the test runner's own limit, ends a slow run. */
const TIMED_TEST_LIMIT_MS = 30_000;

const STRIP_CASES: TimedCase[] = [...UNBROKEN_SHAPES, ADDRESSES_SHAPE].map((shape) => ({ step: "strip", shape }));
const CAUSE_CASES: TimedCase[] = UNBROKEN_SHAPES.flatMap((shape): TimedCase[] => [{ step: "cause", shape }, { step: "cause", shape: spaced(shape) }]);
let childTiming: Promise<ChildTiming> | undefined;
/** Every case timed once, in one child process that both tests below read. */
const timedInChild = (): Promise<ChildTiming> => childTiming ??= timeInChildProcess([...STRIP_CASES, ...CAUSE_CASES], CHILD_DEADLINE_MS);

/** The child process ended before its deadline and ran every one of `cases` within the time limit. Only then
 * is the same work safe to repeat in this process, where nothing could stop it. */
async function expectTimedWithinLimit(cases: TimedCase[]): Promise<void> {
  const { timedOut, exitCode, times } = await timedInChild();
  expect({ timedOut, exitCode }).toEqual({ timedOut: false, exitCode: 0 });
  for (const timed of cases) {
    const label = caseLabel(timed);
    expect({ label, withinLimit: (times[label] ?? Infinity) < TIME_LIMIT_MS }).toEqual({ label, withinLimit: true });
  }
}

test("the address search stays linear: a 2 MB sentence is searched within the time limit", async () => {
  await expectTimedWithinLimit(STRIP_CASES);
  for (const shape of UNBROKEN_SHAPES) {
    const text = toLength(shape, TWO_MB);
    expect(stripAddressSecrets(text)).toBe(text); // no `://` in it: nothing to strip
  }
  // Many real addresses in one sentence: every one is found and stripped.
  const stripped = stripAddressSecrets(toLength(ADDRESSES_SHAPE, TWO_MB));
  expect(stripped.startsWith("http://h/ http://h/ ")).toBe(true);
  expect(stripped).not.toContain("?");
}, TIMED_TEST_LIMIT_MS);

test("a cause sentence of 2 MB is answered within the time limit, whatever its shape", async () => {
  await expectTimedWithinLimit(CAUSE_CASES);
  for (const shape of UNBROKEN_SHAPES) {
    const unbroken = toLength(shape, TWO_MB);
    expect(causeOf(unbroken)).toBe(unbroken.slice(0, CAUSE_MAX_CHARS)); // one token longer than anything that is read, with no address in it: its start is shown
    const broken = toLength(spaced(shape), TWO_MB);
    expect(causeOf(broken)).toBe(broken.trim().slice(0, CAUSE_MAX_CHARS));
  }
}, TIMED_TEST_LIMIT_MS);

test("a long sentence is cut to what a bubble can show, and a short one is left whole", () => {
  const words = toLength("word ", 10_000);
  expect(causeOf(words)).toBe(words.trim().slice(0, CAUSE_MAX_CHARS));
  expect(causeOf(words).length).toBeLessThanOrEqual(CAUSE_MAX_CHARS);
  expect(causeOf("제안 등록 실패: database is locked")).toBe("제안 등록 실패: database is locked");
  expect(causeOf(new Error("refused http://127.0.0.1:41031/client-info"))).toBe("Error: refused http://127.0.0.1:41031/client-info");
});

test("every run of scheme characters before :// is an address, whatever it starts with", () => {
  expect(stripAddressSecrets("a _http://h/p?k=S1 b 1http://h/p?k=S2 c .http://h/p#S3 d -http://u:p@h/q e x_https://h/z?k=S4"))
    .toBe("a _http://h/p b 1http://h/p c .http://h/p d -http://h/q e x_https://h/z");
  expect(stripAddressSecrets("two http://a:b@h1:1/p?k=S and HTTPS://h2/q#S, done")).toBe("two http://h1:1/p and HTTPS://h2/q done");
  // Text that merely holds scheme characters and a colon is not an address.
  expect(stripAddressSecrets("a.b:c d-e:/f")).toBe("a.b:c d-e:/f");
});

const SECRET = "pfix11-cut-secret-value";
const USER = "pfix11user";
const PASSWORD = "PFIX11PASSWORD";
const FILLER_CHARS = 201;
/** A filler of exactly `length` characters that `causeOf` shrinks to `http://h/ `: an address with a long query string. */
const filler = (length: number): string => `http://h/?${"q".repeat(length - 11)} `;
const SHRUNK_FILLER = "http://h/ ";
/** `tail` placed after enough filler that the scan bound falls `keep` characters into it. The fillers shrink to
 * a few characters each, so what is left of the cut tail lands inside the 300 characters the screen shows. */
function sentenceCutInto(tail: string, keep: number): { text: string; fillers: number } {
  const headLength = CAUSE_SCAN_MAX_CHARS - keep;
  const fillers = Math.floor(headLength / FILLER_CHARS);
  return { text: filler(FILLER_CHARS).repeat(fillers - 1) + filler(headLength - FILLER_CHARS * (fillers - 1)) + tail, fillers };
}

test("a cut inside an address's query string leaves neither the query nor its name", () => {
  const tail = `http://h/p?pickupSecret=${SECRET}`;
  const { text, fillers } = sentenceCutInto(tail, `http://h/p?pickupSecret=${SECRET.slice(0, 5)}`.length);
  expect(text.length).toBeGreaterThan(CAUSE_SCAN_MAX_CHARS);
  expect(text.slice(0, CAUSE_SCAN_MAX_CHARS).endsWith(`pickupSecret=${SECRET.slice(0, 5)}`)).toBe(true); // the cut is where the case says
  const cause = causeOf(text);
  expect(cause).toBe(SHRUNK_FILLER.repeat(fillers).trim());
  for (const hidden of ["pickupSecret", SECRET.slice(0, 3), "?"]) expect(cause).not.toContain(hidden);
});

test("a cut inside an address's user information leaves no part of it", () => {
  const { text, fillers } = sentenceCutInto(`http://${USER}:${PASSWORD}@h/p`, `http://${USER}:${PASSWORD.slice(0, 5)}`.length);
  expect(text.slice(0, CAUSE_SCAN_MAX_CHARS).endsWith(`${USER}:${PASSWORD.slice(0, 5)}`)).toBe(true);
  const cause = causeOf(text);
  expect(cause).toBe(SHRUNK_FILLER.repeat(fillers).trim());
  for (const hidden of [USER, PASSWORD.slice(0, 3), "@"]) expect(cause).not.toContain(hidden);
});

test("a sentence that fits the bound, or breaks right at it, keeps its last address, stripped", () => {
  const tail = `http://${USER}:${PASSWORD}@h/p?k=${SECRET}`;
  const exact = sentenceCutInto(tail, tail.length);
  expect(exact.text.length).toBe(CAUSE_SCAN_MAX_CHARS);
  expect(causeOf(exact.text)).toBe(`${SHRUNK_FILLER.repeat(exact.fillers)}http://h/p`);
  // The bound falls on the space after the last address, so that address is whole and is kept, stripped.
  const broken = sentenceCutInto(`${tail} and more words`, tail.length);
  expect(broken.text.charAt(CAUSE_SCAN_MAX_CHARS)).toBe(" ");
  expect(causeOf(broken.text)).toBe(`${SHRUNK_FILLER.repeat(broken.fillers)}http://h/p`);
});

test("one unbroken token longer than the bound is not shown, and nothing of it is kept", () => {
  const text = `http://${"u".repeat(CAUSE_SCAN_MAX_CHARS * 2)}:${PASSWORD}@h/p?k=${SECRET}`;
  expect(causeOf(text)).toBe(messages.serverClient.causeTooLong);
  // An exception's own `Error: ` comes first, and it is a whole token on its own: that is all that is kept.
  expect(causeOf(new Error(text))).toBe("Error:");
});

test("characters that cannot be shown are removed before the checks, so they cannot hide an address or a credential", () => {
  // A zero-width space inside `Bearer` or inside a scheme used to split what the checks look for.
  expect(causeOf("Bear\u200ber abc")).toBe(messages.serverClient.causeWithheld);
  expect(causeOf("ht\u200btp://h/p?k=S\u202e")).toBe("http://h/p");
  expect(causeOf("bara\u2060-token=abc")).toBe(messages.serverClient.causeWithheld);
  // Line breaks and tabs become one space; the rest of the control characters, the private-use and lone
  // surrogate code units, and the bidirectional marks go.
  expect(causeOf("line one\nline\ttwo\u0000\u001b[31m\ue000\ud800\u202d")).toBe("line one line two[31m");
  expect(causeOf("one\r\ntwo\u0085three\vfour\ffive")).toBe("one two three four five");
  // A byte order mark shows nothing and goes; a space that shows, such as a no-break space, stays a space.
  expect(causeOf("a\ufeffb c\u00a0d")).toBe("ab c d");
  // Korean, punctuation and symbols stay.
  expect(causeOf("정리 서버 오류 (코드 12): 후보 \"A\" → 실패")).toBe("정리 서버 오류 (코드 12): 후보 \"A\" → 실패");
});

// WP-PFIX-12: a character that shows nothing was removed only after the cut and the whitespace clean-up. A
// byte order mark (whitespace to `\s`) before `@` split `http://user:pw<BOM>@h/p?k=S` in two, so its user
// information and query string stayed; a zero-width space or soft hyphen inside `://` hid the address from
// the check of the token the cut broke, so half of its user information stayed. Removed first, such a
// character changes nothing: wherever it is placed, the sentence is the one without it.
/** One character of each kind that shows nothing. */
const INVISIBLE: Record<string, string> = {
  byteOrderMark: "\ufeff", zeroWidthSpace: "\u200b", softHyphen: "\u00ad", wordJoiner: "\u2060", rightToLeftOverride: "\u202e",
  combiningGraphemeJoiner: "\u034f", variationSelector: "\ufe0f", hangulFiller: "\u3164", tag: "\u{e0041}",
  privateUse: "\ue000", loneSurrogate: "\udc00", escape: "\u001b",
};
const LEAKY = `http://${USER}:${PASSWORD}@h/p?k=${SECRET}#${SECRET}`;
const insertAt = (text: string, index: number, char: string): string => `${text.slice(0, index)}${char}${text.slice(index)}`;
/** Every placement of every invisible character in `LEAKY`: before, inside and after `://`, the user
 * information, `@`, `?` and `#`. */
const placements = (): { name: string; index: number; address: string }[] => Object.entries(INVISIBLE)
  .flatMap(([name, char]) => Array.from({ length: LEAKY.length + 1 }, (_, index) => ({ name, index, address: insertAt(LEAKY, index, char) })));

test("a character that shows nothing, anywhere in an address, leaves none of its user information or query", () => {
  // The two the tenth QA reproduced.
  expect(causeOf(`http://${USER}:${PASSWORD}\ufeff@h/p?k=${SECRET}`)).toBe("http://h/p");
  expect(causeOf(`http:\u200b//${USER}:${PASSWORD}@h/p?k=${SECRET}`)).toBe("http://h/p");
  expect(causeOf(`failed at ${LEAKY} (retry)`)).toBe("failed at http://h/p (retry)");
  for (const { name, index, address } of placements()) {
    expect({ name, index, cause: causeOf(`failed at ${address} (retry)`) }).toEqual({ name, index, cause: "failed at http://h/p (retry)" });
  }
});

test("a character that shows nothing, anywhere in an address the scan bound cuts, leaves no part of its user information or query", () => {
  // The two the tenth QA reproduced, cut inside the password: what the cut left of the address goes.
  const passwordCut = `http://${USER}:${PASSWORD.slice(0, 5)}`;
  for (const tail of [`http://${USER}:${PASSWORD}\ufeff@h/p?k=${SECRET}`, `http:\u200b//${USER}:${PASSWORD}@h/p`, `http:\u00ad//${USER}:${PASSWORD}@h/p`]) {
    const { text, fillers } = sentenceCutInto(tail, passwordCut.length);
    const cause = causeOf(text);
    expect({ tail, cause }).toEqual({ tail, cause: SHRUNK_FILLER.repeat(fillers).trim() });
    for (const hidden of [USER, PASSWORD.slice(0, 3), SECRET.slice(0, 3), "@", "?"]) expect(cause).not.toContain(hidden);
  }
  // Every placement, with the bound inside the password and inside the query string's value.
  for (const cutAt of [passwordCut, `http://${USER}:${PASSWORD}@h/p?k=${SECRET.slice(0, 5)}`]) {
    const clean = sentenceCutInto(LEAKY, cutAt.length);
    expect(clean.text.slice(0, CAUSE_SCAN_MAX_CHARS).endsWith(cutAt)).toBe(true); // the cut is where the case says
    const expected = SHRUNK_FILLER.repeat(clean.fillers).trim();
    expect(causeOf(clean.text)).toBe(expected);
    for (const { name, index, address } of placements()) {
      expect({ name, index, cause: causeOf(sentenceCutInto(address, cutAt.length).text) }).toEqual({ name, index, cause: expected });
    }
  }
});

test("the cut to what a bubble can show counts characters, so it never leaves half an emoji", () => {
  const emoji = "\u{1f600}";
  const almostFull = `${"x".repeat(CAUSE_MAX_CHARS - 1)}${emoji}`;
  expect(causeOf(almostFull)).toBe(almostFull);
  expect(causeOf(`${"x".repeat(CAUSE_MAX_CHARS)}${emoji}`)).toBe("x".repeat(CAUSE_MAX_CHARS));
  expect(causeOf(emoji.repeat(CAUSE_MAX_CHARS * 2))).toBe(emoji.repeat(CAUSE_MAX_CHARS));
  // Nor does the scan bound, though lone halves are removed before it: falling between an emoji's two halves,
  // it keeps the start up to the emoji.
  const { text, fillers } = sentenceCutInto(`ab${emoji}cd`, "ab".length + 1);
  expect(text.charAt(CAUSE_SCAN_MAX_CHARS - 1)).toBe(emoji.charAt(0));
  expect(causeOf(text)).toBe(`${SHRUNK_FILLER.repeat(fillers)}ab`);
});

// WP-PFIX-13: removing a character that shows nothing before the credential check joined `Bearer` to the token
// after it. A byte order mark there had been whitespace to `\s` and so the space the check looked for; removed,
// it left `BearerTOKEN123`, and the sentence was shown. A token written straight after `bearer` is a credential.
test("a character that shows nothing between Bearer and its token leaves the sentence withheld", () => {
  const withheld = messages.serverClient.causeWithheld;
  expect(causeOf("Bearer\ufeffTOKEN123")).toBe(withheld); // the one the eleventh QA reproduced
  for (const [name, char] of Object.entries(INVISIBLE)) {
    for (const sentence of [`Bearer${char}TOKEN123`, `request failed: authorization: bearer${char}${SECRET} (retry)`]) {
      expect({ name, sentence, cause: causeOf(sentence) }).toEqual({ name, sentence, cause: withheld });
    }
  }
  // However long the run of removed characters before it, the check reads the sentence that is left.
  expect(causeOf(`${"\u200b".repeat(100_000)}Bearer\u00adTOKEN123`)).toBe(withheld);
  // No character at all between them.
  expect(causeOf("BearerTOKEN123")).toBe(withheld);
  // What PFIX-12 began to withhold, by removing the character that split it, stays withheld.
  for (const sentence of ["cookie bara-token\ufeff=abc", "-----\ufeffBEGIN PRIVATE KEY-----", "header Bearer\u0085abc"]) {
    expect({ sentence, cause: causeOf(sentence) }).toEqual({ sentence, cause: withheld });
  }
  // `bearer` before punctuation is not the start of a token, so the sentence is still shown.
  expect(causeOf("the server wants a bearer.")).toBe("the server wants a bearer.");
  expect(causeOf("Bearer: missing")).toBe("Bearer: missing");
});
