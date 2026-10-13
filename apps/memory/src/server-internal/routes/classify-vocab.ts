/**
 * server-internal/routes/classify-vocab.ts — 분류 어휘 CRUD 라우트 등록기
 * (분류 어휘 DB 단계1 Task 4).
 *
 * 세 라우트:
 *   1. POST   /api/classify-vocab      — body {typeName, slot, value} 검증 → 추가 전
 *      불변식 점검(위반 400) → repo.addEntry → 병합 재계산 → setConceptVocabOverride +
 *      resetClassifierCache → 201 + 생성 entry.
 *   2. GET    /api/classify-vocab      — yaml 원본 어휘 + user 행을 *출처(yaml/user) 구분*
 *      해서 한 목록으로 내려준다. yaml 은 읽기전용(id 없음), user 는 삭제용 entryId 보유.
 *   3. DELETE /api/classify-vocab/:id  — repo.deleteEntry → 병합 재계산 → override + reset → 200.
 *
 * 단일 권위 정신(synonyms.ts 본보기 그대로): CRUD 가 쓰는 ClassifyVocabUserRepo
 * (deps.classifyVocabUserRepo)와 부팅 때 모듈 캐시에 주입한 병합본이, CRUD 직후
 * deps.conceptVocabYaml(yaml 깊은 복제 기준선) + repo.listEntries() 를 mergeConceptVocab 로
 * 다시 합쳐 setConceptVocabOverride 로 모듈 캐시를 갈아끼우고 resetClassifierCache 로 분류기
 * 2차 캐시를 비운다. 그래서 추가·삭제가 재시작 없이 다음 입력 글의 분류·위계 진입에 즉시
 * 반영된다(D3). 검색 동의어는 retriever 인스턴스 reload 였지만, 분류 어휘는 전역 모듈 캐시
 * 갱신이라 2-reset(override + classifier) 한 묶음이 그 자리다.
 *
 * 불변식: mergeConceptVocab 가 한 타입 내 synonyms↔subcategories 중복·subcategory 전역
 * 중복을 throw 한다. POST 는 *추가 전* 에 prospective 병합으로 점검해 위반이면 DB 를 안
 * 건드린 채 400 + 명시 에러를 회신한다(silent skip 금지 — 위반 행이 안 남는다).
 *
 * silent fallback 금지: classifyVocabUserRepo 또는 conceptVocabYaml 미주입(부팅 비활성)
 * 시 CRUD·목록 503 — 정직한 비활성(빈 결과로 안 가린다).
 */

import { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { isPositiveString, err } from "../http-helpers.ts";
import { reloadClassifyVocabFromDeps } from "../reload-classify-vocab.ts";
import {
  mergeConceptVocab,
  partitionOrphanClassifyRows,
  buildItemSynonymMap,
  buildColumnTypeMap,
  type ClassifyVocabUserEntryLike,
} from "../../memory/classify-vocab/merge-classify-vocab.ts";
import {
  type ClassifyVocabSlot,
  ITEM_SYNONYM_SEPARATOR,
  parseItemSynonymValue,
} from "../../memory/classify-vocab/classify-vocab-user-repo.ts";
import type { ClassifyVocabOverrideSlot } from "../../memory/classify-vocab/classify-vocab-override-repo.ts";
import {
  setConceptVocabOverride,
  setItemSynonymOverride,
  setColumnTypeOverride,
  placementTypeNames,
  isPlacementType,
  type PlacementTypeName,
} from "../../memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";
import { relationTagKeySet } from "../../memory/entity-relation-vocabulary.ts";
import { isEntityType } from "../../memory/entity-placement-loop.ts";
import { getEntityTypeMeta } from "../../db/store-internal/entity-type-registry.ts";

/** 출처 라벨 — yaml(읽기전용) vs user(삭제 가능). 프론트 표시·삭제 게이트 자료. */
type ClassifyVocabSource = "yaml" | "user";

/**
 * 사용자 편집 대상 칸. 단계2 가 attributes·item_synonym 을, 단계3 T8 이 columns(칸
 * 어휘·D15)를 더했다. synonyms·subcategories·attributes·columns 는 단어 한 칸을 받고,
 * item_synonym 은 `{canonical, alias}` 두 토큰을 받아 repo value 에 `대표키\t동의어` 로 담는다.
 *
 * (2026-06-27 콜론 사슬 구조 배치 spec §6-B·단계1 D2) 옛 seeds slot 은 제거했다 — 종류
 * 씨앗(일반명사 자동 배치 어휘)이 사라져 편집 대상에서도 빠진다.
 */
const SINGLE_VALUE_SLOTS = new Set<string>([
  "synonyms",
  "subcategories",
  "attributes",
  "columns",
]);
// column_types(칸 datatype 표지·단계6b)는 단어 한 칸이 아니라 `칸키\t(number|date)` 두 토큰이라
// SINGLE_VALUE_SLOTS 에 안 넣고 ALL_SLOTS 에만 합류한다(별 검증 분기로 받는다).
const ALL_SLOTS = new Set<string>([...SINGLE_VALUE_SLOTS, "item_synonym", "column_types"]);

/**
 * 값이 그 타입의 칸 키인지 본다(D1·D15 이중 정의 차단). 두 출처를 본다:
 *   1. 기존 10종 전용 컬럼(registry columnLabels) — 8 타입만 가짐(person/project 없음).
 *   2. 새 종류 칸 어휘(columns slot user 행·단계3 T8) — entity_attributes is_column=1 로
 *      저장될 선언 칸. 같은 타입의 columns slot 값과 소문자 비교한다.
 * 칸은 색인 속성이라 라벨(attributes)로 다시 정의하면 한 키가 두 갈래가 된다 — attributes
 * 추가 시 이 검사로 막는다(라우트 POST). 비교는 소문자 정규화(라벨 어휘 소문자 매칭 정합).
 */
function isColumnKey(
  typeName: PlacementTypeName,
  value: string,
  userEntries: readonly { typeName: string; slot: string; value: string }[],
): boolean {
  const target = value.trim().toLowerCase();
  if (isEntityType(typeName) && getEntityTypeMeta(typeName).columnLabels[value] !== undefined) {
    return true;
  }
  for (const e of userEntries) {
    if (e.typeName === typeName && e.slot === "columns" && e.value.trim().toLowerCase() === target) {
      return true;
    }
  }
  return false;
}

/**
 * 값이 그 타입의 라벨(attributes) 키인지 본다(D15 칸↔라벨 이중 정의 차단·columns 추가 시).
 * yaml 기준선 attributes + user attributes slot 둘 다 본다(라벨 어휘 단일 출처). yaml 의
 * attributes 에는 씨앗 관계 키도 섞여 있으나, 칸↔라벨 충돌만 보면 되므로 관계 키 차집합은
 * 안 한다(관계 키 충돌은 별 검사가 잡는다). 비교는 소문자 정규화.
 */
function isLabelKey(
  typeName: PlacementTypeName,
  value: string,
  yamlVocab: NonNullable<MemoryApiDeps["conceptVocabYaml"]>,
  userEntries: readonly { typeName: string; slot: string; value: string }[],
): boolean {
  const target = value.trim().toLowerCase();
  const yv = yamlVocab.get(typeName);
  if (yv) {
    for (const a of yv.attributes) {
      if (a.trim().toLowerCase() === target) return true;
    }
  }
  for (const e of userEntries) {
    if (e.typeName === typeName && e.slot === "attributes" && e.value.trim().toLowerCase() === target) {
      return true;
    }
  }
  return false;
}

/**
 * 값이 그 타입의 항목 동의어(item_synonym) 대표키·동의어 어느 쪽과 겹치는지 본다(D15 칸↔항목
 * 동의어 충돌 차단·columns 추가 시). item_synonym value 는 `대표키\t동의어` 두 토큰이라 둘 다
 * 본다. 비교는 소문자 정규화. user 행만 출처(yaml 엔 항목 동의어가 없다).
 */
function isItemSynonymKey(
  typeName: PlacementTypeName,
  value: string,
  userEntries: readonly { typeName: string; slot: string; value: string }[],
): boolean {
  const target = value.trim().toLowerCase();
  for (const e of userEntries) {
    if (e.typeName !== typeName || e.slot !== "item_synonym") continue;
    const { canonical, alias } = parseItemSynonymValue(e.value);
    if (canonical.trim().toLowerCase() === target || alias.trim().toLowerCase() === target) {
      return true;
    }
  }
  return false;
}

/**
 * yaml 원본 어휘 + user 행을 합쳐 *출처 구분* 목록으로 만든다(GET 응답 자료).
 * yaml 항목은 id 없는 읽기전용, user 항목은 삭제용 entryId 보유. 같은 (타입, 칸, 값)
 * 이 yaml·user 양쪽에 있으면 yaml 쪽을 우선 표시하고 user 중복은 건너뛴다 —
 * 병합(mergeConceptVocab)이 중복 제거하는 것과 같은 정신(한 줄만 보인다 / buildSynonymListing 미러).
 */
function buildClassifyVocabListing(
  yamlVocab: NonNullable<MemoryApiDeps["conceptVocabYaml"]>,
  userEntries: ReturnType<NonNullable<MemoryApiDeps["classifyVocabUserRepo"]>["listEntries"]>,
): Array<{
  id: string | null;
  typeName: string;
  slot: ClassifyVocabSlot;
  value: string;
  source: ClassifyVocabSource;
}> {
  const out: Array<{
    id: string | null;
    typeName: string;
    slot: ClassifyVocabSlot;
    value: string;
    source: ClassifyVocabSource;
  }> = [];
  // 표시 중복 차단 키 — (타입, 칸, 소문자 값). yaml 먼저 채워 user 중복을 건너뛴다.
  const seen = new Set<string>();

  for (const t of placementTypeNames()) {
    const v = yamlVocab.get(t);
    if (!v) continue;
    // 네 칸 모두 읽기전용으로 보여준다(단계2 — attributes·단계3 T8 — columns).
    // item_synonym 은 yaml 어휘 칸이 아니라 user 행만 있어 여기엔 안 나온다.
    for (const slot of ["synonyms", "subcategories", "attributes", "columns"] as const) {
      for (const value of v[slot] ?? []) {
        const key = `${t}\u0000${slot}\u0000${value.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ id: null, typeName: t, slot, value, source: "yaml" });
      }
    }
  }

  for (const e of userEntries) {
    const key = `${e.typeName}\u0000${e.slot}\u0000${e.value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: e.entryId,
      typeName: e.typeName,
      slot: e.slot,
      value: e.value,
      source: "user",
    });
  }

  return out;
}

export function registerClassifyVocabRoutes(app: Hono, deps: MemoryApiDeps): void {
  const api = new Hono({ strict: false });

  // CRUD·목록은 repo + yaml 기준선 둘 다 있어야 가동한다(병합 기준선이 yaml). 둘 중
  // 하나라도 미주입이면 정직한 503(빈 결과로 가리지 않음).
  const repoAndYamlReady = (): boolean =>
    deps.classifyVocabUserRepo !== undefined && deps.conceptVocabYaml !== undefined;

  /**
   * 현재 yaml 기준선 + user 행을 다시 합쳐 모듈 캐시에 주입한다(CRUD 후 공통 단계).
   * 병합 산출을 setConceptVocabOverride 로 얹고 resetClassifierCache 로 분류기 2차
   * 캐시를 비운다(2-reset / D3). repo·yaml 이 있을 때만 호출한다(게이트 통과 전제).
   * 병합이 불변식 위반을 throw 하면 호출자가 잡아 400 으로 회신한다.
   */
  const reloadMergedVocab = (): void => {
    // 가림표 차감(S5)·항목 동의어 맵·칸 datatype 맵(단계2·6b)까지 한 통로(공용 helper)로
    // 주입한다 — 가림표 repo 미주입(옛 테스트 harness)이면 차감 0. 소급(과거 글 재분류) 없음 —
    // 새 글부터만 반영(Q2 결정·applyRetroactive 없음).
    reloadClassifyVocabFromDeps(deps);
  };

  // ── POST /classify-vocab — 검증 → 불변식 점검 → 추가 → 재병합 → 2-reset → 201 ──
  api.post("/classify-vocab", async (c) => {
    if (!repoAndYamlReady()) {
      return err(c, 503, "분류 어휘 CRUD 비활성 (classifyVocabUserRepo/conceptVocabYaml 미주입)");
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    if (!isPositiveString(body.typeName) || !isPlacementType(body.typeName)) {
      return err(c, 400, `typeName 은 등록된 배치 타입이어야 합니다 (받음: ${String(body.typeName)})`);
    }
    if (!isPositiveString(body.slot) || !ALL_SLOTS.has(body.slot)) {
      return err(
        c,
        400,
        "slot 은 synonyms·subcategories·attributes·columns·column_types·item_synonym 중 하나여야 합니다",
      );
    }
    const typeName = body.typeName as PlacementTypeName;
    const slot = body.slot as ClassifyVocabSlot;

    // value 양식은 slot 따라 갈린다 — item_synonym 은 {canonical, alias} 두 토큰, 나머지는
    // 단어 한 칸. repo value 양식으로 정규화한 candidate 를 만든다.
    let candidate: ClassifyVocabUserEntryLike;
    if (slot === "item_synonym") {
      if (!isPositiveString(body.canonical) || !isPositiveString(body.alias)) {
        return err(c, 400, "item_synonym 은 canonical(대표키)·alias(동의어) 두 토큰이 필요합니다");
      }
      const canonical = body.canonical.trim();
      const alias = body.alias.trim();
      // 관계 키(창작자·작가 등)는 항목 동의어로 못 묶는다 — 관계 동의어는 코드(entity-relation-
      // vocabulary)가 전담한다(3분법 경계 보존). 대표키·동의어 어느 쪽이 관계 키라도 막는다.
      // 소문자 비교 — relationTagKeySet 키는 현재 전부 한국어라 무해하나, 외부 fork 의 영어
      // 대문자 관계 키('Creator' 등·normalizedLookup 정합)도 충돌을 놓치지 않게 한다(D).
      const relLower = new Set([...relationTagKeySet()].map((k) => k.toLowerCase()));
      if (relLower.has(canonical.toLowerCase()) || relLower.has(alias.toLowerCase())) {
        return err(
          c,
          400,
          "관계 키는 항목 동의어로 못 묶음 — 관계 동의어는 코드 관리(entity-relation-vocabulary)",
        );
      }
      // 칸/라벨 이중 정의 양방향 가드(D12 대칭·D15) — 대표키·동의어 어느 쪽이라도 이미 같은
      // 종류의 칸(columns)·라벨(attributes)이면 막는다. columns·attributes 분기가 이미 가진
      // 충돌 검사와 대칭이라, 항목 동의어로 칸/라벨 키를 다시 묶어 3분법이 깨지는 통로를 닫는다.
      const userEntries = deps.classifyVocabUserRepo!.listEntries();
      for (const token of [canonical, alias]) {
        if (isColumnKey(typeName, token, userEntries)) {
          return err(
            c,
            400,
            `이미 칸으로 정의됨 — '${token}' 은(는) ${typeName} 의 칸(정렬·필터 가능)이라 항목 동의어로 묶을 수 없습니다`,
          );
        }
        if (isLabelKey(typeName, token, deps.conceptVocabYaml!, userEntries)) {
          return err(
            c,
            400,
            `이미 라벨로 정의됨 — '${token}' 은(는) ${typeName} 의 라벨(꼬리표)이라 항목 동의어로 묶을 수 없습니다`,
          );
        }
      }
      candidate = {
        typeName,
        slot,
        value: `${canonical}${ITEM_SYNONYM_SEPARATOR}${alias}`,
      };
    } else if (slot === "column_types") {
      // column_types(칸 datatype 표지·단계6b) — columns slot 과 같은 단일 body.value 를
      // 받아 value tab 파싱으로 [칸키, datatype] 두 토큰을 갈라 검증한다(item_synonym 의
      // body.canonical·body.alias 두 파라미터 양식이 아님·buildColumnTypeMap 과 같은 파싱).
      if (!isPositiveString(body.value)) {
        return err(c, 400, "column_types value 는 빈 문자열이 아니어야 합니다");
      }
      const raw = body.value.trim();
      const sep = raw.indexOf("\t");
      if (sep < 0) {
        return err(c, 400, "column_types 는 '칸키\\t(number|date)' 단일 value(tab 구분) 양식이어야 합니다");
      }
      const colKey = raw.slice(0, sep).trim();
      const dataType = raw.slice(sep + 1).trim();
      if (!colKey || (dataType !== "number" && dataType !== "date")) {
        return err(
          c,
          400,
          `column_types value 무효 — 칸키 비었거나 datatype 이 'number'/'date' 아님(받음 datatype='${dataType}')`,
        );
      }
      candidate = { typeName, slot, value: raw };
    } else {
      if (!isPositiveString(body.value)) {
        return err(c, 400, "value 는 빈 문자열이 아니어야 합니다");
      }
      const value = body.value.trim();
      // 3분법 칸/라벨 이중 정의 양방향 가드(D12 대칭·D15) — attributes(라벨)·columns(칸)
      // 추가 시 같은 키가 다른 갈래에 이미 있으면 400. user 행을 한 번만 읽어 검사에 쓴다.
      const userEntries = deps.classifyVocabUserRepo!.listEntries();

      // (a) attributes(라벨) 가 이미 칸 키(기존 10종 columnLabels + 새 종류 columns slot)면
      //     막는다(D1·D15 이중 정의 차단) — 칸은 색인 속성이라 라벨로 다시 정의 못 한다.
      if (slot === "attributes" && isColumnKey(typeName, value, userEntries)) {
        return err(
          c,
          400,
          `이미 칸으로 정의됨 — '${value}' 은(는) ${typeName} 의 칸(정렬·필터 가능)이라 라벨로 추가할 수 없습니다`,
        );
      }

      // (b) columns(칸) 추가 — 기존 10종 동결 + 칸↔라벨/관계키/항목동의어 충돌 가드(D8·D12·D15).
      if (slot === "columns") {
        // 기존 10종(person/project + 8 타입)은 전용 물리 컬럼이라 칸 동결 — user 종류만 칸을
        // 자유 추가한다(수정 모달 칸 섹션도 user 종류에만 추가/삭제를 연다·S8).
        if (isEntityType(typeName) || typeName === "person" || typeName === "project") {
          return err(
            c,
            400,
            `기존 10종 칸은 전용 컬럼이라 동결 — '${typeName}' 의 칸은 추가할 수 없습니다(새 종류만 칸 자유 추가)`,
          );
        }
        // 칸 ↔ 라벨 충돌(이미 attributes 라벨로 정의됨).
        if (isLabelKey(typeName, value, deps.conceptVocabYaml!, userEntries)) {
          return err(
            c,
            400,
            `이미 라벨로 정의됨 — '${value}' 은(는) ${typeName} 의 라벨(꼬리표)이라 칸으로 추가할 수 없습니다`,
          );
        }
        // 칸 ↔ 관계 키 충돌(관계는 코드/DB 관계 어휘 전담·3분법 경계). 소문자 비교 —
        // 외부 fork 의 영어 대문자 관계 키도 놓치지 않게 한다(D·item_synonym 분기와 일관).
        const relLowerForColumn = new Set([...relationTagKeySet()].map((k) => k.toLowerCase()));
        if (relLowerForColumn.has(value.toLowerCase())) {
          return err(
            c,
            400,
            `이미 관계 키로 정의됨 — '${value}' 은(는) 관계 태그 키라 칸으로 추가할 수 없습니다`,
          );
        }
        // 칸 ↔ 항목 동의어 충돌(대표키/동의어 어느 쪽이라도).
        if (isItemSynonymKey(typeName, value, userEntries)) {
          return err(
            c,
            400,
            `이미 항목 동의어로 묶임 — '${value}' 은(는) 항목 동의어 키라 칸으로 추가할 수 없습니다`,
          );
        }
      }

      candidate = { typeName, slot, value };
    }

    // 추가 *전* 불변식 점검 — 현재 user 행 + 이 후보를 합쳐 prospective 병합을 만든다.
    // 위반이면 DB 를 안 건드린 채 400 + 명시 에러(위반 행이 안 남는다 / silent skip 금지).
    // synonyms↔subcategories 불변식은 mergeConceptVocab 가, item_synonym 충돌(동의어가 두
    // 대표키)은 buildItemSynonymMap 가, column_types datatype 양식은 buildColumnTypeMap 이
    // 던진다 — 셋 모두 추가 전에 prospective 로 점검한다.
    try {
      // 기존 행 중 종류가 이미 지워진 고아 행은 부팅·재병합과 같이 걸러 낸다(applyClassifyVocabOverrides
      // 와 같은 관용) — 그렇지 않으면 무관한 종류의 어휘 추가까지 고아 때문에 400 이 된다.
      // 후보(candidate)는 위에서 등록된 종류로 검증됐고 병합도 엄격 검증을 그대로 거친다.
      const { entries: existing, tombstones } = partitionOrphanClassifyRows(
        deps.classifyVocabUserRepo!.listEntries(),
        // 가림표 차감(S5)도 prospective 에 함께 적용해, 추가 후 실제 병합과 같은 결과로
        // 불변식을 점검한다(끈 값이 빠진 뒤의 충돌만 본다 — 일관성 유지).
        deps.classifyVocabOverrideRepo?.listOverrides() ?? [],
      );
      const prospective = [...existing, candidate];
      mergeConceptVocab(deps.conceptVocabYaml!, prospective, tombstones);
      buildItemSynonymMap(prospective);
      buildColumnTypeMap(prospective);
    } catch (e) {
      return err(c, 400, (e as Error).message);
    }

    // repo 가 UNIQUE(type_name, slot, value) 충돌을 멱등 처리한다 — 같은 행 재등록은
    // 기존 행 id 를 돌려준다(중복 무해 통과). entry_id 반환.
    const entryId = deps.classifyVocabUserRepo!.addEntry(candidate);

    // 모듈 캐시 + 분류기 캐시 교체 — 다음 입력 글 분류·위계 진입에 즉시 반영(D3).
    reloadMergedVocab();

    return c.json(
      {
        entry: {
          id: entryId,
          typeName: candidate.typeName,
          slot: candidate.slot,
          value: candidate.value,
          source: "user" as ClassifyVocabSource,
        },
      },
      201,
    );
  });

  // 끄기·되살리기는 user repo·yaml 기준선에 더해 가림표 repo 까지 셋이 있어야 가동한다.
  // 셋 중 하나라도 미주입이면 정직한 503(빈 결과로 가리지 않음).
  const overrideReady = (): boolean =>
    repoAndYamlReady() && deps.classifyVocabOverrideRepo !== undefined;

  // 끌 수 있는 칸 — 동의어·하위분류·라벨 세 칸만(columns·item_synonym·column_types 제외).
  const OVERRIDE_SLOTS = new Set<string>(["synonyms", "subcategories", "attributes"]);

  /**
   * 끄려는 (typeName, slot, value) 가 사용자가 직접 추가한 행(user_entries)인지 본다.
   * 사용자 값은 끄기가 아니라 직접 삭제(DELETE /classify-vocab/:id)가 정상 경로다 —
   * yaml·코드 10종이 준 값만 끌 수 있다(spec §3.5·plan S5). user 행에 그 세 토큰이
   * 있으면 true(소문자 정규화 비교 — 병합·표시 매칭 정합). slot 은 user_entries 의 slot
   * 그대로 비교한다.
   */
  const isUserAddedValue = (typeName: string, slot: string, value: string): boolean => {
    const target = value.trim().toLowerCase();
    return deps
      .classifyVocabUserRepo!.listEntries()
      .some(
        (e) =>
          e.typeName === typeName &&
          e.slot === slot &&
          e.value.trim().toLowerCase() === target,
      );
  };

  // ── POST /classify-vocab/override — 끄기(가림표 추가) → 2-reset → 201 ───────
  // 등록 순서 주의: 아래 DELETE /classify-vocab/override 는 DELETE /classify-vocab/:id
  // *앞*에 와야 한다 — Hono 는 등록 순서대로 매칭하므로 :id 가 먼저면 'override' 를
  // id 로 받아 엉뚱한 행 삭제 시도로 떨어진다(memories by-source 선례 정합).
  api.post("/classify-vocab/override", async (c) => {
    if (!overrideReady()) {
      return err(
        c,
        503,
        "분류 어휘 끄기 비활성 (classifyVocabUserRepo/conceptVocabYaml/classifyVocabOverrideRepo 미주입)",
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    if (!isPositiveString(body.typeName) || !isPlacementType(body.typeName)) {
      return err(c, 400, `typeName 은 등록된 배치 타입이어야 합니다 (받음: ${String(body.typeName)})`);
    }
    if (!isPositiveString(body.slot) || !OVERRIDE_SLOTS.has(body.slot)) {
      return err(c, 400, "slot 은 synonyms·subcategories·attributes 중 하나여야 합니다 (가림표 대상 칸)");
    }
    if (!isPositiveString(body.value)) {
      return err(c, 400, "value 는 빈 문자열이 아니어야 합니다");
    }
    const typeName = body.typeName as PlacementTypeName;
    const slot = body.slot as ClassifyVocabOverrideSlot;
    const value = body.value.trim();

    // 사용자 값 끄기 거부(spec §3.5·plan S5) — 사용자가 직접 추가한 행은 끄기가 아니라
    // 직접 삭제(DELETE /classify-vocab/:id)가 정상 경로다. yaml·코드 10종이 준 값만 끈다.
    if (isUserAddedValue(typeName, slot, value)) {
      return err(
        c,
        400,
        `'${value}' 은(는) 사용자가 직접 추가한 ${typeName}.${slot} 값이라 끌 수 없습니다 — 직접 삭제(DELETE)가 정상 경로입니다`,
      );
    }

    // 가림표 추가는 UNIQUE(type_name, slot, value) 멱등 — 같은 값 다시 끄면 기존 id 반환.
    const overrideId = deps.classifyVocabOverrideRepo!.addOverride({ typeName, slot, value });

    // 모듈 캐시 + 분류기 캐시 교체 — 다음 입력 글 분류에서 끈 값이 빠진다(D5·소급 0).
    reloadMergedVocab();

    return c.json(
      { override: { id: overrideId, typeName, slot, value, kind: "tombstone" } },
      201,
    );
  });

  // ── DELETE /classify-vocab/override — 되살리기(가림표 삭제) → 2-reset → 200 ──
  api.delete("/classify-vocab/override", async (c) => {
    if (!overrideReady()) {
      return err(c, 503, "분류 어휘 되살리기 비활성 — 가림표 삭제 불가");
    }

    // body(JSON) 우선, 없으면 query 로도 받는다(되살리기 호출 양식 유연성).
    let typeName: unknown;
    let slot: unknown;
    let value: unknown;
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      typeName = body.typeName;
      slot = body.slot;
      value = body.value;
    } catch {
      typeName = c.req.query("typeName");
      slot = c.req.query("slot");
      value = c.req.query("value");
    }

    if (!isPositiveString(typeName) || !isPlacementType(typeName)) {
      return err(c, 400, `typeName 은 등록된 배치 타입이어야 합니다 (받음: ${String(typeName)})`);
    }
    if (!isPositiveString(slot) || !OVERRIDE_SLOTS.has(slot)) {
      return err(c, 400, "slot 은 synonyms·subcategories·attributes 중 하나여야 합니다 (가림표 대상 칸)");
    }
    if (!isPositiveString(value)) {
      return err(c, 400, "value 는 빈 문자열이 아니어야 합니다");
    }

    // removeOverride 는 없는 행도 멱등(에러 아님) — 잘못된 세 토큰이면 0 행 변경 후 통과.
    deps.classifyVocabOverrideRepo!.removeOverride(
      typeName,
      slot as ClassifyVocabOverrideSlot,
      (value as string).trim(),
    );
    reloadMergedVocab();
    return c.json({ restored: { typeName, slot, value: (value as string).trim() } });
  });

  // ── GET /classify-vocab — yaml + user 합집합 목록(출처 구분) + 가림표 목록 ───
  api.get("/classify-vocab", (c) => {
    if (!repoAndYamlReady()) {
      return err(c, 503, "분류 어휘 CRUD 비활성 — 목록 조회 불가");
    }
    const entries = buildClassifyVocabListing(
      deps.conceptVocabYaml!,
      deps.classifyVocabUserRepo!.listEntries(),
    );
    // 가림표 목록(S5) — 어느 (종류, slot, 값) 이 꺼졌는지 단일 출처로 함께 내려준다.
    // S6 UI 가 yaml·코드 칩에 "끔" 표시를 그릴 때 이 목록을 읽는다(별도 fetch 불요).
    // 가림표 repo 미주입(옛 harness)이면 빈 목록(끄기 기능만 비활성).
    const overrides = (deps.classifyVocabOverrideRepo?.listOverrides() ?? []).map((o) => ({
      id: o.overrideId,
      typeName: o.typeName,
      slot: o.slot,
      value: o.value,
      kind: o.kind,
    }));
    return c.json({ entries, overrides });
  });

  // ── DELETE /classify-vocab/:id — 사용자 행 삭제 → 재병합 → 2-reset ─────────
  api.delete("/classify-vocab/:id", (c) => {
    if (!repoAndYamlReady()) {
      return err(c, 503, "분류 어휘 CRUD 비활성 — 삭제 불가");
    }
    const id = c.req.param("id");
    // yaml 항목은 id 가 없어(읽기전용) 애초에 삭제 대상이 아니다 — 사용자 행만 삭제.
    // deleteEntry 는 없는 id 도 멱등(에러 아님)이라, 잘못된 id 면 0 행 변경 후 통과.
    //
    // 길 B 짝 삭제(S8) — 지우는 행이 columns 칸이면, 같은 (종류, 칸 키) 의 column_types 짝
    // 행(숫자형 표지)도 함께 지운다. 안 그러면 columns 행만 사라지고 column_types 행이 고아로
    // 남아, 같은 칸 키를 다시 추가할 때 옛 숫자형 datatype 이 되살아난다(데이터 오염). 글자형
    // 칸은 column_types 짝이 애초에 없어 findColumnTypeEntryId 가 undefined → 추가 삭제 0(no-op).
    const target = deps.classifyVocabUserRepo!.getEntry(id);
    if (target && target.slot === "columns") {
      const pairId = deps.classifyVocabUserRepo!.findColumnTypeEntryId(
        target.typeName,
        target.value,
      );
      if (pairId !== undefined) deps.classifyVocabUserRepo!.deleteEntry(pairId);
    }
    deps.classifyVocabUserRepo!.deleteEntry(id);
    reloadMergedVocab();
    return c.json({ deleted: id });
  });

  app.route("/api", api);
}
