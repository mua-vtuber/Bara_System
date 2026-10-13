/**
 * parseTags 단위 테스트.
 *
 * acceptance criteria 7건 + 추가 엣지 케이스. 순수 함수라 store / DB 의존 없음.
 */

import { describe, expect, test } from "bun:test";
import { parseTags, stripTagsForDisplay } from "./tag-extractor.ts";

describe("parseTags — acceptance criteria", () => {
  test("한글 태그 두 개 + 본문 — # 토큰만 제거되고 태그 식별자 배열로 반환", () => {
    const result = parseTags("#만화 #주술회전 고조가 죽었어!!");
    expect(result.tags).toEqual(["만화", "주술회전"]);
    expect(result.cleanContent).toBe("고조가 죽었어!!");
  });

  test("태그 없는 평문 — tags 빈 배열 + 본문 그대로", () => {
    const result = parseTags("그냥 메모");
    expect(result.tags).toEqual([]);
    expect(result.cleanContent).toBe("그냥 메모");
  });

  test("영문 대소문자 다른 같은 태그 → 소문자 정규화 + dedup", () => {
    const result = parseTags("#Manga #manga 영문");
    expect(result.tags).toEqual(["manga"]);
    expect(result.cleanContent).toBe("영문");
  });

  test("태그 다음 바로 한 칸 띄고 본문 — 정상 추출", () => {
    const result = parseTags("#만화 다시 봤어");
    expect(result.tags).toEqual(["만화"]);
    expect(result.cleanContent).toBe("다시 봤어");
  });

  test("본문 중간에 태그 — 앞뒤 토큰 보존 + 공백 1칸 정리", () => {
    const result = parseTags("오늘 #만화 너무 재밌었어");
    expect(result.tags).toEqual(["만화"]);
    expect(result.cleanContent).toBe("오늘 너무 재밌었어");
  });

  test("언더바 + 숫자 포함 식별자 허용", () => {
    const result = parseTags("#test_tag #ver2 본문");
    expect(result.tags).toEqual(["test_tag", "ver2"]);
    expect(result.cleanContent).toBe("본문");
  });

  test("`#` 다음 공백이면 태그 아님 — 본문 그대로", () => {
    const result = parseTags("# 띄어쓰기 본문");
    expect(result.tags).toEqual([]);
    expect(result.cleanContent).toBe("# 띄어쓰기 본문");
  });
});

describe("parseTags — #키:값 예약 키 제외 (1.2 후속 F1)", () => {
  test("#사람:민수 #생일:3월5일 #직업:개발자 — 예약 키만 있으면 태그 0 + 본문 빈 값", () => {
    const result = parseTags("#사람:민수 #생일:3월5일 #직업:개발자");
    expect(result.tags).toEqual([]);
    expect(result.cleanContent).toBe("");
  });

  test("콜론 없는 #태그는 그대로 추출 — 기존 동작 변동 0 (회귀 가드)", () => {
    const result = parseTags("#만화 #주술회전 고조가 죽었어!!");
    expect(result.tags).toEqual(["만화", "주술회전"]);
    expect(result.cleanContent).toBe("고조가 죽었어!!");
  });

  test("예약 키 + 콜론 없는 태그 섞임 — 콜론 없는 태그만 추출, #키:값 통째 제거", () => {
    const result = parseTags("#사람:철수, 좋은 글 #만화");
    expect(result.tags).toEqual(["만화"]);
    expect(result.cleanContent).toBe("좋은 글");
  });

  test("#사람: 값 없이 콜론만 — 예약 키로 취급해 태그 0 + 콜론까지 제거", () => {
    const result = parseTags("#사람:");
    expect(result.tags).toEqual([]);
    expect(result.cleanContent).toBe("");
  });

  test("#Manga #manga — 콜론 없는 영문 태그 소문자 정규화 + dedup 유지", () => {
    const result = parseTags("#Manga #manga");
    expect(result.tags).toEqual(["manga"]);
    expect(result.cleanContent).toBe("");
  });
});

describe("parseTags — 긴 #키:값 값 정제(2026-06-28 spec)", () => {
  test("긴 분류 값은 쉼표 전까지 통째로 제거하고 뒤 본문만 남긴다", () => {
    const result = parseTags("#소설:데뷔 못 하면 죽는 병 걸림, 감상 좋았음");
    expect(result.tags).toEqual([]);
    expect(result.cleanContent).toBe("감상 좋았음");
  });

  test("연속 분류 태그는 각각 경계까지 제거하고 본문만 남긴다", () => {
    const result = parseTags("#작품:소설, #소설:데뷔 못 하면 죽는 병 걸림, 좋았다");
    expect(result.tags).toEqual([]);
    expect(result.cleanContent).toBe("좋았다");
  });

  test("다음 # 앞에서 값 경계를 끊어 띄어쓰기 나열 분류 태그를 분리한다", () => {
    const result = parseTags("#언어:TypeScript #런타임:Bun 오늘 작업");
    expect(result.tags).toEqual([]);
    expect(result.cleanContent).toBe("");
  });

  test("쉼표로 태그 값을 닫으면 뒤 텍스트를 본문으로 남긴다", () => {
    const result = parseTags("#언어: TypeScript, 오늘 작업");
    expect(result.tags).toEqual([]);
    expect(result.cleanContent).toBe("오늘 작업");
  });

  test("속성 값 안 공백은 본문으로 잘리지 않는다", () => {
    const result = parseTags(
      "#사람:홍길동, #직업:2D 산골 나무꾼, #생일:0000년 0월 0일",
    );
    expect(result.tags).toEqual([]);
    expect(result.cleanContent).toBe("");
  });

  test("평면 해시태그는 유지하고 긴 분류 태그만 본문에서 제거한다", () => {
    const result = parseTags("#만화 #소설:데뷔 못 하면 죽는 병 걸림, 좋았다");
    expect(result.tags).toEqual(["만화"]);
    expect(result.cleanContent).toBe("좋았다");
  });
});

describe("parseTags — 엣지 케이스", () => {
  test("빈 문자열 입력 — 둘 다 빈 값", () => {
    const result = parseTags("");
    expect(result.tags).toEqual([]);
    expect(result.cleanContent).toBe("");
  });

  test("태그만 있고 본문 없음 — cleanContent 빈 문자열", () => {
    const result = parseTags("#만화 #애니");
    expect(result.tags).toEqual(["만화", "애니"]);
    expect(result.cleanContent).toBe("");
  });

  test("같은 태그 세 번 중복 입력 → 한 번만 남고 첫 등장 순서 유지", () => {
    const result = parseTags("#만화 본문 #만화 더보기 #만화");
    expect(result.tags).toEqual(["만화"]);
    expect(result.cleanContent).toBe("본문 더보기");
  });

  test("한글 + 영문 섞인 dedup — 등장 순서 보존", () => {
    const result = parseTags("#주술회전 #Manga #주술회전 #manga 본문");
    expect(result.tags).toEqual(["주술회전", "manga"]);
    expect(result.cleanContent).toBe("본문");
  });

  test("탭과 줄바꿈 같은 연속 공백도 1칸으로 정리", () => {
    const result = parseTags("#만화\n\n다시   봤어\t진짜");
    expect(result.tags).toEqual(["만화"]);
    expect(result.cleanContent).toBe("다시 봤어 진짜");
  });

  test("쉼표로 닫은 평면 태그 뒤 여러 줄 본문은 앞 쉼표 없이 본문으로 남긴다", () => {
    const result = parseTags(
      "#AI에이전트도구,\nDiscord 음성 세션을 녹음한다.\nNotion 업로드까지 이어진다.",
    );
    expect(result.tags).toEqual(["ai에이전트도구"]);
    expect(result.cleanContent).toBe(
      "Discord 음성 세션을 녹음한다. Notion 업로드까지 이어진다.",
    );
  });
});

describe("parseTags — NFC 유니코드 정규화 경계(G3-a)", () => {
  test("NFD 태그와 NFC 태그가 같은 태그로 dedup 된다", () => {
    const nfc = "노란후드".normalize("NFC");
    const nfd = "노란후드".normalize("NFD");
    // 사전 조건 — 두 표현이 실제로 다른 바이트인지 확인(테스트 전제).
    expect(nfc).not.toBe(nfd);

    const result = parseTags(`#${nfc} #${nfd} 본문`);
    // 정규화 전이면 Set 에 두 항목이 남았을 것 — NFC 통일로 한 태그만 남는다.
    expect(result.tags).toEqual([nfc]);
    expect(result.cleanContent).toBe("본문");
  });

  test("NFC 입력은 그대로 불변(회귀) — 기존 동작 동일", () => {
    const result = parseTags("#만화 #주술회전 고조가 죽었어!!");
    expect(result.tags).toEqual(["만화", "주술회전"]);
    expect(result.cleanContent).toBe("고조가 죽었어!!");
  });
});

describe("stripTagsForDisplay — 화면 표시용 줄바꿈 보존", () => {
  test("태그 없는 다문단 글은 줄바꿈을 유지한다", () => {
    const raw = "첫 줄\n\n둘째 줄\n셋째 줄";
    expect(stripTagsForDisplay(raw)).toBe(raw);
    // LLM/regex 입력용 cleanContent 는 기존처럼 한 줄로 접는다.
    expect(parseTags(raw).cleanContent).toBe("첫 줄 둘째 줄 셋째 줄");
  });

  test("태그를 제거하되 남은 본문의 줄바꿈은 유지한다", () => {
    const raw = "#아이디어\n첫 줄\n#작품:소설,\n둘째 줄 #메모\n셋째 줄";
    expect(stripTagsForDisplay(raw)).toBe("첫 줄\n둘째 줄\n셋째 줄");
  });

  test("태그가 있어도 사용자가 넣은 빈 문단은 유지한다", () => {
    const raw = "#아이디어\n첫 줄\n\n둘째 줄 #메모\n\n셋째 줄";
    expect(stripTagsForDisplay(raw)).toBe("첫 줄\n\n둘째 줄\n\n셋째 줄");
  });
});
