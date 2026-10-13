/**
 * claim-text.test.ts — 주장 본문 정의(SL-2). 순수 함수에 데이터를 넣어 확인한다.
 *
 * 편집 무효화는 이 판정이 "바뀌었다"고 할 때만 파생 기억을 철회한다. 추출기가 LLM 에 넘기는
 * 본문(해시태그 제거·공백 접기)과 같은 정의라야 태그만 바뀐 편집이 파생 기억을 잃지 않는다.
 */

import { describe, expect, test } from "bun:test";
import {
  extractionClaimChanged,
  extractionClaimText,
  normalizeEditableBody,
} from "./claim-text.ts";
import { parseTags } from "./tag-extractor.ts";

const BODY = "배포 창구는 금요일 오후로 정했다. 롤백 담당은 운영팀이 맡는다.";

describe("extractionClaimText — 추출기가 보는 본문", () => {
  test("해시태그(#태그·#키:값)를 빼고 공백을 한 칸으로 접는다 — 백필·즉시 추출의 LLM 입력과 같다", () => {
    const stored = `#배포 ${BODY}\n\n#운영 #담당:운영팀`;
    expect(extractionClaimText(stored)).toBe(BODY);
    expect(extractionClaimText(stored)).toBe(parseTags(stored).cleanContent);
  });

  test("NFD 로 저장된 같은 글은 NFC 글과 같은 주장이다", () => {
    expect(extractionClaimText(BODY.normalize("NFD"))).toBe(BODY);
  });
});

describe("extractionClaimChanged — 편집이 파생 기억을 무효화하는 조건", () => {
  test("태그 추가·변경·줄바꿈만 바뀐 편집은 주장을 바꾸지 않는다", () => {
    expect(extractionClaimChanged(BODY, `${BODY}\n\n#배포`)).toBe(false);
    expect(extractionClaimChanged(`${BODY}\n\n#배포`, `${BODY} #운영 #장소:회의실`)).toBe(false);
    expect(extractionClaimChanged(BODY, BODY.replace(". ", ".\r\n"))).toBe(false);
  });

  test("본문 문장이 바뀐 편집은 주장을 바꾼다", () => {
    expect(extractionClaimChanged(BODY, BODY.replace("금요일 오후", "화요일 오전"))).toBe(true);
    expect(extractionClaimChanged("#만화", "#만화 고조가 죽었어")).toBe(true);
  });
});

test("normalizeEditableBody — 줄바꿈을 LF 로 통일하고 앞뒤 공백을 지운다(문단 줄바꿈은 보존)", () => {
  expect(normalizeEditableBody("  첫 줄\r\n\r\n둘째 줄\r셋째 줄  ")).toBe("첫 줄\n\n둘째 줄\n셋째 줄");
});
