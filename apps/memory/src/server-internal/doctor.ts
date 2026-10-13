/**
 * server-internal/doctor.ts — bara_doctor 자가 진단 내부 함수 (T23 / spec E).
 *
 * AI 가 검색 0건을 받았을 때 "이 주제 기억이 없다"와 "임베더가 죽어 검색 자체가
 * 안 됐다"를 구분할 방법이 없었다 — 전자로 오판(hallucination)하는 게 이 결함의
 * 실제 피해다. runDoctor 는 인자 0개 읽기 전용 진단으로 그 간극을 메운다.
 *
 * 계약(spec E):
 *   1. 응답 = { stages, firstBlockingCause, counters }.
 *   2. firstBlockingCause 는 의존 순서상 *가장 먼저* 실패한 단계 정확히 하나 —
 *      전건 통과면 null. 여러 단계가 동시에 깨져도 사용자가 고칠 것은 하나뿐이다
 *      (뒤 단계는 앞 단계가 원인일 수 있어 동시에 나열하면 오히려 혼란).
 *   3. 각 단계는 개별 try-catch — 한 단계 예외가 전체 진단을 죽이지 않는다.
 *      예외 자체가 "이 단계는 unhealthy"라는 정직한 관측이다.
 *   4. COUNT/메타데이터 쿼리만 — 전체 스캔 금지(D-D). embedder 단계는 로드 상태 +
 *      설정 정합만 보고 라이브 embed 호출은 하지 않는다(비용 회피 — 로드 여부와
 *      차원 일치만으로 "동작 가능"을 충분히 판정할 수 있다).
 *   5. 읽기 전용 — 이 함수는 어떤 테이블에도 쓰지 않는다(최종 체크 타임스탬프도
 *      기록하지 않음).
 *
 * REST(GET /doctor)·MCP(bara_doctor) 양쪽이 이 한 함수를 그대로 재노출한다 — 두
 * 표면이 같은 문구·같은 순서를 갖는다는 계약은 이 단일 출처에서 자동으로 나온다.
 */

import { accessSync, constants, statfsSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryApiDeps } from "./types.ts";
import { embeddingDimensionOf, type EmbedderModel } from "../embedding/factory.ts";
import { listValidRounds } from "../backup/backup-manifest.ts";
import { getConfiguredTimeZone, nowInZone } from "../db/store-internal/helpers.ts";
import { KEEP_OLD_MEMORY_ASSET_FOLDER_GUIDANCE } from "../db/migration-stop-guidance.ts";

/** 한 진단 단계의 결과. detail 은 사람이 읽는 부연 — healthy=true 여도 참고 정보로 실을 수 있다. */
export interface DoctorStageResult {
  name: string;
  healthy: boolean;
  detail?: string;
}

/** 처음 실패한 단계 하나 — 사용자가 지금 당장 손댈 것. fix 는 구체적 설정 키·명령을 이름으로 부른다. */
export interface DoctorFirstBlockingCause {
  stage: string;
  problem: string;
  fix: string;
}

export interface DoctorReport {
  stages: DoctorStageResult[];
  firstBlockingCause: DoctorFirstBlockingCause | null;
  counters: {
    knowledgeNodes: number;
    vecNodes: number;
    ftsRows: number;
  };
}

/**
 * "YYYY-MM-DD HH:MM:SS" 형태로 저장된 시각(nowInZone 이 쓰는 설정 시간대 기준
 * 문자열)이 지금으로부터 몇 ms 지났는지 계산한다.
 *
 * 리뷰 High 2 근거 — cleanup_runs.started_at 은 nowInZone()/nowKst() 로 설정
 * 시간대(default Asia/Seoul, KST) 문자열로 저장된다. 이 문자열을 `Date.parse(s +
 * "Z")` 로 UTC 파싱하면 A1(KST) 운영에서 항상 9시간 어긋난다 — helpers.ts 가 이미
 * 문서화한 정확히 그 함정이다(datetime('now','localtime') 이 UTC 로 떨어지는 것과
 * 쌍을 이루는 반대 방향 오류: 여기서는 KST 문자열을 UTC 로 잘못 해석한다).
 *
 * `Date.parse(s)`(zone 표기 없이 로컬 파싱)도 정답이 아니다 — Node/Bun 의 로컬
 * zone 은 프로세스가 도는 OS 설정이지 애플리케이션 settings.time.zone 이 아니라서,
 * 서버가 UTC 로 도는 A1 인스턴스라면 또 어긋난다. 그래서 "지금 UTC epoch"과 "지금을
 * 설정 시간대로 찍은 같은 포맷 문자열"의 오프셋을 실측해, 그 오프셋을 저장된
 * 문자열에 적용하는 방식으로 설정 시간대를 명시적으로 반영한다(nowInZone 이 저장에
 * 쓰는 것과 대칭 계산 — 리뷰가 요구한 "configured-timezone parser symmetric with
 * nowInZone()").
 *
 * 옛 레거시 행(setTimeZone 도입 전 datetime('now','localtime') 로 적힌 모호한
 * 문자열)은 이 함수로도 완전히 복구되지 않을 수 있다 — 그 시절 문자열이 실제로 어느
 * zone 이었는지는 저장 당시 OS TZ 에 달려 있어 사후 판별이 불가능하다. 이 함수는
 * "현재 설정 시간대가 저장 시간대와 같다"는 전제로 최선을 다해 계산할 뿐, 그
 * 전제가 깨진 과거 행에 대한 완벽한 보정은 하지 않는다(정직한 한계 기록).
 */
function ageMsSinceZoneString(stored: string): number {
  const zone = getConfiguredTimeZone();
  const nowMs = Date.now();
  const nowInZoneStr = nowInZone(zone);
  // "YYYY-MM-DD HH:MM:SS" 를 UTC 로 강제 파싱해 오프셋 계산용 기준점을 만든다 —
  // 이 값 자체는 시간대상 틀리지만, storedAsUtc 와 nowInZoneAsUtc 양쪽에 *같은*
  // 틀린 해석을 적용하므로 차이(오프셋)는 정확하다.
  const nowInZoneAsUtcMs = Date.parse(nowInZoneStr.replace(" ", "T") + "Z");
  const storedAsUtcMs = Date.parse(stored.replace(" ", "T") + "Z");
  if (!Number.isFinite(nowInZoneAsUtcMs) || !Number.isFinite(storedAsUtcMs)) {
    return Number.POSITIVE_INFINITY;
  }
  // offset = (설정 zone 문자열을 UTC 로 잘못 읽은 값) - (진짜 UTC now)
  //        = 설정 zone 이 UTC 보다 얼마나 앞서 있는지(KST 라면 +9h).
  const offsetMs = nowInZoneAsUtcMs - nowMs;
  const storedAsUtcCorrected = storedAsUtcMs - offsetMs;
  return nowMs - storedAsUtcCorrected;
}

/**
 * 한 단계를 실행하고 예외를 잡아 unhealthy 결과로 바꾼다. 계약 3 — 한 단계
 * 예외가 전체 진단을 죽이지 않는다(그 단계 결과 자체가 "예외 발생 = unhealthy").
 */
function runStage(
  name: string,
  fn: () => DoctorStageResult,
): DoctorStageResult {
  try {
    return fn();
  } catch (e) {
    return {
      name,
      healthy: false,
      detail: `단계 실행 중 예외 — ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * bara_doctor 진단 본체. REST GET /doctor · MCP bara_doctor 가 그대로 호출한다.
 *
 * 의존 순서(앞 단계가 무너지면 뒤 단계 판정 자체가 무의미해지는 순서)로 8단계를
 * 돈다: DB open → embedder → vec 정합 → FTS 정합 → image_vec 정합 → cleanup →
 * backup → disk. firstBlockingCause 는 이 순서에서 처음 unhealthy 인 단계 하나만
 * 취한다.
 */
export function runDoctor(deps: MemoryApiDeps): DoctorReport {
  const { store } = deps;

  // ── 1) DB open/readable ────────────────────────────────────────────────
  const dbStage = runStage("db", () => {
    const row = store.getRawDb().query("SELECT 1 AS ok").get() as { ok: number } | null;
    if (!row || row.ok !== 1) {
      return { name: "db", healthy: false, detail: "SELECT 1 프로브가 예상 결과를 반환하지 않음" };
    }
    return { name: "db", healthy: true };
  });

  // ── 2) embedder — 로드 상태 + 설정 차원 vs factory 차원 정합 ────────────
  // 라이브 embed 호출은 비용이라 하지 않는다(계약 4) — 로드 여부 + 차원 일치만으로
  // "검색이 임베딩 계산을 할 수 있는 상태인가"를 충분히 판정할 수 있다.
  //
  // 정직 한계(리뷰 Minor) — 이 단계는 *설정 정합*만 본다. 차원이 맞아도 모델이
  // 내부적으로 깨져 embed() 호출이 항상 실패하는 경우(예: ONNX 런타임 손상)는 이
  // 단계를 통과한다 — 라이브 probe 를 안 하기로 한 계약 4 의 직접적 대가다. detail
  // 문구에 그 한계를 명시해 "healthy=true"가 "실동작 확인됨"으로 오독되지 않게 한다.
  const embedderStage = runStage("embedder", () => {
    const embedder = store.embedder;
    const configuredModel: EmbedderModel = deps.getSettings?.().db.embeddingModel ?? "bge-m3";
    const expectedDim = embeddingDimensionOf(configuredModel);
    if (embedder.dimension !== expectedDim) {
      return {
        name: "embedder",
        healthy: false,
        detail:
          `임베더 차원 불일치 — 설정 모델(${configuredModel})의 기대 차원 ${expectedDim}, ` +
          `실제 로드된 임베더 차원 ${embedder.dimension}`,
      };
    }
    return {
      name: "embedder",
      healthy: true,
      detail:
        `모델 ${configuredModel}, 차원 ${embedder.dimension} — 설정 정합 확인일 뿐 ` +
        `실동작 probe 아님(라이브 embed 호출 없음)`,
    };
  });

  // ── 3) vec 정합 — vec_nodes count vs knowledge_nodes(임베딩 보유분) count ──
  const vecStage = runStage("vecConsistency", () => {
    const db = store.getRawDb();
    const vecCount = (db.query("SELECT COUNT(*) AS n FROM vec_nodes").get() as { n: number }).n;
    // source_type='image_asset' 노드는 Phase 11a 설계상 embedding_text=NULL 로
    // 저장되고 vec_nodes(bge-m3 텍스트 벡터)에 절대 안 들어간다 — 이미지는 SigLIP
    // image_vec 별도 채널을 쓴다(image-asset.ts addImageAssetNode, node-repo-ingest-mixin.ts
    // 주석 근거). 이 예외를 빼지 않으면 이미지가 하나라도 있는 실 DB 는 vec_nodes 가
    // 항상 knowledge_nodes 보다 적어 vecConsistency 가 영구 unhealthy 로 오판된다
    // (리뷰 High 1 — 도구의 목적을 뒤집는 false positive였다).
    const nodeCount = (
      db
        .query("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE source_type != 'image_asset'")
        .get() as { n: number }
    ).n;
    // image 쪽 대칭 확인 — image_vec 이 image_asset 노드 수와 맞는지도 COUNT 로만
    // 곁들인다(본 stage 의 healthy 판정에는 안 넣는다 — vecConsistency 는 텍스트
    // 벡터 채널 전용이라는 이름 그대로 좁게 유지하고, image_vec 어긋남은 detail 로만
    // 노출해 정보 손실 없이 판정 책임은 분리한다).
    const imageAssetCount = (
      db.query("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE source_type = 'image_asset'").get() as {
        n: number;
      }
    ).n;
    const imageVecCount = (db.query("SELECT COUNT(*) AS n FROM image_vec").get() as { n: number }).n;
    const imageNote =
      imageAssetCount > 0
        ? ` (image_asset ${imageAssetCount}건 별도 — image_vec ${imageVecCount}건, ` +
          `임베딩 실패로 skip 된 이미지가 있으면 자연히 낮을 수 있음)`
        : "";
    if (vecCount !== nodeCount) {
      return {
        name: "vecConsistency",
        healthy: false,
        detail: `vec_nodes ${vecCount}건 vs knowledge_nodes(텍스트 임베딩 대상) ${nodeCount}건 — 불일치${imageNote}`,
      };
    }
    return {
      name: "vecConsistency",
      healthy: true,
      detail: `${vecCount}건 정합${imageNote}`,
    };
  });

  // ── 4) FTS 정합 — knowledge_nodes_fts_docsize count vs knowledge_nodes count ──
  const ftsStage = runStage("ftsConsistency", () => {
    const db = store.getRawDb();
    // contentless FTS5(content='knowledge_nodes')는 본 가상 테이블에 대한
    // `SELECT COUNT(*) FROM knowledge_nodes_fts` 가 실제 인덱스 상태를 반영하지
    // 않는다(개별 'delete' 명령으로 문서를 지워도 그대로 옛 건수를 돌려주는 실측
    // 확인 — FTS5 가상 테이블 특성). 대신 FTS5 가 매 문서 크기를 기록하는 shadow
    // table `_docsize` 를 직접 세면 실제 색인된 문서 수를 정확히 반영한다(메타데이터
    // 카운트 — 계약 4, 본문 스캔 아님).
    const ftsCount = (
      db.query("SELECT COUNT(*) AS n FROM knowledge_nodes_fts_docsize").get() as { n: number }
    ).n;
    const nodeCount = (
      db.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }
    ).n;
    if (ftsCount !== nodeCount) {
      return {
        name: "ftsConsistency",
        healthy: false,
        detail: `knowledge_nodes_fts ${ftsCount}건 vs knowledge_nodes ${nodeCount}건 — 불일치`,
      };
    }
    return { name: "ftsConsistency", healthy: true, detail: `${ftsCount}건 정합` };
  });

  // ── 5) imageVecConsistency — SigLIP 이미지 벡터 채널 전용 판정 ──────────
  // vecConsistency(3단계)는 텍스트 벡터 채널 전용이라 image_vec 어긋남을 detail
  // 로만 곁들인다(판정 책임 분리). 그 분리의 대가로 SigLIP 채널이 통째로 죽어도
  // (이미지 노드는 있는데 image_vec 0건) doctor 가 healthy 를 내는 구멍이 있었다
  // — 이 단계가 그 채널을 정면으로 판정한다.
  //
  // 순서 근거 — 텍스트 검색 코어(embedder→vec→FTS) 뒤, 운영 단계(cleanup·backup·
  // disk) 앞. firstBlockingCause 는 앞선 단계를 취하므로, 주 검색 경로(텍스트)
  // 결함이 이미지 전용 채널 결함보다 먼저 사용자에게 가야 하고, 데이터 정합 결함은
  // 운영 유지보수 결함보다 먼저 가야 한다.
  //
  // 판정 기준 — 부분 결측은 정식 경로다: addImageAssetNode(image-asset.ts)는
  // embedding=null 이면 노드만 만들고 warn 후 image_vec 을 skip 한다(모델 미로드
  // 등). 개별 skip 은 ingest 시점에 warn 으로 이미 드러난 산발 실패라 doctor 가
  // 결함으로 격상하지 않는다. 반면 커버리지가 절반 아래면 이미지 검색이 보유
  // 이미지의 다수를 못 찾는 상태 — 산발 실패의 우연한 누적이 아니라 모델이
  // 지속적으로 안 뜨는 체계적 원인을 가리키므로 결함으로 판정한다. 0.5 는 "검색이
  // 놓치는 쪽이 다수가 되는 경계"라는 다수결 기준 — 산발/체계 구분선으로 이보다
  // 덜 자의적인 값이 없어 채택(전멸 0건은 비율과 무관하게 별도 분기로 명시 실패).
  //
  // 정직 한계 — SigLIP 임베더의 현재 가용성(모델 로드 여부)은 여기서 확인하지
  // 않는다: deps 에 이미지 임베더 핸들이 없고, 확인하려면 ONNX 모델 로드가 필요해
  // 계약 4(라이브 probe 금지)와 어긋난다. 이 단계는 DB 에 남은 결과(커버리지)로만
  // 판정한다 — embedder 단계가 텍스트 모델에 대해 갖는 한계와 같은 성질.
  const IMAGE_VEC_MIN_COVERAGE_RATIO = 0.5;
  const imageVecStage = runStage("imageVecConsistency", () => {
    const db = store.getRawDb();
    const imageAssetCount = (
      db.query("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE source_type = 'image_asset'").get() as {
        n: number;
      }
    ).n;
    const imageVecCount = (db.query("SELECT COUNT(*) AS n FROM image_vec").get() as { n: number }).n;
    if (imageVecCount > imageAssetCount) {
      // 정상 경로로는 불가능한 방향(insert 는 노드와 한 트랜잭션, delete 는
      // image_vec_delete 트리거 동기화) — 고아 벡터는 트리거·수동 조작 결함 신호.
      return {
        name: "imageVecConsistency",
        healthy: false,
        detail: `image_vec ${imageVecCount}건 > image_asset 노드 ${imageAssetCount}건 — 고아 벡터(image_vec_delete 트리거 동기화 결함 추정)`,
      };
    }
    if (imageAssetCount === 0) {
      return {
        name: "imageVecConsistency",
        healthy: true,
        detail: "image_asset 노드 없음 — 이미지 채널 점검 대상 아님(실제 빈 상태)",
      };
    }
    if (imageVecCount === 0) {
      return {
        name: "imageVecConsistency",
        healthy: false,
        detail: `image_asset ${imageAssetCount}건 전부 image_vec 없음 — SigLIP 이미지 임베딩 채널 전멸(이미지 검색 불능)`,
      };
    }
    const coverage = imageVecCount / imageAssetCount;
    if (coverage < IMAGE_VEC_MIN_COVERAGE_RATIO) {
      return {
        name: "imageVecConsistency",
        healthy: false,
        detail:
          `image_vec ${imageVecCount}/${imageAssetCount}건(커버리지 ${Math.round(coverage * 100)}%) — ` +
          `절반 미만, 산발 skip 이 아닌 체계적 임베딩 실패 추정`,
      };
    }
    const missing = imageAssetCount - imageVecCount;
    return {
      name: "imageVecConsistency",
      healthy: true,
      detail:
        `image_vec ${imageVecCount}/${imageAssetCount}건 정합` +
        (missing > 0 ? ` — 결측 ${missing}건은 ingest 시 warn 된 산발 skip 허용치 이내` : ""),
    };
  });

  // ── 6) cleanup — run 원장 stalled 감지 ──────────────────────────────────
  // "stalled" = status='running' 인데 시작 후 1시간 넘게 안 끝난 run. 정상 사이클은
  // 분 단위로 끝나므로(cycle-budget maxCalls 상한), 1시간은 "죽은 프로세스가 남긴
  // running 행"을 가리키는 충분히 넉넉한 문턱이다.
  const STALLED_THRESHOLD_MS = 60 * 60 * 1000;
  const cleanupStage = runStage("cleanup", () => {
    const db = store.getRawDb();
    let hasTable = false;
    try {
      db.query("SELECT 1 FROM cleanup_runs LIMIT 1").get();
      hasTable = true;
    } catch {
      hasTable = false;
    }
    if (!hasTable) {
      return { name: "cleanup", healthy: true, detail: "cleanup_runs 테이블 없음(구 스키마) — 점검 대상 아님" };
    }
    const stalled = db
      .query(
        `SELECT run_id, started_at FROM cleanup_runs
         WHERE status = 'running'
         ORDER BY started_at ASC LIMIT 1`,
      )
      .get() as { run_id: string; started_at: string } | null;
    if (!stalled) {
      return { name: "cleanup", healthy: true, detail: "진행 중인 run 없음" };
    }
    const ageMs = ageMsSinceZoneString(stalled.started_at);
    if (ageMs > STALLED_THRESHOLD_MS) {
      return {
        name: "cleanup",
        healthy: false,
        detail: `run_id=${stalled.run_id} 가 ${Math.round(ageMs / 60000)}분째 running 상태 — 정체된 run으로 추정`,
      };
    }
    return { name: "cleanup", healthy: true, detail: `run_id=${stalled.run_id} 진행 중(정상 범위)` };
  });

  // ── 7) backup — 마지막 백업 시각 vs 기대 주기 ───────────────────────────
  // "기대"는 24시간 — backup cron(T3)의 정기 주기가 하루 1회이므로, 24시간을 넘겨도
  // 성공 기록이 없으면 회차가 밀렸거나 cron 자체가 죽었다는 신호다.
  const BACKUP_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
  const backupStage = runStage("backup", () => {
    const backup = deps.backup;
    if (!backup) {
      return { name: "backup", healthy: true, detail: "backup 미배선 — 점검 대상 아님(정직한 비활성)" };
    }
    // getBackupStatus(프로세스 메모리 싱글턴 — 재시작 시 null)는 "이번 가동 중 이력"만
    // 알려줘 doctor 판정 근거로는 약하다 — 디스크의 회차 manifest 를 직접 스캔하는
    // listValidRounds 가 재시작과 무관한 진실을 준다(backup.ts 라우트와 같은 근거).
    const rounds = listValidRounds(backup.backupDir);
    if (rounds.length === 0) {
      return {
        name: "backup",
        healthy: false,
        detail: `backupDir=${backup.backupDir} 안에 유효한 백업 회차 없음`,
      };
    }
    const latest = rounds[rounds.length - 1]!;
    // manifest.timestamp(zone 표기 문자열)를 파싱하지 않는다 — manifest 는 이미
    // epochMs(UTC epoch ms, retention 만료 판정용으로 backup-manifest.ts 가 애초에
    // 마련한 필드)를 갖고 있어 시간대 가정 자체가 필요 없다(리뷰 High 2 — cleanup
    // 단계의 zone 불일치와 별개로, backup 단계는 파싱 없는 산술 비교로 근본 회피).
    const ageMs = Date.now() - latest.manifest.epochMs;
    if (ageMs > BACKUP_STALE_THRESHOLD_MS) {
      return {
        name: "backup",
        healthy: false,
        detail: `마지막 백업이 ${Math.round(ageMs / 3600000)}시간 전(${latest.manifest.timestamp}) — 24시간 주기 초과`,
      };
    }
    return { name: "backup", healthy: true, detail: `마지막 백업 ${latest.manifest.timestamp}` };
  });

  // ── 8) disk — 데이터 디렉토리 쓰기 가능 + 여유 공간 ─────────────────────
  // "cheap fs call" — du 같은 재귀 스캔이 아니라 accessSync(W_OK) + statfs 한 번으로
  // writable·여유 공간을 확인한다(asset-disk.ts 의 du 는 여기서 안 쓴다 — 그쪽은
  // 자산 디렉토리 전체 크기 측정용 무거운 호출이라 doctor 의 "가벼운 체크" 계약과
  // 안 맞는다). accessSync 는 실제 파일을 만들지 않는 권한 비트 확인이라 read-only
  // 파일시스템에 마운트된 경우까지 statfs 단독보다 더 정확히 잡는다.
  const DISK_FREE_THRESHOLD_BYTES = 500 * 1024 * 1024; // 500MB
  const diskStage = runStage("disk", () => {
    const backup = deps.backup;
    if (!backup || backup.dbPath === ":memory:" || backup.dbPath === "") {
      return { name: "disk", healthy: true, detail: "파일 DB 아님(:memory:) — 점검 대상 아님" };
    }
    const dataDir = dirname(backup.dbPath);
    try {
      accessSync(dataDir, constants.W_OK);
    } catch (e) {
      return {
        name: "disk",
        healthy: false,
        detail: `데이터 디렉토리 쓰기 불가 — dataDir=${dataDir}, cause=${e instanceof Error ? e.message : String(e)}`,
      };
    }
    let free: number;
    try {
      const fs = statfsSync(dataDir);
      free = fs.bfree * fs.bsize;
    } catch (e) {
      return {
        name: "disk",
        healthy: false,
        detail: `statfs 실패 — dataDir=${dataDir}, cause=${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (free < DISK_FREE_THRESHOLD_BYTES) {
      return {
        name: "disk",
        healthy: false,
        detail: `여유 공간 ${(free / 1e6).toFixed(1)}MB — 500MB 미만`,
      };
    }
    return { name: "disk", healthy: true, detail: `여유 공간 ${(free / 1e9).toFixed(2)}GB` };
  });

  const stages: DoctorStageResult[] = [
    dbStage,
    embedderStage,
    vecStage,
    ftsStage,
    imageVecStage,
    cleanupStage,
    backupStage,
    diskStage,
  ];

  const firstFailure = stages.find((s) => !s.healthy);
  const firstBlockingCause: DoctorFirstBlockingCause | null = firstFailure
    ? {
        stage: firstFailure.name,
        problem: firstFailure.detail ?? `${firstFailure.name} 단계 비정상`,
        fix: fixMessageFor(firstFailure.name, firstFailure.detail),
      }
    : null;

  // counters 는 표시용 부가 정보라 이 단계 하나의 실패로 전체 응답이 죽으면 안 된다
  // (계약 3 과 같은 정신 — DB 자체가 unhealthy 인 경우 dbStage 가 이미 그 사실을
  // stages 에 담았으니, 여기서는 0 으로 정직하게 떨어뜨린다. silent fallback 이
  // 아니라 — stages[0].healthy=false 가 진짜 원인을 이미 밝혔고, 이 0 은 그 뒤에
  // 딸린 표시값일 뿐이다).
  let counters = { knowledgeNodes: 0, vecNodes: 0, ftsRows: 0 };
  try {
    const db = store.getRawDb();
    counters = {
      knowledgeNodes: (db.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }).n,
      vecNodes: (db.query("SELECT COUNT(*) AS n FROM vec_nodes").get() as { n: number }).n,
      ftsRows: (
        db.query("SELECT COUNT(*) AS n FROM knowledge_nodes_fts_docsize").get() as { n: number }
      ).n,
    };
  } catch {
    // dbStage 가 이미 unhealthy 로 원인을 기록했다 — 여기서는 표시값만 0 으로 둔다.
  }

  return { stages, firstBlockingCause, counters };
}

/**
 * 단계 이름 → 구체적 조치 문구(한글, 설정 키·명령 이름 지정 — 비밀값은 절대 담지
 * 않는다). 각 stage 함수가 이미 detail 로 원인을 말했으니, 여기서는 "무엇을 할지"만
 * 좁혀 말한다.
 */
function fixMessageFor(stageName: string, detail: string | undefined): string {
  switch (stageName) {
    case "db":
      return "DB 파일 경로(BARA_DB_PATH 또는 data/bara.sqlite)와 프로세스 권한을 확인 — 서버 재시작 필요할 수 있음";
    case "embedder":
      return (
        "settings.db.embeddingModel 값과 실제 로드된 임베더가 같은 모델인지 확인 후 서버 재시작(빈 DB 재시작이 필요한 모델 전환일 수 있음). " +
        KEEP_OLD_MEMORY_ASSET_FOLDER_GUIDANCE
      );
    case "vecConsistency":
      return "일부 텍스트 노드가 임베딩 없이 저장됨(image_asset 은 정상적으로 제외됨) — 결측 노드 재저장 또는 재임베딩 절차 필요";
    case "ftsConsistency":
      return "FTS 색인이 본 테이블과 어긋남 — DB 재구성(REINDEX) 또는 서버 재시작 후 재확인 필요";
    case "imageVecConsistency":
      return detail?.includes("고아 벡터")
        ? "image_vec 에 대응 노드 없는 행이 남음 — image_vec_delete 트리거와 수동 DB 조작 이력 확인 필요"
        : "SigLIP 이미지 임베딩이 저장 시점에 계산되지 않음 — 서버 로그의 [image-asset]/[re-embed] warn 확인 후 POST /admin/re-embed-images 로 재임베딩 필요";
    case "cleanup":
      return "정체된 run을 POST /api/cleanup-runs/:id/cancel 로 취소하거나 서버 재시작으로 스케줄러를 복구";
    case "backup":
      return detail?.includes("없음")
        ? "backup.dir 설정과 cron 가동 여부 확인 — 최초 회차가 아직 안 돈 것일 수 있음"
        : "backup cron이 24시간 내 성공하지 못함 — 로그 확인 및 수동 GET /backup/download 로 상태 점검";
    case "disk":
      return detail?.includes("쓰기 불가")
        ? "데이터 디렉토리 권한 확인(프로세스 실행 계정이 쓰기 권한을 가져야 함)"
        : "데이터 디렉토리 여유 공간 확보(오래된 백업 회차·휴지통 정리) 필요";
    default:
      return "server-internal/doctor.ts 의 해당 단계 로직 확인 필요";
  }
}
