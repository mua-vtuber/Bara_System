/**
 * routes/document-record-messages.ts — 자기 노드가 아닌 곳에 놓인 문서 기록(document-record-placement.ts 의 absorbed·
 * legacy_merged)을 사람에게 알리는 문구의 단일 출처. 상태 조회(/api/documents/:id/status)·글자 인식 결과 붙이기·서버에서
 * 다시 읽기가 같은 문구를 쓴다.
 *
 * "삭제되었거나 휴지통" 으로 보이면 사용자가 멀쩡한 문서를 잃었다고 오해하므로 따로 알린다. 같은 파일로 합쳐진 기록은
 * 주인 문서의 실제 상태(결과가 있는지·대기 중인지·실패했는지)를 그대로 말한다 — 결과가 없는데 "함께 쓴다" 고 하지 않는다.
 */

import type { NotOwnedPlacement } from "../../db/store-internal/document-repository.ts";
import type { DocumentParseStatus } from "../../memory/document-parse-status.ts";

type AbsorbedPlacement = Extract<NotOwnedPlacement, { kind: "absorbed" }>;
type LegacyMergedPlacement = Extract<NotOwnedPlacement, { kind: "legacy_merged" }>;

/** 주인 문서의 상태별로 "결과를 함께 쓰는지" 를 말하는 꼬리. */
function ownerResultClause(status: DocumentParseStatus | null): string {
  switch (status) {
    case "text_succeeded":
    case "ocr_succeeded":
      return "그 문서의 결과를 함께 씁니다";
    case "needs_ocr":
      return "그 문서가 글자 인식을 마치면 그 결과를 함께 씁니다(아직 결과 없음)";
    case "ocr_failed":
      return "그 문서의 글자 인식이 실패해 아직 함께 쓸 결과가 없습니다 — 그 문서에서 다시 읽으세요";
    case "parse_failed":
      return "그 문서도 읽지 못해 아직 함께 쓸 결과가 없습니다 — 그 문서에 글자 인식 결과를 붙이세요";
    case "password_required":
      return "그 문서가 암호로 잠겨 아직 함께 쓸 결과가 없습니다 — 암호를 푼 파일로 다시 올리세요";
    case null:
      return "그 문서의 상태를 확인할 수 없어 함께 쓸 결과가 있는지 알 수 없습니다";
  }
}

/** 같은 파일·같은 내용으로 합쳐진 기록의 상태 문장. */
function absorbedNotice(placement: AbsorbedPlacement): string {
  const trash = placement.ownerInTrash ? " (그 노드는 지금 휴지통에 있음)" : "";
  if (placement.recordStatus === null) {
    // 상태 칸이 없는 옛 기록 — 같은 내용으로 합쳐졌다는 것만 안다. 결과를 함께 쓴다고도, 읽힌 적 없다고도 하지 않는다.
    const into = placement.ownerDocumentId !== null
      ? `다른 문서(${placement.ownerDocumentId}, 노드 ${placement.ownerNodeId})`
      : `기억(노드 ${placement.ownerNodeId})`;
    return `이 기록은 같은 내용의 ${into}에 합쳐져 있습니다. 예전 버전에서 저장돼 처리 상태가 기록되지 않았습니다 — 내용은 그 노드에서 보세요${trash}`;
  }
  if (placement.ownerDocumentId !== null) {
    return `같은 파일이 이미 다른 문서(${placement.ownerDocumentId}, 노드 ${placement.ownerNodeId})로 저장돼 있어, ${ownerResultClause(placement.ownerParseStatus)}${trash}`;
  }
  return `같은 내용의 기억(노드 ${placement.ownerNodeId})에 합쳐져, 이 기록은 그 기억을 함께 씁니다${trash}`;
}

/** 옛 버전이 잘못 합친 기록의 상태 문장 — 무엇이 잘못됐고 어떻게 되돌리는지. */
function legacyMergedNotice(placement: LegacyMergedPlacement): string {
  const trash = placement.ownerInTrash ? " (그 노드는 지금 휴지통에 있음)" : "";
  const what = placement.ownerDocumentId !== null
    ? `예전 버전이 이름만 같은 이 기록을 다른 문서(${placement.ownerDocumentId}, 노드 ${placement.ownerNodeId})에 잘못 합쳐 두었습니다${trash}.`
    : `예전 버전이 이 기록을 글이 파일 이름과 같은 기억(노드 ${placement.ownerNodeId})에 잘못 합쳐 두었습니다${trash}.`;
  return `${what} 이 파일 자신의 내용은 읽힌 적이 없습니다 — 같은 파일을 다시 올리면 따로 저장되어 글자 인식을 받을 수 있습니다`;
}

/** 자기 노드가 아닌 곳에 놓인 기록의 상태 문장. */
export function notOwnedRecordNotice(placement: NotOwnedPlacement): string {
  return placement.kind === "absorbed" ? absorbedNotice(placement) : legacyMergedNotice(placement);
}

/** 이런 기록에 글자 인식을 하려 할 때의 거절 사유 — 어디서 무엇을 하면 되는지 알린다. */
export function notOwnedRecordOcrRefusal(placement: NotOwnedPlacement): string {
  if (placement.kind === "legacy_merged") {
    return `${legacyMergedNotice(placement)} — 이 기록에는 글자 인식 결과를 붙일 문서 노드가 없습니다`;
  }
  const target = placement.ownerDocumentId !== null
    ? `글자 인식은 그 문서(${placement.ownerDocumentId})에 하세요`
    : "이 기록에는 글자 인식 결과를 붙일 문서 노드가 없습니다";
  return `${absorbedNotice(placement)} — ${target}`;
}
