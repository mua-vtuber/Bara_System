import "../../test-setup-dom";
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createActiveModeNoticeCard } from "./active-mode-notice";

describe("createActiveModeNoticeCard", () => {
  test("appId='bot-discord' → 안내 카드 반환 + 제목 + 본문 박힘", () => {
    const card = createActiveModeNoticeCard("bot-discord");
    expect(card).not.toBeNull();
    const el = card as HTMLElement;
    expect(el.getAttribute("data-component")).toBe("active-mode-notice");
    expect(el.querySelector(".active-mode-notice-title")?.textContent).toContain(
      "준비 중",
    );
    expect(el.querySelector(".active-mode-notice-body")?.textContent).toContain(
      "아직 제공되지 않습니다",
    );
  });

  test("안내 카드 안 입력 칸 박힘 0 (Phase 10 미구현 surface 노출 금지)", () => {
    const card = createActiveModeNoticeCard("bot-discord") as HTMLElement;
    expect(card.querySelectorAll("input").length).toBe(0);
    expect(card.querySelectorAll("select").length).toBe(0);
    expect(card.querySelectorAll("textarea").length).toBe(0);
    expect(card.querySelectorAll("button").length).toBe(0);
  });

  test("appId='bot-discord' 외 어댑터 → null (다른 어댑터 탭에 박히지 않음)", () => {
    expect(createActiveModeNoticeCard("memory")).toBeNull();
    expect(createActiveModeNoticeCard("bot-telegram")).toBeNull();
    expect(createActiveModeNoticeCard("")).toBeNull();
  });
});

/**
 * 폴링 정직 라벨 — W2 약속 정합 검증.
 *
 * 봇 settings-schema 의 `evolverPollIntervalMin` description 안에
 * "폴링" + "Phase 7.4" 단어가 박혀있는지 확인. 본 description 은
 * 폼 렌더러(form-renderer)가 자동 노출하므로 wiring 추가는 없고,
 * schema description 자체가 진실의 권위.
 *
 * 본 케이스가 실패하면 W2 정착이 누락된 것이라 W6 acceptance 2번
 * (폴링 흐름 + Phase 7.4 push 종착점 표기) 도 깨진다.
 */
describe("evolverPollIntervalMin description (W6 폴링 정직 라벨)", () => {
  test("settings-schema description 안 '폴링' + 'Phase 7.4' 단어 박힘", () => {
    const schemaPath = join(
      __dirname,
      "..",
      "..",
      "..",
      "bot-discord",
      "src",
      "settings-schema.ts",
    );
    const source = readFileSync(schemaPath, "utf8");

    // evolverPollIntervalMin 칸 description 단락만 추출 — 다른 단어 우회 차단.
    const match = source.match(
      /evolverPollIntervalMin:\s*\{[^}]*?description:\s*\n?\s*"([^"]+)"/s,
    );
    expect(match).not.toBeNull();
    const description = match![1]!;

    expect(description).toContain("폴링");
    expect(description).toContain("Phase 7.4");
  });
});
