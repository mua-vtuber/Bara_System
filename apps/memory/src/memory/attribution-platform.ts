/**
 * attribution-platform.ts — 작성자 자동 연결을 하지 않는 플랫폼 판별(DA-1).
 *
 * person-link.ts 안에 인라인으로 있던 Discord 판별 정규식을 단일 출처로 뽑았다
 * (docs/decisions/2026-09-20-discord-author-metadata.md). 이 판별은 person-link.ts
 * 하나만 쓰지만, 판별 규칙 자체(접두어 + `:`·`-` 경계)는 이후 다른 attribution-only
 * 플랫폼이 추가될 때도 이 목록 하나만 늘리면 되게 상수로 둔다.
 */

/**
 * 작성 사실만으로 사람 엔티티·authored_by 엣지를 만들지 않는 플랫폼. 이 목록의 값은
 * 소문자 접두어이고, 판별은 `<접두어>`·`<접두어>:...`·`<접두어>-...` 형태를 모두 잡는다
 * (예: "discord", "discord-channel", "discord:123"). 다른 접두어를 우연히 포함하는
 * 값("discord2")은 잡지 않는다.
 */
export const ATTRIBUTION_ONLY_PLATFORMS = ["discord"] as const;

const ATTRIBUTION_ONLY_PATTERN = new RegExp(
  `^(?:${ATTRIBUTION_ONLY_PLATFORMS.join("|")})(?:$|[-:])`,
  "i",
);

/**
 * value 가 attribution-only 플랫폼을 가리키는지 판별한다. 대소문자 무시, 앞뒤 공백은
 * 호출자가 trim 해서 넘긴다(person-link.ts 선례 — 여러 후보 값을 한 번에 검사하므로
 * trim 은 호출부 판단).
 */
export function isAttributionOnlyPlatform(value: string): boolean {
  return ATTRIBUTION_ONLY_PATTERN.test(value);
}
