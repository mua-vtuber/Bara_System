/**
 * Memory Core Settings — default 값 모음 (C2/schema 분해 2026-06-27).
 *
 * memory-schema.ts 의 MEMORY_DEFAULTS 를 그대로 떼어낸 파일. `as const` 리터럴
 * 타입을 유지한다 (분해 전후 typeof MEMORY_DEFAULTS 동일). MEMORY_SCHEMA 의
 * default 값만 추출한 plain object 로, getMemorySettings 가 디스크 파일과
 * deep merge 할 때 활용한다.
 *
 * Phase 5.7.3 W1 — 신규 6 그룹 (db / llm / autoCleanup / trashManagement /
 * search / valueDecay).
 */

export const MEMORY_DEFAULTS = {
  db: {
    path: "data/bara.sqlite",
    port: 3001,
    host: "127.0.0.1",
    embeddingModel: "bge-m3",
  },
  ui: {
    startPage: "dashboard",
  },
  // P3 G3-b — 저장 시각·상대 날짜·보관 컷오프의 기준 시간대. default Asia/Seoul 은
  // 옛 KST 고정 동작과 byte 동일(회귀 0). 다른 나라 사용자는 이 한 칸만 바꾼다.
  time: {
    zone: "Asia/Seoul",
  },
  llm: {
    extractor: {
      enabled: true,
      // graceful-degradation 정합 — 로컬 우선 default (사용자 결정 2026-06-01).
      // 사용자 settings 파일 저장값은 deep merge 가 보존 (default 가 덮지 않음).
      provider: "ollama",
      ollamaUrl: "http://127.0.0.1:11434",
      // default qwen3:4b-instruct (Apache 2.0·상업 안전·non-thinking).
      // 옛 exaone3.5:7.8b 는 NC(비상업) 라이선스라 외부 배포 default 에서 제거.
      ollamaModel: "qwen3:4b-instruct",
      anthropicApiKey: "",
      anthropicModel: "claude-haiku-4-5",
      openaiBaseUrl: "http://127.0.0.1:1234/v1",
      openaiModel: "qwen3:4b-instruct",
      openaiApiKey: "",
      gptApiKey: "",
      gptModel: "",
      geminiApiKey: "",
      geminiModel: "",
      mode: "backfill",
      minImportance: 0.3,
      // forceJsonFormat=false = 옛 운영 default 모델 exaone3.5:2.4b 기준 측정에서
      // 형식 강제 OFF 가 정상 추출(8/8)이라 정한 값이다. 현 default 모델은
      // qwen3:4b-instruct (2026-06-13 교체)인데 이 모델에서 OFF 품질은 아직
      // 재측정되지 않았다 (근거 미재확인). timeoutMs=900000 (15분) = A1 CPU 추출이
      // 옛 120초를 넘겨 끊기던 흠을 푼다.
      forceJsonFormat: false,
      timeoutMs: 900000,
      backfill: {
        intervalMin: 30,
        batchSize: 10,
        minImportance: 0,
      },
    },
    cleanup: {
      enabled: false,
      provider: "anthropic",
      ollamaUrl: "http://127.0.0.1:11434",
      // default 는 빈 태그 — cleanup 은 enabled:false 라 호출 0 (빈 태그 + 비활성이
      // 한 쌍). 가동하려면 사용자가 큰 Apache 모델 태그를 직접 채운다. 옛
      // exaone3.5:32b 는 NC(비상업) 라이선스라 외부 배포 default 에서 제거.
      ollamaModel: "",
      anthropicApiKey: "",
      anthropicModel: "claude-sonnet-4-6",
      openaiBaseUrl: "http://127.0.0.1:1234/v1",
      openaiModel: "",
      openaiApiKey: "",
      gptApiKey: "",
      gptModel: "",
      geminiApiKey: "",
      geminiModel: "",
      intervalDays: 7,
      // 데이터 정리 AI 효율 가동 spec 4.A-8 — extractor.timeoutMs(900000) 대칭,
      // 3 provider 균일 적용.
      requestTimeoutMs: 900000,
      trigger: "interval",
    },
    vision: {
      enabled: false,
      // Phase 11c hotfix (2026-05-30) — default 'ollama' 양식 정합
      // ([[phase11-14-design-decisions-progress-2026-05-22]] 결정 = Qwen3-VL 4B).
      provider: "ollama",
      ollamaUrl: "http://127.0.0.1:11434",
      // default qwen3-vl:4b-instruct (Apache 2.0·상업 안전·non-thinking). 실측:
      // A1-급 CPU(num_gpu:0)에서 로드 3초·캡션 웜 7초로 정상. 옛 경고(로드 8분·빈
      // 응답)는 thinking 변형 qwen3-vl:4b/:2b 한정 — 그 변형은 설치하지 않는다.
      // Ollama 0.12.7+ 필요. 옛 qwen2.5vl 가족은 NC 라 외부 배포 default 에서 제거.
      ollamaModel: "qwen3-vl:4b-instruct",
      anthropicApiKey: "",
      anthropicModel: "claude-haiku-4-5",
      openaiBaseUrl: "http://127.0.0.1:1234/v1",
      openaiModel: "qwen3-vl:4b-instruct",
      openaiApiKey: "",
      gptApiKey: "",
      gptModel: "",
      geminiApiKey: "",
      geminiModel: "",
      forceCall: false,
      tokenCap: 2000,
      // timeoutMs=360000 (6분) — A1 CPU 캡션 1장 최대 209초 측정 + 여유. 옛
      // OllamaVisionProvider 고정 120초로는 매번 끊기던 흠을 푼다.
      timeoutMs: 360000,
      // Phase 11e G2-4 — 빈 문자열 default = caption-flow 가 개정된 한국어 검색용
      // default 프롬프트 사용. 사용자가 settings 에서 직접 글을 적으면 그 글 우선.
      captionPrompt: "",
      // extractor-vision-unified-clock-scheduler Task 4 — 캡션 시점·주기 분은 의미추출
      // AI 공통 설정(llm.extractor 권위)을 따른다. vision 슬롯에는 한 사이클 batchSize 만.
      backfill: {
        batchSize: 10,
      },
    },
  },
  extractor: {
    regex: {
      enabled: true,
      langs: ["ko", "en"],
      userPatternsEnabled: true,
      userBoostersEnabled: true,
    },
  },
  metadataInfer: {
    enabled: true,
    sessionGapMinutes: 180,
    batchSize: 200,
  },
  cleanupDeepPass: {
    regexStrengthen: {
      // Phase 7 깊은 패스 Task 5 — 강한 모델 API 비용 통제로 default OFF (spec section 8).
      enabled: false,
      batchSize: 50,
      overmatchThreshold: 0.3,
      overmatchSampleSize: 100,
    },
    summary: {
      // Phase 7 요약 단계 Task 9 — 강한 모델 API 비용 통제로 default OFF (spec section 6 상속).
      enabled: false,
      atomicThreshold: 4,
      batchSize: 50,
      relationConfidenceThreshold: 0.6,
      firstParagraphMaxChars: 300,
      searchChannelDefault: true,
    },
    // 데이터 정리 AI 효율 가동 spec 5.B-2 — 사람 연결 단계 손잡이(DCL-1·DCL-7).
    //   enabled default true (현행 동작 보존). autoApply default false (신규 설치는
    //   확실한 연결도 검토 제안 경유가 안전 기본값). 기존 설치는 migrate-legacy-keys 가
    //   autoApply 를 true 로 채워 현행 자동 동작을 보존한다.
    personLink: {
      enabled: true,
      batchSize: 50,
      autoApply: false,
    },
    // 데이터 정리 AI 효율 가동 spec 6.C-2 (DCL-4) — 렌즈 소비 단계(lens_draft). 유료 +
    //   신규 동작이라 default OFF(제안만 만들고 자동 적용 0 — person_link 0.9 자동 예외
    //   불승계). batchSize 20 = 한 사이클에 훑을 빈 칸 엔티티 최대 개수(한 엔티티당 렌즈
    //   계약 + 근거 노드가 실려 다른 단계보다 배치가 작다).
    lensDraft: {
      enabled: false,
      batchSize: 20,
    },
    // 항목·일정 자동 등록(2026-10-10 spec). default OFF — 대시보드 정리 AI 스위치가 함께 켠다.
    //   autoApply true = 확실한 것(코드 검사 통과)만 바로 반영. batchSize 10 은 잠정(평가로 확정).
    entityRegister: { enabled: false, autoApply: true, batchSize: 10 },
    // 데이터 정리 AI 효율 가동 spec 5.B-2 — 관계 발굴 자동 반영 게이트. autoApply default
    //   false (신규 설치는 자동 그래프 엣지 반영이 opt-in). 기존 설치는 migrate-legacy-keys
    //   가 true 로 채운다. relation_summaries 행 저장은 이 값과 무관하게 유지.
    relationDiscovery: {
      autoApply: false,
    },
    // 데이터 정리 AI 효율 가동 spec 4.A-5 — 실행층이 소비하는 신뢰성 값(재시도·attempt·
    // circuit breaker). spec 4.A 표 확정값.
    reliability: {
      maxAttemptsPerTarget: 3,
      retryMaxPerCall: 2,
      retryBaseDelayMs: 2000,
      circuitBreakerThreshold: 5,
      staleRunReclaimMs: 3600000,
    },
    // 데이터 정리 AI 효율 가동 spec 4.A-5 — 사이클 4차원 예산 + 단계별 배분.
    // DCL-6: 아래 수치는 잠정·보수적 — dryRun(run API) 실측 후 확정 예정(잠정). 지금은
    // 안전하게 작게 잡아 폭주만 막는다. stageAllocation 합은 1.0(로드 시 강제).
    budget: {
      maxCallsPerCycle: 50,
      maxEstimatedInputTokensPerCycle: 500000,
      maxOutputTokensPerCycle: 100000,
      maxDurationMsPerCycle: 1800000,
      maxEstimatedInputTokensPerCall: 30000,
      stageAllocation: {
        // 2026-10-10 사용자 결정 — 다섯 단계 균등.
        regexStrengthen: 0.2,
        summary: 0.2,
        personLink: 0.2,
        lensDraft: 0.2,
        entityRegister: 0.2,
      },
    },
  },
  autoCleanup: {
    enabled: true,
    throttleSeconds: 30,
    valueThreshold: 0.05,
  },
  trashManagement: {
    enabled: true,
    cronTime: "03:00",
    retentionDays: 30,
    warningDays: 7,
  },
  // P4 D1 — 서버 내장 백업. cronTime 은 settings.time.zone 기준 벽시계(HH:MM).
  // trash cron(03:00)과 시간 분리. dir 은 다른 디스크 경로 지정 가능.
  backup: {
    enabled: true,
    cronTime: "04:00",
    retentionDays: 7,
    dir: "data/backups",
  },
  // P3 G3-c — events 큐 보존일. default 90 은 SSE 재연결 이어받기 윈도우보다 넉넉히
  // 크게 잡은 값. -1 이면 무제한(삭제 안 함 — 정직한 비활성).
  events: {
    retentionDays: 90,
  },
  search: {
    // C1/M5 (2026-06-18) — 충돌·중복 임계 default 를 -1 sentinel 로 바꿔 "모델
    // 연동" 의미로 만든다(baselineVectorCosine 과 같은 규칙). server.ts 가
    // resolveModelSentinel 로 음수면 모델값(bge-m3 0.55/0.85/0.85)을 쓰고,
    // 사용자가 0..1 로 명시 저장하면 그 값을 보존한다.
    // 옛 고정 default(0.786/0.99)는 bge-m3 운영에서 닿지 못해 supersede·dedup 을
    // 조용히 끄던 흠이라 sentinel 로 교체한다.
    mergeSimThreshold: -1,
    conflictCheckMin: -1,
    conflictSameMax: -1,
    mentionBoost: 0.05,
    precisionStrengthWeight: 0.2,
    baselineFloorMode: "gate",
    baselineVectorCosine: -1,
    baselineImageVecCosine: 0.1,
    // T20(결정 D-B) — AI 경로 결과 하한선. default ON 은 T19 실측 확정이 전제다
    // (측정 전 임시 default 금지 — spec F). bge-m3 absolute 0.44 에서 회수 손실 0
    // (nDCG·recall·MRR·MAP 소수점 6자리까지 불변) + 무관 꼬리 62% 제거라 켜 둘
    // 근거가 실측으로 닫혔다. absolute -1 = 모델 연동 sentinel(0.44).
    // margin 은 baselineMargin 방식 계수 — 그 방식이 등록된 모델이 없어 현재
    // 미사용이며, 방식이 등록되는 시점에 판정 구현과 함께 쓰인다.
    resultFloor: {
      enabled: true,
      mode: "absolute",
      absolute: -1,
      margin: -1,
    },
    // T21(spec C) — index 회신 건수 상한. spec C 가 준 30~50 구간의 가운데 40.
    // 하드 최대 100 은 스키마·파싱이 함께 막는다(search-index-mode 토큰 산법).
    indexModeLimit: 40,
  },
  reranker: {
    enabled: true,
    model: "onnx-community/bge-reranker-v2-m3-ONNX",
    topK_input: 30,
    topK_output: 5,
    host: "local",
  },
  valueDecay: {
    importanceDecay: 0.7,
    recencyHalfLifeDays: 30,
    importanceHalfLifeDays: 90,
  },
  assets: {
    dir: "data/assets",
  },
  images: {
    preserveMode: "smart",
    passthroughMaxMb: 5,
    passthroughMaxPx: 2048,
    animatedPassthroughMaxMb: 15,
    searchCopyMaxPx: 2048,
    searchCopyFormat: "auto",
    previewMaxPx: 512,
    searchSimilarityBoost: 2.5,
    autoConceptLink: {
      enabled: true,
      threshold: 0.1,
    },
  },
  documents: {
    ocr: {
      mode: "manual",
      resourceProfile: "balanced",
      // 2026-10-11 문서 OCR spec — 쪽 출력 한도 8192(사용자 Q3)·쪽 그림·한도·실패 규칙 기본값(사용자 Q8).
      maxOutputTokensPerPage: 8192,
      pageImage: {
        maxEdgePx: 1600,
      },
      schedule: {
        intervalMin: 30,
        batchSize: 1,
        leaseSeconds: 1800,
        timeoutMs: 900000,
        maxPagesPerCycle: 10,
        maxPagesPerDay: 100,
      },
      reliability: {
        maxAttemptsPerPage: 3,
        retryDelayMinutes: 30,
        circuitBreakerThreshold: 3,
      },
      local: {
        provider: "command",
        ollamaUrl: "http://127.0.0.1:11434",
        ollamaModel: "qwen3-vl:4b-instruct",
        lmstudioUrl: "http://127.0.0.1:1234/v1",
        lmstudioModel: "",
        commandJson: "",
        ollamaInputTokenReserve: 8192,
      },
      api: {
        provider: "http_file_api",
        // 공급자별 칸 — 모델·주소 기본은 빈 칸(모델 이름을 코드에 박아 두지 않는다).
        anthropicApiKey: "",
        anthropicModel: "",
        gptApiKey: "",
        gptModel: "",
        geminiApiKey: "",
        geminiModel: "",
        openaiBaseUrl: "",
        openaiModel: "",
        openaiApiKey: "",
        endpointUrl: "",
        model: "",
        apiKey: "",
        responseFormat: "markdown",
      },
      pcCompanion: {
        workerId: "pc-ocr",
        pollSeconds: 30,
        commandSource: "local",
        commandJson: "",
        allowedStatuses: ["needs_ocr", "parse_failed", "ocr_failed"],
      },
    },
  },
  chunking: {
    strategy: "paragraph",
    tokenCap: 2000,
    minChunkTokens: 64,
    maxContextTokens: 2000,
  },
  security: {
    // 입력 byte 상한 — GB 급으로 프로세스 죽이기만 차단(정상 글·이미지·문서는 통과).
    // 자산 상한 64 MiB = 이미지 한도(animatedPassthroughMaxMb 15 MB) x 1.33(base64
    // 팽창 = 19.95 MB) + 여유 이상. 글 상한 8 MiB < 자산 상한.
    maxTextBytes: 8 * 1024 * 1024,
    maxAssetBytes: 64 * 1024 * 1024,
  },
  // T15(결정 D-C) — 저장 관문. default ON: 비밀값으로 보이는 본문은 저장을 거부한다.
  // 한 번 저장되면 청크·추출 자식·수정 이력까지 퍼져 되돌리기 어려운 사고라 기본이
  // 열려 있어야 하고, 끄는 것은 사용자의 명시적 선택이어야 한다.
  // T16(결정 D-A) — 유사-중복 차단도 default ON. threshold -1 = 모델 연동
  // sentinel(storeDuplicateThresholdOf, bge-m3 0.89 실측). 사용자가 0..1 로
  // 명시하면 그 값이 이긴다 — search 그룹 임계들과 같은 sentinel 규칙.
  writeGuard: {
    secretRejection: true,
    duplicateCheck: {
      enabled: true,
      threshold: -1,
    },
  },
} as const;
