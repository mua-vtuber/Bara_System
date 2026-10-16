/**
 * Memory Core Settings — 루트 MemorySettings·partial·mask 타입 (P3 G5-a 분할).
 *
 * memory-settings.ts 파사드의 settings 파일 schema 타입 본문 — 동작 불변.
 * 슬롯 단위 타입(LLM·문서 OCR)은 memory-settings-slots.ts, 파일 read/write 는
 * memory-settings-io.ts 소관.
 */
import type {
  LlmExtractorSlot,
  LlmCleanupSlot,
  LlmVisionSlot,
  DocumentOcrSettings,
} from "./memory-settings-slots";

export interface MemorySettings {
  db: {
    path: string;
    port: number;
    host: string;
    /** Phase 5.7.1 W1 — 옛 embedding.model 흡수. 2026-06-01 운영 default bge-m3 전환. */
    embeddingModel: "bge-m3";
  };
  /** 브라우저 진입점의 기본 화면. /web/dashboard.html 은 항상 대시보드를 직접 연다. */
  ui: {
    startPage: "dashboard" | "graph";
  };
  /**
   * P3 G3-b — 애플리케이션 기준 시간대. 저장 시각(nowKst)·상대 날짜('어제')·자정
   * anchor·보관 컷오프가 모두 이 zone 하나를 따른다. 부팅 시 index.ts 가
   * setTimeZone(settings.time.zone)으로 helpers 모듈에 주입한다. default "Asia/Seoul"
   * 은 옛 KST 고정 동작과 byte 동일(회귀 0).
   */
  time: {
    /** IANA 시간대 이름(예: "Asia/Seoul", "UTC"). 잘못된 이름은 부팅 시 loud fail. */
    zone: string;
  };
  llm: {
    extractor: LlmExtractorSlot;
    cleanup: LlmCleanupSlot;
    /** Phase 11b T10/T11 — VLM 슬롯 (이미지 캡션). */
    vision: LlmVisionSlot;
  };
  /**
   * Phase 6a T10 — 정규식 Level 0 추출기 설정 (spec 7.3). 옛 `llm.extractor`
   * (의미 추출 AI) 와 별 그룹 — 이쪽은 LLM 호출 0 의 정규식 양식 추출. 둘은
   * 경로가 다르므로 (`llm.extractor` vs `extractor.regex`) 충돌하지 않는다.
   */
  extractor: {
    regex: {
      enabled: boolean;
      /** 매치 대상 언어 목록. default ["ko", "en"]. 이 목록의 언어 양식만 가동. */
      langs: string[];
      /** 대시보드 사용자 추가 양식 합류 여부. default true. */
      userPatternsEnabled: boolean;
      /** 대시보드 사용자 추가 booster 합류 여부. default true. */
      userBoostersEnabled: boolean;
    };
  };
  /**
   * Phase 7 2차 Task 6 — 맥락 추론 메타 전파(갈래 2). 같은 작성자·시간 인접 메모를
   * 세션으로 묶어 장소·시각이 비어 있는 메모에 같은 사건의 다른 값을 채울 제안을
   * 만든다. 자동 적용 0 — 전부 검토 게이트. 가동 주기는 의미 추출(extractor) 주기를
   * 따른다(별도 cadence·간격 칸 없음) — index.ts wiring 이 extractor 사이클 끝
   * onCycleComplete 에서 한 사이클을 잇는다. default enabled=true.
   */
  metadataInfer: {
    enabled: boolean;
    /** 세션 끊기 + 익은(닫힌) 세션 판정 간격 G(분). default 180. */
    sessionGapMinutes: number;
    /** 한 사이클 후보 메모 최대 개수. default 200. */
    batchSize: number;
    /**
     * 장소·시각 채우기 응답 한 번의 최대 출력 토큰 수(default 1024). 이 한도에 잘린 세션은 메모에
     * 한도 값을 적어 같은 한도로는 다시 보내지 않는다(metadata-infer-output-limit.ts).
     */
    maxOutputTokens: number;
  };
  /**
   * Phase 7 깊은 패스 Task 5 — 정규식 강화 깊은 패스 설정 (spec section 8/10).
   * 강한 cleanup LLM 이 "정규식이 놓친 글"을 묶어 새 정규식 양식을 제안하는 단계의
   * 손잡이 묶음. llm.cleanup 슬롯(가동 토글·provider·모델·intervalDays)과는 별
   * 그룹 — 이쪽은 강화 단계 고유 손잡이(후보 수·과매치 컷)만 담는다.
   */
  cleanupDeepPass: {
    regexStrengthen: {
      /**
       * 깊은 패스 정규식 강화 가동. default false — 강한 모델은 API 비용(사용자
       * 부담)이라 켜는 시점을 사용자가 고른다(spec section 8 default OFF). 갈래2가
       * ollama 무료라 ON 이었던 것과 다른 판단.
       */
      enabled: boolean;
      /** 한 사이클에 줍는 후보("놓친 글") 최대 개수. default 50. */
      batchSize: number;
      /**
       * 제안된 정규식의 과매치율 컷 임계 [0,1]. 표본 글에서 이 비율을 넘게 매치하면
       * 너무 헐렁한 양식으로 보고 탈락시킨다. default 0.3 (spec section 10).
       */
      overmatchThreshold: number;
      /** 과매치율을 잴 때 쓰는 표본 글 개수. default 100. */
      overmatchSampleSize: number;
    };
    /**
     * Phase 7 요약 단계 Task 9 — 청크요약 + 관계 발굴 둘째 단계 손잡이 (spec section
     * 6/10). 첫 단계 `regexStrengthen` 형제 — 같은 그룹, 같은 가동 슬롯(llm.cleanup)
     * 상속. 청크요약 atomic 임계·후보 수·관계 엣지 confidence 임계·첫 문단 fallback
     * 길이·요약 검색 채널 default 만 담는다(가동 토글·provider·모델·주기는 llm.cleanup
     * 권위). 며칠 써보고 `relationConfidenceThreshold` 한 줄 조정(spec "써봐야 안다").
     */
    summary: {
      /**
       * 요약 단계 가동. default false — 강한 모델은 API 비용(사용자 부담)이라 켜는
       * 시점을 사용자가 고른다(spec section 6 default OFF — 첫 단계와 같은 판단).
       * 가동 슬롯(llm.cleanup.enabled)과 AND 로 함께 켜져야 사이클이 돈다.
       */
      enabled: boolean;
      /**
       * 청크요약 대상 임계 — 한 청크에 달린 atomic(분해된 의미 조각) 수가 이 값 이상
       * 이면 요약 후보로 줍는다. default 4 (spec section 3.1 옛 D4). 양의 정수.
       */
      atomicThreshold: number;
      /** 한 사이클에 줍는 요약 후보 청크 최대 개수. default 50. 양의 정수. */
      batchSize: number;
      /**
       * 관계 발굴 엣지 confidence 컷 임계 [0,1]. 관계요약 행은 항상 저장하되, LLM 이
       * 매긴 confidence 가 이 값 이상일 때만 `llm_relation` 엣지를 만든다. default 0.6
       * (plan 선택값 — 며칠 써보고 한 줄 조정 / spec section 10).
       */
      relationConfidenceThreshold: number;
      /**
       * LLM 이 청크요약을 못 만들 때(graceful) 쓰는 첫 문단 fallback 의 최대 글자 수.
       * default 300. 양의 정수. 첫 문단을 이 길이로 잘라 요약 자리에 채우고
       * generated_by 로 출처를 표시한다(spec section 6 graceful).
       */
      firstParagraphMaxChars: number;
      /**
       * 요약 텍스트 검색 채널 기본 가동(검색 요청이 옵션을 안 주면 따르는 default).
       * default true — 요약은 RRF 합산 후 후처리 옵션 채널이라 켜져 있어도 코어 불변.
       */
      searchChannelDefault: boolean;
    };
    /**
     * 데이터 정리 AI 효율 가동 spec 5.B-2 — 사람 연결 단계 손잡이(DCL-1·DCL-7). 옛
     * person_link 는 토글 없이 항상 돌고 batchSize 를 요약 슬롯에서 차용했다. 이 그룹이
     * 그 둘을 푼다. enabled default true(현행 보존), autoApply default false(신규 설치는
     * 확실한 연결도 검토 제안 경유 — 기존 설치는 migrate-legacy-keys 가 true 로 채움).
     */
    personLink: {
      /** 사람 연결 단계 가동. default true(현행 동작 보존, DCL-1). */
      enabled: boolean;
      /** 한 사이클 사람 연결 후보 노드 최대 개수. default 50(옛 요약 슬롯 차용 해소). */
      batchSize: number;
      /**
       * conf>=0.9 자동 연결 게이트. default false(신규 설치 — 검토 제안 경유). true =
       * 확실한 연결을 자동 mentions 엣지로. 낮은 확신(0.6~0.9)은 이 값과 무관하게 제안.
       */
      autoApply: boolean;
    };
    /**
     * 데이터 정리 AI 효율 가동 spec 6.C-2 (DCL-4) — 렌즈 소비 단계(lens_draft). 렌즈가
     * 정의된 종류의 기존 엔티티 중 빈 칸을 강한 cleanup LLM 이 렌즈 계약 안에서 채워
     * 구조화 초안(cleanup_proposals)으로 만든다. 유료 + 신규 동작이라 default OFF.
     * 자동 적용은 0 — 다중 칸 동시 변경이라 person_link 의 conf>=0.9 자동 예외를
     * 승계하지 않는다(확실한 초안도 전부 검토 게이트 경유).
     */
    lensDraft: {
      /** 렌즈 소비 단계 가동. default false(유료 + 신규 동작 — 명시로 켠다). */
      enabled: boolean;
      /** 한 사이클 빈 칸 엔티티 후보 최대 개수. default 20(렌즈 계약 + 근거 노드 동반). */
      batchSize: number;
    };
    /**
     * 항목·일정 자동 등록(2026-10-10 spec). 태그 없는 메모에서 정리 AI 가 찾은 항목·일정을 코드
     * 판정(spec 4장)으로 자동 반영하거나 정리 제안(entity_register)으로 보낸다.
     */
    entityRegister: {
      /** 단계 가동. default false — 대시보드 정리 AI 스위치가 함께 켠다(buildCleanupLinkedPayload). */
      enabled: boolean;
      /** 확실한 것(spec 4.1 3·7번, 4.5 자동 줄)을 바로 반영. false 면 전부 제안. default true. */
      autoApply: boolean;
      /** 한 호출에 보낼 메모 수. 잠정 default 10(plan 13-2, 평가로 확정). */
      batchSize: number;
    };
    /**
     * 데이터 정리 AI 효율 가동 spec 5.B-2 — 관계 발굴 자동 반영 게이트. 요약 단계가
     * 발굴한 관계를 llm_relation 개념 엣지로 자동 반영할지. relation_summaries 행은
     * 이 값과 무관하게 항상 저장(정리 자산). autoApply=false 면 엣지 자동 생성만 보류.
     */
    relationDiscovery: {
      /** 관계 엣지 자동 반영. default false(신규 설치 — 자동 그래프 변경 opt-in). */
      autoApply: boolean;
    };
    /**
     * 데이터 정리 AI 효율 가동 spec 4.A-5 — 실행층(CleanupLlmExecutor)이 소비하는
     * 신뢰성 손잡이. 일시 오류 backoff 재시도·결정적 실패 attempt 상한·provider 연속
     * 실패 circuit breaker. index.ts 배선이 이 그룹에서 읽어 executor·cycle deps 로
     * 넘긴다(하드코딩 0). spec 4.A 표 확정값.
     */
    reliability: {
      /** 대상별 결정적 실패 attempt 상한 → terminal_failure. default 3. */
      maxAttemptsPerTarget: number;
      /** 일시 오류 호출 재시도 상한. default 2. */
      retryMaxPerCall: number;
      /** backoff 기준 지연 ms(지수 + jitter, Retry-After 우선). default 2000. */
      retryBaseDelayMs: number;
      /** provider+단계 연속 일시 실패 → 단계 중단 임계. default 5. */
      circuitBreakerThreshold: number;
      /**
       * 죽은 run 회수 나이 문턱 ms. 시작 후 이 시간을 넘겨도 status='running' 인
       * 원장 행을 다음 사이클 시작 때 failed 로 회수한다(죽은 프로세스가 남긴 행이
       * idempotency 키를 영구 봉쇄하는 것 차단). default 3600000(1시간).
       */
      staleRunReclaimMs: number;
    };
    /**
     * 데이터 정리 AI 효율 가동 spec 4.A-5 — 사이클 4차원 예산 + 단계별 배분. 유료
     * 강모델 연결 시 사이클 지출을 4차원(호출 수·추정 입력·출력·시간) 상한 안에 묶고,
     * stageAllocation 이 각 차원을 단계별 비율로 나눠 한 단계가 전 예산을 소진해 뒤
     * 단계를 굶기는 것을 막는다. **DCL-6**: 수치는 잠정·보수적 — dryRun 실측 후 확정.
     * stageAllocation 합은 1.0(설정 로드 시 강제 — 어긋나면 loud fail).
     */
    budget: {
      /** 사이클 호출 수 상한(재시도 제외). 잠정 default 50(DCL-6). */
      maxCallsPerCycle: number;
      /** 사이클 추정 입력 토큰 상한. 잠정 default 500000(DCL-6). */
      maxEstimatedInputTokensPerCycle: number;
      /** 사이클 출력 토큰 상한. 잠정 default 100000(DCL-6). */
      maxOutputTokensPerCycle: number;
      /** 사이클 시간 상한 ms. 잠정 default 1800000(30분, DCL-6). */
      maxDurationMsPerCycle: number;
      /** 호출당 입력 토큰 상한(A-6 소비). 잠정 default 30000(DCL-6). */
      maxEstimatedInputTokensPerCall: number;
      /** 단계별 예산 배분 비율(합 1.0 강제). 잠정 값(DCL-6). */
      stageAllocation: {
        regexStrengthen: number;
        summary: number;
        personLink: number;
        lensDraft: number;
        entityRegister: number;
      };
    };
  };
  /**
   * Phase 5.7.3 W1 — 데이터 변동 시점 트리거 메모리 자동 정리 시스템.
   * default enabled=true (이벤트 기반 입력 0 가동 0 정합).
   */
  autoCleanup: {
    enabled: boolean;
    throttleSeconds: number;
    valueThreshold: number;
  };
  /**
   * Phase 5.7.3 W1 — 매일 새벽 cron 휴지통 관리 시스템.
   * default enabled=true (시간 기반 cron 박자 보장). cronTime 형식 = "HH:MM" KST.
   */
  trashManagement: {
    enabled: boolean;
    cronTime: string;
    retentionDays: number;
    warningDays: number;
  };
  /**
   * P4 D1 — 서버 내장 백업. cronTime = "HH:MM" (settings.time.zone 기준 벽시계).
   */
  backup: {
    enabled: boolean;
    cronTime: string;
    retentionDays: number;
    dir: string;
  };
  /**
   * P3 G3-c — events 큐 보존정책. events 테이블은 알림을 영구 적재하는데 DELETE
   * 경로가 없어 무한 성장했다. retentionDays 지난 events 를 trash cron 이 정리한다.
   * default 90(넉넉히 — SSE 재연결 이어받기 윈도우 보호). -1 = 무제한(삭제 안 함).
   */
  events: {
    /** N일 지난 events 삭제. -1 이면 무제한(정직한 비활성). */
    retentionDays: number;
  };
  /**
   * Phase 5.7.1 W1 — 5 칸 (옛 dedupSim + clusterSimHigh 통합 + 시간 감쇠 가닥은
   * valueDecay 그룹으로 이전).
   */
  search: {
    mergeSimThreshold: number;
    conflictCheckMin: number;
    conflictSameMax: number;
    mentionBoost: number;
    /**
     * 강도-반영 정밀 재채점 가중치 λ(강도-반영 융합 설계 §4.2 / T4). 유사도 채널
     * (vector·imageVec)의 보정 cosine 강도를 검색 점수에 가산하는 정도다. 0 이면
     * 정밀 강도 미적용(현행 RRF) / 클수록 강한 유사도 매치를 순위에 더 싣는다.
     * default 0.2 — magnitude-fusion-regression 측정 확정값(dbsf 보정에서 정확 매치
     * 글을 무관 다채널 글 위로 안정 격차로 올리면서 글 nDCG 0.8882 회귀 0).
     * retriever boostedRrf 와 분리된 가산 항이라 RRF 합산 코어(rrf.ts)는 불변.
     */
    precisionStrengthWeight: number;
    /**
     * 채널별 절대 baseline floor 방식(강도-반영 융합 §8.3·§8.6 후속 / D-N2).
     * dbsf 보정은 채널 안 상대 분포만 봐서, 후보가 전부 baseline 잡음이어도 상대
     * 1위에 강도 최대를 준다. baseline floor 가 raw cosine < 채널 baseline 인 매치의
     * 정밀 강도를 0 으로 컷해 baseline 잡음(예 "---" 청크)이 진짜 답 위로 끼어드는
     * 흠을 막는다. 'off'=미적용 / 'gate'(default)=dbsf 분별 유지 + baseline 잡음 컷 /
     * 'tmm-min'=baseline 을 tmm 정규화 하한으로(비교용). RRF 합산 코어(rrf.ts)는 불변.
     */
    baselineFloorMode: "off" | "gate" | "tmm-min";
    /**
     * vector 채널 절대 baseline cosine. raw 가 이 값 미만이면 정밀 강도 0.
     * default -1 = 모델 연동(bge-m3 0.5, A1 실측). 0~1 값을 직접 넣으면 모델 연동 대신 그 값이 우선(사용자
     * 오버라이드). 음수 sentinel 은 search 라우트가 retriever 로 안 흘려, retriever
     * 가 server.ts 주입 모델 baseline(vectorBaselineOf)을 쓴다. baselineFloorMode='off' 면 미사용.
     */
    baselineVectorCosine: number;
    /**
     * imageVec(SigLIP) 채널 절대 baseline cosine. raw 가 이 값 미만이면 정밀 강도 0.
     * default 0.1 — A1 실측(무관 이미지 SigLIP cosine ≈ 0.057 / 관련 이미지
     * 0.117~0.138 사이). SigLIP 한 모델 고정이라 글 임베딩 모델과 무관한 단일값.
     * baselineFloorMode='off' 면 미사용.
     */
    baselineImageVecCosine: number;
    /**
     * T20(결정 D-B) — AI 경로 검색 결과 하한선. 위 baseline* 가족과 척도(raw
     * cosine)는 같지만 하는 일이 다르다 — baseline floor 는 정밀 강도를 0 으로
     * *깎되 결과는 남기고*, 여기는 결과를 목록에서 *버린다*. 0건 회신 허용.
     *
     * 대시보드 REST 검색에는 안 걸린다(단락 11 확정 3) — 호출측 명시 플래그로
     * 가르므로 이 칸을 켜도 사람 눈 경로는 전체 표시 그대로다. absolute 음수
     * (-1 sentinel) = 모델 연동 factory 값(bge-m3 0.44), 0 이상 명시 = 사용자
     * 오버라이드 — baselineVectorCosine 과 같은 규칙.
     */
    resultFloor: {
      enabled: boolean;
      mode: "off" | "absolute" | "baselineMargin";
      absolute: number;
      margin: number;
    };
    /**
     * T21(spec C) — `responseMode:"index"` 색인 회신의 건수 상한. full 모드
     * limit(최대 50)과 *별도* 상한이다: 색인은 건당 본문을 안 실어 건당 토큰이
     * 낮으므로 더 많이 보여도 회신이 감당된다.
     *
     * 토큰 상한이 이 값으로 닫힌다 — 총량 = 이 값 × 건당 상한(oneLine 120자 +
     * 짧은 고정칸). 하드 최대 100(search-index-mode.ts 토큰 산법 주석). default
     * 40 은 spec C 가 준 30~50 구간의 가운데다.
     */
    indexModeLimit: number;
  };
  /**
   * Phase 6b T1 — 리랭커 (검색 결과 재정렬) 그룹 (spec 11.3.1). top-level 배치 결정:
   * spec 11.3.1 JSON 구조가 root 에 `reranker` 를 두고, 6a `extractor` 도 top-level
   * 선례. `search` 그룹은 RRF 임계값 스칼라 모음이고 reranker 는 자체 하위 칸을 가진
   * 검색 가로지르는 별도 단계라 nesting 보다 독립 배치가 깔끔하다. R4 캐시 키 (spec
   * 10.2.2) 가 reranker 상태를 독립 단위로 직렬화하므로 top-level 이 직렬화에도 정합.
   * default enabled=true 는 T7 검색 평가 harness measured-win (nDCG flat +0.1074 /
   * enriched +0.1594 / recall 불변) + 사용자 결정 — 옛 측정 전 보수 OFF 에서 전환.
   */
  reranker: {
    enabled: boolean;
    /** cross-encoder 재정렬 모델 식별자. Task 4 ONNX 확정 ID. */
    model: string;
    /** 운영 최종 점수 상위 N 후보를 재정렬 입력으로 회수 (spec 11.1.1). */
    topK_input: number;
    /** 재정렬 후 회신할 상위 N 결과 수. */
    topK_output: number;
    /** (질의, 글) 한 쌍을 리랭커에 넣을 최대 토큰 수. 넘으면 글 뒷부분을 자른다. */
    maxPairTokens: number;
    /** 리랭커 가동 위치 — 현 단계 'local' 한 갈래. */
    host: "local";
  };
  /**
   * Phase 5.7.1 W1 — 메모리 가치 평가 (시간 감쇠) 3 칸. 옛 search 그룹 안에 있던
   * 가닥 분리.
   */
  valueDecay: {
    importanceDecay: number;
    recencyHalfLifeDays: number;
    importanceHalfLifeDays: number;
  };
  /**
   * Phase 14a T3 — 자산 보관 디렉토리 설정 (공통 인프라 spec 단락 1).
   * env BARA_ASSET_DIR 재정의는 server.ts 부트 단계 담당. 이 그룹은 설정 파일 기본값.
   */
  assets: {
    /** 원본·canonical 자산이 저장되는 디렉토리. default "data/assets". */
    dir: string;
  };
  /**
   * Phase 11a T4 — 이미지 자산 보존 모드 + 한도 + 미리보기 양식.
   * image-preserve/types.ts 의 PreserveSettings 와 1:1 정합. 같은 키 묶음을
   * 두 곳 (여기 + image-preserve types) 에서 정의하지만 본 interface 는 settings
   * 파일 schema 의 타입 권위이고 image-preserve types 가 코어 코드 권위라
   * 분리 정합. 후속 phase 에서 한 곳에서 export + 다른 곳 import 통합 정리 예정.
   */
  images: {
    /** 보존 모드 — 'smart' (default) / 'original' / 'resized'. */
    preserveMode: "smart" | "original" | "resized";
    /** smart 정지 통과 한도 (MB). default 5. */
    passthroughMaxMb: number;
    /** smart 정지 통과 한도 (px). default 2048. */
    passthroughMaxPx: number;
    /** smart 움직이는 통과 한도 (MB). default 15. */
    animatedPassthroughMaxMb: number;
    /** resized + smart 사본 흐름의 가로/세로 한도 (px). default 2048. */
    searchCopyMaxPx: number;
    /** 사본 형식 갈래. 11a 한 갈래 'auto' — jimp 알파 검사. */
    searchCopyFormat: "auto";
    /** 미리보기 한도 (px). default 512. */
    previewMaxPx: number;
    /**
     * image-search-foundation Task 7 (c-C1) — 이미지 유사도(SigLIP image_vec)
     * 채널 전용 검색 출처 boost. "유사 우선, 연결 보조" — 이 값이 1.0 보다
     * 크면 유사도 1위 이미지가 연결성 점수 높은 딴 항목에 가산 합산으로 밀리던
     * 흠을 고친다. 글 노드는 imageVec 채널 기여가 0 이라 이 값을 올려도 글 검색
     * 결과는 불변(retriever boostedRrf 합산 / search-tuning SOURCE_BOOST.imageVec).
     * default 2.5 — T7 측정 확정값(crossover 2.0 위로 약 4% 안정 격차 / 과하지 않은 균형점).
     */
    searchSimilarityBoost: number;
    /**
     * image-search-foundation Task 5 (b-B3) — 이미지 업로드 시 SigLIP 자동
     * 개념 연결. 이미지의 SigLIP 임베딩과 기존 개념의 SigLIP 임베딩을 cosine
     * 비교해 threshold 이상인 *기존* 개념과 node_concept_edges(role='visual')로
     * 잇는다. 새 개념은 만들지 않는다.
     */
    autoConceptLink: {
      /** true (default) 면 업로드 시 자동 연결 시도. false 면 정직한 비활성. */
      enabled: boolean;
      /** 연결 cosine 임계값. default 0.10 (실측 변별 경계). */
      threshold: number;
    };
  };
  /**
   * 문서 처리/OCR 설정. 실행 위치 기준으로 수동·로컬·API·PC companion 을 분리한다.
   * DB 마이그레이션 없이 settings JSON 과 documents.source_metadata.parse 상태로만
   * 운영한다.
   */
  documents: {
    ocr: DocumentOcrSettings;
  };
  /**
   * Phase 14a T11 — 문서 청크 분해 전략 + token 한도 (spec 단락 3.2).
   * sub-object 없는 단순 그룹 — Object.assign 갈래로 부분 갱신 처리.
   */
  chunking: {
    /** 청크 전략. default 'paragraph' (빈 줄 기준). */
    strategy: "paragraph" | "heading";
    /** 한 청크 token budget 상한. 초과 시 더 잘게 분리. default 2000. */
    tokenCap: number;
    /**
     * 활용 단계3 D2 — 짧은 청크 병합 하한(token). 1차 조각 중 이 값 미만은 이웃과
     * 합쳐 과분할을 막는다(전 전략 공통 후처리). default 64 (≈ 한국어 32 글자 —
     * 헤딩 고아 조각은 합치고 한 문장 분량은 보존하는 경계). 0 이면 병합을 끈다.
     */
    minChunkTokens: number;
    /**
     * Phase 14b T2 (14.5) — 검색 결과 청크 + 같은 문서 인접 청크 묶음의 누적
     * token 상한. 넘기 직전 멈춘다. default 2000 (spec 7.1). 청크 content token
     * budget 가닥이라 chunking 그룹에 둔다 (tokenCap 선례 정합).
     */
    maxContextTokens: number;
  };
  /**
   * 입력 byte 상한 — 과도하게 큰 글·자산이 들어와 프로세스를 죽이는 것만 차단하고
   * 정상 입력은 통과시킨다. maxTextBytes 는 글 본문, maxAssetBytes 는 이미지·문서
   * 자산의 byte 한도. 두 칸 모두 양의 정수(byte 단위).
   */
  security: {
    maxTextBytes: number;
    maxAssetBytes: number;
  };
  /**
   * T15(결정 D-C) — 저장 관문. 사용자 글이 DB 로 들어가기 직전 거치는 검사의
   * 손잡이. secretRejection 이 켜져 있으면 API 키·토큰·개인키처럼 보이는 본문의
   * 저장을 거부한다(default true). 저장 통로 전부(saveTextInput · /memories/from-text
   * preserveRaw · PATCH /memories/:id)가 같은 손잡이를 본다.
   */
  writeGuard: {
    secretRejection: boolean;
    /**
     * T16(결정 D-A) — 유사-중복 저장 차단. 이미 있는 기억과 임계 이상 닮은
     * 글은 저장을 막고 기존 기억 id·발췌를 실어 회신한다(호출자가 갱신 /
     * force 재시도를 선택). threshold 음수 = 모델 연동 sentinel(bge-m3 0.89),
     * 0..1 명시 = 사용자 오버라이드 — search 그룹 임계와 같은 규칙.
     */
    duplicateCheck: {
      enabled: boolean;
      threshold: number;
    };
  };
}

/**
 * 그룹 단위 + 필드 단위 두 수준 partial. putMemorySettings 본문이 mergeShallowGroups
 * 로 그룹 안 *필드 단위* 부분 갱신을 받아주므로, 호출자가 일부 필드만 넣은 그룹을
 * 그대로 전달해도 디스크 값이 보존된다. 이 타입은 그 동작과 정합한 시그니처.
 *
 * Phase 5.6 W5 — `llm` 그룹은 두 sub-slot (extractor + cleanup) 각각 독립 부분 갱신
 * 가능. 한 슬롯만 넘어온 partial 도 OK (다른 슬롯은 디스크 값 보존).
 *
 * Phase 5.7.1 W1 — `llm.extractor.backfill` sub-object 도 부분 갱신 정합 (3 칸 중
 * 일부만 들어간 partial 허용).
 */
export type LlmExtractorPartial = Partial<
  Omit<LlmExtractorSlot, "backfill">
> & {
  backfill?: Partial<LlmExtractorSlot["backfill"]>;
};

/**
 * Phase 11e G2-1 — vision 슬롯도 backfill sub-object 부분 갱신 정합 (extractor 와
 * 같은 정신 — backfill 일부만 들어간 partial 허용, 나머지 칸 디스크 값 보존).
 */
export type LlmVisionPartial = Partial<Omit<LlmVisionSlot, "backfill">> & {
  backfill?: Partial<LlmVisionSlot["backfill"]>;
};

export type DocumentOcrPartial = Partial<
  Omit<DocumentOcrSettings, "pageImage" | "schedule" | "reliability" | "local" | "api" | "pcCompanion">
> & {
  pageImage?: Partial<DocumentOcrSettings["pageImage"]>;
  schedule?: Partial<DocumentOcrSettings["schedule"]>;
  reliability?: Partial<DocumentOcrSettings["reliability"]>;
  local?: Partial<DocumentOcrSettings["local"]>;
  api?: Partial<DocumentOcrSettings["api"]>;
  pcCompanion?: Partial<DocumentOcrSettings["pcCompanion"]>;
};

export type MemorySettingsPartial = {
  [K in keyof MemorySettings]?: K extends "llm"
    ? {
        extractor?: LlmExtractorPartial;
        cleanup?: Partial<LlmCleanupSlot>;
        vision?: LlmVisionPartial;
      }
    : K extends "extractor"
      ? {
          // Phase 6a T10 — regex sub-object 안 칸 단위 부분 갱신 정합.
          regex?: Partial<MemorySettings["extractor"]["regex"]>;
        }
      : K extends "images"
        ? Partial<Omit<MemorySettings["images"], "autoConceptLink">> & {
            // image-search-foundation Task 5 — autoConceptLink sub-object 도 칸
            // 단위 부분 갱신 정합 (threshold 만 들어와도 enabled 보존).
            autoConceptLink?: Partial<
              MemorySettings["images"]["autoConceptLink"]
            >;
          }
        : K extends "cleanupDeepPass"
          ? {
              // Phase 7 깊은 패스 Task 5 — regexStrengthen sub-object 칸 단위 부분
              // 갱신 정합 (enabled 만 들어와도 batchSize·임계 보존).
              regexStrengthen?: Partial<
                MemorySettings["cleanupDeepPass"]["regexStrengthen"]
              >;
              // Phase 7 요약 단계 Task 9 — summary sub-object 도 칸 단위 부분 갱신
              // 정합 (enabled 만 들어와도 atomicThreshold·임계 등 보존 — 형제 정신).
              summary?: Partial<
                MemorySettings["cleanupDeepPass"]["summary"]
              >;
              // 효율 가동 spec 5.B-2 — personLink / relationDiscovery sub-object 칸 단위
              // 부분 갱신 정합(enabled 만 들어와도 batchSize·autoApply 보존).
              personLink?: Partial<
                MemorySettings["cleanupDeepPass"]["personLink"]
              >;
              // 효율 가동 spec 6.C-2 — lensDraft sub-object 칸 단위 부분 갱신 정합
              // (enabled 만 들어와도 batchSize 보존).
              lensDraft?: Partial<
                MemorySettings["cleanupDeepPass"]["lensDraft"]
              >;
              entityRegister?: Partial<
                MemorySettings["cleanupDeepPass"]["entityRegister"]
              >;
              relationDiscovery?: Partial<
                MemorySettings["cleanupDeepPass"]["relationDiscovery"]
              >;
              // 효율 가동 spec 4.A-5 — reliability sub-object 칸 단위 부분 갱신 정합.
              reliability?: Partial<
                MemorySettings["cleanupDeepPass"]["reliability"]
              >;
              // 효율 가동 spec 4.A-5 — budget sub-object. stageAllocation 은 한 단계 더
              // 깊게(칸 하나만 들어와도 나머지 배분 칸 보존 — mergeCleanupDeepPass 참조).
              budget?: Partial<
                Omit<MemorySettings["cleanupDeepPass"]["budget"], "stageAllocation">
              > & {
                stageAllocation?: Partial<
                  MemorySettings["cleanupDeepPass"]["budget"]["stageAllocation"]
                >;
              };
            }
          : K extends "documents"
            ? {
                ocr?: DocumentOcrPartial;
              }
            : K extends "writeGuard"
              ? Partial<Omit<MemorySettings["writeGuard"], "duplicateCheck">> & {
                  // T16(결정 D-A) — duplicateCheck sub-object 칸 단위 부분 갱신
                  // 정합(enabled 만 들어와도 threshold 보존 — mergeWriteGuardGroup 짝).
                  duplicateCheck?: Partial<
                    MemorySettings["writeGuard"]["duplicateCheck"]
                  >;
                }
              : K extends "search"
                ? Partial<Omit<MemorySettings["search"], "resultFloor">> & {
                    // T20(결정 D-B) — resultFloor sub-object 칸 단위 부분 갱신
                    // 정합(enabled 만 들어와도 mode·absolute 보존 — mergeSearchGroup 짝).
                    resultFloor?: Partial<
                      MemorySettings["search"]["resultFloor"]
                    >;
                  }
          : Partial<MemorySettings[K]>;
};

/** 마스킹 출력에 첨부되는 메타 — 어느 필드가 가려졌는지 dot-path 배열. */
export type MemorySettingsWithMask = MemorySettings & {
  /** 가린 비밀 칸 경로 전부. */
  $masked?: string[];
  /** 가린 칸 중 실제 값이 저장돼 있는 경로(값은 보내지 않음). */
  $secretsSet?: string[];
};
