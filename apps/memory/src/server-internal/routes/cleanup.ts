/**
 * server-internal/routes/cleanup.ts — cleanup·reset·re-embed 라우트 등록기
 *
 * POST /cleanup — raw auto_capture 노드를 extractor 에 던져 세분화(LLM 백필).
 * POST /admin/reset-memory — 메모리·휴지통·엔티티·자산 전 테이블 한 트랜잭션
 *   비우기(설계 2026-06-11-reset-memory-entity-tables-spec §7.1).
 * POST /admin/re-embed-images — Phase 11b T3, 옛 image_asset 위 새 모델 재 가동.
 *
 * 절대 제약:
 *   extractor·imageEmbedder·assetStore 는 선택 의존이므로 구조분해로 미리
 *   꺼내지 않는다. 핸들러 안에서 호출 시점에 deps 로 lookup — 미설정 시 503.
 */

import type { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { parseLimit, err } from "../http-helpers.ts";
import { mergeSynonymDict } from "../../memory/synonyms/merge-synonym-dict.ts";
import { reloadClassifyVocabFromDeps } from "../reload-classify-vocab.ts";
import { mergeRelationVocabSkippingOrphans } from "../../memory/relation-vocab/relation-vocab-merge.ts";
import { loadRelationVocabularySeed } from "../../memory/relation-vocab/relation-vocab-loader.ts";
import {
  setRelationVocabOverride,
  resetRelationVocabCache,
} from "../../memory/entity-relation-vocabulary.ts";
import {
  setEntityTypeOverride,
  resetConceptTypeVocabularyCache,
  clearConceptVocabularyOverrides,
} from "../../memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";
import { memoryMutationsPending, withMemoryWriteActivity } from "../../memory/shared-memory-mutation-lock.ts";
import { reEmbedAllImages } from "../../memory/migration/re-embed-images.ts";
import {
  commitBackfillCandidate,
  prepareBackfillCandidate,
} from "../../memory/backfill-extraction.ts";

/** 준비 단계가 후보를 건너뛴 이유(prepareBackfillCandidate 가 null 을 돌려준 경우). */
const SKIPPED_AT_PREPARE_REASON =
  "준비 시점에 원문이 현재 기억이 아니거나 기본 조회에서 보이지 않았다";

/** Phase 11b T3 — POST /admin/re-embed-images 안 confirm 토큰 권위 상수. */
const REEMBED_CONFIRM_TOKEN = "REEMBED-ALL-IMAGES";

/**
 * cleanup·reset·re-embed 세 라우트를 app 에 등록한다.
 *
 * deps 객체 자체를 받는다 (extractor·imageEmbedder·assetStore 구조분해 금지).
 * extractor 가 undefined 면 POST /cleanup 은 503.
 * imageEmbedder 또는 assetStore 가 undefined 면 POST /admin/re-embed-images 는 503.
 */
export function registerCleanupRoutes(app: Hono, deps: MemoryApiDeps): void {
  const { store } = deps;

  // ── POST /cleanup — raw 메모리 LLM 백필 ───────────────────────────────
  // 옛 auto_capture 노드들을 차례로 extractor 에 던져 세분화.
  // Body 옵션:
  //   since:   ISO 날짜 (이 시점 이후 노드만; 기본: 전체)
  //   limit:   처리할 노드 최대 수 (기본 50, 최대 200)
  //   dryRun:  true 면 추출만 하고 저장 안 함 (디버깅용)
  //   minImportance: 노드 importance 하한 (이 값 미만은 스킵)
  // 응답: processed·stored·bumped(추출), rechunked(긴 원문 재청크), failures·errors(실패),
  //   discarded(잠금 안 재확인에서 버린 결과와 이유 — 성공으로 세지 않는다).
  app.post("/cleanup", (c) => withMemoryWriteActivity(store, async () => {
    if (!deps.extractor) {
      return err(
        c,
        503,
        "extractor not configured — backfill requires an LLM client",
      );
    }

    let body: {
      since?: unknown;
      limit?: unknown;
      dryRun?: unknown;
      minImportance?: unknown;
    } = {};
    try {
      const raw = await c.req.text();
      if (raw.length > 0) body = JSON.parse(raw);
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    const limit = parseLimit(body.limit, 50, 200);
    const dryRun = body.dryRun === true;
    const since = typeof body.since === "string" ? body.since : undefined;
    const minImportance =
      typeof body.minImportance === "number" &&
      Number.isFinite(body.minImportance)
        ? Math.max(0, Math.min(1, body.minImportance))
        : 0;

    const candidates = await store.getBackfillCandidates({
      limit,
      since,
      minImportance,
    });

    // 저장 경로와 같은 청크 설정 — 긴 원문 후보는 추출하지 않고 재청크한다(WP-B1-31).
    const chunkingSettings = deps.getSettings?.().chunking;
    const chunking = chunkingSettings
      ? { tokenCap: chunkingSettings.tokenCap, minChunkTokens: chunkingSettings.minChunkTokens }
      : undefined;

    let processed = 0;
    let stored = 0;
    let bumped = 0;
    let rechunked = 0;
    let failures = 0;
    const errors: Array<{ nodeId: number; error: string }> = [];
    const discarded: Array<{ nodeId: number; reason: string }> = [];

    for (const candidate of candidates) {
      try {
        // WP-B1-31 — 백필 스케줄러와 같은 준비·저장 두 단계다(memory/backfill-extraction.ts).
        // LLM 은 쓰기 잠금 밖에서 부르고(태그를 뺀 본문, skipHashtagWiring=true — 옛 22~24회
        // 태그 누적 bug 차단), 저장은 잠금 안에서 원문 본문·revision·현재성·가시성·후보 조건을
        // 다시 확인한 뒤에만 한다. LLM 을 기다리는 동안 원문이 편집되면 결과를 버리고
        // 추출 완료 표시를 하지 않는다 — 편집이 남긴 추출 대기 표시가 그대로 남는다.
        // 청크가 필요한 긴 원문은 LLM 을 부르지 않고 재청크한다.
        const prepared = await prepareBackfillCandidate(
          deps.extractor,
          store,
          candidate.id,
          chunking,
        );
        if (prepared === null) {
          discarded.push({ nodeId: candidate.id, reason: SKIPPED_AT_PREPARE_REASON });
          continue;
        }
        if (dryRun) {
          // dryRun — LLM 준비(또는 긴 원문 판정)까지만 하고 아무것도 쓰지 않는다.
          if (prepared.kind === "rechunk") rechunked += 1;
          else processed += 1;
          continue;
        }
        const outcome = await commitBackfillCandidate(deps.extractor, store, prepared);
        if (outcome.kind === "discarded") {
          console.warn(`[cleanup] 기억 ${candidate.id} 추출 결과 버림: ${outcome.reason}`);
          discarded.push({ nodeId: candidate.id, reason: outcome.reason });
          continue;
        }
        if (outcome.kind === "rechunked") {
          rechunked += 1;
          continue;
        }
        stored += outcome.storedNodeIds.length;
        bumped += outcome.bumpedNodeIds.length;
        processed += 1;
      } catch (e) {
        failures += 1;
        const error = e instanceof Error ? e.message : String(e);
        console.error(`[cleanup] 기억 ${candidate.id} 처리 실패: ${error}`);
        errors.push({ nodeId: candidate.id, error });
      }
    }

    return c.json({
      requestedLimit: limit,
      dryRun,
      candidatesFound: candidates.length,
      processed,
      stored,
      bumped,
      // 추출 대신 새 청크로 나눈 긴 원문 수(dryRun 이면 나눌 대상으로 판정한 수, 쓰기 없음).
      rechunked,
      failures,
      errors,
      // 저장하지 않고 버린 후보와 이유 — 성공으로 세지 않는다.
      discarded,
    });
  }));

  // ── POST /admin/reset-memory — 데이터 초기화 ──────────────────────────
  // settings 페이지 "데이터 초기화" 통로가 호출.
  // 현재 schema 의 메모리 전 테이블 — 글·엣지·개념·사람·엔티티 9 본체·라벨/관계
  // 엣지·요약·경계 테이블(정리 작업 표 포함)·자산/문서 메타·사용자 사전(동의어·분류 어휘·
  // 끄기 표시·관계명·새 엔티티 종류) — 을 한 트랜잭션 비우기 +
  // sqlite_sequence 초기화(번호 1 부터) + 디스크 자산 파일 정리. 휴지통(archive)
  // 포함. 설정 JSON 파일과 정규식 학습 자산(regex_user_*)·asset_folder_pairing·schema_version 은 보존 — schema_version 은 기준 스키마(v47)가
  // 적은 버전 기록을 그대로 두어 비운 DB 도 다음 시작의 버전 판정을 통과한다(설계 2026-10-02 마이그레이션 압축 5·9절).
  // 반환은 묶음 집계(ResetMemoryCounts) — 그룹별 합 + totalRowsDeleted.
  //
  // 두 단계로 나눈다:
  //   1) store.resetAllMemory() — DB 트랜잭션(권위). 실패 시 디스크는 안 건드림.
  //   2) deps.assetStore.clearContent() — DB 정리 성공 후 디스크 자산 파일 삭제.
  //      assetStore 미주입(자산 디렉토리 부재) 또는 디스크 정리 실패는 응답 JSON
  //      에 그대로 표기 — 삭제를 성공으로 위장하지 않는다(silent fallback 금지).
  //
  // confirm 토큰 강제 — 우발 curl / 잘못된 fetch 호출 차단.
  // UI 이중 confirm 통과 후에만 이 토큰을 담아 전송한다.
  //   Body: { "confirm": "RESET ALL MEMORY" }
  app.post("/admin/reset-memory", async (c) => {
    let body: { confirm?: unknown } = {};
    try {
      const raw = await c.req.text();
      if (raw.length > 0) body = JSON.parse(raw);
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    if (body.confirm !== "RESET ALL MEMORY") {
      return err(
        c,
        400,
        "confirm 토큰 누락 — 본 통로는 body 에 { confirm: \"RESET ALL MEMORY\" } 가 필요",
      );
    }

    // 0단계: 백그라운드 사이클, 잠금 밖 AI 준비, 실행/대기 중 쓰기가 있으면
    // 물러난다. 초기화가 지운 뒤 그 사이클이 옛 글 번호로 결과·제안을 다시 쓰면, 번호를 1 부터 다시 쓰는 새 글에
    // 옛 결과가 붙는다. 확인과 아래 트랜잭션 사이에 await 가 없어 그 사이 사이클이 시작될 수 없다(단일 스레드).
    // 초기화 뒤 시작한 사이클은 빈 DB 를 본다.
    if (deps.backgroundWritersRunning?.() || memoryMutationsPending(store)) {
      return err(
        c,
        409,
        "입력 저장 또는 백그라운드 작업(정리·추출·이미지 분석·문서 OCR)이 진행 중이라 초기화하지 않았다. 작업이 끝난 뒤(정리 작업은 취소해도 된다) 다시 시도",
      );
    }

    // 1단계: DB 권위 트랜잭션. 여기서 throw 면 디스크는 손대지 않은 상태로 끝.
    const deleted = store.resetAllMemory();

    // 1b단계: 부팅·CRUD 가 모듈 캐시·검색 사전에 얹어 둔 사용자 사전을 DB 와 맞춘다. DB 의 사용자
    // 사전 행이 사라졌는데 캐시에 남으면 재시작 전까지 분류·검색이 지워진 사전을 계속 쓴다.
    // DB 는 이미 비웠으므로 여기서 실패해도 응답을 오류로 바꾸지 않고(자산 정리도 계속) 경고로 알린다 —
    // 재시작하면 부팅이 빈 DB 로 캐시를 다시 얹는다.
    let vocabReloadWarning: string | null = null;
    try {
      reloadVocabCachesAfterReset(deps);
    } catch (e) {
      vocabReloadWarning = `사용자 사전 캐시 갱신 실패 — ${
        e instanceof Error ? e.message : String(e)
      }. DB 는 비웠음. 재시작하면 반영됨.`;
      console.warn(`reset-memory: ${vocabReloadWarning}`);
    }

    // 2단계: 디스크 자산 파일 정리. assetStore 미주입 또는 삭제 실패는 응답에 표기.
    let assetFilesDeleted = 0;
    let assetCleanupWarning: string | null = null;
    if (!deps.assetStore) {
      assetCleanupWarning =
        "assetStore 미설정 — 디스크 자산 파일을 정리하지 못함 " +
        "(settings.assets.dir 또는 BARA_ASSET_DIR 확인). DB 메타는 비웠음.";
      console.warn(`reset-memory: ${assetCleanupWarning}`);
    } else {
      try {
        assetFilesDeleted = deps.assetStore.clearContent();
      } catch (e) {
        assetCleanupWarning = `디스크 자산 파일 정리 실패 — ${
          e instanceof Error ? e.message : String(e)
        }. DB 메타는 비웠음.`;
        console.warn(`reset-memory: ${assetCleanupWarning}`);
      }
    }

    return c.json({
      message: "메모리 + 휴지통 + 사용자 사전 한 묶음 비움. 설정값은 보존.",
      deleted,
      assetFilesDeleted,
      assetCleanupWarning,
      vocabReloadWarning,
    });
  });

  // ── POST /admin/re-embed-images — 옛 자산 새 모델 재 가동 (Phase 11b T3) ─
  // settings 페이지 [재 임베딩] 버튼이 호출. 옛 image_asset 한 가지 한 가지
  // 새 모델 호출 + image_vec 갱신 + 차원 변경 시점 가상 테이블 다시 만들기.
  //
  // confirm 토큰 강제 — 우발 curl / 잘못된 fetch 호출 차단 (옛 reset-memory
  // 양식 정합). UI 이중 confirm 통과 후에만 이 토큰을 담아 전송한다.
  //   Body: { "confirm": "REEMBED-ALL-IMAGES" }
  //
  // 의존:
  //   - deps.assetStore — 자산 파일 회수. 미주입 시 503.
  //   - deps.imageEmbedder — 새 모델 임베더. 미주입 시 503.
  //   - deps.store.getRawDb() — image_vec / images / knowledge_nodes 직접 SQL.
  //
  // 응답: { total, succeeded, failed } 동기. 자산 수가 많으면 응답 시간 길 수
  // 있음 — 사용자 흐름은 [재 임베딩] 버튼 안 비활성·진행 신호 가족 표시.
  app.post("/admin/re-embed-images", (c) => withMemoryWriteActivity(store, async () => {
    let body: { confirm?: unknown } = {};
    try {
      const raw = await c.req.text();
      if (raw.length > 0) body = JSON.parse(raw);
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    if (body.confirm !== REEMBED_CONFIRM_TOKEN) {
      return err(
        c,
        400,
        `confirm 토큰 누락 — 본 통로는 body 에 { confirm: "${REEMBED_CONFIRM_TOKEN}" } 가 필요`,
      );
    }

    if (!deps.assetStore) {
      return err(
        c,
        503,
        "assetStore 미설정 — 자산 디렉토리 부재 (settings.assets.dir 또는 BARA_ASSET_DIR 확인)",
      );
    }
    if (!deps.imageEmbedder) {
      return err(
        c,
        503,
        "imageEmbedder 미설정 — 이미지 임베더 부재 (server.ts createImageEmbedder 확인)",
      );
    }

    const result = await reEmbedAllImages({
      db: store.getRawDb(),
      assetStore: deps.assetStore,
      embedder: deps.imageEmbedder,
    });

    return c.json({
      message: `재 임베딩 마침 — 전체 ${result.total} / 성공 ${result.succeeded} / 실패 ${result.failed}`,
      ...result,
    });
  }));
}

/**
 * 데이터 초기화 직후 사용자 사전 캐시를 DB(이제 비어 있음)에 맞춰 다시 얹는다.
 * 각 CRUD 라우트(synonyms·classify-vocab·entity-types·relation-vocab)의 reload 와 같은 주입을
 * 같은 순서(종류 명부 → 관계 어휘 → 분류 어휘)로 거친다. 주입되지 않은 repo(옛 harness·부팅 비활성)는 건너뛴다.
 */
function reloadVocabCachesAfterReset(deps: MemoryApiDeps): void {
  const { store } = deps;

  // 검색 동의어 — yaml 원본 위에 (이제 빈) 사용자 행을 다시 합친다.
  if (deps.synonymUserRepo && deps.synonymYamlDict) {
    deps.retriever.reloadSynonymDict(
      mergeSynonymDict(deps.synonymYamlDict, deps.synonymUserRepo.listEntries()),
    );
  }

  // 새 엔티티 종류 명부 — 비어 있으면 코드 상수 10종만 남는다. 종류 명부 파생 캐시는 여기서 비운다
  // (이 reset 은 분류 어휘 주입분을 남기므로 아래 분류 어휘 재주입이 따로 필요하다 — 병합이 명부를 돌아
  // 명부 갱신 뒤에 와야 한다).
  setEntityTypeOverride(store.entityTypeRegistryDb.listUserEntityTypes());
  resetConceptTypeVocabularyCache();

  // 관계 어휘 — yaml 씨앗만 남는다.
  if (deps.relationNameUserRepo) {
    setRelationVocabOverride(
      mergeRelationVocabSkippingOrphans(loadRelationVocabularySeed(), deps.relationNameUserRepo.listEntries()),
    );
    resetRelationVocabCache();
  }

  // 분류 어휘 — yaml 기준선만 남는다(사용자 추가·끄기 표시 모두 비어 있음). repo 가 주입되지 않은
  // harness 는 다시 얹을 출처가 없으니 주입분을 비워 yaml 기본으로 돌린다.
  if (!reloadClassifyVocabFromDeps(deps)) clearConceptVocabularyOverrides();

  // 분류기 2차 캐시는 마지막에 비운다.
  resetClassifierCache();
}
