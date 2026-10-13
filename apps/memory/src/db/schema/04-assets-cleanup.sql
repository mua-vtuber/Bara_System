-- bara_system memory baseline schema v47 — file 4 of 4 (user patterns, assets, documents, images,
-- cleanup ledgers, summaries, schema_version). Frozen like the other baseline files; see the header
-- of 01-memory-nodes.sql.

-- ── Phase 6a: regex 자유 추가 양식 / booster 보존 (spec 단락 6.4) ───────────
-- 대시보드 안 사용자 추가 항목 한 가지 한 가지를 DB 에 보존. yaml 갈래(외부 fork)
-- 와 별 차원의 DB 갈래 — regex 1차 추출 흐름 전용. created_at/updated_at 은
-- 1.2 T13(spec 10.1)에서 다른 코어 테이블과 같은 TEXT datetime(nowKst)으로 통일.
-- TEXT datetime 은 lexicographic 비교가 곧 시간 순서라 ORDER BY created_at 정렬 유지.
CREATE TABLE IF NOT EXISTS regex_user_patterns (
    pattern_id    TEXT PRIMARY KEY,             -- 'rpat_user_' + ulid
    pattern_text  TEXT NOT NULL,                -- 정규식 본문
    score         INTEGER NOT NULL,             -- +3 / +2 / +1 / -1 / -2
    category      TEXT NOT NULL,                -- 'decision' / 'preference' / 'constraint' / 'status' / 'fact' / 'technical'
    polarity      TEXT,                         -- 'positive' / 'negative' / 'neutral' (누락 시 category default 추론 — 단락 5.4)
    description   TEXT,
    lang          TEXT NOT NULL DEFAULT 'ko',   -- 'ko' / 'en' / 'ja' / 'zh'
    enabled       INTEGER NOT NULL DEFAULT 1,
    match_count   INTEGER NOT NULL DEFAULT 0,   -- 매치 누적 (활용 통계)
    created_at    TEXT NOT NULL,                -- TEXT datetime (nowKst)
    updated_at    TEXT NOT NULL                 -- TEXT datetime (nowKst)
);

CREATE INDEX IF NOT EXISTS idx_regex_user_patterns_enabled ON regex_user_patterns(enabled);
CREATE INDEX IF NOT EXISTS idx_regex_user_patterns_lang ON regex_user_patterns(lang);

CREATE TABLE IF NOT EXISTS regex_user_boosters (
    booster_id    TEXT PRIMARY KEY,             -- 'rbst_user_' + ulid
    word          TEXT NOT NULL,                -- booster 단어
    score         INTEGER NOT NULL,             -- +3 / +2 / +1 / -1 / -2
    description   TEXT,
    lang          TEXT NOT NULL DEFAULT 'ko',
    enabled       INTEGER NOT NULL DEFAULT 1,
    hit_count     INTEGER NOT NULL DEFAULT 0,   -- 검출 누적 (활용 통계)
    created_at    TEXT NOT NULL,                -- TEXT datetime (nowKst)
    updated_at    TEXT NOT NULL,                -- TEXT datetime (nowKst)
    UNIQUE (word, lang)
);

CREATE INDEX IF NOT EXISTS idx_regex_user_boosters_enabled ON regex_user_boosters(enabled);
CREATE INDEX IF NOT EXISTS idx_regex_user_boosters_word ON regex_user_boosters(word);

-- ── Phase 6b D2: 개념 별칭 후보 (concept ANN 검출 / spec 8.3) ───────────────
-- 새 개념과 의미가 가까운(cosine ≥ 0.95) 기존 개념 쌍을 적재한다. 같은 이름은
-- name UNIQUE 로 자동 합류되므로 검출 대상이 아니다 — 이름이 다르면서 의미가
-- 같은 후보만 모은다(사용자 결정 1). 합류 결정은 대시보드 게이트(T9/T10)가 한다.
-- created_at/resolved_at 은 다른 코어 테이블 관례대로 TEXT datetime.
CREATE TABLE IF NOT EXISTS concept_alias_suggestions (
    suggestion_id        TEXT PRIMARY KEY,        -- 'casug_' + ulid
    new_concept_id       TEXT NOT NULL,           -- 방금 만들어진 개념
    candidate_concept_id TEXT NOT NULL,           -- 의미가 가까운 기존 개념
    cosine               REAL NOT NULL,           -- 1 − distance (concept_vec cosine)
    status               TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'merged', 'rejected')),
    created_at           TEXT NOT NULL,
    resolved_at          TEXT,                    -- merged/rejected 처리 시각 (pending 은 NULL)
    UNIQUE (new_concept_id, candidate_concept_id),
    FOREIGN KEY (new_concept_id) REFERENCES concept_nodes(concept_id) ON DELETE CASCADE,
    FOREIGN KEY (candidate_concept_id) REFERENCES concept_nodes(concept_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_concept_alias_status ON concept_alias_suggestions(status);
CREATE INDEX IF NOT EXISTS idx_concept_alias_new ON concept_alias_suggestions(new_concept_id);

-- ── Phase 14a 자산 보관 + 문서 메타 ────────────────────────────────────────────
-- 공통 인프라 spec 단락 1: content-addressed sha256 파일 저장.
-- 1.2 T13(spec 10.1): 시각 칸을 TEXT datetime(nowKst 'YYYY-MM-DD HH:MM:SS')으로
-- 통일한다 — 다른 코어 테이블과 한 양식으로 모아 혼란을 없앤다. TEXT datetime 은
-- lexicographic 비교가 곧 시간 순서라 ORDER BY 정렬도 그대로 유지된다.
CREATE TABLE IF NOT EXISTS asset_files (
    sha256            TEXT PRIMARY KEY,
    asset_type        TEXT NOT NULL,            -- 'text' / 'image' / 'audio'
    asset_path        TEXT NOT NULL,            -- '${BARA_ASSET_DIR}/content/{sha256}.md' 등
    byte_size         INTEGER NOT NULL,
    mime_type         TEXT,                     -- 'text/markdown' / 'application/pdf' 등
    original_name     TEXT,                     -- 첫 import 시점 원본 파일명
    first_imported_at TEXT NOT NULL             -- TEXT datetime (nowKst)
);
CREATE INDEX IF NOT EXISTS idx_asset_files_type ON asset_files(asset_type);

-- 자산 import 시점별 attribution (같은 자산 여러 번 입력 = 여러 row).
CREATE TABLE IF NOT EXISTS asset_file_imports (
    import_id     TEXT PRIMARY KEY,             -- 'imp_' + uuid
    asset_sha256  TEXT NOT NULL,
    source        TEXT NOT NULL,                -- 'discord' / 'notion' / 'dashboard:manual'
    source_ref    TEXT,
    original_name TEXT,
    imported_at   TEXT NOT NULL,                -- TEXT datetime (nowKst)
    author        TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    FOREIGN KEY (asset_sha256) REFERENCES asset_files(sha256)
);
CREATE INDEX IF NOT EXISTS idx_asset_file_imports_sha256 ON asset_file_imports(asset_sha256);
CREATE INDEX IF NOT EXISTS idx_asset_file_imports_source ON asset_file_imports(source);
CREATE INDEX IF NOT EXISTS idx_asset_file_imports_user ON asset_file_imports(user_id);
-- 원장 행을 `document:<id>`·`image:<node_id>` 로 찾아 지운다(asset-release.ts 의 해제).
CREATE INDEX IF NOT EXISTS idx_asset_file_imports_source_ref ON asset_file_imports(source_ref);

-- Phase 14 문서 메타 (spec 단락 2) — 한 자산 + 문서 형식 metadata.
-- document_type: 'meeting_log' / 'scenario' / 'notion_page' / 'reference' / 'free'.
-- chunk_count / has_summary / has_extracted 는 denormalize 캐시 (spec 명시).
-- source_metadata 는 JSON (tier1 검출 metadata 포함).
-- created_at / updated_at 은 1.2 T13(spec 10.1)에서 TEXT datetime(nowKst)으로 통일.
CREATE TABLE IF NOT EXISTS documents (
    document_id     TEXT PRIMARY KEY,           -- 'doc_' + uuid
    asset_sha256    TEXT NOT NULL,              -- canonical .md 가리킴
    title           TEXT NOT NULL,
    document_type   TEXT NOT NULL,
    chunk_count     INTEGER NOT NULL DEFAULT 0,
    has_summary     INTEGER NOT NULL DEFAULT 0,
    has_extracted   INTEGER NOT NULL DEFAULT 0,
    source_metadata TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL,              -- TEXT datetime (nowKst)
    updated_at      TEXT NOT NULL,              -- TEXT datetime (nowKst)
    FOREIGN KEY (asset_sha256) REFERENCES asset_files(sha256)
);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(document_type);
CREATE INDEX IF NOT EXISTS idx_documents_sha256 ON documents(asset_sha256);
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at);

-- 문서 기록 주인 표(v46, WP-B1-20U 설계 17.18 D32): 문서 기록마다 그 입력이 놓인 노드 하나(새 문서 노드 또는 같은
-- 본문으로 흡수한 노드). 서버만 쓴다 — 클라이언트 metadata 로 쓸 수 없다. 기록이 지워지면 CASCADE 로 함께 지워지고,
-- 노드 쪽 외래 키는 없다(휴지통 이동·복원이 번호를 지키므로 주인이 두 표를 오가도 그대로). 색인
-- idx_document_record_owners_node 는 지운 노드 id 로 그 노드가 주인인 기록을 찾는다.
CREATE TABLE IF NOT EXISTS document_record_owners (
    document_id TEXT PRIMARY KEY REFERENCES documents(document_id) ON DELETE CASCADE,
    node_id     INTEGER NOT NULL,  -- knowledge_nodes.id, 휴지통이면 같은 번호의 knowledge_nodes_archive.id
    created_at  TEXT NOT NULL      -- TEXT datetime (nowKst)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_document_record_owners_node ON document_record_owners(node_id);

-- DB·첨부 폴더 짝 표(v47, WP-B1-20U 설계 17.19 D39): 한 행. 첨부 파일 폴더의 bara-asset-pairing.json 과 같은 짝 번호일
-- 때만 서버 시작 정리가 그 폴더의 파일을 지운다(판정은 asset-file-remover-boot.ts 의 ensureAssetFolderPairing). 데이터
-- 초기화는 이 행을 비우지 않는다. 표 이름은 asset-folder-pairing-repository.ts 의 ASSET_FOLDER_PAIRING_TABLE 과 같다.
CREATE TABLE IF NOT EXISTS asset_folder_pairing (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    pairing_id TEXT NOT NULL,  -- crypto.randomUUID()
    created_at TEXT NOT NULL   -- nowKst, 사람이 읽는 용도(비교하지 않음)
);

-- ── Phase 11a T1: 이미지 자산 메타 + ANN 색인 (spec 단락 5·6) ──────────────────
-- images: 자산 단위 metadata(보존 모드 분기·미리보기 sha256·움직임 경고 배열·해상도).
-- image_vec: SigLIP 2 base-256 768-dim 임베딩 ANN(cosine 거리). knowledge_nodes.id
-- 정합(node_id) — image_asset 노드 한 행마다 한 임베딩.
-- created_at 은 다른 v1 코어 테이블(TEXT datetime) 관례 정합 — 14a 의 epoch ms 양식과
-- 다름(이미지 metadata 는 운영 표시용 / asset_files 안 first_imported_at 이 정해진
-- import 시각을 따로 보유).
CREATE TABLE IF NOT EXISTS images (
    asset_sha256    TEXT PRIMARY KEY,             -- asset_files.sha256 정합(원본 또는 사본)
    thumb_sha256    TEXT,                          -- 미리보기 자산 sha256(asset_files 별 행)
    width           INTEGER NOT NULL,
    height          INTEGER NOT NULL,
    mime            TEXT NOT NULL,                 -- 'image/png' / 'image/jpeg' / 'image/gif' / ...
    preserve_mode   TEXT NOT NULL,                 -- 'smart' / 'original' / 'resized'
    is_animated     INTEGER NOT NULL DEFAULT 0,    -- 1 = GIF/APNG/animated webp
    warnings_json   TEXT NOT NULL DEFAULT '[]',    -- 움직임 손실 경고 등 JSON array
    has_caption_auto INTEGER NOT NULL DEFAULT 0,   -- 1 = T10 VLM 자동 캡션 자식 노드 생성됨 (image_caption 자식 노드 존재 신호)
    created_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (asset_sha256) REFERENCES asset_files(sha256)
);

-- 1.2 T13(spec 10.2 A-6): 옛 idx_images_thumb 색인 제거 — thumb_sha256 로 조회하는
-- 코드가 없어(미리보기는 노드 metadata 의 thumb_sha256 을 직접 들고 다님) 색인 가치가
-- 0이었다. thumb_sha256 칸·미리보기 기능은 보존.
CREATE INDEX IF NOT EXISTS idx_images_mime ON images(mime);
CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at DESC);

-- SigLIP 2 base-256 768-dim 임베딩. node_id = knowledge_nodes.id (image_asset 노드).
-- distance_metric = cosine — vec_nodes / concept_vec 패턴 정합. vec0 는 FK 불가 →
-- DELETE 동기화는 트리거(image_vec_delete).
CREATE VIRTUAL TABLE IF NOT EXISTS image_vec USING vec0(
    node_id INTEGER PRIMARY KEY,
    embedding float[768] distance_metric=cosine
);

CREATE TRIGGER IF NOT EXISTS image_vec_delete AFTER DELETE ON knowledge_nodes BEGIN
    DELETE FROM image_vec WHERE node_id = old.id;
END;

-- 고아 images 행 정리 (image-search-foundation Task 2 a/A2 / D-A1). images 는
-- asset_files 를 FK 참조라 knowledge_nodes 삭제에 CASCADE 안 됨 → image_asset 노드
-- 삭제 시 images 행이 고아로 남던 흠 해소. WHEN 가드로 image_asset 노드 삭제에만
-- 동작(다른 노드 삭제엔 무영향). 공유 자산 보호: AFTER DELETE 라 old 노드는 이미
-- knowledge_nodes 에서 빠진 상태 → NOT EXISTS 는 같은 asset_sha256 을 metadata 에
-- 가진 "남은 다른 image_asset 노드"만 본다. 다른 노드가 남으면 images 행 보존,
-- 마지막 노드가 지워질 때만 정리. images 와 knowledge_nodes 는 metadata_json.$.asset_sha256
-- 으로 이어진다(node-repository.ts join 선례 정합).
CREATE TRIGGER IF NOT EXISTS images_node_delete
    AFTER DELETE ON knowledge_nodes
    WHEN old.source_type = 'image_asset'
BEGIN
    DELETE FROM images
    WHERE asset_sha256 = json_extract(old.metadata_json, '$.asset_sha256')
      AND NOT EXISTS (
        SELECT 1 FROM knowledge_nodes kn
        WHERE kn.source_type = 'image_asset'
          AND json_extract(kn.metadata_json, '$.asset_sha256')
              = json_extract(old.metadata_json, '$.asset_sha256')
      );
END;

-- Phase 11b T12: Phase 7 cleanup-AI 가 emit 한 정리 제안 큐. 상태는 'pending' 으로
-- 들어와 사용자/관리자 검토 후 'approved' 또는 'rejected' 로 갱신된다. payload 는
-- 자유 JSON — kind 별로 형태가 다르다 (병합 후보, 별칭 후보, 폐기 후보 등). created_at
-- /resolved_at 은 TEXT datetime 관례 (코어 노드 가족 정합).
CREATE TABLE IF NOT EXISTS cleanup_proposals (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cleanup_proposals_status ON cleanup_proposals(status);

-- AI 사용성 업그레이드 spec 5-9(T32): 제안 항목별 적용 원장. 한 제안 payload 안 여러
-- 변경을 항목(item)으로 쪼개, 사용자가 고른 항목만 적용하고(부분 승인) 적용된 항목을
-- 여기 한 줄씩 남긴다. 적용 도중 프로세스가 끊겨도 이 원장이 "어디까지 적용됐는지"를
-- 들고 있어, 다음 적용 시도가 이미 적용된 항목을 건너뛴다(중복 적용 차단).
--
-- status 세 값 — 'applied'(적용 성공) / 'skipped'(사용자 미선택·checksum 불일치로 적용
-- 안 함) / 'failed'(적용 함수가 구체 오류로 거부). item_key 는 kind 별 항목 식별자
-- (lens_draft = "columns:칸이름" 양식) — 같은 제안 안에서 유일하다.
--
-- PK(proposal_id, item_key)가 중복 적용을 DB 수준에서도 막는다(재적용 INSERT 충돌).
-- 인덱스는 PK 자동 인덱스로 충분하다 — 조회가 항상 proposal_id 선두다.
-- after_fingerprint: 항목 적용 *직후* 대상 지문. 중단 후 재시도가 이 값을 기준으로
-- 대조한다 — 앞선 시도가 스스로 만든 변화는 통과시키고, 그 뒤 남이 손댄 변화는
-- 여전히 잡는다(중단 복구와 적용 시점 checksum 을 양립시키는 칸).
CREATE TABLE IF NOT EXISTS cleanup_proposal_item_journal (
    proposal_id       TEXT NOT NULL,
    item_key          TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('applied', 'skipped', 'failed')),
    detail            TEXT,
    after_fingerprint TEXT,
    applied_at        TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (proposal_id, item_key)
);

-- 데이터 정리 AI 효율 가동(spec 4.A-3): 깊은 패스 각 단계의 처리 결과 원장. 유료
-- 강모델 연결 시 같은 대상에 영구 재과금하지 않도록 성공·무산출·실패 전 상태를 한
-- 테이블에 남긴다. status 네 값 — 'completed'(산출 있음) / 'completed_noop'(정상
-- 회신인데 산출 0 — 무산출 재과금 차단의 핵심) / 'retryable_failure'(일시 오류,
-- next_retry_at 후 재시도) / 'terminal_failure'(결정적 실패 attempt 소진). 재처리는
-- input_fingerprint 가 바뀌거나 stage_version 이 오를 때만 — completed/completed_noop
-- 행은 지우지 않는다. PK(stage, target_key)는 CREATE TABLE 제약이라 자동 인덱스다.
-- 재시도 조회 인덱스(idx_cleanup_stage_results_retry)는 (stage, status, next_retry_at) 묶음으로
-- retryable_failure 후보의 next_retry_at 경과분을 찾는다.
CREATE TABLE IF NOT EXISTS cleanup_stage_results (
    stage             TEXT NOT NULL,
    target_key        TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('completed', 'completed_noop', 'retryable_failure', 'terminal_failure')),
    input_fingerprint TEXT NOT NULL,
    stage_version     INTEGER NOT NULL,
    attempt_count     INTEGER NOT NULL DEFAULT 0,
    next_retry_at     TEXT,
    last_error        TEXT,
    updated_at        TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    PRIMARY KEY (stage, target_key)
);
CREATE INDEX IF NOT EXISTS idx_cleanup_stage_results_retry ON cleanup_stage_results(stage, status, next_retry_at);

-- 데이터 정리 AI 효율 가동(spec 5.B-1): 깊은 패스 실행 단위(run) 원장 cleanup_runs.
-- 수동 실행(run API)과 정기 스케줄 tick 이 한 통로로 run 행을 남겨, 진행·집계·취소를
-- 같은 관측면에서 본다. status 네 값 — 'running'(진행) / 'completed'(정상 종료) /
-- 'cancelled'(사용자 취소 — 실패 아님, 완료분 원장 유효) / 'failed'(설정 결함 등 중단).
-- trigger 두 값 — 'manual'(run API) / 'scheduled'(정기 tick). options_json 은 요청
-- 옵션(stages/dryRun/maxCalls) 원문, aggregates_json 은 종료 시 단계별 집계(처리·성공·
-- noop·실패 + 호출·토큰 누적). idempotency_key 는 UNIQUE — 같은 키 재요청이 같은 runId
-- 를 돌려받아 중복 실행을 막는다(NULL 은 UNIQUE 제약에서 서로 충돌하지 않으므로 키
-- 없는 run 은 자유 다중 생성). created/finished 는 TEXT datetime 관례. idempotency 재요청
-- 조회 인덱스(idx_cleanup_runs_idem)는 표 아래에 있다.
CREATE TABLE IF NOT EXISTS cleanup_runs (
    run_id          TEXT PRIMARY KEY,
    trigger         TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
    status          TEXT NOT NULL CHECK (status IN ('running', 'completed', 'cancelled', 'failed')),
    started_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    finished_at     TEXT,
    options_json    TEXT NOT NULL DEFAULT '{}',
    aggregates_json TEXT NOT NULL DEFAULT '{}',
    idempotency_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_cleanup_runs_idem ON cleanup_runs(idempotency_key);

-- Phase 7 2차 ① 토대: events 큐. 알림(정리 제안 ready 등)을 영구 적재해 "하나도 안
-- 놓침" 을 보장한다. id 가 단조 증가하므로 SSE Last-Event-ID 커서로 쓴다 — 끊겼다
-- 재연결하면 마지막 받은 id 다음부터 이어받는다. payload_json 은 자유 JSON(type 별로
-- 형태가 다르다). created_at 은 TEXT datetime 관례. events 는 id(INTEGER PRIMARY
-- KEY = rowid 색인)만으로 이어받기 범위 조회가 되므로 추가 인덱스는 없다.
CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    type         TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Phase 7 요약 단계: 청크요약 + 관계요약 + 두 임베딩 vec0 (v13) ──────────────
-- 데이터 정리 깊은 패스 둘째 단계 "요약" 의 저장소. chunk_summaries = 한 청크의 한
-- 문장 대표 요약(검색·열람용). relation_summaries = 강한 LLM 이 발굴한 개념 쌍 +
-- 이름 있는 관계 요약(라이벌/소속 등). generated_at 은 코어 노드 가족 관례대로
-- TEXT datetime. has_embedding 은 vec0 임베딩 적재 신호(default 0). 각 표의 조회 인덱스는
-- 표 아래, vec0 정리 트리거 둘은 두 vec0 표 아래에 있다.
CREATE TABLE IF NOT EXISTS chunk_summaries (
    summary_id         TEXT PRIMARY KEY,            -- 'cs_' + ulid
    parent_chunk_id    INTEGER NOT NULL,            -- knowledge_nodes.id (document_chunk 노드)
    parent_document_id TEXT NOT NULL,               -- documents.document_id
    summary_text       TEXT NOT NULL,
    generated_by       TEXT NOT NULL,               -- 'llm' / 'first_paragraph_fallback' / 'user_edit'
    generated_at       TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    has_embedding      INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (parent_chunk_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_document_id) REFERENCES documents(document_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chunk_summaries_chunk ON chunk_summaries(parent_chunk_id);
CREATE INDEX IF NOT EXISTS idx_chunk_summaries_document ON chunk_summaries(parent_document_id);

-- 2026-06-05 정밀화(Q14): from/to 가 *개념 id*(concept_nodes 'cpt_' / persons 'psn_').
-- 두 부모를 한 칸이 담으므로 단일 FK 를 두지 않는다(애플리케이션 실재 게이트가 막음).
-- cascade·멱등은 source_document_id(documents) 기준 — 문서 삭제 시 발굴 산출 정리 +
-- 한 문서 재발굴 차단.
CREATE TABLE IF NOT EXISTS relation_summaries (
    summary_id         TEXT PRIMARY KEY,            -- 'rs_' + uuid
    from_concept_id    TEXT NOT NULL,               -- concept_nodes.concept_id 또는 persons.person_id
    to_concept_id      TEXT NOT NULL,               -- concept_nodes.concept_id 또는 persons.person_id
    relation_name      TEXT NOT NULL,               -- 발굴된 관계 이름 (라이벌/소속/인과 등)
    summary_text       TEXT NOT NULL,
    confidence         REAL NOT NULL,               -- 발굴 confidence (엣지 승격 게이트 기준)
    generated_by       TEXT NOT NULL,               -- 'llm' (관계요약은 LLM 한정 — fallback 없음)
    generated_at       TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    has_embedding      INTEGER NOT NULL DEFAULT 0,
    source_document_id TEXT NOT NULL,               -- documents.document_id (멱등 판정 + cascade)
    FOREIGN KEY (source_document_id) REFERENCES documents(document_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_relation_summaries_from ON relation_summaries(from_concept_id);
CREATE INDEX IF NOT EXISTS idx_relation_summaries_to ON relation_summaries(to_concept_id);
CREATE INDEX IF NOT EXISTS idx_relation_summaries_source_doc ON relation_summaries(source_document_id);

-- 요약 임베딩 ANN — 글 임베딩과 같은 공간(같은 모델·차원). 차원은 글 벡터 vec_nodes
-- 와 함께 applyBaselineSchema 가 selected 모델 차원으로 치환한다(1.2 T13 으로 default 1024 =
-- bge-m3 / legacy 384-dim 비교는 embeddingDim=384 명시 시 — image_vec 768 고정 리터럴과
-- 다른 글 모델 연동). vec0 는 FK 불가 → DELETE 동기화는 아래 트리거 둘(chunk_summary_vec_delete /
-- relation_summary_vec_delete). summary_rowid = 요약 테이블 rowid 매핑.
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_summary_vec USING vec0(
    summary_rowid INTEGER PRIMARY KEY,
    embedding float[1024] distance_metric=cosine
);

CREATE VIRTUAL TABLE IF NOT EXISTS relation_summary_vec USING vec0(
    summary_rowid INTEGER PRIMARY KEY,
    embedding float[1024] distance_metric=cosine
);

-- vec0 정리 트리거 (vec0 FK 불가 회피 — concept_siglip_vec_delete 패턴 정합).
-- 요약 행 삭제(직접 또는 노드·문서 cascade) 시 임베딩 고아 방지.
CREATE TRIGGER IF NOT EXISTS chunk_summary_vec_delete AFTER DELETE ON chunk_summaries BEGIN
    DELETE FROM chunk_summary_vec WHERE summary_rowid = old.rowid;
END;
CREATE TRIGGER IF NOT EXISTS relation_summary_vec_delete AFTER DELETE ON relation_summaries BEGIN
    DELETE FROM relation_summary_vec WHERE summary_rowid = old.rowid;
END;

-- 2026-06-06 태그 위계 자동 재정리(B) 되돌리기 기록. 콜론 위계 선언 시 평평하게
-- 붙은 과거 글에서 부모 연결을 뗄 때, 떼어낸 (글·부모 개념·트리거 위계·시각)을
-- 보존한다(되돌리기 재료 — spec §4.2.2). FK 는 두지 않는다 — 글·개념이 나중에
-- 삭제돼도 "이 글에서 이 부모를 뗐었다"는 역사 기록이 남는 게 감사·되돌리기에
-- 정직하다(concept_edges 가 FK 없이 두 부모를 담는 양식 정합). 인덱스(idx_trl_node)는 글별 조회용이다.
CREATE TABLE IF NOT EXISTS tag_reflow_log (
    log_id            TEXT PRIMARY KEY,            -- 'trl_' + crypto.randomUUID()
    node_id           INTEGER NOT NULL,            -- 부모 연결을 뗀 글
    parent_concept_id TEXT NOT NULL,               -- 떼어낸 부모 개념
    trigger_hierarchy TEXT NOT NULL,               -- 어떤 위계 선언이 촉발했나 (예: 'category→value')
    detached_at       TEXT NOT NULL                -- 떼어낸 시각 (nowKst)
);
CREATE INDEX IF NOT EXISTS idx_trl_node ON tag_reflow_log(node_id);

-- Schema version registry. applyBaselineSchema (db/baseline-schema.ts) inserts the baseline
-- version row in the same transaction as these files; each v48+ migration adds its own row.
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
