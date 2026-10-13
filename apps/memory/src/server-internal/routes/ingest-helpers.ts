/**
 * routes/ingest-helpers.ts — POST /ingest 공용 타입·판별 헬퍼.
 *
 * routes/ingest.ts 를 책임 경계로 분할하며 옮겨 온 모듈이다(P3 G5-a —
 * docs/decisions/2026-07-03-structure-cleanup-spec.md). 요청 body 타입, 확장자
 * 화이트리스트(Path Traversal 방지), document type 자동 감지, 종류별 칸 키 집합,
 * binary 입력 판별과 세 분기(이미지·텍스트·문서)가 공유하는 파싱 결과 타입을 담는다.
 * 분기 흐름은 ingest-image-flow.ts / ingest-text-flow.ts / ingest-document-flow.ts,
 * 파싱·분기 선택은 ingest.ts 파사드가 진다.
 */

import type { AssetStore } from "../../assets/asset-store.ts";
import { columnLabelKeysOf } from "../../db/store-internal/entity-type-registry.ts";
import {
  getTypeColumns,
  isPlacementType,
  type PlacementTypeName,
} from "../../memory/concept-type-vocabulary.ts";
import { normalizeProjectId } from "../../memory/project-scope.ts";
import { messageSourceInputProblem, normalizePlatform, type InputSourceMessage } from "../../memory/node-sources/source-ref.ts";
import type { Capture } from "./capture.ts";

// ── 요청 body 타입 ────────────────────────────────────────────────────────────

export interface IngestRequestBody {
  /** Optional dashboard submission identity, used only for result reconciliation. */
  requestId?: unknown;
  capture?: unknown;
  source?: unknown;
  content?: {
    type?: unknown;
    data?: unknown;
    mimeType?: unknown;
    originalName?: unknown;
  };
  attribution?: { author?: unknown; userId?: unknown };
  classification?: unknown;
  hashtags?: unknown;
  projectId?: unknown;
  project?: unknown;
  options?: unknown;
  // 단계6 T3b — 종류별 동적 폼. kind=선택 종류(typeName 또는 koName), fields=동적 칸
  // 위젯 값, eventAt/eventUntil=일정 날짜. 순수 타이핑 글 분기에서만 처리(파일·이미지 무관).
  // 미전달이면 기존 ingest 동작 그대로(종류 분류 0·글-칸 0·날짜 0).
  kind?: unknown;
  fields?: unknown;
  eventAt?: unknown;
  eventUntil?: unknown;
  /**
   * WP-B1-20U 설계 17.8 — 이 입력을 보낸 외부 메시지(봇 첨부: 플랫폼·메시지 id·채널·서버·첨부 id). 있으면 세
   * 갈래 모두 그 메시지의 출처 행을 남겨 메시지 삭제가 노드를 찾는다. 모양은 parseSourceMessage 가 검사한다.
   */
  sourceMessage?: unknown;
}

/**
 * 파사드(ingest.ts)의 입력 파싱 단계가 만든 검증 완료 값 묶음 — 세 분기 흐름이
 * 같은 양식으로 받는다. assetStore 는 파사드의 503 가드 통과 후 그 요청 시점
 * lookup 값이다(부팅 시점 고정 아님 — 구조분해 금지 규율과 동일 의미).
 */
export interface IngestParsedInput {
  body: IngestRequestBody;
  /** content.data — 검증 완료 non-empty string. */
  data: string;
  source: string;
  contentType: string;
  mimeType: string;
  originalName: string;
  author: string;
  userId: string;
  projectId: ReturnType<typeof normalizeProjectId>;
  classification: Record<string, string> | undefined;
  capture: Capture | null | undefined;
  hashtags: string[];
  originalBytes: Uint8Array;
  ext: string;
  assetStore: AssetStore;
  /**
   * 파일/이미지를 사용자가 함께 작성한 글 노드 아래에 붙일 때 쓰는 부모 노드 id.
   * 현재 대시보드는 "글 + 첨부" 입력에서 글을 먼저 저장하고, 첨부 payload 의
   * options.attachToNodeId 로 그 원본 노드 id 를 보낸다.
   */
  attachToNodeId: number | null;
  /** 검사를 통과한 sourceMessage(플랫폼 정규화·id trim). 요청에 없으면 null. */
  sourceMessage: InputSourceMessage | null;
}

// ── sourceMessage 검사 (WP-B1-20U 설계 17.8) ─────────────────────────────────

export type ParsedSourceMessage = { ok: true; value: InputSourceMessage | null } | { ok: false; error: string };

/** 비지 않은 문자열(앞뒤 공백 제거 뒤)이면 그 값, 아니면 null. */
function nonEmptyTrimmed(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * POST /ingest 의 sourceMessage 모양 검사. 없으면 null, 틀리면 어느 칸이 틀렸는지 적은 오류(400 문구), 맞으면
 * 플랫폼을 소문자·trim 으로, messageId·attachmentId 를 trim 으로 정규화한 값. messageId 는 DELETE·PATCH by-source 와
 * 같이 trim 한 값으로 저장해야 그 조회가 행을 찾는다. channelId·guildId 는 표시 칸이라 문자열·null 만 받고 그대로 둔다.
 */
export function parseSourceMessage(raw: unknown): ParsedSourceMessage {
  if (raw === undefined) return { ok: true, value: null };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "sourceMessage must be an object" };
  }
  const record = raw as Record<string, unknown>;
  const platform = normalizePlatform(record.platform);
  if (platform === null) return { ok: false, error: "sourceMessage.platform must be a non-empty string" };
  const messageId = nonEmptyTrimmed(record.messageId);
  if (messageId === null) return { ok: false, error: "sourceMessage.messageId must be a non-empty string" };
  const value: InputSourceMessage = { platform, messageId };
  for (const key of ["channelId", "guildId"] as const) {
    const id = record[key];
    if (id === undefined) continue;
    if (id !== null && typeof id !== "string") {
      return { ok: false, error: `sourceMessage.${key} must be a string or null` };
    }
    value[key] = id;
  }
  if (record.attachmentId !== undefined) {
    const attachmentId = nonEmptyTrimmed(record.attachmentId);
    if (attachmentId === null) return { ok: false, error: "sourceMessage.attachmentId must be a non-empty string" };
    value.attachmentId = attachmentId;
  }
  // 출처 키 구분자(설계 17.18 설계 7) — messageId·attachmentId·platform 의 `:` 는 다른 (메시지, 첨부) 쌍의 키와 섞인다.
  const delimiterProblem = messageSourceInputProblem({ sourceMessage: value });
  if (delimiterProblem !== null) return { ok: false, error: delimiterProblem };
  return { ok: true, value };
}

// ── 내부 유틸 ─────────────────────────────────────────────────────────────────

/**
 * 안전한 파일 확장자 화이트리스트 패턴 — 영숫자만, 1~8자.
 *
 * 보안 — Path Traversal 방지(2026-07-02). originalName 은 사용자가 보낸 임의 문자열이라
 * `/`·`\`·`..`·`:` 등 경로 조작 문자가 섞여 들어올 수 있다. 이 패턴을 통과하지 못하는
 * 확장자는 아래 originalExt 에서 절대 그대로 반환하지 않고 mimeType 기반 fallback으로
 * 강등한다 — asset-store.ts 의 path()/write() 가 이 값을 그대로 join() 에 넣어 파일
 * 경로를 만들기 때문에, 여기서 걸러지지 않으면 지정 폴더 밖에 파일을 쓰는 임의 파일
 * 쓰기로 이어진다.
 */
const SAFE_EXT_PATTERN = /^[a-z0-9]{1,8}$/;

/**
 * mime / originalName 확장자에서 원본 파일 확장자를 뽑는다.
 * canonical 은 항상 "md".
 *
 * 보안 — Path Traversal 방지(2026-07-02). originalName.slice(dot+1) 로 뽑은 원시
 * 확장자를 SAFE_EXT_PATTERN 화이트리스트로 검증한 뒤에만 반환한다. `x.tar.gz` 같은
 * 정상 다중 확장자는 lastIndexOf(".") 가 마지막 조각("gz")만 취하므로 그대로 통과한다.
 * `x.../../../../evil`·`evil\..\..\config`·`file.C:\Windows\system32` 처럼 `/`·`\`·`..`·
 * `:`·`.` 등이 섞인 원시 확장자는 화이트리스트를 통과 못 해 mimeType 기반 fallback
 * (pdf/docx) 또는 최종 "md" 로 강등된다 — 오염된 값을 절대 그대로 통과시키지 않는다.
 */
export function originalExt(mimeType: string, originalName: string): string {
  const dot = originalName.lastIndexOf(".");
  if (dot !== -1) {
    const raw = originalName.slice(dot + 1).toLowerCase();
    if (SAFE_EXT_PATTERN.test(raw)) return raw;
    // 화이트리스트 불통과 — 안전하지 않은 원본 확장자를 그대로 쓰지 않고 강등한다.
  }
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.includes("wordprocessingml")) return "docx";
  return "md";
}

/**
 * 자동 document type 감지 (spec 5.10).
 * 명시 classification.document_type 이 있으면 그대로 반환.
 * 없으면 markdown 첫 200글자를 패턴 매칭:
 *   - [Scene / ## / === → scenario
 *   - 회의 일시: / 참석자: → meeting_log
 *   - 그 외 → free
 */
export function detectDocumentType(
  markdown: string | null,
  classification: Record<string, string> | undefined,
): string {
  const explicit = classification?.document_type;
  if (explicit) return explicit;
  const head = (markdown ?? "").slice(0, 200);
  if (/\[Scene[\s\n]|^##\s|===/.test(head)) return "scenario";
  if (/회의\s*일시:|참석자:/.test(head)) return "meeting_log";
  return "free";
}

/** ISO 날짜(YYYY-MM-DD) 한 갈래 — eventAt/eventUntil 검증용(시각 미포함 날짜). */
export const ISO_DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 단계6 T3b — 이 종류의 칸 키 집합(글-칸으로 받을 키). 두 출처를 합친다:
 *   · getTypeColumns — 새 종류 columns slot(분류 단계3 T8). 등록된 배치 타입에만 안전 —
 *     isPlacementType 가 false 면 vocabOf 가 throw 하므로 가드 뒤에서만 호출한다.
 *   · columnLabelKeysOf — 코드 8 타입 columnLabels 키(intake 유통기한 등).
 *
 * 미등록 kind(koName '가계부'·'일정' 등 typeName 이 아닌 값)는 둘 다 빈 집합 — 그 종류에
 * 칸이 0개라는 정직한 사실이다(throw 가 아닌 빈 칸 집합으로 graceful). 칸이 0이면
 * collectGlobFields 가 어떤 글-칸도 안 만들어, 그 입력은 분류만 되고 글-칸 0으로 떨어진다.
 */
export function kindColumnKeys(kindName: string): Set<string> {
  const keys = new Set<string>(columnLabelKeysOf(kindName));
  if (isPlacementType(kindName)) {
    for (const k of getTypeColumns(kindName as PlacementTypeName)) keys.add(k);
  }
  return keys;
}

/**
 * mimeType 또는 content.type 으로 binary 입력(base64) 여부 판단.
 * PDF / docx 는 base64 로 전달한다.
 */
export function isBinaryContent(mimeType: string, contentType: string): boolean {
  return (
    mimeType === "application/pdf" ||
    mimeType.includes("wordprocessingml") ||
    // 실제 형식(mimeType)이 이미지/오디오면 base64 디코드 — 클라이언트의 content.type
    // 라벨(대시보드는 "auto", 봇은 "image")에 의존하지 않는다. 대시보드 드래그앤드롭이
    // 이미지를 type="auto" + image mimeType 으로 보내면 옛 조건(contentType==="image")이
    // 안 걸려 base64 가 텍스트로 인코딩되던 버그(버퍼가 "/9j/..." = 0x2f 0x39) 차단.
    mimeType.startsWith("image/") ||
    mimeType.startsWith("audio/") ||
    contentType === "image" ||
    contentType === "audio"
  );
}
