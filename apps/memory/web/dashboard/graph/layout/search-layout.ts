/**
 * 검색 결과 전용 방사형 배치 토큰.
 *
 * overview 는 전체 기억 지도를 넓게 펼쳐야 하지만, 검색 화면은 결과 hit 를 중심에
 * 모아 보여주는 흐름이다. 독립 hit 가 전체 지도용 orphan shell(30)을 그대로 쓰면
 * Top3 가 화면 가장자리로 크게 벌어지므로 검색 subgraph 에서만 더 조밀한 shell 을 쓴다.
 */
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";
import type { RadialTokens } from "./radial-layout.ts";

export const SEARCH_RADIAL_LAYOUT: RadialTokens = {
  ...GRAPH_RENDER_THEME.radialLayout,
  rootSphereRadius: 4,
  depthStep: 1.5,
  orphanShellRadius: 8,
  entityClusterMinRadius: 2,
  entityClusterLeafScale: 0.34,
  entityClusterDepthScale: 0.55,
  entityClusterGap: 1.1,
};
