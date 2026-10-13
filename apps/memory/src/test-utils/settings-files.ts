/**
 * test-utils/settings-files.ts — 설정 파일 읽기·쓰기를 "settings 옆 비밀값 파일"과 한 쌍으로 부르는 테스트 도우미.
 * 테스트 전용: 제품 코드가 import 하지 않는다.
 *
 * get/putMemorySettings 는 비밀값 파일 경로를 필수로 받는다(env BARA_SECRETS_PATH 미참조). 이 도우미는 테스트가 넘긴
 * settings 경로 옆(secretsPathBesideSettings)을 명시로 넘겨, apps/memory/.env 가 운영 비밀값 파일을 가리켜도
 * 케이스 임시 폴더 밖에는 쓰지 않는다.
 */
import {
  getMemorySettings,
  putMemorySettings,
  secretsPathBesideSettings,
  type MemorySettings,
  type MemorySettingsPartial,
} from "../settings/memory-settings.ts";

/** settingsPath 와 그 옆 비밀값 파일로 설정을 읽는다. */
export function getSettingsAt(settingsPath: string): MemorySettings {
  return getMemorySettings(settingsPath, secretsPathBesideSettings(settingsPath));
}

/** settingsPath 와 그 옆 비밀값 파일에 부분 설정을 저장한다. */
export function putSettingsAt(partial: MemorySettingsPartial, settingsPath: string): void {
  putMemorySettings(partial, settingsPath, secretsPathBesideSettings(settingsPath));
}
