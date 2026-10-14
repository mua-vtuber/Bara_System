/**
 * dashboard/settings-llm-section.ts — 설정 LLM 슬롯 블록 렌더·섹션 조립.
 *
 * LLM 세 슬롯(의미 추출 extractor / 데이터 정리 cleanup / 이미지 캡션 vision) 의
 * 블록 렌더와 한 섹션 조립(renderLlmSection)을 담는다. 값 타입·읽기 헬퍼는
 * settings-llm-types.ts, 공통 컨트롤 빌더는 settings-llm-controls.ts 에 있다.
 * settings.ts 에는 readLlmGroup·renderLlmSection 만 노출한다(readLlmGroup 은 재노출).
 */

import { renderBackfillAttemptsPanel } from "./settings-backfill-attempts-panel";
import { createSlotCommonControls } from "./settings-llm-controls";
import { renderRetryFields } from "./settings-llm-retry-fields";
import { buildProviderPayload, isProviderChanged } from "./settings-llm-provider-forms";
import {
  readLlmGroup,
  type LlmProvider,
  type LlmGroupValue,
  type LlmExtractorValue,
  type LlmCleanupValue,
  type LlmVisionValue,
  type LlmSectionHandle,
  type LlmSlotSectionHandle,
  type CommonModeBlockHandle,
  type LlmSlotBlocksHandle,
} from "./settings-llm-types";

// settings.ts 가 한 모듈에서 두 진입점을 받도록 readLlmGroup 을 재노출한다.
export { readLlmGroup };

/**
 * 공통 동작방식 (3) 블록 — 즉시/주기 라디오 1쌍 + 주기 분 입력 1개 (Task 6).
 *
 * extractor-vision-unified-clock-scheduler 결정 5 — 캡션 시점·주기 분은 의미추출
 * AI 수준 공통 설정이고 권위는 llm.extractor 슬롯이다. 그래서 이 블록의 payload·
 * isChanged 는 extractor 의 mode / backfill.intervalMin 에만 합류하고, vision
 * payload 에는 mode·intervalMin 이 들어가지 않는다.
 *
 * 입력 id 는 extractor 권위 유지 — `llm-extractor-mode-{immediate,backfill}` /
 * `llm-extractor-backfill-intervalMin`. 한 라디오 쌍이 텍스트·이미지 batchSize
 * 가시성 둘 다 제어한다 (registerBackfillTarget 로 등록한 외부 블록 일괄 토글).
 *
 * @param current extractor 옛 디스크 값 (mode·intervalMin 초기 채움).
 * @param original extractor 옛 디스크 값 (변경 감지 기준).
 */
export function renderCommonModeBlock(
  current: LlmExtractorValue,
  original: LlmExtractorValue,
): CommonModeBlockHandle {
  const block = document.createElement("div");
  block.className = "llm-common-mode-block";
  block.dataset.section = "common-mode";

  const heading = document.createElement("h3");
  heading.className = "llm-block-title";
  heading.textContent = "처리 시점";
  block.appendChild(heading);

  // ── mode 라디오 (즉시 / 주기 갈래 선택, extractor 권위) ─────────────────────
  const modeRow = document.createElement("div");
  modeRow.className = "llm-extra-row";
  modeRow.dataset.section = "extractor-mode";
  const modeLabel = document.createElement("label");
  modeLabel.textContent = "처리 시점";
  modeRow.appendChild(modeLabel);

  const modeList = document.createElement("div");
  modeList.className = "llm-mode-list";

  // 라디오 1 — 즉시 추출.
  const immediateLabel = document.createElement("label");
  const immediateRadio = document.createElement("input");
  immediateRadio.type = "radio";
  immediateRadio.name = "llm-extractor-mode";
  immediateRadio.value = "immediate";
  immediateRadio.id = "llm-extractor-mode-immediate";
  immediateRadio.checked = current.mode === "immediate";
  immediateLabel.appendChild(immediateRadio);
  immediateLabel.appendChild(document.createTextNode("입력하면 바로 처리"));
  modeList.appendChild(immediateLabel);

  // 라디오 2 — 주기로 추출 (사이클 가동).
  const backfillLabel = document.createElement("label");
  const backfillRadio = document.createElement("input");
  backfillRadio.type = "radio";
  backfillRadio.name = "llm-extractor-mode";
  backfillRadio.value = "backfill";
  backfillRadio.id = "llm-extractor-mode-backfill";
  backfillRadio.checked = current.mode === "backfill";
  backfillLabel.appendChild(backfillRadio);
  backfillLabel.appendChild(document.createTextNode("일정 간격으로 처리"));
  modeList.appendChild(backfillLabel);

  modeRow.appendChild(modeList);
  block.appendChild(modeRow);

  // ── 주기 분 입력 (extractor 권위 — id 유지) ────────────────────────────────
  const backfillBox = document.createElement("div");
  backfillBox.className = "llm-backfill-box";
  backfillBox.dataset.section = "common-mode-interval";

  const intervalRow = document.createElement("div");
  intervalRow.className = "llm-field-row";
  const intervalLabel = document.createElement("label");
  intervalLabel.htmlFor = "llm-extractor-backfill-intervalMin";
  intervalLabel.textContent = "처리 간격(분)";
  intervalRow.appendChild(intervalLabel);
  const backfillIntervalInput = document.createElement("input");
  backfillIntervalInput.type = "number";
  backfillIntervalInput.id = "llm-extractor-backfill-intervalMin";
  backfillIntervalInput.min = "1";
  backfillIntervalInput.value = String(current.backfill.intervalMin);
  intervalRow.appendChild(backfillIntervalInput);
  backfillBox.appendChild(intervalRow);

  block.appendChild(backfillBox);

  // 한 라디오 쌍이 (3) 주기 분 + (4)/(5) batchSize 가시성을 모두 제어한다. backfill
  // 갈래일 때만 보여야 할 외부 블록을 등록받아 mode 토글 시 일괄 display 갱신.
  // display:none 만 토글 — DOM 안 입력값은 살아 있어 form-state 보존.
  const backfillTargets: HTMLElement[] = [backfillBox];

  function applyModeVisibility(): void {
    const visible = backfillRadio.checked;
    for (const el of backfillTargets) {
      el.style.display = visible ? "" : "none";
    }
  }
  applyModeVisibility();
  immediateRadio.addEventListener("change", applyModeVisibility);
  backfillRadio.addEventListener("change", applyModeVisibility);

  function registerBackfillTarget(el: HTMLElement): void {
    backfillTargets.push(el);
    el.style.display = backfillRadio.checked ? "" : "none";
  }

  function isBackfillSelected(): boolean {
    return backfillRadio.checked;
  }

  // mode·intervalMin 부분 payload — extractor 슬롯 payload 에 머지된다.
  function getPayload(): Record<string, unknown> {
    const mode: "immediate" | "backfill" = backfillRadio.checked
      ? "backfill"
      : "immediate";
    const payload: Record<string, unknown> = { mode };
    if (mode === "backfill") {
      const intervalMin = Number.parseInt(backfillIntervalInput.value, 10);
      payload.intervalMin = Number.isFinite(intervalMin) ? intervalMin : 0;
    }
    return payload;
  }

  function isChanged(): boolean {
    const mode: "immediate" | "backfill" = backfillRadio.checked
      ? "backfill"
      : "immediate";
    if (mode !== original.mode) return true;
    if (mode === "backfill") {
      const intervalMin = Number.parseInt(backfillIntervalInput.value, 10);
      if (
        Number.isFinite(intervalMin) &&
        intervalMin !== original.backfill.intervalMin
      ) {
        return true;
      }
    }
    return false;
  }

  return {
    element: block,
    isBackfillSelected,
    registerBackfillTarget,
    getPayload,
    isChanged,
  };
}

/**
 * 글에서 의미 추출하기 슬롯 블록 분리 (Task 6) — (1) 모델 블록 + (4) 글 처리 수량.
 *
 * 모델 블록 = createSlotCommonControls 의 section (헤딩 + 켜기 체크박스 + provider
 * + 모델). 텍스트 전용 설정 = backfill batchSize + minImportance (backfill 갈래일
 * 때만 보임 — commonMode.registerBackfillTarget 으로 가시성 묶음).
 *
 * mode·intervalMin 은 commonMode 권위 — extractor payload 에 머지한다.
 */
export function renderExtractorBlocks(
  current: LlmExtractorValue,
  original: LlmExtractorValue,
  commonMode: CommonModeBlockHandle,
): LlmSlotBlocksHandle {
  const ctrl = createSlotCommonControls(
    "extractor",
    "글에서 의미 추출하기",
    "",
    current,
    original,
    { showDesc: false, showHints: false },
  );

  // 실패 기록 패널(2026-10-14 spec 6장) — 모델 블록 끝에 둔다. 처리 시점(즉시/주기)·켜기와 무관하게 멈춘 기억이 보이도록
  // 접히는 칸(detailBlock) 밖이다. 처음 그릴 때 한 번 불러온다.
  const attemptsPanel = renderBackfillAttemptsPanel("extraction");
  ctrl.section.appendChild(attemptsPanel.element);
  void attemptsPanel.refresh();

  // ── (4) 텍스트 전용 설정 블록 (batchSize + minImportance) ───────────────────
  //
  // 옛 extractor.backfill 3 칸 중 intervalMin 은 (3) 공통 동작방식으로 이동.
  // 남은 batchSize + minImportance 만 텍스트 전용으로. backfill 갈래일 때만 보임.

  const detailBlock = document.createElement("div");
  detailBlock.className = "llm-detail-block";
  detailBlock.dataset.section = "extractor-detail";

  const detailTitle = document.createElement("h3");
  detailTitle.className = "llm-block-title";
  detailTitle.textContent = "글 처리 수량";
  detailBlock.appendChild(detailTitle);

  const backfillBox = document.createElement("div");
  backfillBox.className = "llm-backfill-box";
  backfillBox.dataset.section = "extractor-backfill";

  // 한 번에 처리할 메시지 갯수.
  const batchRow = document.createElement("div");
  batchRow.className = "llm-field-row";
  const batchLabel = document.createElement("label");
  batchLabel.htmlFor = "llm-extractor-backfill-batchSize";
  batchLabel.textContent = "한 번에 처리할 글 수";
  batchRow.appendChild(batchLabel);
  const backfillBatchInput = document.createElement("input");
  backfillBatchInput.type = "number";
  backfillBatchInput.id = "llm-extractor-backfill-batchSize";
  backfillBatchInput.min = "1";
  backfillBatchInput.value = String(current.backfill.batchSize);
  batchRow.appendChild(backfillBatchInput);
  backfillBox.appendChild(batchRow);

  // 최소 중요도.
  const minImpRow = document.createElement("div");
  minImpRow.className = "llm-field-row";
  const minImpLabel = document.createElement("label");
  minImpLabel.htmlFor = "llm-extractor-backfill-minImportance";
  minImpLabel.textContent = "최소 중요도";
  minImpRow.appendChild(minImpLabel);
  const backfillMinImpInput = document.createElement("input");
  backfillMinImpInput.type = "number";
  backfillMinImpInput.id = "llm-extractor-backfill-minImportance";
  backfillMinImpInput.min = "0";
  backfillMinImpInput.step = "0.05";
  backfillMinImpInput.value = String(current.backfill.minImportance);
  minImpRow.appendChild(backfillMinImpInput);
  backfillBox.appendChild(minImpRow);

  // 자동 재시도 칸 세 개(2026-10-14 spec 4.4) — 정해진 주기 처리 칸 옆. 처리 시점이 즉시면 함께 숨는다.
  const retryFields = renderRetryFields("llm-extractor-backfill", current.backfill);
  backfillBox.appendChild(retryFields.element);

  detailBlock.appendChild(backfillBox);

  // (4) batchSize·minImportance 가시성을 공통 동작방식 라디오에 묶는다.
  commonMode.registerBackfillTarget(detailBlock);

  // ── payload 산출 ─────────────────────────────────────────────────────────

  function getPayload(): Record<string, unknown> {
    const enabled = ctrl.enabledInput.checked;
    const provider = ctrl.providerSelect.value as LlmProvider;
    const payload: Record<string, unknown> = { enabled, provider };

    // 고른 공급자의 칸만 싣는다(공급자 표 기반, 빈 키 = 저장된 키 유지).
    Object.assign(payload, buildProviderPayload(ctrl.fields, provider));

    // mode·intervalMin 은 공통 동작방식(extractor 권위) 부분 payload 머지.
    const modePayload = commonMode.getPayload();
    payload.mode = modePayload.mode;

    // backfill sub-object — mode=backfill 시점만 포함 (mergeLlmSlots 가 옛 값 보존).
    // intervalMin 은 공통 동작방식에서, batchSize·minImportance 는 이 블록에서.
    if (commonMode.isBackfillSelected()) {
      const intervalMin = modePayload.intervalMin as number;
      const batchSize = Number.parseInt(backfillBatchInput.value, 10);
      const minImportance = Number.parseFloat(backfillMinImpInput.value);
      payload.backfill = {
        intervalMin,
        batchSize: Number.isFinite(batchSize) ? batchSize : 0,
        minImportance: Number.isFinite(minImportance) ? minImportance : 0,
        ...retryFields.read(),
      };
    }
    return payload;
  }

  function isChanged(): boolean {
    if (ctrl.enabledInput.checked !== original.enabled) return true;
    const provider = ctrl.providerSelect.value as LlmProvider;
    if (provider !== original.provider) return true;
    if (isProviderChanged(ctrl.fields, original, provider)) return true;
    // mode·intervalMin 변경은 공통 동작방식 핸들이 판단 (extractor 권위).
    if (commonMode.isChanged()) return true;

    // backfill batchSize·minImportance 변경 감지 (backfill 갈래일 때만 의미).
    if (commonMode.isBackfillSelected()) {
      if (retryFields.isChanged(original.backfill)) return true;
      const batchSize = Number.parseInt(backfillBatchInput.value, 10);
      if (
        Number.isFinite(batchSize) &&
        batchSize !== original.backfill.batchSize
      ) {
        return true;
      }
      const minImportance = Number.parseFloat(backfillMinImpInput.value);
      if (
        Number.isFinite(minImportance) &&
        minImportance !== original.backfill.minImportance
      ) {
        return true;
      }
    }
    return false;
  }

  return { modelBlock: ctrl.section, detailBlock, getPayload, isChanged };
}

/**
 * 정리 AI 슬롯 핸들 — 정리 시점 조각(settings-cleanup-extra.ts)이 정리 주기 줄 옆에 시점 선택을 붙이고
 * 시점에 따라 단위 글을 바꿀 수 있게 그 줄의 요소를 함께 내준다.
 */
export interface CleanupSectionHandle extends LlmSlotSectionHandle {
  interval: { row: HTMLElement; label: HTMLLabelElement; input: HTMLElement; unit: Text };
}

/**
 * 데이터 정리 AI 슬롯 섹션 (Phase 5.6 W7) — 공통 컨트롤 + intervalDays 입력.
 * 공통 LLM 슬롯 UX를 사용하는 cleanup 섹션.
 */
export function renderCleanupSection(
  current: LlmCleanupValue,
  original: LlmCleanupValue,
): CleanupSectionHandle {
  const ctrl = createSlotCommonControls(
    "cleanup",
    "AI 데이터 정리",
    "",
    current,
    original,
    { showDesc: false, showHints: false },
  );

  // ── intervalDays 입력 ────────────────────────────────────────────────────

  const extraRow = document.createElement("div");
  extraRow.className = "llm-extra-row";
  const extraLabel = document.createElement("label");
  extraLabel.htmlFor = "llm-cleanup-intervalDays";
  extraLabel.textContent = "정리 주기(일)";
  extraRow.appendChild(extraLabel);

  const intervalRow = document.createElement("div");
  intervalRow.className = "llm-interval-row";
  const intervalInput = document.createElement("input");
  intervalInput.type = "number";
  intervalInput.id = "llm-cleanup-intervalDays";
  intervalInput.min = "1";
  intervalInput.value = String(current.intervalDays);
  intervalRow.appendChild(intervalInput);
  const intervalUnit = document.createTextNode("일마다 정리");
  intervalRow.appendChild(intervalUnit);
  extraRow.appendChild(intervalRow);

  ctrl.configBox.appendChild(extraRow);

  // ── payload 산출 ─────────────────────────────────────────────────────────

  function getPayload(): Record<string, unknown> {
    const enabled = ctrl.enabledInput.checked;
    const provider = ctrl.providerSelect.value as LlmProvider;
    const payload: Record<string, unknown> = { enabled, provider };

    // 고른 공급자의 칸만 싣는다(공급자 표 기반, 빈 키 = 저장된 키 유지).
    Object.assign(payload, buildProviderPayload(ctrl.fields, provider));

    const intervalDays = Number.parseInt(intervalInput.value, 10);
    payload.intervalDays = Number.isFinite(intervalDays) ? intervalDays : 0;
    return payload;
  }

  function isChanged(): boolean {
    if (ctrl.enabledInput.checked !== original.enabled) return true;
    const provider = ctrl.providerSelect.value as LlmProvider;
    if (provider !== original.provider) return true;
    if (isProviderChanged(ctrl.fields, original, provider)) return true;
    const intervalDays = Number.parseInt(intervalInput.value, 10);
    if (
      Number.isFinite(intervalDays) &&
      intervalDays !== original.intervalDays
    ) {
      return true;
    }
    return false;
  }

  return {
    element: ctrl.section, getPayload, isChanged,
    interval: { row: extraRow, label: extraLabel, input: intervalRow, unit: intervalUnit },
  };
}

/**
 * 이미지 의미 추출 슬롯 블록 분리 (Task 6) — (2) 모델 블록 + (5) 이미지 전용 설정.
 *
 * 모델 블록 = createSlotCommonControls 의 section (헤딩 + 켜기 체크박스 + provider
 * + 모델) + 안내 글 (기본 꺼짐 안내 + 비활성 안내).
 * 이미지 전용 설정 = tokenCap + backfill batchSize.
 *
 * 캡션 시점(mode)·주기 분(intervalMin) 은 의미추출 AI 공통 동작방식(extractor
 * 권위)을 따르므로 이 슬롯에는 mode 라디오·intervalMin 입력이 0 개다. backfill
 * batchSize 가시성은 commonMode.registerBackfillTarget 로 공통 라디오에 묶는다.
 *
 * SigLIP 이미지 임베딩이 이미 정착된 위에 *추가* 신호 통로 (VLM 캡션 묘사) —
 * 기본 꺼짐, 사용자가 켠 뒤부터 가동.
 */
export function renderVisionBlocks(
  current: LlmVisionValue,
  original: LlmVisionValue,
  commonMode: CommonModeBlockHandle,
): LlmSlotBlocksHandle {
  const ctrl = createSlotCommonControls(
    "vision",
    "이미지 설명 만들기",
    "",
    current,
    original,
    { showDesc: false, showHints: false },
  );

  // 실패 기록 패널(2026-10-14 spec 6장) — 모델 블록 끝에 둔다. 처리 시점(즉시/주기)·켜기와 무관하게 멈춘 기억이 보이도록
  // 접히는 칸(detailBlock) 밖이다. 처음 그릴 때 한 번 불러온다.
  const attemptsPanel = renderBackfillAttemptsPanel("caption");
  ctrl.section.appendChild(attemptsPanel.element);
  void attemptsPanel.refresh();

  // ── 기본 꺼짐 + 캡션 시점 안내 ──────────────────────────────────────────────
  // "켰는데 안 된다" 오해 차단. 기본 꺼짐 + 켰을 때 캡션 생성 시점을 한곳에 정직하게
  // 안내한다. 캡션 시점(즉시/주기)·주기 분은 의미추출 AI 공통 동작방식을 따른다.
  // 안내 문구라 항상 보이게 둔다(disabledNotice 는 꺼짐일 때만 — 이건 별 갈래).
  // ── 정직한 disabled state 안내 (spec §11 UX) ───────────────────────────────
  //
  // enabled=false 면 "이미지 캡션 비활성" + 캡션 없이도 이미지는 SigLIP 으로
  // 검색됨 안내. 가짜 활성 표시 금지 — 실제 enabled 값을 그대로 반영. config
  // 카드(provider·모델)는 createSlotCommonControls 의 enabled 토글이 이미
  // display:none 으로 숨기므로, 이 안내가 그 자리를 정직하게 채운다.

  // ── (5) 이미지 전용 설정 블록 ──────────────────────────────────────────────

  const detailBlock = document.createElement("div");
  detailBlock.className = "llm-detail-block";
  detailBlock.dataset.section = "vision-detail";

  const detailTitle = document.createElement("h3");
  detailTitle.className = "llm-block-title";
  detailTitle.textContent = "이미지 설명 설정";
  detailBlock.appendChild(detailTitle);

  // tokenCap 입력.
  const capRow = document.createElement("div");
  capRow.className = "llm-field-row";
  capRow.dataset.section = "vision-tokenCap";
  const capLabel = document.createElement("label");
  capLabel.htmlFor = "llm-vision-tokenCap";
  capLabel.textContent = "캡션 길이 한도";
  capRow.appendChild(capLabel);
  const capInput = document.createElement("input");
  capInput.type = "number";
  capInput.id = "llm-vision-tokenCap";
  capInput.min = "1";
  capInput.value = String(current.tokenCap);
  capRow.appendChild(capInput);
  detailBlock.appendChild(capRow);

  // backfill batchSize 한 칸 — Task 4·6 (mode·intervalMin·minImportance 제외).
  // 캡션 시점·주기 분은 공통 동작방식(extractor 권위)을 따른다. backfill 갈래일
  // 때만 보임 — commonMode.registerBackfillTarget 으로 공통 라디오에 가시성 묶음.
  const backfillBox = document.createElement("div");
  backfillBox.className = "llm-backfill-box";
  backfillBox.dataset.section = "vision-backfill";

  const batchRow = document.createElement("div");
  batchRow.className = "llm-field-row";
  const batchLabel = document.createElement("label");
  batchLabel.htmlFor = "llm-vision-backfill-batchSize";
  batchLabel.textContent = "한 번에 처리할 이미지 수";
  batchRow.appendChild(batchLabel);
  const backfillBatchInput = document.createElement("input");
  backfillBatchInput.type = "number";
  backfillBatchInput.id = "llm-vision-backfill-batchSize";
  backfillBatchInput.min = "1";
  backfillBatchInput.value = String(current.backfill.batchSize);
  batchRow.appendChild(backfillBatchInput);
  backfillBox.appendChild(batchRow);

  // 자동 재시도 칸 세 개(2026-10-14 spec 4.4) — 캡션 batchSize 옆. 처리 시점이 즉시면 함께 숨는다.
  const retryFields = renderRetryFields("llm-vision-backfill", current.backfill);
  backfillBox.appendChild(retryFields.element);

  detailBlock.appendChild(backfillBox);

  // (5) batchSize 가시성을 공통 동작방식 라디오에 묶는다.
  commonMode.registerBackfillTarget(backfillBox);

  // ── payload 산출 ─────────────────────────────────────────────────────────

  function getPayload(): Record<string, unknown> {
    const enabled = ctrl.enabledInput.checked;
    const provider = ctrl.providerSelect.value as LlmProvider;
    const payload: Record<string, unknown> = { enabled, provider };

    // 고른 공급자의 칸만 싣는다(공급자 표 기반, 빈 키 = 저장된 키 유지).
    Object.assign(payload, buildProviderPayload(ctrl.fields, provider));

    const tokenCap = Number.parseInt(capInput.value, 10);
    payload.tokenCap = Number.isFinite(tokenCap) ? tokenCap : 0;

    // backfill sub-object = batchSize 한 칸만 (Task 4·6). mode·intervalMin 은
    // 공통 동작방식(extractor 권위)을 따르므로 vision payload 에 0 개. backfill
    // 갈래일 때만 포함 (immediate 시점은 0 → mergeLlmSlots 가 옛 값 유지).
    if (commonMode.isBackfillSelected()) {
      const batchSize = Number.parseInt(backfillBatchInput.value, 10);
      payload.backfill = {
        batchSize: Number.isFinite(batchSize) ? batchSize : 0,
        ...retryFields.read(),
      };
    }
    return payload;
  }

  function isChanged(): boolean {
    if (ctrl.enabledInput.checked !== original.enabled) return true;
    const provider = ctrl.providerSelect.value as LlmProvider;
    if (provider !== original.provider) return true;
    if (isProviderChanged(ctrl.fields, original, provider)) return true;
    const tokenCap = Number.parseInt(capInput.value, 10);
    if (Number.isFinite(tokenCap) && tokenCap !== original.tokenCap) {
      return true;
    }

    // backfill batchSize 변경 감지 — backfill 갈래일 때만 의미 (Task 4·6).
    if (commonMode.isBackfillSelected()) {
      if (retryFields.isChanged(original.backfill)) return true;
      const batchSize = Number.parseInt(backfillBatchInput.value, 10);
      if (
        Number.isFinite(batchSize) &&
        batchSize !== original.backfill.batchSize
      ) {
        return true;
      }
    }
    return false;
  }

  return { modelBlock: ctrl.section, detailBlock, getPayload, isChanged };
}

/**
 * 자동 처리 섹션의 의미 추출 5블록 조립.
 *
 * 섹션 컨테이너 안 5블록을 목업 순서대로 마운트한다:
 *   (1) 글에서 의미 추출하기 — 모델 블록 (켜기 + provider + 모델)
 *   (2) 이미지 설명 만들기 — 모델 블록 (켜기 + provider + 모델)
 *   (3) 처리 시점          — 공통, extractor 권위 (즉시/주기 라디오 + 주기 분)
 *   (4) 글 처리 수량       — 글 전용 (batchSize + minImportance)
 *   (5) 이미지 설명 설정   — 이미지 전용 (tokenCap + batchSize)
 *
 * 공통 동작방식 (3) 의 mode·intervalMin 은 extractor 권위 — extractor payload 에
 * 머지된다. vision payload 에는 mode·intervalMin 이 0 개다. 한 라디오 쌍이 (3)
 * 주기 분 + (4)/(5) batchSize 가시성을 모두 제어한다 (registerBackfillTarget).
 */
export function renderSemanticExtractionSection(
  current: LlmGroupValue,
  original: LlmGroupValue,
): {
  element: HTMLElement;
  getChangedSlotsPayload: () => Record<string, unknown>;
  isChanged: () => boolean;
} {
  // (3) 공통 동작방식 — extractor 권위. extractor·vision 블록보다 먼저 만들어
  // registerBackfillTarget 연결에 활용. mode·intervalMin payload·isChanged 합류.
  const commonMode = renderCommonModeBlock(current.extractor, original.extractor);

  // (1)/(4) 텍스트 + (2)/(5) 이미지 블록 분리 산출. 두 블록 모두 commonMode 의
  // 라디오를 구독해 자기 backfill 칸 가시성을 묶는다 (registerBackfillTarget).
  const extractor = renderExtractorBlocks(
    current.extractor,
    original.extractor,
    commonMode,
  );
  const vision = renderVisionBlocks(current.vision, original.vision, commonMode);

  // 자동 처리 화면 안의 의미 추출 컨테이너 — (1)→(2)→(3)→(4)→(5) 순서 마운트.
  const aiSection = document.createElement("section");
  aiSection.className = "llm-section";
  aiSection.id = "llm-semantic-extraction";
  aiSection.appendChild(extractor.modelBlock); // (1)
  aiSection.appendChild(vision.modelBlock); // (2)
  aiSection.appendChild(commonMode.element); // (3)
  aiSection.appendChild(extractor.detailBlock); // (4)
  aiSection.appendChild(vision.detailBlock); // (5)

  function getChangedSlotsPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    // extractor 변경 = 모델 블록 + 공통 동작방식 변경 둘 다 포함 (commonMode 가
    // extractor.isChanged 안에서 OR 로 합류 — extractor 권위라 한 슬롯에 머지).
    if (extractor.isChanged()) {
      payload.extractor = extractor.getPayload();
    }
    if (vision.isChanged()) {
      payload.vision = vision.getPayload();
    }
    return payload;
  }

  function isChanged(): boolean {
    return extractor.isChanged() || vision.isChanged();
  }

  return {
    element: aiSection,
    getChangedSlotsPayload,
    isChanged,
  };
}

/**
 * 자동 처리의 의미 추출 5블록 + AI 데이터 정리 별 섹션 조립.
 *
 * 저장 흐름: 세 슬롯 중 변경된 슬롯만 payload 에 담아 PUT body 의 `llm` 묶음에 합쳐
 * 보낸다. mergeLlmSlots (memory-settings.ts) 가 슬롯 단위 얕은 머지하므로 변동
 * 없는 슬롯 + 비활성 갈래 옛 필드는 디스크 보존.
 */
export function renderLlmSection(
  current: LlmGroupValue,
  original: LlmGroupValue,
): LlmSectionHandle {
  const semantic = renderSemanticExtractionSection(current, original);
  const cleanup = renderCleanupSection(current.cleanup, original.cleanup);

  function getChangedSlotsPayload(): Record<string, unknown> {
    const payload = semantic.getChangedSlotsPayload();
    if (cleanup.isChanged()) {
      payload.cleanup = cleanup.getPayload();
    }
    return payload;
  }

  function isChanged(): boolean {
    return semantic.isChanged() || cleanup.isChanged();
  }

  return {
    semanticElement: semantic.element,
    cleanupElement: cleanup.element,
    getChangedSlotsPayload,
    isChanged,
  };
}
