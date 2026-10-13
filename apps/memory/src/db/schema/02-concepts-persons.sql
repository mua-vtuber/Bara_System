-- bara_system memory baseline schema v47 — file 2 of 4 (concepts, persons, their search indexes).
-- Frozen like the other baseline files; see the header of 01-memory-nodes.sql.

-- ── 1.0b: 개념·사람·관계 전용 테이블 ──────────────────────────────────────
-- 옛 양식(knowledge_nodes 안 is_concept=1 행)을 전용 테이블로 분리.
-- knowledge_nodes 에는 실제 메모리 글(자산 노드)만 남는다.
-- id 는 application 이 crypto.randomUUID() + 접두사로 생성(cpt_ / psn_).

-- 개념 통합 테이블(태그·분류). 같은 이름 = 같은 노드(name UNIQUE).
CREATE TABLE IF NOT EXISTS concept_nodes (
    concept_id  TEXT PRIMARY KEY,             -- 'cpt_' + crypto.randomUUID()
    name        TEXT UNIQUE NOT NULL,         -- canonical 이름
    ko_name     TEXT,
    ko_aliases  TEXT,                          -- 한국어 별칭 JSON array
    en_aliases  TEXT,                          -- 영어 별칭 JSON array
    description TEXT,
    embedding_text TEXT,                       -- 1.1a / 개념 임베딩 입력 본문 (name+ko_name+aliases+description 합성 / NULL 시 name fallback)

    is_tag                  INTEGER NOT NULL DEFAULT 0,
    is_classification_key   INTEGER NOT NULL DEFAULT 0,
    is_classification_value INTEGER NOT NULL DEFAULT 0,

    tag_usage_count            INTEGER NOT NULL DEFAULT 0,
    classification_usage_count INTEGER NOT NULL DEFAULT 0,

    search_blacklist INTEGER NOT NULL DEFAULT 0,

    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_concept_name ON concept_nodes(name);
CREATE INDEX IF NOT EXISTS idx_concept_ko_name ON concept_nodes(ko_name);
CREATE INDEX IF NOT EXISTS idx_concept_tag ON concept_nodes(is_tag) WHERE is_tag=1;
CREATE INDEX IF NOT EXISTS idx_concept_class_key ON concept_nodes(is_classification_key) WHERE is_classification_key=1;
CREATE INDEX IF NOT EXISTS idx_concept_class_value ON concept_nodes(is_classification_value) WHERE is_classification_value=1;

-- 사람 신원 영구 보관소. external_refs 안 어댑터별 user_id 로 같은 사람 합류.
CREATE TABLE IF NOT EXISTS persons (
    person_id     TEXT PRIMARY KEY,           -- 'psn_' + crypto.randomUUID()
    display_name  TEXT NOT NULL,
    aliases       TEXT,                       -- JSON array
    external_refs TEXT,                        -- JSON {discord_user_id / notion_user_id / ...}
    -- 1.2 신규: 그 사람 고유 사실 고정 칸 (직업·회사는 칸 아님 — 라벨)
    birthday      TEXT,                        -- 생일 (고유 사실 / persons_fts 부분 매치)
    address       TEXT,                        -- 주소 (고유 사실 / lookup·표시 중심)
    gender        TEXT,                        -- 성별 (고유 사실 / lookup·표시 중심)
    attributes_json TEXT NOT NULL DEFAULT '{}', -- 혈액형·MBTI 등 자유형 (검색 비노출)
    embedding_text  TEXT,                       -- person_vec 임베딩 입력 (NULL 시 display_name fallback)
    created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 자산 글 → 개념. node_id 는 knowledge_nodes.id(INTEGER).
CREATE TABLE IF NOT EXISTS node_concept_edges (
    node_id    INTEGER NOT NULL,
    concept_id TEXT NOT NULL,
    role       TEXT NOT NULL,                 -- 'tag' / 'classification' / 'mention'
    provenance TEXT NOT NULL,
    source_node_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    PRIMARY KEY (node_id, concept_id, role),
    FOREIGN KEY (node_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (concept_id) REFERENCES concept_nodes(concept_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_nce_node ON node_concept_edges(node_id);
CREATE INDEX IF NOT EXISTS idx_nce_concept ON node_concept_edges(concept_id);

-- 자산 글 → 사람. node_id 는 knowledge_nodes.id(INTEGER).
CREATE TABLE IF NOT EXISTS node_person_edges (
    node_id    INTEGER NOT NULL,
    person_id  TEXT NOT NULL,
    relation   TEXT NOT NULL,                 -- 'mentions' / 'authored_by'
    provenance TEXT NOT NULL,
    source_node_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    PRIMARY KEY (node_id, person_id, relation),
    FOREIGN KEY (node_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (person_id) REFERENCES persons(person_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_npe_node ON node_person_edges(node_id);
CREATE INDEX IF NOT EXISTS idx_npe_person ON node_person_edges(person_id);

-- 개념·사람 ↔ 개념·사람 자유 연결. 강도(weight) 단계 승격 + 다중 부모 보존.
-- 2026-06-05(Task 18): 양 끝 FK(둘 다 concept_nodes ON DELETE CASCADE)를 제거.
-- source/target 은 개념(concept_nodes 'cpt_')·사람(persons 'psn_') 두 부모를
-- 자유롭게 담는 TEXT id 라 단일 칸 FK 를 두지 않는다(relation_summaries 가 FK
-- 없이 푼 양식과 일관 / spec §4.2.1·§7). 환각 차단은 애플리케이션 검증
-- (validateRelationSummary 의 결정적 개념·사람 실재 확인)이 책임진다. parent_of
-- (개념 위계, 항상 'cpt_'-'cpt_') 동작은 불변 — mergeConceptAlias 가 명시
-- UPDATE/DELETE 로 재연결해 FK ON DELETE CASCADE 에 의존하지 않았다.
-- 1.2 T13(spec 10.2 A-2): 옛 co_occurrence_count 칸을 제거했다 — 읽는 코드가 없고
-- (어디서도 logic 으로 안 읽음), 공출현 수는 store.countConceptCoOccurrence 가
-- node_concept_edges self-join 으로 그때그때 계산하므로 칸 보존 가치가 0이었다.
CREATE TABLE IF NOT EXISTS concept_edges (
    source_concept_id   TEXT NOT NULL,        -- 출발 끝 ('cpt_' 개념 / 'psn_' 사람)
    target_concept_id   TEXT NOT NULL,        -- 도착 끝 ('cpt_' 개념 / 'psn_' 사람)
    relation            TEXT NOT NULL,        -- 'parent_of' (개념 위계) / 자유 관계명
    provenance          TEXT NOT NULL,
    source_node_id      INTEGER,
    weight              REAL NOT NULL DEFAULT 0.3,
    created_at          TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    PRIMARY KEY (source_concept_id, target_concept_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_ce_source ON concept_edges(source_concept_id);
CREATE INDEX IF NOT EXISTS idx_ce_target ON concept_edges(target_concept_id);

-- ── 1.2: 프로젝트 참여자 관계 — 옛 project_person_edges 제거(S4) ─────────────
-- 참여자 관계(participated_by)는 S2·S3 전환으로 범용 엣지 entity_relation_edges
-- (source_type='project'·target_type='person')에 통합됐다. 그래서 옛 전용 테이블
-- project_person_edges 는 읽고 쓰는 코드가 0이 됐고, 기준 스키마에 그 표는 없다.

-- ── 1.1a: 개념 전용 검색 색인 (1.0b spec 단락 4 이관) ──────────────────────
-- 검색어 → 개념 매칭용. 개념이 1.0b 에서 knowledge_nodes 를 떠나 그래프 BFS
-- 채널에 없으므로, 개념을 retrieval 신호로 복귀시키는 색인을 둔다.

-- 개념 FTS5 (trigram) — name + ko_name + 한/영 별칭을 한 본문으로 색인.
-- standalone(external-content 아님) — 트리거가 합성 본문을 직접 적재한다.
CREATE VIRTUAL TABLE IF NOT EXISTS concept_nodes_fts USING fts5(
    concept_id UNINDEXED,
    text,
    tokenize='trigram'
);

-- 개념 2글자 검색 복구 보조 색인 (S5 / 사용자 승인 2026-07-03). trigram 단독은
-- 2글자('바라'·'커피')를 글자로 못 잡으므로(연속 3 코드포인트 색인), unicode61 본색인을
-- 병행 추가한다 — knowledge_nodes 의 unicode61+trigram 이중 색인 패턴 복제. 기존 trigram
-- 은 3글자+ 합성어 부분매치용으로 유지(삭제 0). searchConceptsByFts 가 두 색인을 RRF
-- 합친다(searchByFts 선례). standalone 이라 트리거가 concept_nodes_fts 와 같은 합성 본문
-- (name + ko_name + 한/영 별칭)을 직접 적재한다.
CREATE VIRTUAL TABLE IF NOT EXISTS concept_nodes_uni USING fts5(
    concept_id UNINDEXED,
    text,
    tokenize='unicode61'
);

-- 개념 임베딩 ANN — 글 임베딩과 같은 공간(같은 모델·차원). 차원은 글 벡터
-- vec_nodes 와 함께 runMigrations 가 selected 모델 차원으로 치환한다(1.2 T13 으로
-- default 1024 = bge-m3 / legacy 384-dim 비교는 embeddingDim=384 명시 시). vec0 는 FK
-- 불가 → DELETE 동기화는 트리거(concept_vec_delete).
CREATE VIRTUAL TABLE IF NOT EXISTS concept_vec USING vec0(
    concept_rowid INTEGER PRIMARY KEY,
    embedding float[1024] distance_metric=cosine
);

-- concept_nodes_fts 동기화 트리거. 합성 본문 = name + ko_name + 별칭.
CREATE TRIGGER IF NOT EXISTS concept_fts_insert AFTER INSERT ON concept_nodes BEGIN
    INSERT INTO concept_nodes_fts(rowid, concept_id, text)
    VALUES (new.rowid, new.concept_id,
            new.name || ' ' || COALESCE(new.ko_name,'') || ' ' ||
            COALESCE(new.ko_aliases,'') || ' ' || COALESCE(new.en_aliases,''));
END;

CREATE TRIGGER IF NOT EXISTS concept_fts_delete AFTER DELETE ON concept_nodes BEGIN
    DELETE FROM concept_nodes_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS concept_fts_update
AFTER UPDATE OF name, ko_name, ko_aliases, en_aliases ON concept_nodes BEGIN
    DELETE FROM concept_nodes_fts WHERE rowid = old.rowid;
    INSERT INTO concept_nodes_fts(rowid, concept_id, text)
    VALUES (new.rowid, new.concept_id,
            new.name || ' ' || COALESCE(new.ko_name,'') || ' ' ||
            COALESCE(new.ko_aliases,'') || ' ' || COALESCE(new.en_aliases,''));
END;

-- concept_nodes_uni 동기화 트리거 (S5). concept_fts_insert/delete/update 와 같은 합성
-- 규칙을 unicode61 보조 색인에 별도 적재한다 — trigram 트리거와 별 트리거다.
-- rowid = concept_nodes.rowid 정합.
CREATE TRIGGER IF NOT EXISTS concept_uni_insert AFTER INSERT ON concept_nodes BEGIN
    INSERT INTO concept_nodes_uni(rowid, concept_id, text)
    VALUES (new.rowid, new.concept_id,
            new.name || ' ' || COALESCE(new.ko_name,'') || ' ' ||
            COALESCE(new.ko_aliases,'') || ' ' || COALESCE(new.en_aliases,''));
END;

CREATE TRIGGER IF NOT EXISTS concept_uni_delete AFTER DELETE ON concept_nodes BEGIN
    DELETE FROM concept_nodes_uni WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS concept_uni_update
AFTER UPDATE OF name, ko_name, ko_aliases, en_aliases ON concept_nodes BEGIN
    DELETE FROM concept_nodes_uni WHERE rowid = old.rowid;
    INSERT INTO concept_nodes_uni(rowid, concept_id, text)
    VALUES (new.rowid, new.concept_id,
            new.name || ' ' || COALESCE(new.ko_name,'') || ' ' ||
            COALESCE(new.ko_aliases,'') || ' ' || COALESCE(new.en_aliases,''));
END;

-- concept_vec 정리 트리거 (vec0 FK 불가 회피 — kn_vec_delete 패턴 따름).
CREATE TRIGGER IF NOT EXISTS concept_vec_delete AFTER DELETE ON concept_nodes BEGIN
    DELETE FROM concept_vec WHERE concept_rowid = old.rowid;
END;

-- 개념 SigLIP 임베딩 ANN — SigLIP text encoder 768-dim. concept_nodes.rowid 매핑.
-- concept_vec(text embedding)와 별 공간 — 이미지 image_vec(768-dim cosine)와 같은
-- 공간·메트릭이라 자동 개념 연결(image-search-foundation Task 3 b/B1)의 후보 검색에 쓴다.
-- vec0 는 FK 불가 → DELETE 동기화는 트리거(concept_siglip_vec_delete).
CREATE VIRTUAL TABLE IF NOT EXISTS concept_siglip_vec USING vec0(
    concept_rowid INTEGER PRIMARY KEY,
    embedding float[768] distance_metric=cosine
);

-- concept_siglip_vec 정리 트리거 (concept_vec_delete 패턴 정합).
CREATE TRIGGER IF NOT EXISTS concept_siglip_vec_delete AFTER DELETE ON concept_nodes BEGIN
    DELETE FROM concept_siglip_vec WHERE concept_rowid = old.rowid;
END;

-- ── 1.2: 사람 검색 색인 (concept_nodes_fts/concept_vec 양식) ──────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS persons_fts USING fts5(
    person_id UNINDEXED,
    text,
    tokenize='trigram'
);

-- 사람 2글자 검색 복구 보조 색인 (S5 / 사용자 승인 2026-07-03). concept_nodes_uni 양식
-- 정합 — trigram 은 2글자('민수')를 못 잡으므로 unicode61 을 병행 추가(trigram 유지·삭제 0).
-- searchPersonsByFts 가 두 색인을 RRF 합친다. standalone 이라 트리거가 persons_fts 와 같은
-- 합성 본문(display_name + aliases + birthday)을 직접 적재한다.
CREATE VIRTUAL TABLE IF NOT EXISTS persons_uni USING fts5(
    person_id UNINDEXED,
    text,
    tokenize='unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS person_vec USING vec0(
    person_rowid INTEGER PRIMARY KEY,
    embedding float[1024] distance_metric=cosine
);

CREATE TRIGGER IF NOT EXISTS person_fts_insert AFTER INSERT ON persons BEGIN
    INSERT INTO persons_fts(rowid, person_id, text)
    VALUES (new.rowid, new.person_id,
            new.display_name || ' ' || COALESCE(new.aliases,'') || ' ' ||
            COALESCE(new.birthday,''));
END;

CREATE TRIGGER IF NOT EXISTS person_fts_delete AFTER DELETE ON persons BEGIN
    DELETE FROM persons_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS person_fts_update
AFTER UPDATE OF display_name, aliases, birthday ON persons BEGIN
    DELETE FROM persons_fts WHERE rowid = old.rowid;
    INSERT INTO persons_fts(rowid, person_id, text)
    VALUES (new.rowid, new.person_id,
            new.display_name || ' ' || COALESCE(new.aliases,'') || ' ' ||
            COALESCE(new.birthday,''));
END;

-- persons_uni 동기화 트리거 (S5). person_fts_insert/delete/update 와 같은 합성 규칙을
-- unicode61 보조 색인에 별도 적재한다 — trigram 트리거 본문은 안 바꾼다(별 트리거).
CREATE TRIGGER IF NOT EXISTS person_uni_insert AFTER INSERT ON persons BEGIN
    INSERT INTO persons_uni(rowid, person_id, text)
    VALUES (new.rowid, new.person_id,
            new.display_name || ' ' || COALESCE(new.aliases,'') || ' ' ||
            COALESCE(new.birthday,''));
END;

CREATE TRIGGER IF NOT EXISTS person_uni_delete AFTER DELETE ON persons BEGIN
    DELETE FROM persons_uni WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS person_uni_update
AFTER UPDATE OF display_name, aliases, birthday ON persons BEGIN
    DELETE FROM persons_uni WHERE rowid = old.rowid;
    INSERT INTO persons_uni(rowid, person_id, text)
    VALUES (new.rowid, new.person_id,
            new.display_name || ' ' || COALESCE(new.aliases,'') || ' ' ||
            COALESCE(new.birthday,''));
END;

CREATE TRIGGER IF NOT EXISTS person_vec_delete AFTER DELETE ON persons BEGIN
    DELETE FROM person_vec WHERE person_rowid = old.rowid;
END;

-- ── 개념 엔티티 타입 체계 1단계·3단계: 정적 8 타입 전용 테이블·전용 엣지 (제거됨) ──
-- 단계4 전면 통일(T4·T7'b)에서 정적 8 타입(creature·thing·intake·usable·work·
-- material·place·schedule)의 본체가 범용 entities(type_name 칸)·entity_attributes 로,
-- 라벨·identity 엣지가 범용 entity_concept_edges 로 옮겨졌다. 그래서 옛 전용 테이블
-- (creatures…schedules + 각 *_fts·*_vec·동기화 트리거)과 옛 전용 라벨 엣지 8개
-- (<type>_concept_edges)는 읽고 쓰는 코드가 0이 됐고, 기준 스키마에 그 표들은 없다.
-- 종류·라벨의 런타임 권위는 범용 entities/entity_concept_edges + 종류 명부 DB 다.

