/**
 * dashboard/settings-danger-zone.ts — 설정 메모리 탭 하단 "위험 영역" 모듈.
 *
 * settings.ts 에서 떼어낸 데이터 초기화·이미지 재임베딩 통로(renderDangerZone +
 * runDataReset + runReembedImages)를 한곳에 모은다. settings.ts 본체를 800줄 한계
 * 아래로 내리기 위한 분리일 뿐 동작은 옮기기 전과 동일하다.
 */

import { showToast } from "./form/toast";
import { apiFetch } from "./api-fetch";

const SETTINGS_BASE = "/settings";

/**
 * 메모리 탭 하단 "위험 영역" — 데이터 초기화 통로.
 *
 * 본 단락은 본인 결정으로 박힌 통로 (2026-05-21):
 *   - 삭제 범위 = 메모리 + 정리 세션 (knowledge_nodes / edges / archive /
 *     evolver_activity / memory_revisions). 휴지통 포함. 설정값 보존.
 *   - 안전장치 = 이중 클릭 모달 (confirm 두 번).
 *
 * 클라이언트 이중 confirm 통과 후에만 라우트 confirm 토큰 박아 호출.
 * 라우트(POST /admin/reset-memory) 자체도 같은 토큰 강제 — 우발 curl
 * 차단 두 번째 layer.
 *
 * Phase 5.7.3 W5 reference — 데이터 초기화 통로가 참조하는 `evolver_activity`
 * 테이블 이름은 옛 evolver 사이클 폐기 후에도 그대로 재사용한다 (W6 plan §6
 * 결정 — 활동 로그 테이블 schema 변경 회피). 따라서 위 단락 + runDataReset
 * 안 `evolverActivity` 응답 필드 이름은 DB-측 식별자로 의도적으로 유지한다.
 */
export function renderDangerZone(): HTMLElement {
  const section = document.createElement("section");
  section.className = "danger-zone";
  section.dataset.section = "danger-zone";

  const title = document.createElement("h2");
  title.textContent = "위험 영역";
  section.appendChild(title);

  const desc = document.createElement("p");
  desc.className = "danger-zone-desc";
  desc.textContent =
    "데이터 초기화 = 저장된 메모리·휴지통·엔티티·첨부 기록과 정리 작업 기록, 사용자가 추가한 사전(동의어·분류 어휘·관계명·새 엔티티 종류)까지 한 묶음 비우기. 설정값(LLM 슬롯, 디스코드 토큰 등)과 정규식 학습 자산은 보존. 되돌릴 수 없음.";
  section.appendChild(desc);

  const status = document.createElement("p");
  status.className = "danger-zone-status";
  status.textContent = "";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "danger-zone-btn";
  btn.textContent = "데이터 초기화";
  btn.addEventListener("click", () => {
    void runDataReset(btn, status);
  });

  section.appendChild(btn);
  section.appendChild(status);

  // ── 이미지 재 임베딩 통로 (Phase 11b T3 / 2026-05-29) ──────────────────
  // settings 안 이미지 임베딩 모델 변경 시점 옛 자산 위 새 모델 재 가동.
  // 같은 위험 단락 안 두 번째 갈래 — 데이터 자체는 보존 (knowledge_nodes·
  // images·asset_files 무수정), image_vec 가상 테이블만 갱신. 차원 변경
  // 시점 = 가상 테이블 DROP + 새 차원 다시 만들기 (옛 임베딩 자연 비워짐).
  //
  // 이중 confirm = 옛 데이터 초기화 양식 정합. POST /admin/re-embed-images
  // 라우트도 confirm 토큰 강제 — 우발 호출 차단 두 layer.
  const reembedDesc = document.createElement("p");
  reembedDesc.className = "danger-zone-desc";
  reembedDesc.style.marginTop = "16px";
  reembedDesc.textContent =
    "이미지 재 임베딩 = 옛 이미지 자산을 현재 설정된 모델로 다시 임베딩. 차원이 달라지면 image_vec 가상 테이블을 새로 만든다 (옛 임베딩은 자연 비워짐). 자산 파일과 노드는 보존. 자산이 많으면 시간이 걸린다.";
  section.appendChild(reembedDesc);

  const reembedStatus = document.createElement("p");
  reembedStatus.className = "danger-zone-status";
  reembedStatus.textContent = "";

  const reembedBtn = document.createElement("button");
  reembedBtn.type = "button";
  reembedBtn.className = "danger-zone-btn";
  reembedBtn.textContent = "이미지 재 임베딩";
  reembedBtn.addEventListener("click", () => {
    void runReembedImages(reembedBtn, reembedStatus);
  });

  section.appendChild(reembedBtn);
  section.appendChild(reembedStatus);

  return section;
}

async function runDataReset(
  btn: HTMLButtonElement,
  status: HTMLElement,
): Promise<void> {
  // 1차 confirm — 본인 의도 확인.
  const ok1 = globalThis.confirm(
    "데이터 초기화 = 저장된 메모리·휴지통·엔티티·첨부 기록과 정리 작업 기록, 사용자가 추가한 사전(동의어·분류 어휘·관계명·새 엔티티 종류)을 한 묶음 비우기. 설정값과 정규식 학습 자산은 보존. 되돌릴 수 없음.\n\n진행할까?",
  );
  if (!ok1) return;

  // 2차 confirm — 본인이 한 번 더 손가락 누르는 자리. 실수 클릭 차단.
  const ok2 = globalThis.confirm(
    "마지막 확인. 본 동작은 *모든* 메모리 + 휴지통 데이터와 사용자 사전을 비운다.\n\n진짜 진행할까?",
  );
  if (!ok2) return;

  btn.disabled = true;
  status.textContent = "초기화 중...";
  status.classList.remove("error");
  try {
    const res = await apiFetch("/admin/reset-memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "RESET ALL MEMORY" }),
    });
    // 응답 deleted = 묶음 집계(ResetMemoryCounts). 핵심 3칸(노드·관계·휴지통)은
    // 호환 위해 유지되고, 새 그룹(엔티티·요약·자산·경계)과 totalRowsDeleted 가
    // 더해졌다(설계 2026-06-11-reset-memory-entity-tables-spec §7.2).
    const body = (await res.json().catch(() => ({}))) as {
      message?: string;
      error?: string;
      deleted?: {
        knowledgeNodes: number;
        knowledgeEdges: number;
        knowledgeNodesArchive: number;
        entities: number;
        entityEdges: number;
        summaries: number;
        conceptsAndPersons: number;
        assets: number;
        logs: number;
        boundary: number;
        /** 사용자 사전(동의어·분류 어휘·관계명·새 종류). 옛 서버 응답에는 없을 수 있다. */
        userVocabulary?: number;
        totalRowsDeleted: number;
      };
      /** DB 는 비웠지만 뒤따른 정리(디스크 첨부 파일·사전 캐시)가 실패했을 때의 설명. */
      assetCleanupWarning?: string | null;
      vocabReloadWarning?: string | null;
    };
    if (!res.ok) {
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    const d = body.deleted;
    const summary = d
      ? `노드 ${d.knowledgeNodes} / 관계 ${d.knowledgeEdges} / 휴지통 ${d.knowledgeNodesArchive} / 엔티티 ${d.entities} / 요약 ${d.summaries} / 자산 ${d.assets} / 사용자 사전 ${d.userVocabulary ?? 0} / 전체 ${d.totalRowsDeleted}행 비움.`
      : "비움 완료.";
    const warnings = [body.assetCleanupWarning, body.vocabReloadWarning].filter((w): w is string => !!w);
    status.textContent = `데이터 초기화 완료 — ${summary}${warnings.length ? ` 주의: ${warnings.join(" / ")}` : ""}`;
    showToast(warnings.length ? "데이터 초기화 완료(일부 정리 실패 — 상태 줄 확인)" : "데이터 초기화 완료", warnings.length ? "error" : "success");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    status.textContent = `초기화 실패: ${message}`;
    status.classList.add("error");
    showToast(`초기화 실패: ${message}`, "error");
  } finally {
    btn.disabled = false;
  }
}

/**
 * 이미지 재 임베딩 실행 (Phase 11b T3 / 2026-05-29).
 *
 * 이중 confirm 통과 후 POST /admin/re-embed-images 호출 (confirm 토큰
 * `REEMBED-ALL-IMAGES`). 응답 = `{ message, total, succeeded, failed }`.
 * 자산 수가 많으면 응답 시간 길 수 있어 버튼 비활성 + "재 임베딩 중..."
 * 상태 표시. 옛 runDataReset 양식 정합 — silent skip 금지, 실패는 명시
 * 신호 (status.error 클래스 + 토스트).
 */
async function runReembedImages(
  btn: HTMLButtonElement,
  status: HTMLElement,
): Promise<void> {
  // 1차 confirm — 의도 확인.
  const ok1 = globalThis.confirm(
    "이미지 재 임베딩 = 옛 이미지 자산 한 가지 한 가지 새 모델로 다시 가동. 자산이 많으면 시간이 걸린다.\n\n진행할까?",
  );
  if (!ok1) return;

  // 2차 confirm — 한 번 더 손가락. 실수 클릭 차단.
  const ok2 = globalThis.confirm(
    "마지막 확인. 차원이 바뀌면 옛 image_vec 가상 테이블이 새로 만들어진다 (옛 임베딩 자연 비워짐).\n\n진짜 진행할까?",
  );
  if (!ok2) return;

  btn.disabled = true;
  status.textContent = "재 임베딩 중...";
  status.classList.remove("error");
  try {
    const res = await apiFetch("/admin/re-embed-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "REEMBED-ALL-IMAGES" }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      message?: string;
      error?: string;
      total?: number;
      succeeded?: number;
      failed?: number;
    };
    if (!res.ok) {
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    const summary =
      typeof body.total === "number"
        ? `전체 ${body.total} / 성공 ${body.succeeded ?? 0} / 실패 ${body.failed ?? 0}`
        : "마침.";
    status.textContent = `재 임베딩 완료 — ${summary}`;
    showToast("재 임베딩 완료", "success");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    status.textContent = `재 임베딩 실패: ${message}`;
    status.classList.add("error");
    showToast(`재 임베딩 실패: ${message}`, "error");
  } finally {
    btn.disabled = false;
  }
}
