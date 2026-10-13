/**
 * server-internal/routes/relation-vocab.ts — 관계명 동결 해제 CRUD 라우트 등록기
 * (분류 단계3 T7b · D11·D12·D13).
 *
 * 세 라우트(entity-types.ts·classify-vocab.ts 양식 미러):
 *   1. POST   /api/relation-vocab — body {relationKey, relationName, sourceTypes,
 *      targetTypes, defaultTargetType} 검증 → 3분법 충돌 점검(위반 400) →
 *      relationNameUserRepo.addEntry → 재병합 → 4-reset → 201 + 생성 관계명.
 *   2. GET    /api/relation-vocab — 코드 상수 8개 씨앗(source "code"·읽기전용) + DB 새
 *      관계명(source "user"·삭제 가능)을 한 목록으로 내려준다. 씨앗은 yaml 로더,
 *      새 관계명은 relationNameUserRepo.listEntries(삭제용 relationKey 보유).
 *   3. DELETE /api/relation-vocab/:relationKey — 코드 상수 8개 키 삭제 시도는 400,
 *      새 관계명만 deleteByKey → 재병합 → 4-reset → 200.
 *
 * 단일 권위 정신(classify-vocab.ts 본보기 그대로): CRUD 가 쓰는 RelationNameUserRepo
 * (deps.relationNameUserRepo)와 부팅 때 모듈 캐시에 주입한 병합본이, CRUD 직후 yaml
 * 관계 씨앗(loadRelationVocabularySeed) + repo.listEntries() 를 mergeRelationVocab 로
 * 다시 합쳐 setRelationVocabOverride 로 모듈 캐시를 갈아끼우고, 관계 어휘 파생 캐시
 * (resetRelationVocabCache)·종류 명부 파생 캐시(resetConceptTypeVocabularyCache)·분류기
 * 2차 캐시(resetClassifierCache)를 비운다. 그래서 추가·삭제가 재시작 없이 다음 입력 글의
 * 관계 wiring(#새관계:대상 → entity_relation_edges)에 즉시 반영된다(새 글부터·소급 0·D13).
 *
 * 3분법 충돌 가드(D12 세 검사): 새 관계 키가 칸(registry columnLabels 기존 10종 + 새 종류
 * entity_attributes is_column)·라벨(yaml+DB attributes)·항목 동의어(item_synonym 대표키/
 * 동의어)와 겹치면 400. 단계2 가 깐 역방향(관계 키를 항목 동의어로 등록하면 400)의 대칭 —
 * 두 방향 가드로 3분법이 닫힌다. checkRelationKeyTrichotomyConflict(T7a) 순수 함수에 현재
 * 어휘 상태를 모아 넘긴다.
 *
 * silent fallback 금지:
 *   - relationNameUserRepo 미주입(부팅 비활성) 시 CRUD·목록 503 — 정직한 비활성.
 *   - 빈/공백 relationKey·relationName 은 400. source/target 미등록 타입·거짓 기본 타입은
 *     mergeRelationVocab 가 추가 전 prospective 병합에서 throw → 400(위반 행이 안 남는다).
 *   - 코드 상수 8개 충돌·중복 다른값은 mergeRelationVocab/addEntry 가 throw → 400.
 *   - 코드 상수 8개 삭제 시도는 라우트가 막아 400(거짓 성공 차단).
 */

import { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { isPositiveString, err } from "../http-helpers.ts";
import {
  mergeRelationVocab,
  mergeRelationVocabSkippingOrphans,
  partitionOrphanRelationEntries,
  checkRelationKeyTrichotomyConflict,
} from "../../memory/relation-vocab/relation-vocab-merge.ts";
import { loadRelationVocabularySeed } from "../../memory/relation-vocab/relation-vocab-loader.ts";
import {
  setRelationVocabOverride,
  resetRelationVocabCache,
  relationTagKeySet,
} from "../../memory/entity-relation-vocabulary.ts";
import {
  resetConceptTypeVocabularyCache,
  placementTypeNames,
} from "../../memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";
import {
  ENTITY_TYPE_METAS,
  columnLabelKeysOf,
} from "../../db/store-internal/entity-type-registry.ts";
import { parseItemSynonymValue } from "../../memory/classify-vocab/classify-vocab-user-repo.ts";
import type { ConceptTypeVocabulary } from "../../memory/concept-type-vocabulary.ts";
import type { ClassifyVocabUserRepo } from "../../memory/classify-vocab/classify-vocab-user-repo.ts";

/** 출처 라벨 — code(읽기전용 씨앗 8개) vs user(삭제 가능 DB 새 관계명). */
type RelationVocabSource = "code" | "user";

/** GET 응답 한 건 — 씨앗·새 관계명 공통 모양. source/target 타입 목록 + 기본 타입 포함. */
interface RelationVocabListing {
  relationKey: string;
  relationName: string;
  sourceTypes: string[];
  targetTypes: string[];
  defaultTargetType: string;
  source: RelationVocabSource;
}

/**
 * 현재 등록된 칸 키 집합을 모은다(3분법 첫째 검사 입력) — 세 출처를 합친다:
 *   1. 기존 10종 전용 컬럼(registry columnLabels·코드 상수 권위).
 *   2. 새 종류 *선언* 칸 어휘(classify-vocab columns slot user 행·단계3 T8·D15). 칸이 아직
 *      한 번도 입력으로 저장된 적 없어도(닭-달걀) 선언만으로 칸 충돌을 잡는다.
 *   3. 새 종류 *적용* 칸(entity_attributes is_column=1·이미 저장된 칸). 선언과 같은 칸을
 *      가리키지만, 선언 통로를 안 거치고 들어온 칸까지 빠짐없이 본다(드리프트 0).
 * 세 출처를 합쳐 새 관계 키가 어느 칸과도 안 겹치게 한다(D12 첫째 검사).
 */
function collectColumnKeys(
  store: MemoryApiDeps["store"],
  classifyRepo: ClassifyVocabUserRepo | undefined,
): string[] {
  const keys: string[] = [];
  // 1) 기존 10종 — entity-type-registry 의 columnLabels 가 칸 권위(코드 상수).
  //    칸 키 추출은 columnLabelKeysOf(레지스트리 단일 출처)로 모은다 — 8 타입은 전부
  //    멤버라 가드를 그대로 통과해 각 타입의 columnLabels 키를 돌려준다.
  for (const meta of ENTITY_TYPE_METAS) {
    for (const k of columnLabelKeysOf(meta.typeName)) {
      keys.push(k);
    }
  }
  // 2) 새 종류 선언 칸 어휘(columns slot) — T8 이 연 칸 등록 통로(선언 권위).
  if (classifyRepo !== undefined) {
    for (const e of classifyRepo.listEntries()) {
      if (e.slot === "columns") keys.push(e.value);
    }
  }
  // 3) 새 종류 적용 칸 — entity_attributes is_column=1 attr_key(DB). store 가 항상 있으나
  //    타입상 멤버까지 정직히 검사한다(silent fallback 금지 — 없으면 새 종류 칸 0).
  if (store !== undefined) {
    for (const k of store.listEntityColumnKeys()) keys.push(k);
  }
  return keys;
}

/**
 * 현재 등록된 라벨 키 집합을 모은다(3분법 둘째 검사 입력) — yaml 기준선 attributes +
 * DB user 행 attributes slot 값에서 *관계 태그 키를 뺀다*. classify-vocab 어휘가 라벨
 * 어휘의 단일 출처지만, yaml attributes 에는 씨앗 관계 키(창작자·출처·주인·관련사람…)도
 * 섞여 있다(concept_type_vocabulary.yaml). 런타임 라벨 어휘는 entity-attribute-wiring 이
 * `attributes − columnLabels − relationTagKeySet` 차집합으로 본다(:221-223) — 같은 규칙을
 * 여기서도 따라, 씨앗 관계 키가 라벨로 오인돼 새 관계명 등록을 잘못 막는 일을 없앤다(씨앗
 * 관계 키 충돌은 mergeRelationVocab 의 "씨앗과 겹침" 검사가 정확히 잡는다). classify-vocab
 * repo·yaml 이 미주입이면(부팅 비활성) 라벨 검사는 비어, 관계명 등록이 라벨과 안 겹친다는
 * 보장이 약해진다 — 그건 classify-vocab 비활성의 정직한 한계다(가짜로 채우지 않는다).
 */
function collectLabelKeys(
  yamlVocab: ConceptTypeVocabulary | undefined,
  classifyRepo: ClassifyVocabUserRepo | undefined,
): string[] {
  const relationKeys = relationTagKeySet();
  const keys: string[] = [];
  if (yamlVocab) {
    for (const t of placementTypeNames()) {
      const v = yamlVocab.get(t);
      if (v) for (const a of v.attributes) {
        if (!relationKeys.has(a)) keys.push(a);
      }
    }
  }
  if (classifyRepo) {
    for (const e of classifyRepo.listEntries()) {
      if (e.slot === "attributes" && !relationKeys.has(e.value)) keys.push(e.value);
    }
  }
  return keys;
}

/**
 * 현재 등록된 항목 동의어 키 집합을 모은다(3분법 셋째 검사 입력) — item_synonym slot
 * 행의 대표키·동의어 양쪽. classify-vocab user 행이 항목 동의어의 유일 출처다(yaml 칸엔
 * 항목 동의어가 없다). 새 관계 키가 대표키나 동의어 어느 쪽과 겹쳐도 막는다(단계2 가 깐
 * 역방향 가드 — 관계 키를 항목 동의어로 등록하면 400 — 의 대칭). repo 미주입이면 빈 배열.
 */
function collectItemSynonymKeys(classifyRepo: ClassifyVocabUserRepo | undefined): string[] {
  const keys: string[] = [];
  if (!classifyRepo) return keys;
  for (const e of classifyRepo.listEntries()) {
    if (e.slot !== "item_synonym") continue;
    const { canonical, alias } = parseItemSynonymValue(e.value);
    keys.push(canonical, alias);
  }
  return keys;
}

export function registerRelationVocabRoutes(app: Hono, deps: MemoryApiDeps): void {
  const api = new Hono({ strict: false });

  // 관계명 CRUD repo 가 있어야 가동한다 — 없으면 빈 목록으로 가리지 않고 정직한 503.
  const repoReady = (): boolean => deps.relationNameUserRepo !== undefined;

  /**
   * CRUD 후 공통 4-reset — yaml 관계 씨앗 + DB 새 관계명을 다시 병합해 모듈 캐시에
   * 얹고(setRelationVocabOverride), 관계 어휘 파생 캐시(resetRelationVocabCache)·종류
   * 명부 파생 캐시(resetConceptTypeVocabularyCache)·분류기 2차 캐시(resetClassifierCache)
   * 를 비운다. resetConceptTypeVocabularyCache 는 사용자 분류 어휘 주입분(병합본·항목 동의어·
   * 칸 datatype)을 남기고, 관계명 CRUD 는 종류 명부를 안 바꾸므로 분류 어휘 재주입은 필요 없다.
   * 다음 입력 글의 관계 wiring(parseRelationTags → lookupRelationTag → addEntityRelationEdge)이 현재 관계 어휘로 재빌드해 새 관계 키가 즉시 인식된다(D13).
   * repo 가 있을 때만 호출한다(게이트 통과 전제). 병합이 불변식 위반을 throw 하면
   * 호출자가 잡아 400 으로 회신한다.
   */
  const reloadMergedRelationVocab = (): void => {
    const seed = loadRelationVocabularySeed();
    const userEntries = deps.relationNameUserRepo!.listEntries();
    // 불러오는 쪽은 고아 행(종류가 지워진 뒤 남은 행)을 건너뛰는 관용 병합 — 고아가 무관한 관계명 CRUD 를 막지 않는다.
    const merged = mergeRelationVocabSkippingOrphans(seed, userEntries);
    setRelationVocabOverride(merged);
    resetRelationVocabCache();
    resetConceptTypeVocabularyCache();
    resetClassifierCache();
  };

  /** 코드 상수 8개 씨앗(source code) + DB 새 관계명(source user) 합집합 목록(GET 응답·출처 구분). */
  const buildRelationVocabListing = (): RelationVocabListing[] => {
    const out: RelationVocabListing[] = [];
    // 씨앗 — yaml 로더(코드 상수 8개와 동행 검증된 단일 출처). 읽기전용이라 삭제 불가.
    for (const [relationKey, spec] of loadRelationVocabularySeed()) {
      out.push({
        relationKey,
        relationName: spec.relation,
        sourceTypes: [...spec.sourceTypes],
        targetTypes: [...spec.targetTypes],
        defaultTargetType: spec.defaultTargetType,
        source: "code",
      });
    }
    // DB 새 관계명 — relationKey 로 삭제 가능. listEntries 가 타입 목록을 배열로 역직렬화한다.
    for (const e of deps.relationNameUserRepo!.listEntries()) {
      out.push({
        relationKey: e.relationKey,
        relationName: e.relationName,
        sourceTypes: e.sourceTypes,
        targetTypes: e.targetTypes,
        defaultTargetType: e.defaultTargetType,
        source: "user",
      });
    }
    return out;
  };

  /** 씨앗 관계 키 집합(코드 상수 8개·삭제 불가). DELETE 가 씨앗 키 삭제 시도를 막는 데 쓴다. */
  const seedRelationKeys = (): Set<string> =>
    new Set(loadRelationVocabularySeed().keys());

  // string[] body 칸을 trim·문자열 검증한다. 비배열·비문자열 원소는 거른다(라우트 방어).
  const parseTypeList = (val: unknown): string[] | null => {
    if (!Array.isArray(val)) return null;
    const out: string[] = [];
    for (const x of val) {
      if (typeof x !== "string") return null;
      const t = x.trim();
      if (t) out.push(t);
    }
    return out;
  };

  // ── POST /relation-vocab — 검증 → 3분법 점검 → 추가 → 재병합 → 4-reset → 201 ──
  api.post("/relation-vocab", async (c) => {
    if (!repoReady()) {
      return err(c, 503, "관계명 CRUD 비활성 (relationNameUserRepo 미주입)");
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    if (!isPositiveString(body.relationKey)) {
      return err(c, 400, "relationKey(관계 태그 키) 는 빈 문자열이 아니어야 합니다");
    }
    if (!isPositiveString(body.relationName)) {
      return err(c, 400, "relationName(영문 관계명) 은 빈 문자열이 아니어야 합니다");
    }
    const sourceTypes = parseTypeList(body.sourceTypes);
    if (sourceTypes === null || sourceTypes.length === 0) {
      return err(c, 400, "sourceTypes 는 종류 이름 문자열 배열이어야 하고 최소 하나가 필요합니다");
    }
    const targetTypes = parseTypeList(body.targetTypes);
    if (targetTypes === null || targetTypes.length === 0) {
      return err(c, 400, "targetTypes 는 종류 이름 문자열 배열이어야 하고 최소 하나가 필요합니다");
    }
    if (!isPositiveString(body.defaultTargetType)) {
      return err(c, 400, "defaultTargetType(기본 target 종류) 는 빈 문자열이 아니어야 합니다");
    }

    const relationKey = body.relationKey.trim();
    const relationName = body.relationName.trim();
    const defaultTargetType = body.defaultTargetType.trim();

    // 3분법 충돌 점검 — 새 관계 키가 칸/라벨/항목 동의어와 겹치면 DB 를 안 건드린 채 400
    // (D12 세 검사·단계2 역방향 가드의 대칭). checkRelationKeyTrichotomyConflict 순수 함수.
    const conflict = checkRelationKeyTrichotomyConflict(
      relationKey,
      collectColumnKeys(deps.store, deps.classifyVocabUserRepo),
      collectLabelKeys(deps.conceptVocabYaml, deps.classifyVocabUserRepo),
      collectItemSynonymKeys(deps.classifyVocabUserRepo),
    );
    if (conflict) {
      return err(c, 400, conflict.message);
    }

    // 추가 *전* prospective 병합 — 현재 user 행(같은 relationKey 기존 행은 빼고) + 이 후보를
    // 합쳐 병합을 미리 돌린다. 같은 키 기존 행을 빼는 이유: 멱등 재등록(같은 값 다시) 시
    // mergeRelationVocab 의 DB↔DB 키 중복 throw 를 피한다 — 값이 같으면 addEntry 가 멱등
    // 통과하고, 값이 다르면 addEntry 가 "덮어쓰기 금지" throw 로 막는다(그 판정은 addEntry
    // 몫). 여기 prospective 는 *씨앗 충돌·미등록 타입·거짓 기본 타입* 만 미리 걸러 DB 를 안
    // 건드린 채 400 을 낸다(silent skip 금지). 코드 상수 씨앗 키 충돌은 candidate 가
    // 씨앗 키면 mergeRelationVocab 가 식별자 담아 throw → 400.
    const candidate = {
      relationKey,
      relationName,
      sourceTypes,
      targetTypes,
      defaultTargetType,
    };
    try {
      const seed = loadRelationVocabularySeed();
      // 기존 행 중 고아(종류가 이미 지워진 행)는 재병합과 같이 걸러 낸다 — 후보만 엄격 검증.
      const others = partitionOrphanRelationEntries(
        deps.relationNameUserRepo!.listEntries().filter((e) => e.relationKey !== relationKey),
      ).entries;
      mergeRelationVocab(seed, [...others, candidate]);
    } catch (e) {
      return err(c, 400, (e as Error).message);
    }

    // repo 가 relation_key UNIQUE 를 멱등 처리한다 — 같은 값 재등록은 기존 id 회신,
    // 다른 값은 덮어쓰기 금지 throw → 400. entry_id 반환.
    try {
      deps.relationNameUserRepo!.addEntry(candidate);
    } catch (e) {
      return err(c, 400, (e as Error).message);
    }

    // 모듈 캐시 + 파생/분류기 캐시 교체 — 다음 입력 글 관계 wiring 에 즉시 반영(D13).
    reloadMergedRelationVocab();

    return c.json(
      {
        relationVocab: {
          relationKey,
          relationName,
          sourceTypes,
          targetTypes,
          defaultTargetType,
          source: "user" as RelationVocabSource,
        },
      },
      201,
    );
  });

  // ── GET /relation-vocab — 씨앗 8개(code) ∪ DB 새 관계명(user) 출처 구분 ──────
  api.get("/relation-vocab", (c) => {
    if (!repoReady()) {
      return err(c, 503, "관계명 CRUD 비활성 — 목록 조회 불가");
    }
    return c.json({ relationVocab: buildRelationVocabListing() });
  });

  // ── DELETE /relation-vocab/:relationKey — 새 관계명만 삭제 → 4-reset ────────
  api.delete("/relation-vocab/:relationKey", (c) => {
    if (!repoReady()) {
      return err(c, 503, "관계명 CRUD 비활성 — 삭제 불가");
    }
    const relationKey = c.req.param("relationKey");
    // 코드 상수 8개 씨앗 키 삭제 시도는 막는다(거짓 성공 차단·loud fail) — 씨앗은 yaml
    // 권위라 화면에서 못 지운다. 없는 새 관계명은 deleteByKey 가 멱등(0행 변경) 통과.
    if (seedRelationKeys().has(relationKey)) {
      return err(
        c,
        400,
        `'${relationKey}' 은(는) 코드 상수 관계 키라 삭제할 수 없습니다 — 새로 더한 관계명만 삭제 가능`,
      );
    }
    deps.relationNameUserRepo!.deleteByKey(relationKey);
    reloadMergedRelationVocab();
    return c.json({ deleted: relationKey });
  });

  app.route("/api", api);
}
