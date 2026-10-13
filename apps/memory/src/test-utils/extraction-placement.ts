/**
 * test-utils/extraction-placement.ts — 저장된 원문 없이 추출기를 직접 부르는 테스트의 자식 출처.
 *
 * storeExtraction·extractAndStore 는 자식이 붙는 곳(계보 또는 직접 출처)을 받아야 한다(WP-B1-20T 설계 6.2).
 * 원문 노드 없이 추출 동작(중복 흡수 범위·작성자 연결·잠금 배선 등)만 보는 테스트는 from-text 를 preserveRaw
 * 없이 부른 경우와 같게, 이 입력의 직접 저장 출처(describeInputSource — 운영 코드와 같은 함수)를 자식에
 * 남긴다. 운영 코드는 import 하지 않는다.
 */

import type { ExtractInput, ExtractionPlacement } from "../memory/extractor.ts";
import { describeInputSource } from "../memory/node-sources/source-ref.ts";

/** 입력(platform·author·metadata)의 직접 저장 출처를 자식 출처로 쓰는 placement. */
export function inputChildSource(
  input: Pick<ExtractInput, "platform" | "author" | "metadata">,
): ExtractionPlacement {
  return {
    childSource: describeInputSource({ source: input.platform ?? "", author: input.author, metadata: input.metadata }),
  };
}
