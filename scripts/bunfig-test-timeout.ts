import { join } from "node:path";

/**
 * 테스트 러너가 bunfig.toml 의 `[test] timeout`(ms)을 읽어 `bun test --timeout` 으로 넘기기 위한 읽기 함수.
 *
 * Bun 1.3.6 은 bunfig.toml 의 `[test] timeout` 을 읽지 않는다. 문서화된 `[test]` 키는
 * root·preload·pathIgnorePatterns·smol·coverage 계열뿐이고, 타임아웃은 `--timeout` 플래그나
 * 테스트별 세 번째 인자로만 줄 수 있다. 그래서 `timeout = 60000` 을 적어 두어도 6초짜리 테스트가
 * 5000ms 기본값에서 실패했다(실측). 러너가 이 함수로 같은 파일의 값을 읽어 플래그로 넘기면
 * 설정값이 한 곳(bunfig.toml)에서 실제로 적용된다.
 *
 * 값이 없거나 양의 정수가 아니면 기본값으로 때우지 않고 오류로 멈춘다.
 *
 * @param dir `bun test` 를 실행할 작업 디렉터리 — Bun 이 읽는 bunfig.toml 이 있는 곳.
 */
export async function readBunfigTestTimeoutMs(dir: string): Promise<number> {
  const bunfigPath = join(dir, "bunfig.toml");
  const file = Bun.file(bunfigPath);
  if (!(await file.exists())) {
    throw new Error(`${bunfigPath} 가 없어 [test] timeout 을 읽을 수 없습니다.`);
  }
  const parsed = Bun.TOML.parse(await file.text()) as {
    test?: { timeout?: unknown };
  };
  const timeout = parsed.test?.timeout;
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0) {
    throw new Error(
      `${bunfigPath} 의 [test] timeout 이 양의 정수(ms)가 아닙니다: ${String(timeout)}`,
    );
  }
  return timeout;
}
