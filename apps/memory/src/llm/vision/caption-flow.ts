/**
 * caption-flow.ts — Phase 11b T10.
 *
 * VLM 호출 흐름 + image_caption 자식 노드 추가. 부모 image_asset 노드 위에
 * `source_type='image_caption'` 자식 노드 한 줄 + `parent_of` 엣지 + bge-m3
 * 텍스트 임베딩(NodeRepository.addNode 자연 흐름) + images.has_caption_auto=1.
 *
 * 흐름 분기 (decideVlmInvocation):
 *  1. settings.enabled=false  → false (옵션 OFF — 호출 0)
 *  2. settings.provider=null  → false (provider 미지정 = OFF)
 *  3. settings.forceCall=true 또는 ctx.forceCall=true → true (강제 호출 / SigLIP 가동 무관)
 *  4. 강제 호출 아님 + SigLIP 임베딩 가용 → false (옵션 토큰 절약 — VLM skip)
 *  5. 강제 호출 아님 + SigLIP 임베딩 미가용 → true (자연 fallback — VLM 호출)
 *
 * ctx.forceCall = 호출별 강제 호출 override (백필 갈래용). 설정값 forceCall 과 OR
 * 결합 — 백필은 settings.forceCall=false 여도 임베딩 무관하게 캡션을 만든다.
 *
 * 호출 실패 흐름 ([[graceful-degradation-principle-2026-05-22]] 정합):
 *  - VisionProvider.captionImage 가 throw → console.warn 한 줄 + caption=null
 *    정직 회수. 자산 저장 흐름 차단 X — 호출자 (ingest 라우트) 는 본 흐름 회신
 *    자연 반영 (caption=null 응답 안 표현 가능). silent skip X — called=true 인
 *    데 caption=null 양식이 호출 자체는 시도했다는 정직한 신호.
 *  - 2026-10-14 — 실패 원인은 failure 칸에 실어 돌려준다(던지지 않는 동작은 그대로). 캡션 백필이 분류에 쓴다.
 *
 * 권위: docs/decisions/2026-05-28-phase11b-plan(...).md § Task 10.
 */

import type { Database } from "bun:sqlite";
import type { SqliteMemoryStore } from "../../db/store.ts";
import type { LlmVisionSlot } from "../../settings/memory-settings.ts";
import { LLM_PROVIDER_SPECS } from "../provider-registry.ts";
import type {
  VisionCaptionOptions,
  VisionProvider,
  VisionProviderSettings,
} from "./index.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 공개 — toVisionProviderSettings (LlmVisionSlot → VisionProviderSettings 양식 변환)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * settings.llm.vision (LlmVisionSlot — 공급자별 모델·키·주소 칸) 을 createVisionProvider 가 받는
 * VisionProviderSettings 양식(provider + 단일 model + endpoint + apiKey) 으로 변환.
 *
 * 공급자→칸 대응은 공급자 표(LLM_PROVIDER_SPECS) 한 곳을 읽는다 — 모델 칸, 키 칸(없으면 null),
 * 주소 칸(고정 주소 공급자는 null). 호출 한도(timeoutMs)는 모든 공급자에 넘긴다(Anthropic 은 SDK 자체
 * 타임아웃을 써서 이 칸을 쓰지 않는다).
 */
export function toVisionProviderSettings(
  slot: LlmVisionSlot,
): VisionProviderSettings {
  const spec = LLM_PROVIDER_SPECS[slot.provider];
  return {
    enabled: slot.enabled,
    provider: slot.provider,
    model: slot[spec.modelField],
    endpoint: spec.baseUrlField === null ? null : slot[spec.baseUrlField],
    apiKey: spec.apiKeyField === null ? null : slot[spec.apiKeyField],
    tokenCap: slot.tokenCap,
    forceCall: slot.forceCall,
    timeoutMs: slot.timeoutMs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 공개 — decideVlmInvocation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * VLM 호출 의지 결정. 4 분기 (위 docstring 단계 1~5).
 *
 * `hasEmbedding` = SigLIP image_vec 임베딩 가용 여부. 옛 T5 흐름 안 `embedding!==null`
 * 검사 시점 정합. true 면 그래도 token 절약 흐름 (옵션 forceCall=false 갈래).
 *
 * `ctx.forceCall` = 호출별 강제 호출 override. 백필 갈래가 임베딩 가용 여부와
 * 무관하게 캡션을 만들어야 할 때 전달한다(settings.forceCall=false 여도 강제).
 * settings.forceCall 과 OR 결합 — 둘 중 하나라도 true 면 호출. 단, enabled=false /
 * provider=null 가드가 그 앞에 있어 꺼져 있으면 forceCall override 여도 호출 안 함.
 */
export function decideVlmInvocation(
  settings: VisionProviderSettings,
  ctx: { hasEmbedding: boolean; forceCall?: boolean },
): boolean {
  if (settings.enabled === false) return false;
  if (settings.provider === null) return false;
  // 설정값 forceCall 또는 호출별 forceCall override 둘 중 하나라도 true 면 강제 호출.
  if (settings.forceCall === true || ctx.forceCall === true) return true;
  // forceCall=false 흐름 — SigLIP 임베딩 가용 시 token 절약 (skip).
  if (ctx.hasEmbedding === true) return false;
  // 임베딩 미가용 — 자연 fallback (호출).
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 공개 — applyVlmCaptionFlow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `applyVlmCaptionFlow` 인자. 가운데 호출자 (ingest-image 통로) 가 전부 주입.
 *
 * `provider` 는 옵셔널 — undefined 면 createVisionProvider 회수 null 자연 갈래
 * 정합 (decideVlmInvocation 가 false 회수해서 호출 자체 안 일어남 — 안전).
 */
export interface ApplyVlmCaptionFlowArgs {
  store: SqliteMemoryStore;
  db: Database;
  parentNodeId: number;
  assetSha256: string;
  imageBuffer: Buffer | Uint8Array;
  mimeType: string;
  visionSettings: VisionProviderSettings;
  provider: VisionProvider | null;
  /** SigLIP image_vec 임베딩 가용 여부 (옛 T5 흐름 안 embedding!==null 양식 정합). */
  hasEmbedding: boolean;
  /**
   * 백필 갈래가 임베딩 무관 강제 호출용. 미지정이면 settings.forceCall 따름.
   * decideVlmInvocation 의 ctx.forceCall 로 그대로 전달 — true 면 hasEmbedding 가
   * true 여도 호출(token 절약 skip 안 함). ingest 즉시 캡션 통로는 이 칸을 안 넘겨
   * 기존 token 절약 동작 보존.
   */
  forceCall?: boolean;
  /**
   * 캡션 프롬프트 글 (settings.llm.vision.captionPrompt 통로). 비었거나 미지정이면
   * 개정된 DEFAULT_CAPTION_PROMPT 사용 (Phase 11e G2-4 / spec §10.5). 사용자가
   * 보관소 성격에 맞춰 settings 에서 조정 가능 — 빈 값은 "조정 안 함" = default 의미.
   */
  prompt?: string;
  /** captionImage 호출 옵션 (signal 등). */
  options?: VisionCaptionOptions;
}

/**
 * `applyVlmCaptionFlow` 회수 양식.
 *
 * - `called` — VLM 호출 시도 여부. decideVlmInvocation=false 면 false.
 * - `caption` — 호출 OK 시 회수 글 / 호출 실패 시 null 정직 회수 / called=false 면 undefined.
 * - `captionNodeId` — image_caption 자식 노드 id (호출 OK 한정).
 */
export interface ApplyVlmCaptionFlowResult {
  called: boolean;
  caption?: string | null;
  captionNodeId?: number;
  /**
   * called=true + caption=null 일 때 그 원인 — 잡은 예외 그대로, 빈 캡션이면 EmptyCaptionError (2026-10-14 spec 4.6).
   * 캡션 백필이 실패 분류에 쓴다. 새 이미지 저장 경로(ingest-image-flow)는 읽지 않고 응답에도 싣지 않는다.
   */
  failure?: unknown;
}

/**
 * 캡션 프롬프트 default (Phase 11e G2-4 / spec §10.5 D5 검색용 개정).
 *
 * 이미지를 분석해 눈에 보이는 것만 — 인물(성별·머리색·옷차림·표정), 사물, 배경,
 * 분위기, 그림체 — 를 한국어 명사 위주 2~3문장으로 묘사하게 한다. 추측·해석·상상을
 * 금지해 환각을 줄여 캡션의 검색 신뢰도를 높인다. 사용자가 불릿 형식으로 지정한 원문.
 *
 * 사용자가 settings.llm.vision.captionPrompt 에 직접 글을 적으면 그 글이 우선
 * (보관소 성격이 만화·일러스트인지에 따라 조정 가능). 빈 값이면 이 default 사용.
 */
export const DEFAULT_CAPTION_PROMPT =
  "- 이미지를 분석하여 보이는 것을 한글로 설명해라\n" +
  "- 인물(성별·머리색·옷차림·표정), 사물, 배경, 분위기, 그림체를 명사 위주로 2~3문장\n" +
  "- 추측, 해석, 상상 금지";

/**
 * 캡션 프롬프트 우선순위 결정 — settings 글이 비어있지 않으면 그 글, 아니면 default.
 *
 * `??` 한 줄로는 빈 문자열("")이 그대로 통과해 VLM 에 빈 프롬프트가 넘어간다.
 * settings 칸 미설정(= 빈 문자열) 흐름을 default 로 강등하려면 trim 후 길이 검사가
 * 필요하다. 이 함수가 그 한 갈래를 순수 로직으로 분리 — 데이터 fixture 단위 검증 대상.
 */
export function resolveCaptionPrompt(prompt?: string): string {
  if (typeof prompt === "string" && prompt.trim().length > 0) {
    return prompt;
  }
  return DEFAULT_CAPTION_PROMPT;
}

/**
 * VLM 호출 흐름 한 단계 (POST /ingest image 분기 + 옛 ingestImage 직후 호출 단계).
 * requestVlmCaption(판정 + 공급자 호출, DB 쓰기 없음)과 storeVlmCaption(쓰기)의 합성이다.
 * 비전 백필은 두 단계를 나눠 VLM 호출을 쓰기 잠금 밖에서 한다(WP-B1-07).
 *
 * 단계:
 *  1. decideVlmInvocation 검사 — false 면 즉시 `{ called: false }` 회수.
 *  2. provider=null 인데 decision=true 면 createVisionProvider 단계 안 양식 불일치 —
 *     console.warn + `{ called: false }` 정직 회수 (호출자 무한 흐름 차단).
 *  3. provider.captionImage 호출 — 회수 OK 면 store.addImageCaption 흐름 합류.
 *  4. 호출 실패 (throw) → console.warn 한 줄 + `{ called: true, caption: null }` 회수.
 */
export async function applyVlmCaptionFlow(
  args: ApplyVlmCaptionFlowArgs,
): Promise<ApplyVlmCaptionFlowResult> {
  const request = await requestVlmCaption(args);
  return storeVlmCaption(args, request);
}

/** requestVlmCaption 인자 — 저장에만 쓰는 store·db 를 뺀 applyVlmCaptionFlow 인자. */
export type RequestVlmCaptionArgs = Omit<ApplyVlmCaptionFlowArgs, "store" | "db">;

/**
 * `requestVlmCaption` 회수 양식 — 저장 전 단계라 captionNodeId 가 없다. caption=null 이면 failure 가 반드시 있다
 * (형이 강제한다 — 원인 없는 실패를 만들 수 없다).
 */
export type VlmCaptionRequest =
  | { called: false }
  | { called: true; caption: string }
  | { called: true; caption: null; failure: unknown };

/** 공급자가 빈 캡션을 돌려줌 — 같은 입력이면 다시 해도 같을 가능성이 커 백필은 세는 실패로 본다. */
export class EmptyCaptionError extends Error {
  constructor(parentNodeId: number) {
    super(`VLM 이 빈 캡션을 돌려줌 (parentNodeId=${parentNodeId})`);
    this.name = "EmptyCaptionError";
  }
}

/**
 * 캡션 요청 — 호출 판정(decideVlmInvocation)과 공급자 호출까지만 한다. DB 에 쓰지 않는다.
 * 위 단계 1·2·4 와 3 의 공급자 호출.
 */
export async function requestVlmCaption(
  args: RequestVlmCaptionArgs,
): Promise<VlmCaptionRequest> {
  const decision = decideVlmInvocation(args.visionSettings, {
    hasEmbedding: args.hasEmbedding,
    forceCall: args.forceCall,
  });
  if (!decision) {
    return { called: false };
  }

  if (args.provider === null) {
    // decideVlmInvocation 가 true 회수했는데 provider 가 null 이면 settings 양식이
    // 어긋난 흐름 (createVisionProvider 안 throw 가족이 호출 직전에 잡았어야 함).
    // 이 단계에서는 silent fallback 금지 정합 — console.warn 한 줄 + 정직 회수.
    console.warn(
      `[caption-flow] decideVlmInvocation=true 인데 provider=null — settings.llm.vision 양식 검토 필요 (parentNodeId=${args.parentNodeId})`,
    );
    return { called: false };
  }

  try {
    const callOptions: VisionCaptionOptions = {
      maxTokens: args.visionSettings.tokenCap,
      temperature: 0.3,
      ...(args.options ?? {}),
    };
    const response = await args.provider.captionImage(
      args.imageBuffer,
      args.mimeType,
      resolveCaptionPrompt(args.prompt),
      callOptions,
    );
    const caption = response.caption.trim();
    if (response.stopReason === "max_tokens" && caption.length > 0) {
      // 사용자 결정(Q6) — 잘린 캡션도 앞부분이 검색에 쓸모 있어 저장하되, 한도를 올리라고 알린다.
      console.warn(
        `[vision] 캡션이 출력 한도(tokenCap=${callOptions.maxTokens})에서 잘림 — llm.vision.tokenCap 을 올려라 (parentNodeId=${args.parentNodeId})`,
      );
    }
    if (caption.length === 0) {
      console.warn(
        `[caption-flow] provider 회수 caption 글 빈 문자열 — 노드 추가 건너뜀 (parentNodeId=${args.parentNodeId})`,
      );
      return { called: true, caption: null, failure: new EmptyCaptionError(args.parentNodeId) };
    }
    return { called: true, caption };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[caption-flow] VisionProvider.captionImage 가동 실패 — 자산 흐름 차단 X (parentNodeId=${args.parentNodeId}, asset_sha256=${args.assetSha256}, err=${msg})`,
    );
    return { called: true, caption: null, failure: e };
  }
}

/**
 * 캡션 저장 — 요청이 캡션을 받았을 때만 image_caption 자식 노드 + parent_of 엣지 +
 * has_caption_auto=1 을 store facade 한 호출로 쓴다. 받지 못한 요청은 그대로 돌려준다.
 */
export async function storeVlmCaption(
  args: { store: SqliteMemoryStore; parentNodeId: number; assetSha256: string },
  request: VlmCaptionRequest,
): Promise<ApplyVlmCaptionFlowResult> {
  if (!request.called || typeof request.caption !== "string") return request;
  const captionNodeId = await args.store.addImageCaption({
    parentNodeId: args.parentNodeId,
    assetSha256: args.assetSha256,
    caption: request.caption,
    captionRole: "auto",
  });
  return { called: true, caption: request.caption, captionNodeId };
}
