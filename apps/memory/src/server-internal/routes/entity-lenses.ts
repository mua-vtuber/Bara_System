/**
 * server-internal/routes/entity-lenses.ts — 데이터 정리 AI 렌즈 계약 API.
 *
 * 렌즈는 AI 에게 엔티티별로 채울 수 있는 칸(columns), 라벨(attributes),
 * 관계칸(relations), 메타정보칸(metadataFields)을 알려 주는 서버 권위 계약이다.
 * 적용 라우트는 이 렌즈 밖 키를 거부하고, 사람 관계칸은 문자열 이름이 아니라
 * 기존 personId 만 받는다.
 *
 * 계약 조립(buildEntityLens·EntityLens)은 도메인 층
 * memory/cleanup-deep-pass/entity-lens.ts 가 단일 출처다 — 이 라우트는 그 HTTP
 * 표면일 뿐이고, 기존 참조처 보존을 위해 여기서 re-export 한다(events 계약의
 * "memory 가 정의, server-internal 이 re-export" 선례 / G5-b 계층 규율).
 */

import { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { err, isPositiveString } from "../http-helpers.ts";
import {
  isPlacementType,
  placementTypeNames,
} from "../../memory/concept-type-vocabulary.ts";
import type { ProjectStatus } from "../../memory/types.ts";
import {
  buildEntityLens,
  type EntityLens,
} from "../../memory/cleanup-deep-pass/entity-lens.ts";
import {
  applyLensDraft,
  LensApplyError,
  validateDraftShape,
  type LensApplyView,
} from "../../memory/cleanup-deep-pass/lens-apply.ts";

export { buildEntityLens } from "../../memory/cleanup-deep-pass/entity-lens.ts";
export type { EntityLens } from "../../memory/cleanup-deep-pass/entity-lens.ts";

const PROJECT_STATUSES: readonly ProjectStatus[] = ["active", "done", "paused"];

export function registerEntityLensRoutes(app: Hono, deps: MemoryApiDeps): void {
  const api = new Hono({ strict: false });

  api.get("/api/entity-lenses", (c) => {
    return c.json({
      lenses: placementTypeNames().map((typeName) =>
        buildEntityLens(typeName as string),
      ),
    });
  });

  api.get("/api/entity-lenses/:typeName", (c) => {
    const typeName = c.req.param("typeName");
    if (!isPlacementType(typeName)) {
      return err(c, 404, `알 수 없는 엔티티 종류: ${typeName}`);
    }
    return c.json({ lens: buildEntityLens(typeName) });
  });

  api.post("/api/lens-drafts/apply", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid JSON body");
    }
    if (!isRecord(body)) return err(c, 400, "body must be an object");

    const typeName = typeof body.typeName === "string" ? body.typeName.trim() : "";
    if (!isPlacementType(typeName)) {
      return err(c, 400, `알 수 없는 엔티티 종류: ${typeName}`);
    }
    const lens = buildEntityLens(typeName);
    const columns = asRecord(body.columns, "columns");
    const labels = asRecord(body.labels ?? body.attributes, "labels");
    const relations = asRecord(body.relations, "relations");
    const metadata = asRecord(body.metadata, "metadata");
    if (columns.error) return err(c, 400, columns.error);
    if (labels.error) return err(c, 400, labels.error);
    if (relations.error) return err(c, 400, relations.error);
    if (metadata.error) return err(c, 400, metadata.error);

    const sourceNodeId =
      typeof body.sourceNodeId === "number" && Number.isInteger(body.sourceNodeId)
        ? body.sourceNodeId
        : null;

    const entityBody = asRecord(body.entity, "entity");
    if (entityBody.error) return err(c, 400, entityBody.error);

    // 키·형식·대상 검증과 단일 트랜잭션 적용은 공유 함수가 맡는다(spec 6.C-2 선행 정비).
    // route 는 그 함수의 HTTP 표면 — HTTP 경로는 옛 동작 보존을 위해 project·범용 엔티티를
    // 새로 만들 수 있다. 단 "거부된 적용은 엔티티를 만들지 않는다" 불변식을 지키려면 값 형식·
    // 렌즈 밖 키·관계 모양 검증(validateDraftShape)을 엔티티 해소 *전에* 돌려야 한다 —
    // resolveSourceEntity 가 findOrCreate 로 새 엔티티를 만들기 전에 잘못된 초안을 걸러낸다.
    // 대상 존재·fingerprint·단일 트랜잭션은 엔티티 해소 뒤 applyLensDraft 가 이어서 한다.
    const applyLens = toApplyView(lens);
    const values = {
      columns: columns.value,
      labels: labels.value,
      relations: relations.value,
      metadata: metadata.value,
    };
    try {
      validateDraftShape(applyLens, values);
      // metadata 는 근거 노드가 필요하다 — 엔티티 해소 전에 걸러 거부 초안이 엔티티를 안 만들게.
      if (Object.keys(values.metadata).length > 0 && sourceNodeId === null) {
        return err(c, 400, "metadata 적용에는 sourceNodeId(number)가 필요");
      }
      const sourceId = await resolveSourceEntity(deps, typeName, entityBody.value);
      const result = await applyLensDraft(deps, {
        lens: applyLens,
        entityId: sourceId,
        values,
        sourceNodeId,
        aiPath: false,
      });
      return c.json(result);
    } catch (e) {
      if (e instanceof LensApplyError) return err(c, 400, e.message);
      return err(c, 400, e instanceof Error ? e.message : String(e));
    }
  });

  app.route("/", api);
}

function asRecord(
  value: unknown,
  name: string,
): { value: Record<string, unknown>; error?: undefined } | { value: Record<string, unknown>; error: string } {
  if (value === undefined || value === null) return { value: {} };
  if (!isRecord(value)) return { value: {}, error: `${name} must be an object` };
  return { value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * EntityLens(HTTP 계약 뷰)를 공유 적용 함수 applyLensDraft 가 쓰는 LensApplyView 로
 * 좁힌다. 키·dataType·관계 방향 판정에 필요한 최소 계약만 넘긴다(적용 검증 단일 출처는
 * lens-apply.ts).
 */
function toApplyView(lens: EntityLens): LensApplyView {
  return {
    typeName: lens.typeName,
    columns: lens.columns.map((c) => ({ key: c.key, dataType: c.dataType })),
    attributeKeys: lens.attributes.map((a) => a.key),
    relations: lens.relations.map((r) => ({
      key: r.key,
      relation: r.relation,
      targetTypes: r.targetTypes,
      defaultTargetType: r.defaultTargetType,
    })),
    metadataKeys: lens.metadataFields.map((m) => m.key),
  };
}

async function resolveSourceEntity(
  deps: MemoryApiDeps,
  typeName: string,
  entity: Record<string, unknown>,
): Promise<string> {
  if (typeName === "person") {
    if (typeof entity.id !== "string" || !entity.id.trim()) {
      throw new Error("person 렌즈 적용은 기존 entity.id(personId)가 필요 — 새 사람 생성 불가");
    }
    const person = await deps.store.getPerson(entity.id.trim());
    if (!person) throw new Error(`기존 personId 없음: ${entity.id}`);
    return person.personId;
  }

  if (typeName === "project") {
    if (typeof entity.id === "string" && entity.id.trim()) {
      const existing = await deps.store.getProject(entity.id.trim());
      if (!existing) throw new Error(`기존 projectId 없음: ${entity.id}`);
      return existing.projectId;
    }
    if (!isPositiveString(entity.name)) {
      throw new Error("project 렌즈 적용은 entity.name 또는 기존 entity.id 필요");
    }
    const status = isProjectStatus(entity.status) ? entity.status : "active";
    const project = await deps.store.findOrCreateProject({
      name: entity.name.trim(),
      summary: typeof entity.summary === "string" ? entity.summary : null,
      status,
    });
    if (typeof entity.summary === "string" || isProjectStatus(entity.status)) {
      await deps.store.updateProject(project.projectId, {
        ...(typeof entity.summary === "string" ? { summary: entity.summary } : {}),
        ...(isProjectStatus(entity.status) ? { status: entity.status } : {}),
      });
    }
    return project.projectId;
  }

  if (typeof entity.id === "string" && entity.id.trim()) {
    const existing = await deps.store.entitiesRepo.get(entity.id.trim());
    if (!existing || existing.typeName !== typeName) {
      throw new Error(`기존 entity id/type 불일치: ${entity.id}`);
    }
    return existing.id;
  }
  if (!isPositiveString(entity.name)) {
    throw new Error(`${typeName} 렌즈 적용은 entity.name 또는 기존 entity.id 필요`);
  }
  const entityRow = await deps.store.entitiesRepo.findOrCreateEntity(
    typeName,
    entity.name.trim(),
  );
  return entityRow.id;
}

function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && PROJECT_STATUSES.includes(value as ProjectStatus);
}
