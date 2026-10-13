/**
 * 능동 모드 안내 카드 (Phase 5.7.1 W6).
 *
 * 봇 어댑터 탭(`app.id === "bot-discord"`)에 정적으로 노출되는 정보 카드.
 *
 * 디스코드 봇이 자기 판단으로 답을 던지는 "능동 모드" 기능은
 * Phase 10 정착 시 입력 칸이 노출된다. 본 시점 미구현이라 입력 칸은
 * 박지 않고, 사용자가 헛된 기대를 하지 않도록 정직한 안내 카드만 둔다.
 *
 * 약속(Phase 5.7.1 spec section 5.2 / plan section 7.2):
 *   - 봇 탭 진입 시 안내 카드 노출 + 입력 칸 0 + 아직 사용할 수 없음을 명시
 *   - 어떤 식으로도 동작 영향 0 — 정적 DOM 만 박힘
 *
 * Mock / fixture / stub 금지 규칙 정합: 본 카드 자체가 "기능이 아직 없다"는
 * 정직한 표기라 production code path 에서 거짓을 말하지 않는다.
 */

/** 봇 어댑터 식별자. manifest `app.manifest.json` 의 `"id"` 값. */
const BOT_DISCORD_APP_ID = "bot-discord";

/**
 * 능동 모드 안내 카드를 만든다.
 *
 * @param appId  현재 어댑터 탭의 app id (`FederationAppDTO.id`).
 * @returns 봇 어댑터(`bot-discord`) 일 때만 카드 element, 그 외 어댑터는 null.
 *          null 일 땐 호출부가 아무것도 박지 않는다.
 */
export function createActiveModeNoticeCard(appId: string): HTMLElement | null {
  if (appId !== BOT_DISCORD_APP_ID) {
    return null;
  }

  const card = document.createElement("section");
  card.className = "active-mode-notice";
  card.setAttribute("data-component", "active-mode-notice");

  const title = document.createElement("h3");
  title.className = "active-mode-notice-title";
  title.textContent = "봇이 먼저 메시지 보내기 — 준비 중";
  card.appendChild(title);

  const body = document.createElement("p");
  body.className = "active-mode-notice-body";
  body.textContent =
    "디스코드 봇이 스스로 판단해 메시지를 보내는 기능은 아직 제공되지 않습니다. 현재는 이 기능을 켜거나 설정할 수 없습니다.";
  card.appendChild(body);

  return card;
}
