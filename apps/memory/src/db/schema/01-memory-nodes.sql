-- bara_system memory baseline schema v47 — file 1 of 4 (memory nodes).
-- db/baseline-schema.ts applyBaselineSchema runs the four files in BASELINE_SCHEMA_FILES order inside one
-- transaction, only on an empty database (zero sqlite_master objects), then records schema_version 47.
-- These files are frozen: their sha256 sits in the header of src/test-utils/schema-snapshot.txt, and
-- schema changes are added as v48+ migrations in db/migrations.ts instead of edits here. The CREATE
-- lines keep IF NOT EXISTS because they were moved unchanged from the pre-squash schema and up() code.
--
-- Integrates old Python migrations 003 (embeddings), 005 (knowledge graph), 006 (mention boost)
-- into a single fresh schema. Old BLOB embedding column is replaced by sqlite-vec vec0
-- virtual table for native ANN search.
--
-- Phase 1 scope: knowledge_nodes + FTS5 + edges + vec_nodes.
-- Deferred tables (added when their consumers arrive): entity_profiles, sentiment_history,
-- consolidation_log, memory_sessions.

-- Atomic memory units: facts, preferences, triples, insights, episodes.
CREATE TABLE IF NOT EXISTS knowledge_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    memory_type TEXT NOT NULL DEFAULT 'fact',
    source_type TEXT NOT NULL DEFAULT 'auto_capture',
    importance REAL NOT NULL DEFAULT 0.5,
    confidence REAL NOT NULL DEFAULT 0.7,
    platform TEXT DEFAULT '',
    author TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT NULL, -- 수동 본문 수정 시각. NULL = 생성 후 본문 수정 없음.
    last_accessed_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    access_count INTEGER NOT NULL DEFAULT 0,
    mention_count INTEGER NOT NULL DEFAULT 0,
    last_mentioned_at TEXT DEFAULT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    embedding_text TEXT,        -- D6 / 임베딩 입력 본문 (검색 최적화 / Level 0 fallback = raw content)
    polarity TEXT,              -- D7 / 'positive' | 'negative' | 'neutral' (regex 매치 시점 추론 / default NULL)
    project_id TEXT,            -- D8 / 다중 프로젝트 어휘 가르마 (default NULL)
    event_at TEXT,              -- Phase 7 갈래 1 / 사건 발생 시각 (과거 포함 / created_at 과 별개 / default NULL / 검색은 COALESCE(event_at, created_at))
    event_until TEXT,           -- 활용 단계2 ① / 일정 종료 일시 (NULL 이면 단일 시점 / 저장 구간 = [event_at, COALESCE(event_until, event_at)] / 검색 구간 겹침)
    content_hash TEXT           -- P0-A 입력 멱등성 / 정규화(NFC+trim) 후 sha256 hex. 정확-중복 흡수 키(흡수는 (content_hash, project_id) 로 가른다 — 같은 내용 다른 project 는 별 노드 / D8). 이미지 노드는 NULL. 복합 부분 인덱스 idx_kn_content_hash(content_hash, project_id) WHERE content_hash IS NOT NULL 은 아래 인덱스 묶음에 있다.
);

CREATE INDEX IF NOT EXISTS idx_kn_memory_type ON knowledge_nodes(memory_type);
CREATE INDEX IF NOT EXISTS idx_kn_author ON knowledge_nodes(author);
CREATE INDEX IF NOT EXISTS idx_kn_importance ON knowledge_nodes(importance DESC);
CREATE INDEX IF NOT EXISTS idx_kn_last_accessed ON knowledge_nodes(last_accessed_at);
CREATE INDEX IF NOT EXISTS idx_kn_source_type ON knowledge_nodes(source_type);
CREATE INDEX IF NOT EXISTS idx_kn_platform ON knowledge_nodes(platform);
CREATE INDEX IF NOT EXISTS idx_kn_mention_count ON knowledge_nodes(mention_count DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_project ON knowledge_nodes(project_id);
-- 최신순 조회(getRecent·백필 since 조회). created_at 은 TEXT datetime(nowKst)이라
-- lexicographic 비교가 곧 시간 순서 — DESC 인덱스가 ORDER BY created_at DESC, id DESC
-- 를 정렬 없이 태운다. id DESC 를 두 번째 열로 둬 같은 초 안 삽입된 행의 tie 를 인덱스
-- 만으로 끊는다(getRecent 의 tie-breaker 와 정합).
CREATE INDEX IF NOT EXISTS idx_kn_created_at ON knowledge_nodes(created_at DESC, id DESC);
-- 프로젝트별 최신순 조회(getProjectMemberNodes — 그래프 허브 조립). project_id 로 좁힌 뒤
-- created_at DESC, id DESC 로 최신을 앞세운다. idx_knowledge_nodes_project(project_id 단독)
-- 는 정렬을 인덱스로 못 잡아 별도 sort 가 걸렸다 — 이 복합 인덱스가 필터+정렬을 한 번에 태운다.
CREATE INDEX IF NOT EXISTS idx_kn_project_created ON knowledge_nodes(project_id, created_at DESC, id DESC);
-- 사건 시각 조회(검색 기간 필터가 COALESCE(event_at, created_at) 로 좁힐 때 event_at 쪽).
CREATE INDEX IF NOT EXISTS idx_kn_event_at ON knowledge_nodes(event_at);
-- 복합 인덱스 (content_hash, project_id) — 흡수 조회가 (content_hash, project_id)
-- 로 좁혀지므로(addNodeIdempotent: WHERE content_hash = ? AND project_id = ?/IS
-- NULL) 복합으로 둬 project 별 조회가 인덱스만으로 끝난다. WHERE 부분 조건:
-- content_hash IS NULL 인 이미지 노드는 흡수 대상이 아니라 색인 제외.
CREATE INDEX IF NOT EXISTS idx_kn_content_hash ON knowledge_nodes(content_hash, project_id) WHERE content_hash IS NOT NULL;

-- FTS5 full-text index. unicode61 tokenizer handles Korean code points; morpheme-aware
-- search (mecab-ko) is deferred per architecture.md.
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_nodes_fts USING fts5(
    content,
    content='knowledge_nodes',
    content_rowid='id',
    tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS kn_fts_insert AFTER INSERT ON knowledge_nodes BEGIN
    INSERT INTO knowledge_nodes_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS kn_fts_delete AFTER DELETE ON knowledge_nodes BEGIN
    INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, content)
    VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS kn_fts_update AFTER UPDATE OF content ON knowledge_nodes BEGIN
    INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, content)
    VALUES ('delete', old.id, old.content);
    INSERT INTO knowledge_nodes_fts(rowid, content) VALUES (new.id, new.content);
END;

-- 한국어 합성어 부분 매치 보조 색인 (1.1a / 상위 spec 단락 16 / DCL-1). trigram =
-- 3-gram(연속 3 코드포인트) 색인 — "변경이유" 적재 시 "변경이"·"경이유" 색인 →
-- "변경이유"·"디스코드" 등 3글자 이상 합성어 부분 매치 가능. 단 2글자 검색어는
-- trigram 에서 매치 0건이므로(격리 검증 확정), 위 unicode61 본색인이 2글자를 맡고
-- 이 보조 색인이 3글자+ 합성어 부분 매치를 맡는다(searchByFts 가 두 색인을 RRF 합침).
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_nodes_trgm USING fts5(
    content,
    content='knowledge_nodes',
    content_rowid='id',
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS kn_trgm_insert AFTER INSERT ON knowledge_nodes BEGIN
    INSERT INTO knowledge_nodes_trgm(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS kn_trgm_delete AFTER DELETE ON knowledge_nodes BEGIN
    INSERT INTO knowledge_nodes_trgm(knowledge_nodes_trgm, rowid, content)
    VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS kn_trgm_update AFTER UPDATE OF content ON knowledge_nodes BEGIN
    INSERT INTO knowledge_nodes_trgm(knowledge_nodes_trgm, rowid, content)
    VALUES ('delete', old.id, old.content);
    INSERT INTO knowledge_nodes_trgm(rowid, content) VALUES (new.id, new.content);
END;

-- ANN index. cosine distance matches the model's intended similarity metric.
--
-- 글 벡터 차원은 선택된 임베딩 모델에서 자동으로 정해진다 — baseline-schema.ts 의
-- applyBaselineSchema 가 settings.db.embeddingModel 차원으로 아래 `float[1024]` 리터럴을
-- 치환한다. 1.2 T13(spec 10.5): baseline 기본 차원을 운영 default bge-m3(1024)로
-- 맞춰 "스키마 기본값이 실제 운영 모델과 어긋나던 혼란"을 없앴다(default 1024 = byte
-- 동일 / legacy 384-dim 비교는 embeddingDim=384 명시 전달 시 384 로 치환). 이 파일은
-- default 차원을 보유하고, 실제 치환은 빈 DB 부팅 시점에 일어난다.
-- 차원이 다른 기존 DB 를 열면 openMemoryDatabase 가 구체 에러로 멈춘다(빈 DB
-- 재시작 안내 / 운영 DB 자동 삭제 안 함). SigLIP 768 가상 테이블은 글 임베딩과
-- 무관해 치환 밖이다(패턴이 float[1024] 한정 — 768 자연 보존).
CREATE VIRTUAL TABLE IF NOT EXISTS vec_nodes USING vec0(
    node_id INTEGER PRIMARY KEY,
    embedding float[1024] distance_metric=cosine
);

-- vec0 cannot participate in SQL foreign keys, so a trigger keeps it in sync.
CREATE TRIGGER IF NOT EXISTS kn_vec_delete AFTER DELETE ON knowledge_nodes BEGIN
    DELETE FROM vec_nodes WHERE node_id = old.id;
END;

-- Relationship graph between nodes (supersedes, contradicts, related_to, etc.).
CREATE TABLE IF NOT EXISTS knowledge_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    relation TEXT NOT NULL DEFAULT 'related_to',
    provenance TEXT NOT NULL,
    source_node_id INTEGER,
    weight REAL NOT NULL DEFAULT 1.0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (source_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ke_source ON knowledge_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_ke_target ON knowledge_edges(target_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ke_pair ON knowledge_edges(source_id, target_id, relation);

-- Archive: evolver가 가치 점수 임계값 이하로 판단한 노드 이동처.
-- 30일 보존 후 영구 삭제. /restore로 knowledge_nodes로 복원 가능.
CREATE TABLE IF NOT EXISTS knowledge_nodes_archive (
    id INTEGER PRIMARY KEY,
    content TEXT NOT NULL,
    memory_type TEXT NOT NULL,
    source_type TEXT NOT NULL,
    importance REAL NOT NULL,
    confidence REAL NOT NULL,
    platform TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT,
    last_accessed_at TEXT NOT NULL,
    access_count INTEGER NOT NULL DEFAULT 0,
    mention_count INTEGER NOT NULL DEFAULT 0,
    last_mentioned_at TEXT DEFAULT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    embedding_text TEXT,
    polarity TEXT,
    project_id TEXT,
    event_at TEXT,                              -- 1.2 T13(spec 10.3 A-5) / 보관 시 사건 시각 보존 → 복원 시 그대로 회복
    event_until TEXT,                           -- 활용 단계2 ② / 보관 시 일정 종료 일시 보존 → 복원 시 그대로 회복 (유실 차단)
    content_hash TEXT,                          -- P0-A 입력 멱등성 / 보관 시 정규화 해시 보존 → 복원 시 그대로 회복 (v35 updated_at 선례 정합)
    archived_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_archive_archived_at ON knowledge_nodes_archive(archived_at);

-- evolver 사이클별 한 행. 대시보드 활동 섹션이 읽음.
-- 1.2 T13(spec 10.2 A-3): 옛 concepts_emerged / concepts_archived 두 칸을 제거했다 —
-- 채우는 logEvolverActivity 의 운영 호출처가 0이고 봇·대시보드·라우트 round-trip 도
-- 그 두 값을 안 읽어, 둘 다 0 으로만 적히던 죽은 칸이었다.
CREATE TABLE IF NOT EXISTS evolver_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ran_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    cluster_edges_added INTEGER NOT NULL DEFAULT 0,
    nodes_archived INTEGER NOT NULL DEFAULT 0,
    nodes_purged INTEGER NOT NULL DEFAULT 0,
    soon_to_purge_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_activity_ran_at ON evolver_activity(ran_at);

-- 노드 변경 이력. ConflictChecker가 supersede 시 자동 INSERT, manual/evolution/
-- duplicate_merge 경로도 같은 테이블 공유. new_node_id는 nullable (순수 비활성화).
-- relation/CHECK는 DB 제약으로 강제 — types.ts RevisionType union과 1:1.
-- source_message_id·source_platform(v45): 외부 메시지의 동기 수정(PATCH by-source 의 같은 id 수정·분리 이력)이
-- 남긴 행만 그 메시지 id·출처 행 플랫폼을 적는다. 메시지 삭제가 이 칸으로 행을 찾아 본문을 지운다(WP-B1-20U
-- 설계 17.6). 부분 색인 idx_revisions_source_message 는 표 아래 인덱스 묶음에 있다 — 메시지 동기 수정이 아닌
-- 대부분의 행(NULL)은 색인에 들어가지 않는다.
CREATE TABLE IF NOT EXISTS memory_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    old_node_id INTEGER NOT NULL,
    new_node_id INTEGER,
    revision_type TEXT NOT NULL CHECK (revision_type IN (
        'conflict_supersede', 'manual', 'evolution', 'duplicate_merge'
    )),
    reason TEXT,
    similarity_score REAL,
    old_content TEXT,
    new_content TEXT,
    editor TEXT,
    edit_source TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    source_message_id TEXT,
    source_platform TEXT
);

CREATE INDEX IF NOT EXISTS idx_revisions_old ON memory_revisions(old_node_id);
CREATE INDEX IF NOT EXISTS idx_revisions_new ON memory_revisions(new_node_id);
CREATE INDEX IF NOT EXISTS idx_revisions_created ON memory_revisions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_revisions_source_message ON memory_revisions(source_message_id)
       WHERE source_message_id IS NOT NULL;

-- Shared AI memory: atomic retry results and source-event claim identities (v42).
CREATE TABLE IF NOT EXISTS memory_mutations (
    request_id TEXT PRIMARY KEY,
    node_id INTEGER NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_source_events (
    event_key TEXT PRIMARY KEY,
    node_id INTEGER NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
    evidence_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

-- 근거 원장 노드별 읽기.
CREATE INDEX IF NOT EXISTS idx_mse_node ON memory_source_events(node_id);

-- Default read visibility generation (v43). Visibility is a function of knowledge_nodes
-- (id, project_id, source_type, metadata_json) and lineage edges only; these triggers bump
-- the number whenever those inputs change, so an equal number reuses the cached snapshot
-- (shared-memory-read.ts). The INSERT below seeds the single id = 1 row at generation 0; the
-- relation names in the edge triggers match SHARED_MEMORY_LINEAGE_RELATIONS (shared-memory-contract.ts).
CREATE TABLE IF NOT EXISTS memory_visibility_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    generation INTEGER NOT NULL
);

INSERT OR IGNORE INTO memory_visibility_state (id, generation) VALUES (1, 0);

CREATE TRIGGER IF NOT EXISTS kn_visibility_insert AFTER INSERT ON knowledge_nodes BEGIN
    UPDATE memory_visibility_state SET generation = generation + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS kn_visibility_delete AFTER DELETE ON knowledge_nodes BEGIN
    UPDATE memory_visibility_state SET generation = generation + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS kn_visibility_update
AFTER UPDATE OF id, project_id, source_type, metadata_json ON knowledge_nodes
WHEN old.id IS NOT new.id OR old.project_id IS NOT new.project_id
  OR old.source_type IS NOT new.source_type OR old.metadata_json IS NOT new.metadata_json
BEGIN
    UPDATE memory_visibility_state SET generation = generation + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS ke_visibility_insert AFTER INSERT ON knowledge_edges
WHEN new.relation IN ('merged_into', 'parent_of')
BEGIN
    UPDATE memory_visibility_state SET generation = generation + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS ke_visibility_delete AFTER DELETE ON knowledge_edges
WHEN old.relation IN ('merged_into', 'parent_of')
BEGIN
    UPDATE memory_visibility_state SET generation = generation + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS ke_visibility_update
AFTER UPDATE OF source_id, target_id, relation, provenance ON knowledge_edges
WHEN old.relation IN ('merged_into', 'parent_of') OR new.relation IN ('merged_into', 'parent_of')
BEGIN
    UPDATE memory_visibility_state SET generation = generation + 1 WHERE id = 1;
END;

-- Node source lists (v44): which saves hold each memory (a message, a direct save, a restore).
-- Server-owned; clients cannot write them through metadata. The archive table keeps the rows of
-- trashed nodes plus 'archived_lineage' rows (external_id = lineage parent id). The kind CHECK lists
-- match NODE_SOURCE_KINDS / ARCHIVED_LINEAGE_KIND (memory/node-sources/source-ref.ts).
CREATE TABLE IF NOT EXISTS memory_node_sources (
    node_id     INTEGER NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
    source_key  TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('message', 'direct_save', 'restore')),
    platform    TEXT,
    external_id TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL,
    PRIMARY KEY (node_id, source_key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS memory_node_sources_archive (
    node_id     INTEGER NOT NULL REFERENCES knowledge_nodes_archive(id) ON DELETE CASCADE,
    source_key  TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('message', 'direct_save', 'restore', 'archived_lineage')),
    platform    TEXT,
    external_id TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL,
    PRIMARY KEY (node_id, source_key)
) WITHOUT ROWID;

-- (kind, external_id) — 메시지 id·계보 부모 id 로 출처 행을 찾는다.
CREATE INDEX IF NOT EXISTS idx_mns_external ON memory_node_sources(kind, external_id);
CREATE INDEX IF NOT EXISTS idx_mnsa_external ON memory_node_sources_archive(kind, external_id);

-- 다중 프로젝트 어휘 의미 차이 (D8). 검색 시점 ?project=<id> query expansion 소비 = Wave 1.1.
-- 1.0a는 테이블만 — 쓰는 통로(대시보드/cleanup-AI)·읽는 통로(검색)는 후속 wave.
CREATE TABLE IF NOT EXISTS project_vocabularies (
    project_id       TEXT NOT NULL,
    term             TEXT NOT NULL,
    expanded_meaning TEXT NOT NULL,
    added_at         TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    added_by         TEXT,
    PRIMARY KEY (project_id, term)
);

