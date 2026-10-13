/**
 * reloginWithNewToken — 디스코드 봇 토큰 변경 hot-reload (Phase 5.5.6 / S16).
 *
 * reload-bus 구독자가 토큰 변경을 감지하면 본 helper 를 호출. destroy + login
 * 순서로 새 토큰 세션을 연다. 본인 매일 사용 봇에 영향 = *토큰 변경 1회* 한정.
 *
 * silent fallback 차단:
 *   - 새 토큰 빈 문자열 = warn 출력 + 재로그인 안 함 (옛 세션 유지)
 *   - destroy 실패 = warn 후 login 은 계속 시도 (사용자가 직접 봐서 surface)
 *   - login 실패 = error 출력 + settings 페이지 안내 메시지
 *
 * relogin 모듈을 `index.ts` 와 분리한 이유: index.ts 가 top-level 에서
 * main() 호출 즉시 봇 부팅 — 단위 검증을 위해 import 만 해도 봇이 실행되어선
 * 안 된다. relogin 은 부작용 없이 import 가능.
 */

/** 검증용 최소 discord.js Client 인터페이스. 가짜 *구현체* 안 만든다. */
export interface MinimalDiscordClient {
  destroy(): Promise<unknown> | unknown;
  login(token: string): Promise<unknown>;
}

function tag(): string {
  return `[bot-discord ${new Date().toISOString().slice(11, 19)}]`;
}

export async function reloginWithNewToken(
  client: MinimalDiscordClient,
  newToken: string,
): Promise<void> {
  if (!newToken || newToken.length === 0) {
    console.warn(
      `${tag()} reload-bus: 새 토큰이 비어 있음 — 재로그인 안 함. 봇 세션 유지.`,
    );
    return;
  }
  try {
    await client.destroy();
  } catch (err) {
    console.warn(
      `${tag()} reload-bus: 옛 client.destroy 실패 — ${err instanceof Error ? err.message : String(err)}`,
    );
    // destroy 실패해도 login 은 시도. discord.js 가 내부 상태를 정리 못 하면
    // 다음 login 이 throw 하므로 사용자에게 자연 surface.
  }
  try {
    await client.login(newToken);
    console.log(`${tag()} reload-bus: 새 토큰으로 재로그인 성공`);
  } catch (err) {
    console.error(
      `${tag()} reload-bus: 새 토큰 재로그인 실패 — ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      `${tag()} 새 토큰이 잘못됐거나 Discord 가 거부. settings 페이지에서 토큰 다시 확인 + 저장.`,
    );
  }
}
