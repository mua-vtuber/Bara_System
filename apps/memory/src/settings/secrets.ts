/**
 * API 키 별도 600 secret 파일 분리 (Phase 7 2차 Task 9 / 설계 9.3 ⓑ)
 *
 * 권위: docs/decisions/2026-06-04-phase7-2nd-active-loop-plan.md Task 9
 *       docs/decisions/2026-06-02-phase7-redesign-design.md 단락 9.3 ⓑ
 *
 * 무엇을 하나:
 *   memory-settings.json 에는 키 이름·non-secret 만 남기고, 비밀값(anthropicApiKey)은
 *   별도 파일 data/secrets.json (권한 600) 으로 분리한다. settings json 에 비밀값이
 *   0 이라, settings 파일이 읽혀도(예 백업·로그) 키가 새지 않는다.
 *
 * S10 결정(env→json)과 정합:
 *   env 로 되돌리는 게 아니라, "키만 별도 600 secret 파일로 분리 + json 은 키 이름·
 *   non-secret 만" 방향을 유지한다([[phase5.5.5-s10-completed-2026-05-19]]).
 *
 * 보관 양식 = dot-path → 값. PASSWORD_FIELD_PATHS 와 같은 경로 키를 쓴다
 *   (llm.extractor.anthropicApiKey / llm.cleanup.anthropicApiKey /
 *    llm.vision.anthropicApiKey). 한 출처라 새 키 슬롯이 늘어도 PASSWORD_FIELD_PATHS
 *   한 곳만 늘리면 분리·합류 통로가 자동으로 따라간다.
 *
 * 평문 키 로그 금지(보안 핵심): 키 값을 console.* / 에러 메시지 / throw 메시지에
 *   절대 넣지 않는다. 로그에 식별자가 필요하면 *키 이름(dot-path)* 만. 자릿수
 *   (length) 정도는 디버그 단서로 허용하되 값 자체는 절대 미포함.
 *
 * sse-tokens.ts(Task 2) 의 600 파일 보관 양식(tmp+rename atomic write + chmod)을
 *   그대로 따른다.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** at-rest 파일 권한(소유자만 읽기·쓰기). sse-tokens.ts FILE_MODE 와 같은 보안 상수. */
const FILE_MODE = 0o600;

/**
 * 디스크 보관 양식 — dot-path → 비밀값.
 * 양식 버전은 미래 변경 대비.
 */
interface SecretsFileShape {
  version: 1;
  /** dot-path(PASSWORD_FIELD_PATHS 정합) → 비밀값. */
  secrets: Record<string, string>;
}

/**
 * 600 secret 파일 보관소.
 *
 *   get(keyName)        → 비밀값 또는 undefined(부재).
 *   getOrThrow(keyName) → 비밀값. 부재면 loud throw(식별자=키 이름, 값 미포함).
 *   set(keyName, value) → 비밀값 저장(빈 문자열은 삭제 의미) + 600 영속.
 *   has(keyName)        → 비어있지 않은 값 보유 여부.
 *   snapshot()          → keyName → 값 사본(overlay 용). 비밀값을 담으니 로그 금지.
 *
 * 한 인스턴스가 한 파일을 담당. 호출자가 매번 새로 만들어도 디스크가 단일 출처라
 * 안전하다(생성자에서 로드). 파일 경로는 필수 — env BARA_SECRETS_PATH 는 부팅 진입점만 해석한다.
 */
export class SecretStore {
  private readonly values = new Map<string, string>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  /** 비밀값 조회. 부재면 undefined(silent 통과 아님 — 호출자가 부재를 판단). */
  get(keyName: string): string | undefined {
    return this.values.get(keyName);
  }

  /**
   * 비밀값 조회 — 부재면 loud throw. 식별자는 *키 이름* 만, 값은 절대 미포함.
   * Anthropic 경로처럼 키가 반드시 있어야 하는 호출자가 쓴다.
   */
  getOrThrow(keyName: string): string {
    const value = this.values.get(keyName);
    if (value === undefined || value.length === 0) {
      throw new Error(
        `secret 부재: ${keyName} — data/secrets.json 에 키를 채우거나 ollama 경로로 전환하라.`,
      );
    }
    return value;
  }

  /** 비어있지 않은 비밀값 보유 여부. */
  has(keyName: string): boolean {
    const value = this.values.get(keyName);
    return typeof value === "string" && value.length > 0;
  }

  /**
   * 비밀값 저장. 빈 문자열을 넣으면 그 키를 삭제(미설정 의미)한다.
   * 값이 바뀌지 않으면 디스크 쓰기 0(멱등 — 같은 값 재저장은 no-op).
   * 반환 = 디스크에 실제 변동이 있었는지(true=썼음).
   */
  set(keyName: string, value: string): boolean {
    const trimmedKey = keyName.trim();
    if (trimmedKey.length === 0) {
      throw new Error("secret 저장 실패: 키 이름이 비어 있다");
    }
    if (value.length === 0) {
      // 빈 값 = 삭제 의미. 키가 없으면 변동 없음.
      if (!this.values.has(trimmedKey)) return false;
      this.values.delete(trimmedKey);
      this.persist();
      return true;
    }
    if (this.values.get(trimmedKey) === value) {
      // 같은 값 재저장 — 멱등 no-op(디스크 쓰기 0).
      return false;
    }
    this.values.set(trimmedKey, value);
    this.persist();
    return true;
  }

  /**
   * keyName → 값 사본. settings overlay 가 비밀값을 settings 객체에 얹을 때 쓴다.
   * 비밀값을 담은 객체이므로 *로그에 절대 출력 금지*.
   */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.values);
  }

  /** 디스크에서 비밀값을 로드(파일 부재 = 빈 보관소). */
  private load(): void {
    if (!existsSync(this.filePath)) {
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch (err) {
      // 파일이 있는데 못 읽으면 loud fail — silent fallback 금지(경로만, 비밀값 X).
      throw new Error(
        `secret 파일 읽기 실패: ${this.filePath} — ${(err as Error).message}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `secret 파일 JSON 파싱 실패: ${this.filePath} — ${(err as Error).message}`,
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as SecretsFileShape).secrets !== "object" ||
      (parsed as SecretsFileShape).secrets === null
    ) {
      throw new Error(
        `secret 파일 형식 오류: ${this.filePath} — secrets 객체 필요`,
      );
    }
    for (const [keyName, value] of Object.entries(
      (parsed as SecretsFileShape).secrets,
    )) {
      if (typeof value !== "string" || value.length === 0) {
        continue;
      }
      this.values.set(keyName, value);
    }
  }

  /** 현재 비밀값을 디스크에 atomic 저장(tmp 쓰기 → rename) + 권한 600. */
  private persist(): void {
    const dir = dirname(this.filePath);
    if (dir && dir !== "." && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const shape: SecretsFileShape = {
      version: 1,
      secrets: Object.fromEntries(this.values),
    };

    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tmpPath, `${JSON.stringify(shape, null, 2)}\n`, {
        encoding: "utf-8",
        mode: FILE_MODE,
      });
      // 일부 마운트는 writeFileSync mode 인자를 무시할 수 있어 명시 chmod 보강.
      chmodSync(tmpPath, FILE_MODE);
      renameSync(tmpPath, this.filePath);
      // rename 후 대상 파일 권한도 명시(이미 존재했던 경우 보강).
      chmodSync(this.filePath, FILE_MODE);
    } catch (err) {
      if (existsSync(tmpPath)) {
        try {
          unlinkSync(tmpPath);
        } catch {
          // tmp 정리 실패는 저장 실패 사유를 가리지 않게 조용히 통과
          // (아래에서 원래 에러를 loud 로 던진다).
        }
      }
      throw new Error(
        `secret 파일 저장 실패: ${this.filePath} — ${(err as Error).message}`,
      );
    }
  }
}
