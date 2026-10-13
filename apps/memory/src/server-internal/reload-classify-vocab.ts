/**
 * server-internal/reload-classify-vocab.ts — deps 의 repo·yaml 기준선으로 분류 어휘 주입분을
 * 다시 얹는 공용 통로. 분류 어휘 CRUD·종류 CRUD·데이터 초기화 라우트가 한 곳을 거친다
 * (라우트마다 복사본을 두면 한쪽만 고쳐져 어긋난다).
 */
import type { MemoryApiDeps } from "./types.ts";
import { applyClassifyVocabOverrides } from "../memory/classify-vocab/apply-classify-vocab.ts";

/**
 * yaml 기준선(conceptVocabYaml) + 사용자 추가 행 + 가림표를 다시 병합해 병합본·항목 동의어 맵·
 * 칸 datatype 맵을 주입하고 분류기 2차 캐시를 비운다. 병합이 종류 명부를 돌므로 종류 명부가
 * 바뀐 직후(setEntityTypeOverride 뒤)에 부른다.
 *
 * repo 또는 yaml 기준선이 미주입(옛 harness·부팅 비활성)이면 건너뛰고 false 를 돌려준다.
 * 병합이 불변식 위반을 throw 하면 그대로 올려 보낸다 — 호출자가 처리한다.
 */
export function reloadClassifyVocabFromDeps(deps: MemoryApiDeps): boolean {
  if (!deps.classifyVocabUserRepo || !deps.conceptVocabYaml) return false;
  applyClassifyVocabOverrides(
    deps.conceptVocabYaml,
    deps.classifyVocabUserRepo.listEntries(),
    deps.classifyVocabOverrideRepo?.listOverrides() ?? [],
  );
  return true;
}
