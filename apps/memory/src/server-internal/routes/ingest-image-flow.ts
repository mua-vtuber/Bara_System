/**
 * routes/ingest-image-flow.ts — POST /ingest 이미지 mime 분기 (Phase 11a T5).
 *
 * routes/ingest.ts 를 책임 경계로 분할하며 옮겨 온 모듈이다(P3 G5-a —
 * docs/decisions/2026-07-03-structure-cleanup-spec.md). 이미지는 텍스트 추출이 없는
 * 별 갈래 — canonical .md 흐름·documents·chunk 를 건너뛰고 ingestImage 통로로 보낸다.
 * 응답 양식도 분기 — images 응답 객체 하나. imageEmbedder 미주입 = 503 (정직한
 * 비활성 — silent no-op 금지). 분기 선택(isImageMime)은 ingest.ts 파사드가 진다.
 */

import type { Context } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { err } from "../http-helpers.ts";
import { EVENT_TYPES } from "../event-bus.ts";
import { ingestImage } from "../../memory/ingest-image.ts";
import { linkImageToConceptsBySiglip } from "../../memory/image-concept-link.ts";
import {
  applyVlmCaptionFlow,
  toVisionProviderSettings,
} from "../../llm/vision/caption-flow.ts";
import { createVisionProvider } from "../../llm/vision/index.ts";
import type { IngestParsedInput } from "./ingest-helpers.ts";
import { wireFileHashtagsToNodes } from "./ingest-file-tags.ts";

export async function handleImageIngest(
  c: Context,
  deps: MemoryApiDeps,
  store: MemoryApiDeps["store"],
  input: IngestParsedInput,
) {
  const { mimeType, originalName, author, userId, projectId, source, hashtags, originalBytes, attachToNodeId, capture } =
    input;

  if (!deps.imageEmbedder) {
    return err(
      c,
      503,
      "image embedder not configured (createImageEmbedder 미주입) — 이미지 입력 비활성",
    );
  }
  const settingsForImage = deps.getSettings?.();
  try {
    const imageResult = await ingestImage(
      {
        db: store.getRawDb(),
        assetStore: input.assetStore,
        imageEmbedder: deps.imageEmbedder,
        preserveSettings: settingsForImage?.images,
      },
      {
        buffer: Buffer.from(originalBytes),
        mime: mimeType,
        originalName: originalName || undefined,
        author,
        platform: source,
        source,
        userId,
        projectId,
        capture,
        // WP-B1-20U 설계 17.8 — 외부 메시지의 첨부면 이미지 노드가 그 메시지의 출처 행(첨부 키)을 받는다.
        sourceMessage: input.sourceMessage,
      },
    );
    // 콜론 분류(`#category:value`) 위계 처리는 아래 wireEntityPlacementSafe 단일 출처가
    // 텍스트 입력과 똑같이 진다(C3 수정) — 옛 손수 addClassificationTag 루프를 뺐다.
    //
    // 옛 코드는 parseClassificationTags 가 돌려준 *정규화된* category(작품→series 변환)를
    // 그대로 addClassificationTag 에 넣어, 같은 `#작품:데못죽` 태그가 텍스트(work 엔티티 행)
    // 와 이미지(series → 데못죽 엉뚱한 분류 위계)로 갈렸다. wireEntityPlacement 는
    // rawCategory(정규화 전 원본 '작품')로 처리하고 타입 표지 콜론은 work/project/person
    // 엔티티 행으로, 비-타입표지 콜론(#character:· #style:)은 rawCategory 위계로 보내
    // 텍스트 경로와 같은 결과를 낸다. 그래서 손수 콜론 분류 루프를 제거하고 위계 생성을
    // wireEntityPlacementSafe 한 곳에 맡긴다(이중 생성·통로별 갈림 차단).
    // ── 파일 해시태그 wiring — 평면 태그 + 콜론 분류/엔티티 ───────────────
    // 대시보드는 `#고양이` 를 hashtags 배열에 `"고양이"` 로 보낸다. 공용 helper 가
    // `#` 유무를 정규화한 뒤, 평면 태그(role='tag')와 콜론 분류/엔티티 wiring 을
    // 같은 규칙으로 적용한다. 설정 게이트(autoConceptLink/vision)와 무관하게 항상 잇는다.
    await wireFileHashtagsToNodes(
      store,
      [imageResult.nodeId],
      hashtags,
      deps.autoCleanupTrigger,
      "POST /ingest image",
    );

    let attachedToNodeId: number | null = null;
    if (attachToNodeId !== null && attachToNodeId !== imageResult.nodeId) {
      const parentNode = await store.getNode(attachToNodeId);
      if (parentNode) {
        await store.addEdge({
          sourceId: imageResult.nodeId,
          targetId: attachToNodeId,
          relation: "parent_of",
          provenance: "user_input",
          sourceNodeId: imageResult.nodeId,
          weight: 1,
        });
        attachedToNodeId = attachToNodeId;
      } else {
        console.warn(
          `[ingest] 이미지 첨부 부모 노드 없음 — parent_of 연결 건너뜀 ` +
            `(image_node_id=${imageResult.nodeId}, attach_to_node_id=${attachToNodeId})`,
        );
      }
    }

    // ── 이미지 검색 토대 T5 (b-B3) — SigLIP 자동 개념 연결 ────────────────
    // 이미지의 SigLIP 임베딩과 기존 개념의 SigLIP 임베딩을 cosine 비교해, 닮음이
    // threshold 이상인 *기존* 개념에 role='visual' 엣지를 잇는다(없으면 0, 새
    // 개념 생성 0 — 사용자 확정 U3). 평면 태그 연결 옆에서 같은 이미지 노드에
    // 합류시켜, 손 태그가 없어도 이미지가 연결검색에 끼게 한다(spec §8.5 갭 해소).
    //
    // best-effort — 이미지 자산 저장은 이미 끝났다(imageResult 회신 가능). 자동
    // 연결이 실패해도(임베딩 호출 예외 등) 그 성공을 깨면 안 되므로, 구체 사유 +
    // node_id 로 warn 후 계속한다(detectAndSaveAliasSuggestions best-effort 양식
    // 정합 — silent fallback 아님, 가짜 엣지 0). enabled=false 면 호출 자체를 건너뛴다.
    const autoLink = settingsForImage?.images?.autoConceptLink;
    const hasExplicitHashtags = hashtags.length > 0;
    if (autoLink?.enabled) {
      if (hasExplicitHashtags) {
        console.info(
          `[ingest] 명시 해시태그가 있는 이미지 — SigLIP visual 자동 개념 연결 건너뜀 ` +
            `(node_id=${imageResult.nodeId})`,
        );
      } else {
        try {
          await linkImageToConceptsBySiglip({
            db: store.getRawDb(),
            nodeId: imageResult.nodeId,
            threshold: autoLink.threshold,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(
            `[ingest] SigLIP 자동 개념 연결 실패 — 이미지 저장은 보존, 자동 연결만 건너뜀 ` +
              `(node_id=${imageResult.nodeId}, 사유: ${msg})`,
          );
        }
      }
    }
    // ── Phase 11b T10 — VLM 자동 캡션 흐름 합류 ───────────────────────────
    // decideVlmInvocation 4 분기 — settings.llm.vision.enabled / forceCall + SigLIP
    // image_vec 임베딩 가용 여부에 따라 호출 의지 결정. 자산 저장 흐름은 이미
    // 마감 상태 — VLM 호출 실패해도 자산·imageResult 회신은 자연 보존. graceful
    // degrade ([[graceful-degradation-principle-2026-05-22]]) 정합.
    //
    // hasEmbedding — image_asset 노드 vec0 합류 여부. images.warnings_json 안
    // 'siglip-skip' 가족 신호가 없으면 imageEmbedder.embedImage 가 Float32Array
    // 회수했다고 간주 (옛 T5 흐름 정합). 보수 양식 — warnings 자체가 빈 배열인
    // 자연 갈래 = 임베딩 가용.
    //
    // 동작 방식(mode) 갈래 — 동작 방식·주기는 의미추출 AI 수준 공통이라 권위 =
    // extractor 슬롯(extractor-vision-unified-clock-scheduler 결정 3·5 / 옛 Phase
    // 11e G2-1 주석을 통합 기준으로 갱신). extractor.mode='immediate' + vision.enabled
    // 일 때만 업로드 통로에서 동기 캡션 호출(켜기 토글은 vision 슬롯 — 이미지 캡션
    // default OFF). extractor.mode='backfill' 이면 업로드는 캡션을 건너뛰고 즉시
    // 끝낸다 — image_asset 은 has_caption_auto=0 으로 남아 T7 스케줄러가 주기로
    // 줍는다. 이는 누락 위장이 아니라 정직한 비동기(스케줄러가 나중에 채움).
    let captionResult: Awaited<ReturnType<typeof applyVlmCaptionFlow>> | null =
      null;
    if (
      settingsForImage?.llm?.extractor?.mode === "immediate" &&
      settingsForImage?.llm?.vision?.enabled
    ) {
      const visionSlot = settingsForImage.llm.vision;
      const visionProviderSettings = toVisionProviderSettings(visionSlot);
      let provider = null as Awaited<
        ReturnType<typeof createVisionProvider>
      > | null;
      try {
        provider = createVisionProvider(visionProviderSettings);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // createVisionProvider 안 throw — settings 양식 어긋남. 자산 흐름 차단 X.
        console.warn(
          `[ingest] createVisionProvider 실패 — VLM 흐름 건너뜀 (${msg})`,
        );
      }
      const hasEmbedding = !imageResult.warnings.some((w) =>
        w.includes("siglip"),
      );
      captionResult = await applyVlmCaptionFlow({
        store,
        db: store.getRawDb(),
        parentNodeId: imageResult.nodeId,
        assetSha256: imageResult.assetSha256,
        imageBuffer: Buffer.from(originalBytes),
        mimeType,
        visionSettings: visionProviderSettings,
        provider,
        hasEmbedding,
        // Phase 11e G2-4 — settings.llm.vision.captionPrompt 통로. 빈 값이면
        // caption-flow 가 개정된 한국어 검색용 DEFAULT_CAPTION_PROMPT 강등.
        prompt: visionSlot.captionPrompt,
      });
    }
    // autoCleanupTrigger — 14a 텍스트 분기 정합. 이미지 입력도 외부 SDK 통로.
    deps.autoCleanupTrigger?.emit("external-sdk-write");
    // 그래프 라이브 연출 2a — 이미지 입력이 진짜 저장된 끝에서 graph_changed 발행.
    // eventBus 미주입이면 no-op. 저장 성공 경로에서만(에러 응답은 여기 못 온다).
    deps.eventBus?.emit(EVENT_TYPES.GRAPH_CHANGED, { reason: "ingested" });
    return c.json(
      {
        ok: true,
        type: "image",
        images: [imageResult],
        attachedToNodeId,
        // 실패 원인(failure)은 캡션 백필 전용 칸이라 응답에 싣지 않는다 — 응답 모양을 바꾸지 않는다(2026-10-14 spec 4.6).
        captionFlow:
          captionResult === null
            ? null
            : { called: captionResult.called, caption: captionResult.caption, captionNodeId: captionResult.captionNodeId },
      },
      201,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 지원 안 하는 image mime 등 — 400 (silent no-op 금지).
    return err(c, 400, `이미지 입력 실패: ${msg}`);
  }
}
