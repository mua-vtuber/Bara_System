import { expect, test } from "bun:test";
import { inSequence, parseProgressLine, PROGRESS_LINE_PREFIX, PROGRESS_MAX_PARTS } from "./progress-line.ts";

const line = (body: string) => `${PROGRESS_LINE_PREFIX}${body}`;

test("a download script's progress line is read as its four counts", () => {
  expect(parseProgressLine('@@bara-progress {"part":2,"parts":4,"loaded":312000000,"total":570000000}'))
    .toEqual({ part: 2, parts: 4, loaded: 312_000_000, total: 570_000_000 });
  expect(parseProgressLine(line('{"total":0,"loaded":0,"parts":1,"part":1}'))).toEqual({ part: 1, parts: 1, loaded: 0, total: 0 });
  expect(parseProgressLine(line(`{"part":10,"parts":10,"loaded":${Number.MAX_SAFE_INTEGER},"total":${Number.MAX_SAFE_INTEGER}}`)))
    .toEqual({ part: 10, parts: 10, loaded: Number.MAX_SAFE_INTEGER, total: Number.MAX_SAFE_INTEGER });
  expect(PROGRESS_MAX_PARTS).toBe(10);
});

test("anything but the exact line is ignored", () => {
  for (const text of [
    "", "downloading bge-m3 41%", '{"part":1,"parts":1,"loaded":1,"total":1}',
    '@@bara-progress{"part":1,"parts":1,"loaded":1,"total":1}', ' @@bara-progress {"part":1,"parts":1,"loaded":1,"total":1}',
    '@@BARA-PROGRESS {"part":1,"parts":1,"loaded":1,"total":1}', '@@bara-progress  x', line(""), line("null"), line("[1,1,1,1]"),
    line('"1/1"'), line("{"), line('{"part":1,"parts":1,"loaded":1}'),
    line('{"part":1,"parts":1,"loaded":1,"total":1,"file":"C:/Users/me/token"}'),
    line('{"part":0,"parts":1,"loaded":1,"total":1}'), line('{"part":2,"parts":1,"loaded":1,"total":1}'),
    line('{"part":1,"parts":11,"loaded":1,"total":1}'), line('{"part":1,"parts":1,"loaded":-1,"total":1}'),
    line('{"part":1,"parts":1,"loaded":1.5,"total":1}'), line('{"part":"1","parts":1,"loaded":1,"total":1}'),
    line(`{"part":1,"parts":1,"loaded":${Number.MAX_SAFE_INTEGER + 1},"total":1}`), line('{"part":1,"parts":1,"loaded":1,"total":1e400}'),
    line('{"part":1,"parts":1,"loaded":1,"total":null}'),
  ]) expect(parseProgressLine(text)).toBeNull();
});

test("each script's parts are placed in the install's one model sequence", () => {
  // The dictionary is part 1 of 1 + 4; the core models' part P of 4 becomes 1 + P of 5.
  expect(inSequence({ part: 1, parts: 1, loaded: 5, total: 9 }, 0, 4)).toEqual({ part: 1, parts: 5, loaded: 5, total: 9 });
  expect(inSequence({ part: 2, parts: 4, loaded: 5, total: 0 }, 1, 0)).toEqual({ part: 3, parts: 5, loaded: 5, total: 0 });
  expect(inSequence({ part: 4, parts: 4, loaded: 1, total: 1 }, 1, 0)).toEqual({ part: 5, parts: 5, loaded: 1, total: 1 });
  // A sequence longer than the host forwards is not reported at all.
  expect(inSequence({ part: 1, parts: 10, loaded: 1, total: 1 }, 1, 0)).toBeNull();
});
