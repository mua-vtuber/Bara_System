/**
 * 3D 그래프 렌더 토큰 — three.js 씬이 그리는 색의 단일 출처.
 * 3D 비주얼은 테마 무관 고정 팔레트다(샘플 theme.js 의 graph 블록도 light/dark 동일).
 * 0단계: 현재 렌더러 하드코딩 색을 그대로 옮긴 동작 보존 세트.
 * (엣지 3단 mid 는 4단계, halo·fog·조명 토큰은 2·3단계에서 추가.)
 */
export interface GraphRenderTokens {
  /** 노드 타입별 색 (GraphNodeType 12종). */
  nodeTypeColors: Record<string, string>;
  /** 타입 미상 시 기본 노드 색. */
  nodeDefaultColor: string;
  /** 글로우 sprite 방사형 그라디언트 stop (offset, css color). */
  glowStops: ReadonlyArray<readonly [number, string]>;
  /** 코어 sprite 방사형 그라디언트 stop. */
  coreStops: ReadonlyArray<readonly [number, string]>;
  /** 엣지 약(낮은 weight) 색. */
  edgeLow: string;
  /** 엣지 강(높은 weight) 색. */
  edgeHigh: string;
  /**
   * 엔티티 관계선(entity_relation_edges) 색 — 글 연결선과 또렷이 구별한다(spec 3.5·5.2·DCL-3).
   * created_by·located_at 등 관계명 type 을 가진 엣지에만 적용.
   * 4단계 edgeLow/edgeHigh 그라디언트는 글 연결선 전용으로 유지.
   */
  edgeRelation: string;
  /**
   * 묶음 소속선(member_of) 색 — 개별 엔티티를 묶음 노드에 잇는 선(시각효과 Task 2).
   * 글 연결선·엔티티 관계선과 또렷이 구별한다(색=연결 종류). 오로라 재조율(2026-07-10):
   * 명확한 파랑 — 관계선(보라)·소유선(청록)과 채도로 갈린다.
   */
  edgeMembership: string;
  /**
   * 프로젝트 소유선(owns_memory) 색 — 프로젝트 노드가 자기 글을 거느리는 허브 선(D5·spec 5.2·6.2).
   * 오로라 재조율(2026-07-10): 청록 계열(브리핑 지정) — 글↔글(edgeLow→edgeHigh 보라→핑크)·
   * 관계선(edgeRelation 보라)·묶음 소속선(edgeMembership 파랑)과 또렷이 갈린다. 라이브로 조정 가능.
   */
  edgeProjectOwnership: string;
  /**
   * 엣지 굵기 버킷 단계(시각효과 Task 2) — 약→강 오름차순 굵기 값(픽셀 단위).
   * LineMaterial worldUnits=false 라 화면 픽셀 두께다(world 단위면 카메라 가까이서
   * 막대처럼 부푼다). 강도(weight)를 이 단계로 양자화해 약한 글↔글 연결은 가늘게,
   * 강한 연결은 굵게 그린다. 버킷 수가 곧 그리기 batch 수다(버킷마다 LineMaterial 1개).
   * 라이브로 보며 조정.
   */
  edgeWidthSteps: ReadonlyArray<number>;
  /**
   * 강도 버킷별 엣지 투명도(약 흐림→강 또렷·시각효과 Task 2).
   * edgeWidthSteps 와 같은 4단계·같은 버킷 인덱스를 공유한다 — 버킷 i 의 선은
   * 굵기 edgeWidthSteps[i]·기본 투명도 edgeOpacitySteps[i] 로 그린다.
   * 실제 밝기는 edgeFocusAlpha/edgeAmbientAlpha/edgeDimAlpha 가 한 번 더 조절한다.
   * 약한 글↔글 연결을 흐리게 깔아 화면이 정리되도록. 라이브로 보며 조정.
   */
  edgeOpacitySteps: ReadonlyArray<number>;
  /** hover/selected/search 로 강조된 엣지의 색 강도. */
  edgeFocusAlpha: number;
  /** 평소 배경 구조로 깔리는 엣지의 색 강도. */
  edgeAmbientAlpha: number;
  /** 검색 focus 밖으로 밀린 엣지의 색 강도. */
  edgeDimAlpha: number;
  /**
   * hover/선택으로 focus 상태가 된 1차 연결선을 배경선 위에 덧그리는 오버레이 선의
   * 굵기 가산 픽셀 — 오버레이 굵기 = 그 버킷 배경 굵기(lineWidth) + 이 값. 사용자 요청 수치,
   * 라이브로 조정 가능.
   */
  edgeFocusWidthBoost: number;
  /**
   * focus 오버레이 선 묶음의 material 투명도 — 1차 연결선을 배경(ambient/dim)보다 또렷하게
   * 덧그리는 밝기. 배경 버킷 투명도(edgeOpacitySteps ≤0.46)에 눌리지 않게 별도로 높인다.
   * 라이브로 조정 가능.
   */
  edgeFocusOverlayOpacity: number;
  /** 화면 깊이 순위에서 이 값 뒤부터 ambient 엣지를 흐리게 한다(0=가장 앞, 1=가장 뒤). */
  edgeAmbientDepthFadeStart: number;
  /** 가장 뒤쪽 ambient 엣지에 남길 최소 밝기 배율. */
  edgeAmbientDepthFadeFloor: number;
  /** 뒤쪽으로 갈수록 흐려지는 곡선 강도. */
  edgeAmbientDepthFadePower: number;
  /** 화면 깊이 순위에서 이 값 뒤부터 뒤쪽 노드 글로우를 아주 얕게 물린다(0=가장 앞, 1=가장 뒤). */
  nodeDepthFadeStart: number;
  /** 가장 뒤쪽 노드 코어에 남길 최소 밝기 배율. */
  nodeDepthBackCoreFloor: number;
  /** 가장 뒤쪽 노드 글로우에 남길 최소 밝기 배율. */
  nodeDepthBackGlowFloor: number;
  /** 가장 뒤쪽 노드 헤일로에 남길 최소 밝기 배율. */
  nodeDepthBackHaloFloor: number;
  /** 가장 앞쪽 노드 글로우를 살짝 더 또렷하게 하는 밝기 배율. */
  nodeDepthFrontGlowBoost: number;
  /** 가장 앞쪽 노드 코어를 살짝 키워 초점을 또렷하게 하는 배율. */
  nodeDepthFrontCoreScale: number;
  /** 뒤쪽으로 갈수록 노드가 물러나는 곡선 강도. */
  nodeDepthFadePower: number;
  /** 씬 fog 색 — 멀리 노드가 성운 남색에 녹아들도록(2단계 레이어링). */
  fogColor: string;
  /** 씬 fog 밀도(FogExp2). 성운 배경이 깔리므로 낮게. */
  fogDensity: number;
  /**
   * 별 색 스펙트럼 — 생명력 0~1 에 대응하는 stop (생명력값, hex 색).
   * 오로라 재조율(2026-07-10): 생명력이 낮은 별은 어두운 보라(죽어감), 중간은 청록,
   * 높을수록 백색 코어(살아있음)로 보간한다. 두 stop 사이를 RGB 채널 선형 보간한다.
   */
  starSpectrum: ReadonlyArray<readonly [number, string]>;
  /**
   * 별 크기 정규화 상한 — sizeSignal = min(degree, cap) / cap. 크기 전용이다
   * (색은 생명력 입력이라 이 상한과 무관 — 3a 개정으로 색·크기 채널 분리).
   */
  starDegreeCap: number;
  /** halo(후광) sprite 불투명도 — glow 보다 옅게. */
  haloOpacity: number;
  /** halo(후광) sprite 크기 배율 — glow 보다 넓게. */
  haloScale: number;
  /**
   * 묶음 노드(entity_group) 크기 배수 — 개별 노드 최대 크기(NODE_SIZE.max) 대비.
   * 묶음을 개별보다 크게 키워 구별한다(Q5). degree(자식 수)에 맡기지 않고 토큰으로 정한다.
   * 라이브로 보며 조정(권장 1.8~2.2).
   */
  groupScale: number;
  /**
   * 타입별 장식(3b) 토큰 — 별 둘레에 더하는 빌보드 스프라이트.
   * 장식 색은 별 생명력 색과 독립이다(장식=종류 표시·색≠생사). 전부 토큰 색.
   */
  decoration: GraphDecorationTokens;
  /**
   * 배경 먼지 파티클 레이어(시각효과 Task 3) — 노드·엣지와 독립한 별도 레이어다.
   * 화면 깊이감을 주려고 멀리 천천히 흐르는 작은 점들을 깐다. 끄기 쉽게 분리.
   */
  dust: GraphDustTokens;
  /**
   * 드래그 완화 스프링 토큰(시각효과 Task 4) — relaxStep 의 끌어당김 세기·한 스텝 상한·
   * anchor 추종 보간 계수. 라이브로 출렁 세기·정착 느낌을 보며 조정한다.
   */
  dragRelax: GraphDragRelaxTokens;
  /**
   * 노드 상시 드리프트(시각효과 Task 6·분리형) — 진폭·속도. 별이 평소에도 아주 천천히
   * 떠다니게 한다. node-drift.ts + graph-controller 호출 한 줄을 지우면 0 영향으로 떼어낸다.
   * amplitude 를 0 으로 두면 오프셋이 0 이라 효과가 꺼진다(라이브로 별로면 되돌리기 쉽게).
   */
  nodeDrift: { amplitude: number; speed: number };
  /** 새 노드 별똥별 진입·재정렬·엣지 성장 박자. */
  nodeBirth: GraphNodeBirthTokens;
  /** 새 노드 중심에서 한 번 퍼지는 빛 파동. */
  birthRipple: GraphBirthRippleTokens;
  /** 최근 생성 노드 강조·라벨 유지 정책. */
  recentNode: GraphRecentNodeTokens;
  /**
   * 신규 그래프 이펙트(Task 11) 토큰 — 버스트 입자·펄스 링·에너지 흐름·병합 충격파.
   * 색은 오로라 팔레트(보라·청록 계열)를 그대로 따른다.
   */
  effects: GraphEffectsTokens;
  /**
   * 노드 간격(충돌 방지) 계산 상수 — 크기→반지름 변환 비율·여유분·초기 배치 보정 강도.
   * spacing.ts 순수 헬퍼와 force-layout 충돌 패스에서만 이 값을 읽는다. 라이브로 조정 가능.
   */
  nodeSpacing: {
    /** 반지름 = size × radiusFactor. 노드 크기(size)를 물리 반지름으로 환산한다. */
    radiusFactor: number;
    /** 최소간격 여유분 — 두 반지름 합에 더하는 추가 간격(월드 단위). */
    gapPadding: number;
    /** 초기 배치 충돌 보정 강도(0~1) — force-layout 첫 패스에서 겹침을 얼마나 즉시 푸는지. */
    initCollisionStrength: number;
    /** 이 크기일 때 무게가 정확히 1 — massOfSize(massRefSize) = 1. NODE_SIZE.min 과 같아야 한다. */
    massRefSize: number;
  };
  /**
   * 계층 방사형 레이아웃 튜닝 토큰(spec 2026-06-14) — radial-layout.ts 의 해석적 좌표 계산이 읽는다.
   * 루트 구 표면 반지름·깊이 한 단계 거리·자식 콘 반각·자식 콘 잎수 비례·외톨이 껍질·겹침 보정 횟수.
   */
  radialLayout: RadialLayoutTokens;
}

/** 계층 방사형 레이아웃 튜닝 토큰(spec 2026-06-14). 라이브로 보며 조정한다. */
export interface RadialLayoutTokens {
  /** 루트(종류) 노드를 피보나치로 흩는 구 표면 반지름. */
  rootSphereRadius: number;
  /** 깊이 한 단계마다 중심에서 멀어지는 거리. */
  depthStep: number;
  /** 루트 콘 반각 상한(라디안) — 깊이 내려가며 자손 잎 비율로 좁아진다. */
  coneHalfAngle: number;
  /** 외톨이 글을 흩는 바깥 껍질 반지름. */
  orphanShellRadius: number;
  /** 겹침 보정 반복 횟수. */
  collisionPasses: number;
  /** entity_group 하나가 차지하는 최소 국소 구체 반지름. */
  entityClusterMinRadius: number;
  /** 자손 잎 수가 많을수록 국소 구체 반지름을 키우는 배율. */
  entityClusterLeafScale: number;
  /** 위계가 깊을수록 국소 구체 반지름을 키우는 배율. */
  entityClusterDepthScale: number;
  /** 국소 구체끼리 떨어뜨릴 추가 여백. */
  entityClusterGap: number;
}

export interface GraphNodeBirthTokens {
  durationS: number;
  localMoveDurationS: number;
  globalMoveDurationS: number;
  staggerS: number;
  maxStaggerS: number;
  maxConcurrent: number;
  travelDistanceMin: number;
  travelDistanceMax: number;
  arcStrength: number;
  /**
   * T19(Problem B) — 꼬리 길이(월드 유닛, 절대값). computeTrailTail 이 head 에서 이동
   * 시작점 방향으로 이 길이만큼 뗀 지점을 tail 로 삼는다(단 이동 시작점을 넘지 않도록 clamp).
   *
   * 옛 trailLengthRatio(이동 거리에 곱하는 비율) 방식은 scatter(anchor 부모에서 태어나 이동
   * 거리가 depthStep=2.0 유닛 안팎)에서 곱산값(2.0*0.18=0.36)이 노드 반지름(0.08~0.26)과
   * 비슷해져 화면에서 사실상 안 보였다 — 이동 거리가 짧을수록 꼬리도 비례해 짧아지는 게
   * 근본 결함이었다. 절대 길이로 바꿔 이동 거리와 무관하게 화면 스케일 대비 길이를 보장한다.
   */
  trailMinLength: number;
  trailOpacity: number;
  trailWidth: number;
  /** 꼬리 끝(tail) 색 감쇠 배율 — head 색에 곱해 꼬리가 뒤로 갈수록 어두워지게 한다. */
  trailTailDim: number;
  edgeDelayRatio: number;
  edgeGrowDurationS: number;
  maxLocalAddedNodes: number;
}

export interface GraphBirthRippleTokens {
  /** 파동 지속 시간(초). 0 이면 파동 레이어가 꺼진다. */
  durationS: number;
  /** 시작 크기 — 노드 코어 크기 기준 배율. */
  startScale: number;
  /** 끝 크기 — 노드 코어 크기 기준 배율. */
  endScale: number;
  /** 최고 불투명도. 0 이면 파동 레이어가 꺼진다. */
  opacity: number;
  /** 커질수록 빠르게 사라지는 곡선 강도. */
  fadePower: number;
  /** 시작 페이드-인 구간 — 진행률(0..1) 중 이 비율 지점까지 밝기가 차오른다. */
  attackFraction: number;
  /** 링 스프라이트 텍스처 한 변 픽셀 — 방사형 그라디언트 해상도. */
  textureSize: number;
  /** 링 안쪽 투명 경계 stop(0..1) — 중심부터 여기까지 완전 투명(속이 빈 고리). */
  ringInnerStop: number;
  /** 링 최대 밝기 stop(0..1). */
  ringPeakStop: number;
  /** 링 최대 밝기 알파. */
  ringPeakAlpha: number;
  /** 링 바깥 경계 stop(0..1) — 이후 가장자리(1)로 갈수록 투명. */
  ringOuterStop: number;
  /** 링 바깥 경계 알파. */
  ringOuterAlpha: number;
}

export interface GraphRecentNodeTokens {
  windowHours: number;
  labelCap: number;
  glowMultiplier: number;
  pulseDurationS: number;
  pulseAmplitude: number;
}

/**
 * 신규 그래프 이펙트(Task 11) 토큰 — 버스트 입자(노드 생성)·펄스 링(선택)·
 * 에너지 흐름(focus 엣지)·병합 충격파. 색·수치는 전부 이 토큰에서만 정한다.
 */
export interface GraphEffectsTokens {
  /** 버스트 입자 지속 시간(초) — sampleBurst 의 durationS. */
  burstDurationS: number;
  /** 버스트 입자 개수. */
  burstCount: number;
  /** 버스트 입자 색(오로라 청록 계열). */
  burstColor: string;
  /** 버스트 입자 점 크기(PointsMaterial size) — 활성·소멸 두 branch 공통. */
  burstDotSize: number;
  /** 버스트 입자 최소 방사 속도 — sampleBurst 의 흩어짐 거리 하한 계수. */
  burstSpeedMin: number;
  /** 버스트 입자 방사 속도 무작위 가산 폭 — min + rand()*var. */
  burstSpeedVar: number;
  /** 버스트 입자 알파 하한 계수 — 남은 수명 비율(1-t)에 곱해진다. */
  burstAlphaMin: number;
  /** 버스트 입자 알파 무작위 가산 폭 — min + rand()*var. */
  burstAlphaVar: number;
  /** 버스트 스프라이트 텍스처 한 변 픽셀 — 방사형 그라디언트 해상도. */
  burstTextureSize: number;
  /** 버스트 텍스처 그라디언트 중간 stop 위치(0..1) — 빛 알갱이 심 크기. */
  burstTextureMidStop: number;
  /** 버스트 텍스처 그라디언트 중간 stop 알파 — 심 둘레 밝기. */
  burstTextureMidAlpha: number;
  /** 펄스 링 한 주기 길이(초). */
  pulseRingPeriodS: number;
  /** 펄스 링 시작 반지름 — 노드 코어 크기 기준 배율. */
  pulseRingBaseRadius: number;
  /** 펄스 링 팽창 폭 — baseRadius 에 더해지는 최대 반지름. */
  pulseRingSpread: number;
  /** 펄스 링 개수(위상차를 둔 동시 링 수). */
  pulseRingCount: number;
  /** 펄스 링 색(오로라 보라 계열). */
  pulseRingColor: string;
  /** 펄스 링 선 굵기(픽셀) — THREE.LineBasicMaterial.linewidth 는 대부분의 WebGL 구현에서 무시되어 항상 1px 로 그려지므로, 현재 이 토큰은 실제 시각 효과가 없다. */
  pulseRingWidth: number;
  /** 펄스 링 시작(위상 0) 알파 — 팽창할수록 0 까지 선형 감쇠한다. */
  pulseRingMaxAlpha: number;
  /** 에너지 흐름 점 이동 속도(초당 오프셋 진행량). */
  energyFlowSpeed: number;
  /** 엣지 하나당 에너지 점 개수. */
  energyFlowDotsPerEdge: number;
  /** 에너지 흐름 점 색(오로라 청록 계열). */
  energyFlowColor: string;
  /** 에너지 흐름 점 크기. */
  energyFlowDotSize: number;
  /** 에너지 흐름 material 전체 불투명도. */
  energyFlowOpacity: number;
  /** 에너지 흐름 스프라이트 텍스처 한 변 픽셀 — 방사형 그라디언트 해상도. */
  energyFlowTextureSize: number;
  /** 에너지 흐름 텍스처 그라디언트 중간 stop 위치(0..1). */
  energyFlowTextureMidStop: number;
  /** 에너지 흐름 텍스처 그라디언트 중간 stop 알파. */
  energyFlowTextureMidAlpha: number;
  /** 병합 충격파 색(오로라 보라 계열) — birthRipple trigger 의 color 옵션에 넘긴다. */
  mergeShockwaveColor: string;
  /** 병합 충격파 폭 배율 — birthRipple trigger 의 width 옵션에 넘긴다(기본 파동보다 두껍게). */
  mergeShockwaveWidthMul: number;
}

/**
 * 드래그 완화 스프링 토큰(시각효과 Task 4) — 속도(velocity) 기반 물리.
 * spring 은 이제 가속도로 누적되고, damping(1 미만)이 매 스텝 속도를 줄여 관성 후 멈춤과 발산 차단을
 * 함께 한다. maxVel 은 한 프레임 속도 상한, maxStep 은 한 프레임 위치 변화 상한, settleThreshold 는
 * anchor 를 놓은 뒤 이웃 속도가 이보다 작아지면 정착을 끝내는 임계다. followLerp 은 anchor 가 마우스
 * 목표 위치로 따라가는 부드러움. 라이브로 출렁 세기·정착 느낌을 보며 조정한다.
 */
export interface GraphDragRelaxTokens {
  /** 스프링 가속도 비율(0~1). 현재거리−자연길이에 곱해 힘으로 누적한다. 크면 빨리 모인다. */
  spring: number;
  /** 한 스텝 위치 변화 크기 상한(world 단위). 발산 방지 클램프 — 작을수록 안정. */
  maxStep: number;
  /** anchor 가 마우스 목표 위치로 따라가는 보간 계수(0~1). 휙 점프 대신 부드럽게 추종. */
  followLerp: number;
  /** 감쇠 계수(1 미만). 매 스텝 속도에 곱해 관성을 빼며 멈추고 발산도 막는다(예 0.82). */
  damping: number;
  /** 한 프레임 속도 크기 상한(world 단위). 누적이 빨라도 위치가 폭발하지 않게 클램프. */
  maxVel: number;
  /** 이웃 속도가 이보다 작아지면 놓은 뒤 정착을 끝낸다(속도 합 또는 최대 기준). */
  settleThreshold: number;
  /** 자연길이 배수 — 스프링 자연길이를 최소간격에 이 값을 곱해 정한다(1 이상이면 여유를 둔다). */
  slackFactor: number;
  /** 끌어당김 스프링 세기(0~1) — collisionStep 에서 겹친 노드 쌍을 밀어낼 때 쓰는 인력·척력 계수. */
  pullSpring: number;
  /** 충돌 보정 강도(0~1) — 한 스텝에서 겹침을 얼마나 즉시 푸는지 결정한다. */
  collisionStrength: number;
  /** 무게 지수 — massOfSize 에서 (size/massRefSize)^massExp 로 무게를 계산한다. */
  massExp: number;
  /**
   * 정착 단계 한 스텝 위치 변화 상한(world 단위) — 활성 드래그의 maxStep 보다 작게 두어
   * 정착 첫 프레임에 이웃 무리가 한 번에 멀리 튀지 않게 한다.
   */
  settleMaxStep: number;
  /**
   * 정착 단계 한 프레임 속도 상한(world 단위) — 드래그 잔여 속도가 리셋된 뒤에도
   * 충돌 힘 자체가 첫 프레임을 크게 움직이지 않도록 작게 제한한다.
   */
  settleMaxVel: number;
  /**
   * 정착 이징 구간(프레임 수) — 정착이 시작된 뒤 이 프레임 수에 걸쳐
   * collisionStrength 를 0 에서 전체 값까지 선형으로 늘린다.
   * 이 구간 동안 충돌 보정이 천천히 적용되므로 첫 프레임 "탁" 점프가 사라진다.
   */
  settleEaseFrames: number;
}

/**
 * 배경 먼지 파티클 토큰(시각효과 Task 3) — 점 개수·크기·분포 범위·드리프트 수치.
 * 노드·엣지보다 뒤(renderOrder 음수)에 깔려 천천히 흐른다. 전부 이 토큰에서만 정한다.
 */
export interface GraphDustTokens {
  /** 먼지 점 개수. */
  count: number;
  /** 점 크기(PointsMaterial size). */
  size: number;
  /** 점을 흩는 정육면체 한 변의 절반 길이(원점 기준 ±spread). */
  spread: number;
  /**
   * 흐름 속도(월드유닛/초) — 먼지가 자기 고유 방향으로 등속으로 흐른다(라이브 7차).
   * 먼지마다 다른 방향벡터에 이 속도를 곱해 천천히 흐르게 한다. 끝에 닿으면 반대편에서
   * 다시 나타난다(경계 순환). 천천히 흐르게 작게 두고 라이브로 보며 조정한다.
   */
  flowSpeed: number;
  /** 드리프트 속도 — sin/cos 시간 계수가 클수록 빨리 출렁인다. */
  driftSpeed: number;
  /** 드리프트 진폭 — 점이 기준 좌표에서 벗어나는 최대 거리. 작게 둬 은은하게. */
  driftAmplitude: number;
  /** 점 색. */
  color: string;
  /** 점 불투명도. */
  opacity: number;
}

/**
 * 장식(고리·빛살·크리스탈 보석 파편) 토큰 — 각 장식의 색·크기·불투명도·형태 수치.
 * 3b 개정: 빛살만 2D 빌보드 스프라이트로 남고, 고리는 평면 링(RingGeometry),
 * 분류 키는 각진 크리스탈 보석(IcosahedronGeometry) 여러 조각으로 그린다.
 * 색·개수·배율 숫자는 전부 이 토큰에서만 정한다.
 */
export interface GraphDecorationTokens {
  /** 사람(person)=뾰족한 빛살(starburst). 옅은 청백. (2D 빌보드 스프라이트) */
  rayColor: string;
  /** 빛살 갈래 수. */
  rayCount: number;
  /** 빛살 스프라이트 크기 배율. */
  rayScale: number;
  /** 빛살 불투명도. */
  rayOpacity: number;
  /**
   * 빛살 가장자리 페이드 강도(T18) — rayAlphaAt 의 edgePower. 클수록 중심선에
   * 몰린 좁은 빛줄기, 작을수록 폭이 넓게 퍼진 부채꼴에 가깝다.
   */
  rayEdgePower: number;
  /** 빛살 부채꼴 반각 — (PI/rayCount) 대비 배율. 작을수록 가느다란 빛줄기. */
  rayHalfAngleScale: number;
  /**
   * 빛살 뿌리 페이드인 구간 폭(T20) — rayAlphaAt/rayPixelAlpha 의 rootFade.
   * 캔버스 t(0=중심, 1=끝점) 기준 비율. 0<t<rayRootFade 구간에서 알파가
   * smoothstep 으로 0→1 매끄럽게 올라와 빛살이 중심(코어 발광)에서 하드엣지
   * 없이 자연스럽게 이어져 나오는 느낌을 만든다. 0이면 비활성(하위호환).
   */
  rayRootFade: number;

  /**
   * 엔티티·프로젝트(Phase8 재매핑)=비스듬한 평면 링. 따뜻한 금빛.
   * 두께 없는 RingGeometry — 비스듬히 누우면 얇은 타원으로 보인다.
   */
  ringColor: string;
  /** 링 바깥 반지름 — 코어 대비 배율(별보다 크게 감싼다). */
  ringScale: number;
  /**
   * 링 폭 — 코어 대비 배율. innerRadius = ringScale - ringWidth.
   * 작을수록 얇은 선에 가깝고, 클수록 넓은 환형이 된다.
   */
  ringWidth: number;
  /** 링 기울기(도) — rotation.x 로 비스듬히 눕혀 타원처럼 보이게. 기준값. */
  ringTilt: number;
  /**
   * 고리 기울기 흩기 폭(도) — 노드 id 해시로 기준 ± 이 값 안에서 결정적으로 흩는다.
   * 같은 노드는 항상 같은 각도(깜빡임 0). spec 3.6·DCL-3.
   */
  ringTiltJitterDeg: number;
  /** 고리 불투명도. */
  ringOpacity: number;

  /**
   * 분류 키(classification_key·Phase8 재매핑)=별 코어를 감싸는 반투명 크리스탈 보석 구 하나.
   * IcosahedronGeometry + flatShading + 낮은 opacity·AdditiveBlending 으로 안의
   * 별빛이 비쳐 보이고 각 면이 명암을 달리 받아 깨진 유리처럼 반짝인다.
   */
  shardColor: string;
  /** 보석 구 반지름 — 코어 대비 배율(별보다 크게 감싼다). */
  shardScale: number;
  /** 보석 세분 단계(0=각진 20면, 1=80면). 면 명암을 살리려면 0~1. */
  shardDetail: number;
  /** 크리스탈 불투명도(낮을수록 안의 별빛이 더 비친다). */
  shardOpacity: number;
}

export const GRAPH_RENDER_THEME: GraphRenderTokens = {
  nodeTypeColors: {
    project: "#ffd780",
    concept: "#ffffff",
    person: "#ffffff",
    document: "#c5e8b0",
    document_chunk: "#90c4e0",
    image: "#d4b0e0",
    image_caption: "#b8a0d0",
    llm_extract: "#80d8c0",
    decision: "#f4d160",
    tag: "#e0c0a0",
    memory: "#c8b8a0",
    unknown: "#aaaaaa",
  },
  nodeDefaultColor: "#c8b8a0",
  glowStops: [
    [0, "rgba(255,255,255,1)"],
    [0.09, "rgba(255,252,238,1)"],
    [0.24, "rgba(255,219,128,0.58)"],
    [0.50, "rgba(223,95,38,0.16)"],
    [1, "rgba(205,78,34,0)"],
  ],
  coreStops: [
    [0, "rgba(255,255,255,1)"],
    [0.09, "rgba(255,255,255,1)"],
    [0.23, "rgba(255,246,214,0.86)"],
    [0.50, "rgba(255,190,84,0.16)"],
    [1, "rgba(255,116,46,0)"],
  ],
  // 오로라 재조율(2026-07-10): 글↔글 그라디언트도 성운 배경과 어울리게 짙은 보라→핑크 계열로.
  edgeLow: "#4a3a72",
  edgeHigh: "#ff7ad9",
  // 오로라 재조율: 관계선 = 보라 계열(주 발광 #a882ff) — 청록 owns_memory 와 또렷이 갈린다.
  edgeRelation: "#a882ff",
  // 오로라 재조율: 묶음 소속선 = 명확한 파랑(관계선 보라·소유선 청록과 색차 95+ 확보).
  edgeMembership: "#6ea8ff",
  // 오로라 재조율: 프로젝트 소유선 = 진한 청록(#00b8d9) — 브리핑 지정, 관계선 보라와 대비, 별 스펙트럼과 구별.
  edgeProjectOwnership: "#00b8d9",
  edgeWidthSteps: [0.2, 0.4, 0.6, 0.8],
  edgeOpacitySteps: [0.14, 0.22, 0.34, 0.46],
  edgeFocusAlpha: 1,
  edgeAmbientAlpha: 0.36,
  edgeDimAlpha: 0.08,
  // 사용자 요청 수치 — 라이브로 조정 가능(focus 오버레이 굵기 가산 픽셀).
  edgeFocusWidthBoost: 0.02,
  // 1차 연결선을 배경보다 또렷하게 덧그리는 밝기 — 라이브로 조정 가능.
  edgeFocusOverlayOpacity: 0.85,
  edgeAmbientDepthFadeStart: 0.35,
  edgeAmbientDepthFadeFloor: 0.5,
  edgeAmbientDepthFadePower: 1.2,
  nodeDepthFadeStart: 0.35,
  nodeDepthBackCoreFloor: 0.88,
  nodeDepthBackGlowFloor: 0.68,
  nodeDepthBackHaloFloor: 0.58,
  nodeDepthFrontGlowBoost: 1.12,
  nodeDepthFrontCoreScale: 1.08,
  nodeDepthFadePower: 1.2,
  fogColor: "#0a1426",
  fogDensity: 0.006,
  // 오로라 재조율(2026-07-10): 생명력 낮음=어두운 보라 → 중간=청록 → 최고=백색 코어.
  // 중간 stop(0.25·0.75)은 lerpHexColor 로 계산한 정확한 보간값(양 끝 사이 t=0.5).
  starSpectrum: [
    [0, "#5a4a9a"],
    [0.25, "#4999cd"],
    [0.5, "#38e8ff"],
    [0.75, "#94eaff"],
    [1, "#f0ecff"],
  ],
  starDegreeCap: 12,
  haloOpacity: 0.22,
  haloScale: 7.2,
  groupScale: 2.0,
  decoration: {
    rayColor: "#cfe0ff",
    rayCount: 6,
    // Phase8 Task 6: 사용자 "조금 길게" 요청 — 3.2 → 4.2 (약 31% 증가)
    rayScale: 4.2,
    rayOpacity: 0.5,
    // T18: 단색 삼각형 실루엣 제거 — 길이+폭 방향 모두 페이드하는 빛줄기로.
    rayEdgePower: 1.6,
    rayHalfAngleScale: 0.42,
    // T20: 뿌리 페이드인 구간 — t 기준 15%(캔버스 반지름의 약 0.15)에 걸쳐 서서히 밝아진다.
    // core glow(별 코어)가 이 구간을 덮으므로 살짝 겹쳐도 무해하고, 그 바깥은 육안으로
    // 하드엣지 없이 자연스럽게 이어진다. 라이브로 보며 조정 가능(권장 0.1~0.25).
    rayRootFade: 0.15,
    ringColor: "#8fe3ff",
    // 라이브 2차: 별 코어에 바짝 붙게 크기 축소(2.0 → 1.4).
    ringScale: 1.4,
    // 라이브 2차: 두툼한 띠로 폭 확대(0.18 → 0.5 = 바깥 반지름 대비 약 36%).
    ringWidth: 0.5,
    ringTilt: 68,
    // Phase8 Task 6: 노드 id 해시로 고리 기울기를 ±40° 흩는다(spec 3.6·DCL-3)
    ringTiltJitterDeg: 40,
    ringOpacity: 0.55,
    shardColor: "#c4a8ff",
    // 라이브 2차: 별을 품는 단일 보석 구 — 별 코어보다 크게 감싼다.
    shardScale: 1.8,
    // detail 0 = 각진 20면 크리스탈(sample_01.png 느낌).
    shardDetail: 0,
    // 낮은 opacity 로 안의 별 코어가 비쳐 보이게(0.2~0.4 권장 — 0.3).
    shardOpacity: 0.3,
  },
  dust: {
    // 라이브 2차: 너무 빽빽해 400 으로 줄임(1400 → 400).
    count: 400,
    // 라이브 3차: 너무 작고(0.06) 넓게(14) 퍼져 3개만 보임 → 크게·진하게.
    // 라이브 4차: 9 는 너무 중앙에 몰려 답답 → 11.
    // 라이브 5차: 11 도 카메라 안쪽 느낌 → 14 로 더 넓게.
    // 라이브 6차: 줌아웃(카메라 최대거리 64)하면 14 정육면체가 화면 중앙에만 뭉쳐 보임
    //   → 50 으로 넓혀 카메라 최대거리를 감싸게(count 400 유지 — 밀도는 보고 조정).
    size: 0.18,
    spread: 50,
    // 라이브 7차: 먼지가 자기 고유 방향으로 흐르는 등속 속도(월드유닛/초). 천천히 흐르게 — 라이브로 조정.
    flowSpeed: 0.5,
    driftSpeed: 0.2,
    driftAmplitude: 0.18,
    color: "#cfe0ff",
    opacity: 0.65,
  },
  dragRelax: {
    // 속도 기반으로 바뀌어 spring 은 가속도로 누적된다 — 위치 기반 0.18 그대로면 관성이 겹쳐 과해서
    // 0.1 로 낮춘다(라이브로 0.08~0.12 사이 조정 전제 시작값).
    spring: 0.1,
    // 한 프레임 위치 변화 상한 — 빠른 마우스 이동에도 이웃이 화면 밖으로 튀지 않게.
    maxStep: 1.5,
    // anchor 가 마우스 목표 위치로 따라가는 부드러움 — 휙 점프 대신 매 프레임 30% 보간.
    followLerp: 0.3,
    // 1 미만 — 관성 + 감쇠(에너지 빠짐·발산 차단). 0.82 면 외력 없이 약 4프레임에 속도 절반.
    damping: 0.82,
    // 한 프레임 속도 상한(world 단위).
    maxVel: 0.6,
    // 이웃 속도가 이보다 작아지면 정착 종료(놓은 뒤 뒤따름이 멈췄다고 본다).
    settleThreshold: 0.004,
    // 스프링 자연길이 배수 — 최소간격보다 60% 여유를 두어 노드가 살짝 떨어져 보이게(라이브 조정).
    slackFactor: 1.6,
    // 충돌 스텝 인력·척력 세기 — 너무 크면 진동, 작으면 정착이 느리다.
    pullSpring: 0.08,
    // 한 스텝 겹침 해소 강도 — 0.6 이면 한 스텝에 겹침의 60% 를 즉시 푼다.
    collisionStrength: 0.6,
    // 무게 지수 — 크기 비율의 제곱으로 무게를 정한다(size 2 배면 무게 4 배).
    massExp: 2,
    // 정착 단계 위치 변화 상한 — 활성 드래그(1.5)의 1/5 수준으로 작게 두어 한 프레임 이동을 제한한다.
    settleMaxStep: 0.3,
    // 정착 단계 속도 상한 — 활성 드래그(0.6)의 절반 미만으로 두어 충돌 힘 누적을 제한한다.
    settleMaxVel: 0.25,
    // 정착 이징 구간(프레임) — 이 프레임에 걸쳐 충돌 보정 강도를 0 → 전체값으로 선형으로 늘린다.
    settleEaseFrames: 12,
  },
  nodeDrift: {
    // 라이브로 보며 조정 전제 시작값 — 진폭이 별 크기(0.16~)에 견줘 작아 배치는 그대로 보이고
    // 가장자리만 살짝 일렁인다. speed 가 작아 아주 천천히 떠다닌다.
    amplitude: 0.18,
    speed: 0.5,
  },
  nodeBirth: {
    durationS: 1.6,
    localMoveDurationS: 1.25,
    globalMoveDurationS: 2.0,
    staggerS: 0.08,
    maxStaggerS: 0.5,
    maxConcurrent: 40,
    travelDistanceMin: 10,
    travelDistanceMax: 14,
    arcStrength: 0.35,
    // 0.9 는 depthStep(2.0, scatter/gather anchor 간 전형적 거리)의 약 45% — 이동 시작점을
    // 넘지 않게 clamp 되면서도 노드 반지름(0.08~0.26)보다 충분히 길어 화면에서 보인다.
    // 유성 비행(원거리 10~14 유닛)에서는 이 값이 이동 거리에 비해 짧아 꼬리가 head 바로
    // 뒤 일부 구간만 그려지는데, 이는 기존에도(ratio=0.18 곱산값 1.8~2.52) 비슷한 비율이었다.
    trailMinLength: 0.9,
    trailOpacity: 0.78,
    trailWidth: 2.2,
    // 꼬리 감쇠 — 기존 리터럴 0.15 그대로 토큰화(동작 보존).
    trailTailDim: 0.15,
    edgeDelayRatio: 0.72,
    edgeGrowDurationS: 0.65,
    maxLocalAddedNodes: 8,
  },
  birthRipple: {
    durationS: 1.45,
    startScale: 1.2,
    endScale: 9.2,
    opacity: 0.46,
    fadePower: 1.7,
    // 아래 계수 — 기존 리터럴 값 그대로 토큰화(동작 보존).
    attackFraction: 0.12,
    textureSize: 128,
    ringInnerStop: 0.34,
    ringPeakStop: 0.45,
    ringPeakAlpha: 0.78,
    ringOuterStop: 0.56,
    ringOuterAlpha: 0.26,
  },
  recentNode: {
    windowHours: 12,
    labelCap: 15,
    glowMultiplier: 1.62,
    pulseDurationS: 24,
    pulseAmplitude: 0.26,
  },
  effects: {
    burstDurationS: 0.9,
    burstCount: 14,
    // 오로라 청록(starSpectrum 중간 stop 과 같은 계열) — 탄생 순간의 밝은 산란.
    burstColor: "#38e8ff",
    // 버스트 입자 점 크기 — 기존 하드코딩 0.12 값 그대로 토큰화(동작 보존).
    burstDotSize: 0.12,
    // 아래 burst/pulse/energy 세부 계수 — 기존 리터럴 값 그대로 토큰화(동작 보존).
    burstSpeedMin: 0.6,
    burstSpeedVar: 0.8,
    burstAlphaMin: 0.5,
    burstAlphaVar: 0.5,
    burstTextureSize: 64,
    burstTextureMidStop: 0.4,
    burstTextureMidAlpha: 0.55,
    pulseRingPeriodS: 1.4,
    pulseRingBaseRadius: 1.0,
    pulseRingSpread: 1.6,
    pulseRingCount: 2,
    // 오로라 보라(edgeRelation 과 같은 계열) — 선택 강조는 관계선과 같은 색 언어를 쓴다.
    pulseRingColor: "#a882ff",
    pulseRingWidth: 1.6,
    pulseRingMaxAlpha: 0.55,
    energyFlowSpeed: 0.6,
    energyFlowDotsPerEdge: 3,
    // 오로라 청록 — focus 엣지 위를 흐르는 점은 버스트와 같은 "활성" 색 언어.
    energyFlowColor: "#38e8ff",
    energyFlowDotSize: 0.12,
    energyFlowOpacity: 0.85,
    energyFlowTextureSize: 48,
    energyFlowTextureMidStop: 0.5,
    energyFlowTextureMidAlpha: 0.5,
    // 병합 충격파 = 오로라 보라(주 발광 #a882ff) — 브리핑 지정.
    mergeShockwaveColor: "#a882ff",
    // 기본 탄생 파동보다 두껍게 — 병합은 두 별이 하나로 합쳐지는 더 큰 사건이다.
    mergeShockwaveWidthMul: 1.6,
  },
  nodeSpacing: {
    // 반지름 = size × 0.5 — size 0.16 이면 반지름 0.08, size 0.52 이면 반지름 0.26.
    radiusFactor: 0.5,
    // 두 반지름 합에 더하는 최소 여유 간격(월드 단위). 작으면 빽빽, 크면 너무 벌어진다.
    gapPadding: 0.4,
    // 초기 배치 충돌 보정 강도 — 0.5 이면 첫 패스에서 겹침의 절반을 즉시 해소한다.
    initCollisionStrength: 0.5,
    // NODE_SIZE.min 실제값(nodes.ts 참조). 이 크기일 때 massOfSize = 1.
    massRefSize: 0.16,
  },
  radialLayout: {
    rootSphereRadius: 6,
    depthStep: 2.0,
    coneHalfAngle: 1.2,
    orphanShellRadius: 30,
    collisionPasses: 6,
    entityClusterMinRadius: 2.8,
    entityClusterLeafScale: 0.44,
    entityClusterDepthScale: 0.72,
    entityClusterGap: 1.8,
  },
};
