/**
 * server-internal/routes/cleanup-proposals.ts — cleanup_proposals 검토 게이트 API
 * 등록기 (Phase 11b T13 / sidecar acceptance).
 *
 * Phase 7 cleanup-AI 가 emit 한 정리 제안을 사용자가 대시보드 안 [승인]/[거절]
 * 버튼으로 결정하는 통로. 자동 적용 안 함 — 사용자가 직접 클릭한 시점에만
 * `setPlace` / `setEventAt` / `addNodePersonEdge` / `regexUserRepo.addPattern` 등이
 * 호출된다.
 *
 * 4 라우트:
 *   1. GET  /cleanup-proposals?status=pending&limit=N&offset=N — 대기 목록 + 총 개수
 *   2. GET  /cleanup-proposals/:id — 한 건 본문 또는 404
 *   3. POST /cleanup-proposals/:id/approve — kind 분기 후 적용 + status='approved'
 *   4. POST /cleanup-proposals/:id/reject  — status='rejected' (적용 함수 호출 안 함)
 *
 * 사용자 결정 동결 (2026-05-29):
 *   - kind 가 'metadata_fill' / 'person_link' / 'regex_pattern_add' 외 = **400 정직 회신 + status pending 보존**
 *   - 자동 status='rejected_unknown_kind' 양식 채택 안 함 — 호출자가 어느 kind 가
 *     적용 함수 미정착인지 자연 가시화 (graceful-degradation-principle 정합).
 *   - 메시지: `알 수 없는 kind '<kind 값>' — 이 종류는 아직 적용 함수 부재`
 *
 * DCL-5 (2026-07-11 효율 가동 spec 단락 6.C-3): 'classification' / 'synonym'
 * approve 분기는 생산자 없는 죽은 코드였다 — "이 kind 를 처리할 수 있다"는
 * 위장을 없애기 위해 제거하고 KNOWN_KINDS 에서도 뺐다(모르는 kind = 400 정직
 * 회신에 합류). D2 동의어 병합 생산자(05-24 spec §3.7/§5.4 의 0.80~0.94
 * silent-store 대역)를 출하하는 날, 생산자와 이 approve 분기를 **한 commit 에서
 * 같이** 복원한다. classification 은 생산자 부재가 계속되면 재검토 대상.
 *
 * 이미 처리된 (status != 'pending') 제안 = 400 — 두 번 적용 차단.
 *
 * silent fallback 금지: 없는 id = 404 / 잘못된 payload = 적용 함수가 구체 에러로
 * throw → 400 으로 노출 (정직).
 *
 * 옛 concept-aliases.ts 라우트 양식 정합 — `app.route('/', api)` + Hono 한 묶음.
 */

import { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { err, parseLimit } from "../http-helpers.ts";
import { CleanupProposalsRepository } from "../../db/store-internal/cleanup-proposals-repository.ts";
import type { RegexCategory } from "../../memory/regex-l0/types.ts";
import { LensApplyError } from "../../memory/cleanup-deep-pass/lens-apply.ts";
import {
  KNOWN_KINDS,
  validateProposalPayload,
  submitExternalProposal,
} from "../cleanup-external/proposals.ts";
import {
  ITEMIZED_KINDS,
  listProposalItems,
  applyProposalItems,
  judgeProposalStatus,
  describeZeroApplyReason,
} from "../cleanup-external/proposal-items.ts";
import { ENTITY_REGISTER_KIND } from "../../memory/cleanup-deep-pass/entity-register/constants.ts";
import { approveEntityRegisterRoute, rejectEntityRegisterRoute } from "./cleanup-proposals-entity-register.ts";

/** GET 목록 default limit — 대시보드 한 화면 한 묶음. */
const DEFAULT_LIMIT = 20;
/** GET 목록 max limit — 과도 회신 차단. parseLimit 가 자연 clamp. */
const MAX_LIMIT = 100;

// KNOWN_KINDS 단일 출처는 cleanup-external/proposals.ts — 등록·승인 두 경로가 같은
// kind 집합을 쓴다(라우트→cleanup-external 한 방향 import, 순환 차단). 새 kind 추가 시
// 그 파일의 set + 아래 approve 분기 둘 다 갱신.

// metadata_fill 의 place 적용은 1차(memory/metadata-apply.ts)와 같은 진입점
// store.setPlace 로 합류한다(활용 단계2 ③). 1차는 source="system", 검토 게이트
// 적용(이번 분기)은 source="inferred" — place 엔티티는 같은 places 행으로 수렴하고
// (name UNIQUE 멱등), 출처만 갈린다. 둘 다 setPlace 안 canWriteField 가드가 직접
// 입력(direct) 장소를 보호한다.

export function registerCleanupProposalsRoutes(
  app: Hono,
  deps: MemoryApiDeps,
): void {
  // Repository 인스턴스 — register 진입 시점 1회 생성 (db 핸들은 store 가 보존).
  // 매 요청마다 new 호출 회피 + 옛 concept-aliases.ts 안 store facade 통로 양식과
  // 같은 정신 (단 store 합류는 T12 권위 밖이라 repository 직접 가동).
  const repo = new CleanupProposalsRepository(deps.store.getRawDb());

  const api = new Hono({ strict: false });

  // ── GET /cleanup-proposals — 대기 목록 + 총 개수 ───────────────────────────
  //
  // status query param = 'pending' 한정 가동. 다른 값 = 400 (옛 결정 외 status
  // 가족 도입 차단 — 추후 spec 확장 시 본 분기 갱신).
  api.get("/cleanup-proposals", (c) => {
    const status = c.req.query("status") ?? "pending";
    if (status !== "pending") {
      return err(
        c,
        400,
        `지원 안 하는 status '${status}' — pending 한정 가동`,
      );
    }

    const limit = parseLimit(c.req.query("limit"), DEFAULT_LIMIT, MAX_LIMIT);
    const rawOffset = Number(c.req.query("offset") ?? 0);
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0
      ? Math.floor(rawOffset)
      : 0;

    // 항목 분해를 동봉한다(추가형 — 기존 칸 전부 보존, spec 5-9). 분해 대상이 아닌
    // 추가형 kind 는 items:[] 로 나가고 대시보드가 현행 단일 승인 버튼을 그대로 쓴다.
    const proposals = repo.findPending(limit, offset).map((p) => ({
      ...p,
      items: listProposalItems(p.kind, p.payload),
    }));

    // total — pending 전체 개수 (paging UI 안 "1 / 12" 양식 산출 자료).
    const totalRow = deps.store
      .getRawDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM cleanup_proposals WHERE status = 'pending'",
      )
      .get() as { n: number };

    return c.json({ proposals, total: totalRow.n });
  });

  // ── GET /cleanup-proposals/:id — 한 건 본문 ─────────────────────────────────
  api.get("/cleanup-proposals/:id", (c) => {
    const id = c.req.param("id");
    const proposal = repo.findById(id);
    if (!proposal) {
      return err(c, 404, "proposal 없음 — id 확인");
    }
    // items = 항목 분해(부분 승인 선택지), journal = 항목별 적용 기록(무엇이 적용되고
    // 무엇이 왜 안 들어갔는지). 둘 다 추가형 — 기존 칸은 그대로다(spec 5-9).
    return c.json({
      ...proposal,
      items: listProposalItems(proposal.kind, proposal.payload),
      journal: repo.listJournal(proposal.id),
    });
  });

  // ── POST /cleanup-proposals/:id/approve — 적용 + status='approved' ─────────
  //
  // kind 분기:
  //   - 'metadata_fill'  → field='place'    → store.setPlace(nodeId, value, "inferred")
  //                        field='event_at' → store.setEventAt(nodeId, value, "inferred")
  //   - 'person_link'    → 기존 personId 검증 후 store.addNodePersonEdge(..., "mentions")
  //   - 그 외           → 400 + status pending 보존 (사용자 결정 동결)
  //
  // 적용 함수가 throw 한 경우 (잘못된 payload / 없는 node·concept id 등) = 400
  // 으로 노출 + status 변경 안 함 (실패 = pending 그대로 — 재시도 가능).
  api.post("/cleanup-proposals/:id/approve", async (c) => {
    const id = c.req.param("id");
    const proposal = repo.findById(id);
    if (!proposal) {
      return err(c, 404, "proposal 없음 — id 확인");
    }
    // entity_register 는 항목별 선택(choices) 승인 — 몸통은 별도 모듈(spec 6장: 라우트에 직접 쓰지 않는다).
    if (proposal.kind === ENTITY_REGISTER_KIND) return approveEntityRegisterRoute(c, deps, repo, proposal);

    // 부분 승인 선택 — body 의 itemKeys 배열(선택). 없으면 전건 승인(옛 계약 그대로:
    // body 없는 POST 가 지금까지처럼 전부 적용). 파괴형 kind 한정으로 읽는다.
    let selectedItemKeys: Set<string> | undefined;
    if (ITEMIZED_KINDS.has(proposal.kind)) {
      const raw = await c.req.json().catch(() => null);
      const itemKeys = (raw as { itemKeys?: unknown } | null)?.itemKeys;
      if (itemKeys !== undefined) {
        if (
          !Array.isArray(itemKeys) ||
          itemKeys.some((k) => typeof k !== "string")
        ) {
          return err(
            c,
            400,
            "itemKeys 어긋남 — 문자열 배열이어야 함(생략 시 전건 승인)",
          );
        }
        selectedItemKeys = new Set(itemKeys as string[]);
      }
    }

    // 이미 처리된 제안 = 두 번 적용 차단.
    if (proposal.status !== "pending") {
      return err(
        c,
        400,
        `이미 처리된 proposal — status: ${proposal.status}`,
      );
    }

    // unknown kind 게이트 — 사용자 결정 동결 (status pending 그대로 + 400).
    if (!KNOWN_KINDS.has(proposal.kind)) {
      return err(
        c,
        400,
        `알 수 없는 kind '${proposal.kind}' — 이 종류는 아직 적용 함수 부재`,
      );
    }

    // payload 구조 검증 — 등록 경로(submitExternalProposal)와 공유 함수(spec 6.2).
    // 등록 시점에 이미 한 번 검증하지만, 등록 후 DB 상태가 바뀔 수 있으므로 승인
    // 시점에도 같은 규칙으로 재검증한다(이중 검증). 실패 = 현행과 같은 400 + pending
    // 보존. DB 존재 검증·적용 호출은 아래 분기가 현행 그대로 이어서 한다.
    const payloadCheck = validateProposalPayload(proposal.kind, proposal.payload);
    if (!payloadCheck.ok) {
      return err(c, 400, payloadCheck.message);
    }

    // regex_pattern_add 토글 OFF 게이트 — regexUserRepo/regexL0 미주입(regex 사용자
    // 양식 토글 OFF)이면 적용 통로가 없다. regex.ts CRUD 와 같은 정직한 503 + status
    // pending 보존(적용 안 함 — 토글 켜고 재시도 가능). try 진입 전 단계에서 차단.
    if (
      proposal.kind === "regex_pattern_add" &&
      (!deps.regexUserRepo || !deps.regexL0)
    ) {
      return err(
        c,
        503,
        "regex 사용자 양식 토글 OFF (settings.extractor.regex.userPatternsEnabled=false) — 정규식 추가 제안 적용 불가",
      );
    }

    // 적용 — kind 별 분기. payload 양식이 어긋난 경우 store 가 구체 에러로 throw.
    try {
      if (proposal.kind === "metadata_fill") {
        // 갈래 2(맥락 추론 메타 전파)가 만든 제안. 빈 칸(place·event_at)에
        // 같은 세션의 다른 노드에서 추론한 값을 채운다. 수락/거절만 — 수정 X.
        // payload: { nodeId, field: "place"|"event_at", value, evidence? }
        // evidence 는 근거 표시용 자유 칸이라 적용 분기는 읽지 않는다.
        // 구조 검증(nodeId·value·field)은 위 validateProposalPayload 가 이미 통과시켰다 —
        // field 는 'place' 또는 'event_at' 로 확정. 아래는 적용 분기만 한다.
        const { nodeId, field, value } = proposal.payload as {
          nodeId: number;
          field: "place" | "event_at";
          value: string;
        };
        if (field === "place") {
          // 추론(inferred) place — setPlace 의 inferred 갈래는 concept(장소)→
          // concept(value) 위계만 만든다(1급 places 행은 안 만듦·거짓 엔티티 방지·C-1·
          // event_at 의 setEventAt(…,"inferred") 정합). 직접 입력(direct) 장소가 이미
          // 있으면 source-conflict 로 거부돼 wrote=false — 조용히 덮지 않고 이 라우트의
          // 기존 거부 양식(payload·field 어긋남 = 400 + status pending 보존)에 맞춰 400 으로
          // 정직하게 사유를 알린다(spec §5.1·silent 아님). 409 가 더 정밀하나 err 헬퍼가
          // 400/401/404/500/503 만 받아 기존 양식에 합류한다.
          const res = await deps.store.setPlace(nodeId, value, "inferred");
          if (!res.wrote) {
            return err(
              c,
              400,
              `place 추론 적용 skip — 이 글의 장소는 더 높은 출처(직접 입력)로 이미 채워져 있음 (nodeId=${nodeId})`,
            );
          }
        } else {
          // field 는 위 검증에서 'event_at' 로 확정(place 는 위 갈래).
          await deps.store.setEventAt(nodeId, value, "inferred");
        }
      } else if (proposal.kind === "person_link") {
        // 데이터 정리 AI 가 만든 사람 연결 제안. 사람 생성 권한은 없다.
        // payload: { nodeId, personId, confidence?, evidence?, candidateText? }
        // personId 는 반드시 기존 persons.person_id 여야 하고, 문자열 이름이나
        // 임의 id 는 승인 시점 서버 검증에서 거부한다.
        // 구조 검증(nodeId·personId)은 위 validateProposalPayload 가 이미 통과시켰다 —
        // 아래는 DB 존재 검증(node·person)·엣지 추가만 한다(이중 검증 — spec 6.2).
        const { nodeId, personId } = proposal.payload as {
          nodeId: number;
          personId: string;
        };
        const node = await deps.store.getNode(nodeId);
        if (!node) {
          return err(c, 404, `person_link 대상 node 없음 — nodeId=${nodeId}`);
        }
        const person = await deps.store.getPerson(personId);
        if (!person) {
          return err(
            c,
            404,
            `person_link 대상 person 없음 — personId=${personId}`,
          );
        }
        await deps.store.addNodePersonEdge(
          nodeId,
          personId,
          "mentions",
          "evolver",
          nodeId,
        );
      } else if (proposal.kind === "regex_pattern_add") {
        // 깊은 패스가 정규식 0매치 후보를 모아 추론한 새 양식. 승인 시 DB 갈래
        // (RegexUserRepo) 에 추가하고 추출기 캐시를 reload — 다음 입력부터 매치한다.
        // yaml 은 건드리지 않는다(외부 fork 파일 통로). 토글 OFF 는 위에서 503 차단.
        // payload: { pattern, score, category, polarity?, description? }
        // pattern·score(정수)·category(6-enum) 검증은 위 validateProposalPayload 가 이미
        // 통과시켰다(등록·승인 공유 규칙 — regex.ts parseScore/parseCategory 와 같은 기준).
        // polarity·description 은 선택 칸이라 여기서 방어 파싱만 한다.
        const { pattern, score, category, polarity, description } =
          proposal.payload as {
            pattern: string;
            score: number;
            category: RegexCategory;
            polarity?: string;
            description?: string;
          };
        // 토글 ON 게이트를 통과했으므로 둘 다 정의돼 있다(위 503 분기 보장).
        // addPattern 이 new RegExp 컴파일 검증 — 깨진 정규식은 구체 에러로 throw,
        // 본 try/catch 가 400 "적용 실패: ..." 로 노출(silent 저장 금지).
        deps.regexUserRepo!.addPattern({
          pattern,
          score,
          category,
          polarity:
            polarity === "positive" ||
            polarity === "negative" ||
            polarity === "neutral"
              ? polarity
              : undefined,
          description:
            typeof description === "string" ? description : undefined,
          lang: "ko",
          enabled: true,
        });
        // 같은 인스턴스 캐시 reload — regex.ts CRUD 와 같은 단일 권위 정신.
        deps.regexL0!.reload();
      } else if (proposal.kind === "lens_draft") {
        // 파괴형 kind — 항목별 결정 + 적용 시점 checksum + 적용 원장(spec 5-9).
        // 한 엔티티의 여러 칸을 한꺼번에 덮는 유일한 kind 라 되돌리기가 어렵다:
        // 사용자가 고른 항목만 적용하고, 적용 직전 대상이 바뀌었으면 전건 거부하며,
        // 적용된 항목은 원장에 남겨 중단 후 재시도가 두 번 적용하지 않게 한다.
        const result = await applyProposalItems(deps, repo, {
          proposalId: id,
          payload: proposal.payload,
          ...(selectedItemKeys ? { selectedItemKeys } : {}),
        });

        const nextStatus = judgeProposalStatus(result);
        repo.updateStatus(id, nextStatus);

        // 적용 0 = 400 으로 사유를 드러낸다(조용한 성공 위장 금지). 부분 적용은 200 —
        // 적용된 항목이 실제로 있으므로 성공 회신에 항목별 결과를 실어 보낸다.
        if (result.appliedCount === 0 && nextStatus === "needs_revision") {
          return c.json(
            {
              // 사유를 갈래별로 구분한다(빈 초안 / 대상 변경 / 미선택 / 전건 실패) —
              // 같은 needs_revision 이라도 사용자가 할 일이 다르다.
              error: describeZeroApplyReason(result),
              status: nextStatus,
              items: result.outcomes,
            },
            400,
          );
        }

        return c.json({
          approved: id,
          status: nextStatus,
          appliedCount: result.appliedCount,
          items: result.outcomes,
        });
      }
    } catch (e) {
      if (e instanceof LensApplyError) return err(c, 400, `적용 실패: ${e.message}`);
      return err(c, 400, `적용 실패: ${(e as Error).message}`);
    }

    // 추가형 kind 적용 성공 — status='approved' + resolved_at 자동 갱신 (Repository 양식).
    // 파괴형(lens_draft)은 위 분기가 항목별 판정 상태로 이미 회신했으므로 여기 안 온다.
    repo.updateStatus(id, "approved");

    return c.json({ approved: id });
  });

  // ── POST /cleanup-proposals/:id/reject — status='rejected' ─────────────────
  //
  // 적용 함수 호출 안 함 — 사용자가 거절 한 묶음 = 데이터 변동 0. status 만 갱신.
  // 예외: entity_register 는 무시 기록을 남긴다(아래 분기).
  api.post("/cleanup-proposals/:id/reject", async (c) => {
    const id = c.req.param("id");
    const proposal = repo.findById(id);
    if (!proposal) {
      return err(c, 404, "proposal 없음 — id 확인");
    }

    if (proposal.status !== "pending") {
      return err(
        c,
        400,
        `이미 처리된 proposal — status: ${proposal.status}`,
      );
    }

    // entity_register 거절 = 모든 이름·일정을 무시 기록으로 남겨 다시 묻지 않는다(사용자 결정).
    if (proposal.kind === ENTITY_REGISTER_KIND) return rejectEntityRegisterRoute(c, deps, repo, proposal);

    repo.updateStatus(id, "rejected");
    return c.json({ rejected: id });
  });

  // ── POST /cleanup-proposals — 외부 제안 등록 (MCP spec 6.2) ────────────────
  // candidate 블록 필수(D-6 — 자유 등록 불허). 검증·트랜잭션 권위는
  // submitExternalProposal 한 곳 — MCP cleanup_submit_proposal 과 공유.
  api.post("/cleanup-proposals", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return err(c, 400, "invalid JSON body");
    }
    const outcome = await submitExternalProposal(deps, {
      kind: body.kind,
      payload: body.payload,
      candidate: body.candidate,
    });
    if (!outcome.ok) {
      if (outcome.httpStatus === 409) {
        return c.json(
          { error: outcome.message, current: outcome.current },
          409,
        );
      }
      return err(c, outcome.httpStatus, outcome.message);
    }
    // candidate 필수 확정(D-6)으로 ledgerRecorded 는 항상 true — false 갈래는 없다(spec 6.2).
    // entity_register 는 서버 판정 결과 제안 없이 자동 반영만 될 수 있다(proposalId null → status none).
    // regex_pattern_add 는 서버 하네스에서 탈락하면 제안 없이 탈락 사유를 싣는다(status rejected).
    return c.json(
      {
        proposalId: outcome.proposalId,
        status: outcome.rejected ? "rejected" : outcome.proposalId === null ? "none" : "pending",
        ledgerRecorded: true,
        ...(outcome.autoApplied !== undefined ? { autoApplied: outcome.autoApplied } : {}),
        ...(outcome.rejected ? { rejected: outcome.rejected } : {}),
      },
      201,
    );
  });

  app.route("/", api);
}
