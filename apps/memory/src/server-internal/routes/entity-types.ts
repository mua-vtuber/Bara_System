/**
 * server-internal/routes/entity-types.ts — 새 엔티티 종류 CRUD 라우트 등록기
 * (분류 단계3 T6).
 *
 * 세 라우트(classify-vocab.ts 양식 미러):
 *   1. POST   /api/entity-types          — body {typeName, koName, idPrefix?} 검증 →
 *      store.entityTypeRegistryDb.addEntityType → 2-reset → 201 + 생성 종류.
 *   2. GET    /api/entity-types          — 코드 상수 10종(source "code") + DB 새 종류
 *      (source "user")을 한 목록으로 내려준다. 코드 상수는 STATIC_PLACEMENT_TYPE_NAMES +
 *      koNameOf, 새 종류는 listUserEntityTypes(삭제용·idPrefix 보유).
 *   3. DELETE /api/entity-types/:typeName — 이 종류를 가리키는 분류 어휘·가림표·관계명·
 *      엔티티가 남아 있으면 409(고아 방지) → deleteEntityType(코드 상수 삭제 시도는 throw
 *      → 400) → 2-reset → 200.
 *
 * 단일 권위 정신(classify-vocab.ts 본보기 그대로): CRUD 가 쓰는 EntityTypeRegistryDb
 * (store.entityTypeRegistryDb)와 부팅 때 모듈 캐시에 주입한 종류 명부가, CRUD 직후
 * listUserEntityTypes() 산출을 setEntityTypeOverride 로 다시 얹고, 종류 명부 파생 캐시
 * (resetConceptTypeVocabularyCache)와 분류기 2차 캐시(resetClassifierCache)를 비운다.
 * 그래서 추가·삭제가 재시작 없이 다음 입력 글의 분류·위계 진입에 즉시 반영된다
 * (새 글부터·소급 0·D9). 이 2-reset 으로 placementTypeNames()·isPlacementType()·
 * typeIndicatorMap(분류기 키 맵)이 새 종류의 koName 콜론 키(`#장비:키보드` 의 '장비')를
 * 타입 지시 키로 인식한다.
 *
 * conceptVocabYaml 기준선 재생성은 불필요 — T3 가 mergeConceptVocab 를 placementTypeNames()
 * 순회로 동적화해, setEntityTypeOverride 만으로 새 종류 칸이 빈 어휘로 생긴다(어휘 0개는
 * 정직한 사실 — 어휘는 /api/classify-vocab 로 따로 더한다).
 *
 * silent fallback 금지:
 *   - store(따라서 store.entityTypeRegistryDb) 미주입(부팅 비활성) 시 CRUD·목록 503
 *     — 정직한 비활성(빈 목록으로 가리지 않는다).
 *   - 빈/공백 koName 은 400 — koName 이 null/빈이면 koNameOf 가 분류 경로 전체에서 throw 해
 *     (T3 qa Minor), 라우트가 trim 후 빈값을 막는다(addEntityType 가 빈 koName 을 안 막으므로).
 *   - 코드 상수 충돌·중복 다른값·코드 상수 삭제 시도는 addEntityType/deleteEntityType 가
 *     throw → 400(에러 메시지 그대로 회신). 같은 값 재등록은 멱등 통과(201).
 */

import { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { isPositiveString, err } from "../http-helpers.ts";
import { reloadClassifyVocabFromDeps } from "../reload-classify-vocab.ts";
import {
  STATIC_PLACEMENT_TYPE_NAMES,
  type TypeDependentCounts,
} from "../../db/store-internal/entity-type-registry-db.ts";
import {
  setEntityTypeOverride,
  resetConceptTypeVocabularyCache,
  getTypeColumns,
  getColumnDataType,
  getTypeSubcategories,
  type PlacementTypeName,
} from "../../memory/concept-type-vocabulary.ts";
import { koNameOf, resetClassifierCache } from "../../memory/entity-type-classifier.ts";
import { columnLabelKeysOf, columnDataTypeOf, type ColumnDataType } from "../../db/store-internal/entity-type-registry.ts";

/** 출처 라벨 — code(읽기전용 코드 상수 10종) vs user(삭제 가능 DB 새 종류). */
type EntityTypeSource = "code" | "user";

const PERSON_CODE_COLUMNS: Array<{ key: string; label: string; dataType: ColumnDataType }> = [
  { key: "생일", label: "생일", dataType: "date" },
];

/** GET 응답 한 건 — 코드 상수·새 종류 공통 모양. idPrefix 는 새 종류만 의미 있다. */
interface EntityTypeListing {
  typeName: string;
  koName: string;
  idPrefix: string | null;
  source: EntityTypeSource;
  /**
   * 종류별 칸 목록(key=한국어 칸 키·label=표시명·dataType=글자형/숫자형/날짜형). 코드 종류=
   * columnLabels+columnDataTypeOf, 새 종류=columns slot+column_types slot. 칸 없는 종류는 [].
   * dataType 은 단계6b 계산 탭이 숫자형 칸만 드롭다운에 보이게 읽는다.
   */
  columns: Array<{ key: string; label: string; dataType: ColumnDataType }>;
  /**
   * 이 종류의 하위분류(subcategory) 갈래 목록(S7). 그래프 검색 모달의 하위분류 단일
   * 드롭다운이 이 목록으로 채워져, 고른 갈래를 filter 값으로 보내 글→갈래 분류 링크
   * (node_concept_edges role='classification')로 후보를 좁힌다. merge vocab 의
   * getTypeSubcategories 가 끈 값(tombstone)을 이미 차감하므로 라우트는 그대로 받는다.
   * 갈래 없는 종류는 [](가짜 항목 0·정직한 빈 상태).
   */
  subcategories: string[];
}

function codeColumnsForType(typeName: string): Array<{ key: string; label: string; dataType: ColumnDataType }> {
  if (typeName === "person") return PERSON_CODE_COLUMNS;
  return columnLabelKeysOf(typeName).map((k) => ({
    key: k,
    label: k,
    dataType: columnDataTypeOf(typeName, k),
  }));
}

/** 종류 삭제를 막는 의존 데이터를 "이름 N개" 문장 조각으로 만든다(개수 0 인 갈래는 뺀다). */
function describeTypeBlockers(n: TypeDependentCounts): string[] {
  const out: string[] = [];
  if (n.vocabEntries > 0) out.push(`분류 어휘(동의어·하위분류·라벨·칸·항목 동의어) ${n.vocabEntries}개`);
  if (n.overrides > 0) out.push(`꺼 둔 기본 어휘(가림표) ${n.overrides}개`);
  if (n.relationNames > 0) out.push(`이 종류를 쓰는 관계명 ${n.relationNames}개`);
  if (n.entities > 0) out.push(`이 종류의 엔티티 ${n.entities}개`);
  return out;
}

export function registerEntityTypesRoutes(app: Hono, deps: MemoryApiDeps): void {
  const api = new Hono({ strict: false });

  // store(EntityTypeRegistryDb 보유)가 있어야 가동한다. deps.store 는 타입상 항상 있으나
  // entityTypeRegistryDb 멤버까지 정직히 검사해, 미주입이면 빈 목록으로 가리지 않고 503.
  const registryReady = (): boolean =>
    deps.store !== undefined && deps.store.entityTypeRegistryDb !== undefined;

  /**
   * CRUD 후 공통 reload — DB 새 종류 명부를 모듈 캐시에 다시 얹고(setEntityTypeOverride)
   * 종류 명부 파생 캐시 + 분류기 2차 캐시를 비운다. 다음 placementTypeNames()·
   * isPlacementType()·typeIndicatorMap() 이 현재 명부로 재빌드해 새 종류가 즉시 분류·위계
   * 진입에 반영된다(D3·D9). registry 가 있을 때만 호출한다(게이트 통과 전제).
   *
   * resetConceptTypeVocabularyCache 는 사용자 분류 어휘 주입분(병합본·항목 동의어·칸 datatype)을
   * 남긴다. 병합이 종류 명부를 돌므로, 명부가 바뀐 지금 yaml 기준선 + 사용자 행을 같은 통로로
   * 다시 얹어 새 종류 칸을 병합본에 맞춘다(주입분이 없는 harness 는 건너뛴다).
   * 지운 종류에 걸린 분류 어휘 행이 남아 병합이 throw 하면 응답을 깨지 않고(종류 CRUD 는 이미
   * 반영됨) 경고만 남기며, 직전 주입분이 그대로 유지된다.
   */
  const reloadEntityTypes = (): void => {
    setEntityTypeOverride(deps.store.entityTypeRegistryDb.listUserEntityTypes());
    resetConceptTypeVocabularyCache();
    try {
      reloadClassifyVocabFromDeps(deps);
    } catch (e) {
      console.warn(
        `entity-types: 분류 어휘 재병합 실패 — 직전 병합본 유지: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    resetClassifierCache();
  };

  /** 코드 상수 10종 + DB 새 종류 합집합 목록(GET 응답 자료·출처 구분). */
  const buildEntityTypeListing = (): EntityTypeListing[] => {
    const out: EntityTypeListing[] = [];
    // 코드 상수 10종 — koName 은 koNameOf(레지스트리/상수 권위). idPrefix 는 코드 종류라
    // 화면 의미가 없어 null(전용 테이블 키 양식이라 사용자 입력 대상이 아니다).
    // STATIC_PLACEMENT_TYPE_NAMES 는 정적 10종이라 모두 union 멤버 — 단언이 안전하다.
    for (const typeName of STATIC_PLACEMENT_TYPE_NAMES) {
      // 코드 칸 키는 기본적으로 columnLabelKeysOf(8종 메타 단일 출처)를 따른다. person 은
      // 전용 persons.birthday 고유 사실을 화면 칸으로도 보여 주기 위해 별도 코드 칸을 얹는다.
      const columns = codeColumnsForType(typeName);
      out.push({
        typeName,
        koName: koNameOf(typeName as PlacementTypeName),
        idPrefix: null,
        source: "code",
        columns,
        // 하위분류는 merge vocab(getTypeSubcategories)에서 읽는다 — 끈 값은 merge 가 차감.
        // person·project 는 vocab 에 subcategories slot 이 없어 빈 배열을 돌려준다.
        subcategories: getTypeSubcategories(typeName as PlacementTypeName),
      });
    }
    // DB 새 종류 — koName/idPrefix DB 권위. koName 은 라우트가 빈값을 막아 항상 채워진다.
    // columns 는 concept-type-vocabulary yaml 의 columns slot 에서 읽는다(slot 0개 = []).
    for (const u of deps.store.entityTypeRegistryDb.listUserEntityTypes()) {
      out.push({
        typeName: u.typeName,
        koName: u.koName ?? "",
        idPrefix: u.idPrefix,
        source: "user",
        columns: getTypeColumns(u.typeName as PlacementTypeName).map((k) => ({
          key: k,
          label: k,
          dataType: getColumnDataType(u.typeName, k),
        })),
        // 하위분류 — 새 종류도 merge vocab 의 subcategories slot 에서 읽는다(slot 0개 = []·끈 값 차감 merge 몫).
        subcategories: getTypeSubcategories(u.typeName as PlacementTypeName),
      });
    }
    return out;
  };

  // ── POST /entity-types — 검증 → addEntityType → 2-reset → 201 ──────────────
  api.post("/entity-types", async (c) => {
    if (!registryReady()) {
      return err(c, 503, "새 종류 CRUD 비활성 (store.entityTypeRegistryDb 미주입)");
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    if (!isPositiveString(body.typeName)) {
      return err(c, 400, "typeName 은 빈 문자열이 아니어야 합니다");
    }
    // 빈/공백 koName 은 막는다 — koName 이 비면 koNameOf 가 분류 경로에서 throw 해
    // (typeIndicatorMap·LLM 프롬프트 모두 koName 필요) 새 종류 입력 글이 전부 깨진다.
    if (!isPositiveString(body.koName)) {
      return err(c, 400, "koName(표시명) 은 빈 문자열이 아니어야 합니다");
    }
    if (body.idPrefix !== undefined && typeof body.idPrefix !== "string") {
      return err(c, 400, "idPrefix 는 문자열이어야 합니다");
    }

    const typeName = body.typeName.trim();
    const koName = body.koName.trim();
    // idPrefix 미지정·빈값이면 빈 접두사 — entities-repository.newId 가 빈 접두사 + UUID 를
    // 만들어 충돌 없는 entity_id 를 생성한다(idPrefix 는 가독용 prefix 일 뿐 식별엔 UUID).
    const idPrefix = typeof body.idPrefix === "string" ? body.idPrefix.trim() : "";

    // 코드 상수 충돌·중복 다른값은 addEntityType 가 throw → 400(에러 메시지 그대로).
    // 같은 값 재등록은 멱등 통과(throw 안 함). 검증 실패가 DB 를 안 건드린 채 끝난다.
    try {
      deps.store.entityTypeRegistryDb.addEntityType({ typeName, koName, idPrefix });
    } catch (e) {
      return err(c, 400, (e as Error).message);
    }

    // 모듈 캐시 + 분류기 캐시 교체 — 다음 입력 글 분류·위계 진입에 즉시 반영(D3·D9).
    reloadEntityTypes();

    return c.json(
      {
        entityType: {
          typeName,
          koName,
          idPrefix,
          source: "user" as EntityTypeSource,
        },
      },
      201,
    );
  });

  // ── GET /entity-types — 코드 상수 ∪ DB 새 종류(출처 구분) ──────────────────
  api.get("/entity-types", (c) => {
    if (!registryReady()) {
      return err(c, 503, "새 종류 CRUD 비활성 — 목록 조회 불가");
    }
    return c.json({ entityTypes: buildEntityTypeListing() });
  });

  // ── DELETE /entity-types/:typeName — 새 종류만 삭제 → 2-reset ───────────────
  api.delete("/entity-types/:typeName", (c) => {
    if (!registryReady()) {
      return err(c, 503, "새 종류 CRUD 비활성 — 삭제 불가");
    }
    const typeName = c.req.param("typeName");
    // 고아 방지 — 이 종류를 가리키는 분류 어휘·가림표·관계명·엔티티가 남아 있으면 409 로 막는다.
    // 종류 행만 지우면 그 행들이 고아로 남아 다음 서버 시작의 어휘 병합이 미등록 종류로 걸리고,
    // 엔티티는 종류 표시명·id 접두사를 못 찾아 분류 경로가 깨진다. 엔티티는 사용자 데이터라 같이
    // 지우지(연쇄 삭제) 않고 먼저 정리하도록 돌려보낸다. 코드 상수 10종은 아래 deleteEntityType 의
    // 400 이 맡고(점검 대상 아님), 명부에 없는 종류는 지울 게 없어 기존대로 멱등 통과한다.
    if (
      !STATIC_PLACEMENT_TYPE_NAMES.includes(typeName) &&
      deps.store.entityTypeRegistryDb.isUserEntityType(typeName)
    ) {
      const blockers = describeTypeBlockers(
        deps.store.entityTypeRegistryDb.countTypeDependents(typeName),
      );
      if (blockers.length > 0) {
        const ko = deps.store.entityTypeRegistryDb.koNameOf(typeName);
        const label = ko ? `${ko}(${typeName})` : typeName;
        return err(
          c,
          409,
          `종류 '${label}' 을(를) 지울 수 없습니다 — 아직 이 종류를 쓰는 데이터가 있습니다. ` +
            `먼저 다음을 지우거나 정리한 뒤 다시 시도하세요: ${blockers.join(", ")}`,
        );
      }
    }
    // 코드 상수 10종 삭제 시도는 deleteEntityType 가 throw → 400(거짓 성공 차단·loud fail).
    // 없는 새 종류는 멱등 통과(0행 변경).
    try {
      deps.store.entityTypeRegistryDb.deleteEntityType(typeName);
    } catch (e) {
      return err(c, 400, (e as Error).message);
    }
    reloadEntityTypes();
    return c.json({ deleted: typeName });
  });

  app.route("/api", api);
}
