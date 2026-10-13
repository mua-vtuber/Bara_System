import { describe, expect, test } from "bun:test";
import {
  displaySnippetWithoutHashtags,
  displayTextWithoutHashtags,
  displayTitleForNode,
  keywordTagLabelsFromText,
  mergeTagLabels,
} from "./hashtag-display.ts";

describe("hashtag-display — 제목·본문 표시 정리", () => {
  test("평면 키워드 해시태그는 제목에서 숨기고 본문만 남긴다", () => {
    expect(
      displayTitleForNode({
        type: "memory",
        label: "#아이디어 #그래프 그래프 모달 정리",
        snippet: "#아이디어 #그래프 그래프 모달 정리",
      }),
    ).toBe("그래프 모달 정리");
  });

  test("이미 정리된 graph label 이 있으면 snippet 보다 label 을 우선한다", () => {
    expect(
      displayTitleForNode({
        sourceType: "bot",
        label: "산책 중에 생각한 것들",
        snippet: "#메모 날씨가 좋아서 한강변을 걸었다.",
      }),
    ).toBe("산책 중에 생각한 것들");
  });

  test("콜론 태그도 제목에서 숨기지만 태그 칸 후보가 되지는 않는다", () => {
    const text = "#작품:데뷔 못 하면 죽는 병 걸림, #장르:판타지, 다시 읽기";
    expect(displayTextWithoutHashtags(text)).toBe("다시 읽기");
    expect(keywordTagLabelsFromText(text)).toEqual([]);
  });

  test("평면 키워드 태그만 # 붙은 칩 라벨로 돌려준다", () => {
    const text = "#아이디어 #작품:소설, #Graph #graph 본문";
    expect(keywordTagLabelsFromText(text)).toEqual(["#아이디어", "#graph"]);
  });

  test("태그만 있는 글은 제목 fallback 을 쓴다", () => {
    expect(
      displayTitleForNode({
        type: "memory",
        label: "#아이디어 #그래프",
        snippet: "#아이디어 #그래프",
      }),
    ).toBe("태그만 있는 글");
  });

  test("본문 없는 일정 태그 글은 일정 값을 제목 fallback 으로 쓴다", () => {
    expect(
      displayTitleForNode({
        type: "memory",
        label: "#일정:침뜸치료, #날짜:2000년 01월 01일",
        snippet: "#일정:침뜸치료, #날짜:2000년 01월 01일",
      }),
    ).toBe("침뜸치료");
  });

  test("엔티티·분류 노드는 라벨 자체를 보존한다", () => {
    expect(
      displayTitleForNode({
        type: "classification_key",
        label: "작품",
        snippet: "#작품:소설",
      }),
    ).toBe("작품");
  });

  test("snippet 도 표시용으로 해시태그를 걷어낸다", () => {
    expect(displaySnippetWithoutHashtags("#태그 본문 #메모")).toBe("본문");
    expect(displaySnippetWithoutHashtags("#태그 #메모")).toBeUndefined();
  });

  test("표시용 snippet 은 사용자가 입력한 줄바꿈을 보존한다", () => {
    expect(displaySnippetWithoutHashtags("첫 줄\n\n둘째 줄")).toBe("첫 줄\n\n둘째 줄");
    expect(displaySnippetWithoutHashtags("#태그\n첫 줄\n둘째 줄")).toBe("첫 줄\n둘째 줄");
  });

  test("tag label 병합은 순서 보존 + 중복 제거", () => {
    expect(mergeTagLabels(["#a", "#b"], ["#b", "#c"])).toEqual(["#a", "#b", "#c"]);
    expect(mergeTagLabels([], undefined)).toBeUndefined();
  });
});
