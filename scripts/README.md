# scripts/

| 파일 | 핵심 |
|---|---|
| `test-suite.ts` | 루트 테스트 러너. 루트의 테스트는 `bun run test` 로 실행한다(러너가 실행할 파일 목록을 만들고 `apps/memory` 는 자체 러너에 맡기며 `apps/pet` 은 넣지 않는다). 루트에서 `bun test` 만 직접 실행하는 방식은 지원하지 않는다 — `apps/memory` 와 `apps/pet` 의 테스트까지 함께 잡힌다 |
| `bunfig-test-timeout.ts` | `bunfig.toml` 의 `[test] timeout` 값을 읽어 러너가 `--timeout` 으로 넘기게 한다(Bun 1.3.6 은 이 키를 직접 읽지 않는다) |

예전의 A1 자동 배포 스크립트(`a1-auto-deploy.sh`)는 2026-10-08 펫 방식 단일 배포로 바뀌면서 삭제했다. 지금 서버 반영은 저장소 루트의 `bun run deploy:a1` 하나다([deploy/README.md](../deploy/README.md)).

`apps/pet` 은 루트 workspace 밖의 독립 패키지(자기 `package.json`·`bun.lock`)다. 루트 `package.json` 의 `"!apps/pet"` 줄을 지우면 루트 잠금 파일에 없는 workspace 가 생겨 `bun install --frozen-lockfile` 이 `lockfile had changes, but lockfile is frozen` 으로 멈춘다.
