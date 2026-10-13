-- bara_system memory baseline schema v47 — file 3 of 4 (entities, edges, user vocabularies).
-- Frozen like the other baseline files; see the header of 01-memory-nodes.sql.

-- ── 개념 엔티티 타입 체계 4단계 Task 1: 통합 cross-type 관계 엣지 (spec 2026-06-09 §7.2) ─
-- 3단계가 만든 엔티티 행끼리(작품→사람 created_by 등)를 잇는 단일 cross-type 관계 엣지.
--
-- ── FK 정책: FK 0 부류(다형 끝점) — 선통일 묶음 M4/T4 명문화 ──────────────────
-- source/target 이 8 타입 + person/project 어느 테이블이든 가리키므로 단일 칸 FK 를
-- 둘 수 없다 — concept_edges·node_concept_edges 가 두 부모를 한 TEXT id 칸으로 담아
-- FK 0 인 것과 같은 양식이다. 따라서 ON DELETE CASCADE 도 없고 삭제 트리거도 없다.
-- 끝점 행이 지워져도 이 엣지가 끊긴 채 남을 수 있다(감사 C2 결함의 구조적 뿌리 —
-- spec 2026-06-18 §13.4).
-- 끊긴 엣지 정리 책임(현재 어디 있는가): 애플리케이션이 진다.
--   1. 끝점 행 실재·관계명 유효 = 입력 게이트가 막는다 —
--      entity-relation-vocabulary.assertRelationName 의 unknown loud throw + wiring 의
--      끝점 해석(존재하는 행만 source/target 으로 적는다).
--   2. 개념 합치기(별칭 합류) 시 재연결 = concept-repository.repointConceptInFkZeroTables
--      (mergeConceptAlias 가 source 개념 삭제 직전 같은 트랜잭션에서 호출). 'concept'
--      끝점이 사라질 source 를 가리키던 행을 target 으로 옮기고 끊긴/중복 행을 정리해
--      dangling 0 으로 만든다(감사 C2 의 2026-06-18 코드 처리 지점).
-- 단계4 경계(이번 범위 밖): FK 회귀(entities 단일 FK·CASCADE) vs repointEntityRef
--   1급화 중 어느 쪽을 채택할지는 spec §13.4 의 단계4 결정이다. 이번 M4/T4 는 두
--   부류 정책을 글로 확정하는 데까지만이고, 코드 회귀(단일 FK 도입·헬퍼 1급화)는 하지
--   않는다 — 두 선택지를 그대로 보존한다. 정책 표 권위:
--   docs/decisions/2026-06-25-pre-unification-audit-debt-plan.md(D9·T4 표) + spec §13.4.
--
-- created_at 은 형제 hierarchy_edges·다른 코어 테이블과 같은 TEXT datetime
-- (nowKst) — lexicographic 비교가 곧 시간 순서라 ORDER BY created_at 정렬을 유지한다
-- (양방향 1-hop 조회). 옛 INTEGER epoch ms 양식은 선통일 묶음 M2/T1 에서 TEXT 로
-- 통일했다.
--
-- 인덱스 두 개(idx_ere_source·idx_ere_target)는 검색 1-hop 양방향(source→target·
-- target→source) 조회용이다.
CREATE TABLE IF NOT EXISTS entity_relation_edges (
    source_type TEXT NOT NULL,        -- 출발 엔티티 타입 (work·material·creature…person·project)
    source_id   TEXT NOT NULL,        -- 출발 엔티티 행 id
    target_type TEXT NOT NULL,        -- 도착 엔티티 타입
    target_id   TEXT NOT NULL,        -- 도착 엔티티 행 id
    relation    TEXT NOT NULL,        -- 관계명 (created_by·owned_by… / ENTITY_RELATION_NAMES)
    provenance  TEXT NOT NULL,
    source_node_id INTEGER,
    weight      REAL,                 -- 관계 강도 (선택 — 없으면 NULL)
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),  -- TEXT datetime (nowKst) — 양방향 1-hop 조회 정렬용 (형제 hierarchy_edges 와 형 일치)
    PRIMARY KEY (source_type, source_id, target_type, target_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_ere_source ON entity_relation_edges(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_ere_target ON entity_relation_edges(target_type, target_id);

-- ── 위계 단일 출처 재설계 Stage 0 Task 1: hierarchy_edges (spec 2026-06-14 §4.1·§8) ─
-- 위계 저장 단일 출처. 그림자 개념 + identity 엣지 + 그래프 빌드 흡수(라이브 회귀의
-- 원인)를 없애고, 엔티티/사람 행이 위계 잎으로 직접 잇는다.
--
-- ── FK 정책: FK 0 부류(다형 끝점) — 선통일 묶음 M4/T4 명문화 ──────────────────
-- source/target 이 concept·person·8 엔티티·project 어느 테이블이든 가리키므로 단일
-- 칸 FK 를 둘 수 없다 — 형제 entity_relation_edges 와 같은 양식으로 FK 0 이다(따라서
-- ON DELETE CASCADE 도 트리거도 없다·감사 C2 의 구조적 뿌리·spec §13.4).
-- 끊긴 엣지 정리 책임(현재 어디 있는가): 애플리케이션이 진다 —
--   1. 끝점 행 실재 = wiring 게이트(존재하는 행만 source/target 으로 적는다).
--   2. 개념 합치기 시 재연결 = concept-repository.repointConceptInFkZeroTables
--      (entity_relation_edges 와 한 헬퍼로 함께 처리·mergeConceptAlias 가 호출).
-- 단계4 경계(이번 범위 밖): FK 회귀(entities 단일 FK·CASCADE) vs repointEntityRef
--   1급화 채택은 spec §13.4 의 단계4 결정이다. 이번 M4/T4 는 정책을 글로 확정만 하고
--   코드 회귀는 안 한다. 정책 표 권위는 entity_relation_edges 단락과 같다.
--
-- 인덱스 두 개(idx_he_source·idx_he_target)는 위계 양방향(부모→자식·자식→부모) 조회용이다.
CREATE TABLE IF NOT EXISTS hierarchy_edges (
    source_type TEXT NOT NULL,        -- 부모 끝 종류('concept'|'person'|8 엔티티|'project')
    source_id   TEXT NOT NULL,        -- 부모 끝 id
    target_type TEXT NOT NULL,        -- 자식 끝 종류
    target_id   TEXT NOT NULL,        -- 자식 끝 id
    relation    TEXT NOT NULL,        -- 'parent_of'
    provenance  TEXT NOT NULL,
    source_node_id INTEGER,
    weight      REAL NOT NULL DEFAULT 0.9,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    PRIMARY KEY (source_type, source_id, target_type, target_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_he_source ON hierarchy_edges(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_he_target ON hierarchy_edges(target_type, target_id);

-- ── 웨이브3 동의어 설정 탭 항목12 B1: synonym_user_entries ──────────────────
-- 사용자가 대시보드 동의어 설정 탭에서 손으로 추가하는 동의어 쌍(term ↔ synonym)을
-- 보존한다. created_at 은 다른 코어 테이블과 같은 TEXT datetime(nowKst) — lexicographic
-- 비교가 곧 시간 순서라 ORDER BY created_at 정렬을 유지한다. 인덱스(idx_synonym_user_term)는
-- term·lang 으로 동의어를 찾는 조회용이다.
CREATE TABLE IF NOT EXISTS synonym_user_entries (
    entry_id    TEXT PRIMARY KEY,             -- 'syn_user_' + UUID
    term        TEXT NOT NULL,                -- 원본 용어(예: '고양이')
    synonym     TEXT NOT NULL,                -- 동의어(예: '냥이')
    lang        TEXT NOT NULL,                -- 'ko' / 'en' / 'ja' / 'zh'
    created_at  TEXT NOT NULL,                -- TEXT datetime (nowKst)
    UNIQUE (term, synonym, lang)
);

CREATE INDEX IF NOT EXISTS idx_synonym_user_term ON synonym_user_entries(term, lang);

-- ── 분류 어휘 DB 단계1: classify_vocab_user_entries ────────────────────────
-- 사용자가 대시보드 "분류 어휘" 설정 탭에서 손으로 추가하는 분류 어휘 행을 보존한다.
-- 검색 동의어와 달리 (타입, 칸, 값) 3차원이라 type_name·slot·value 세 칸을 둔다 —
-- type_name 은 PlacementTypeName('work'·'creature'…), slot 은 synonyms|subcategories,
-- value 는 등록 단어. created_at 은 다른 코어 테이블과 같은 TEXT datetime(nowKst)이라
-- lexicographic 비교가 곧 시간 순서다(ORDER BY created_at 정렬 유지). 조회가
-- (type_name, slot) 묶음이라 인덱스(idx_classify_vocab_type_slot)도 그 묶음이다.
CREATE TABLE IF NOT EXISTS classify_vocab_user_entries (
    entry_id    TEXT PRIMARY KEY,             -- 'cvocab_user_' + UUID
    type_name   TEXT NOT NULL,                -- PlacementTypeName ('work'·'creature'…)
    slot        TEXT NOT NULL,                -- 'synonyms' | 'subcategories'
    value       TEXT NOT NULL,                -- 단어 (예: '창작물', '소설')
    created_at  TEXT NOT NULL,                -- TEXT datetime (nowKst)
    UNIQUE (type_name, slot, value)
);

CREATE INDEX IF NOT EXISTS idx_classify_vocab_type_slot ON classify_vocab_user_entries(type_name, slot);

-- ── 엔티티 관리 통합 S5: classify_vocab_overrides (가림표 층·tombstone) ──────
-- 기본 사전(yaml)·코드 10종이 준 동의어·하위분류·라벨은 파일/코드라 화면에서 못 지운다.
-- 사용자가 "이 값 끄기"를 누르면 여기에 "이 (종류, slot, 값)은 끔" 한 줄을 남긴다.
-- 분류 어휘 병합(mergeConceptVocab)이 이 행을 읽어 결과에서 그 값을 뺀다(위에 덮어 숨김).
-- 끄기·되살리기는 다음 입력 글부터 반영(소급 0·classify_vocab_user_entries 의 2-reset 정신).
--
-- 별 테이블 채택 근거(spec §6.2·plan S5): classify_vocab_user_entries 에 kind 칸을 더하지
-- 않는다 — 사용자 추가(더하기)와 끄기(빼기)는 반대 방향 자료라 한 테이블에 섞으면 멱등·
-- UNIQUE·삭제 의미가 엉킨다. slot 은 synonyms|subcategories|attributes 세 칸만 끌 수 있다
-- (columns·item_synonym·column_types 는 가림표 대상이 아니라 CHECK 가 3종으로 막는다).
-- kind 는 현재 'tombstone'(끔) 고정이되 칸은 두어 미래 'override'(덮음) 확장 자리를 남긴다.
-- 병합 차감이 한 타입·칸의 가림표를 (type_name, slot) 묶음으로 찾으므로 인덱스
-- (idx_classify_vocab_overrides_lookup)도 그 묶음이다.
CREATE TABLE IF NOT EXISTS classify_vocab_overrides (
    override_id  TEXT PRIMARY KEY,            -- 'cvocab_ovr_' + UUID
    type_name    TEXT NOT NULL,               -- PlacementTypeName ('work'·'creature'…)
    slot         TEXT NOT NULL CHECK (slot IN ('synonyms', 'subcategories', 'attributes')),
    value        TEXT NOT NULL,               -- 끌 대상 값 (yaml·코드 10종이 준 단어)
    kind         TEXT NOT NULL DEFAULT 'tombstone',  -- 'tombstone'(끔) — 미래 'override' 확장 자리
    created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (type_name, slot, value)
);

CREATE INDEX IF NOT EXISTS idx_classify_vocab_overrides_lookup ON classify_vocab_overrides(type_name, slot);

-- ── 분류 단계3 T1: 종류 명부 + 범용 본체 + 범용 색인 (spec 2026-06-09 §2·§4) ──
-- 사용자가 화면으로 새 엔티티 종류(기존 10종 밖 11번째 이후)를 추가하는 토대.
-- 기존 10종은 전용 테이블(persons·creatures…)에 갇혀 코드 상수가 권위로 남고, 새
-- 종류만 여기 범용 본체(entities·entity_attributes)에 산다 — 단계4까지 기존 10종
-- 전용 테이블은 한 줄도 안 건드린다.
--
-- entity_types: 새 종류의 본행(type_name UNIQUE). 기존 10종은 이 테이블에 행을 넣지
--   않는다(코드 상수가 계속 권위).
-- entities: 범용 본체. 새 종류 엔티티만. (type_name, name) 한 쌍으로 같은 종류 안
--   같은 이름을 하나로 모은다.
-- entity_attributes: EAV 속성. is_column=1 은 칸(전용 칸처럼 검색 합류), 0 은 라벨.
-- entities_fts: 합성 텍스트 색인 = 이름 + ko_name + 칸값(is_column=1) 한 덩이.
-- entities_vec: 임베딩 색인. 차원은 글 모델 vec_nodes 와 함께 applyBaselineSchema 가
--   selected 모델 차원으로 치환한다(EMBEDDING_DIMENSIONS 단일 출처 연동 / 하드코딩
--   아님 — bge-m3 1024 / legacy 384-dim). vec0 는 FK 불가 → DELETE 동기화는 트리거.
--
-- type_name UNIQUE·(entity_id, attr_key) PK 는 CREATE TABLE 안 제약이라 자동 인덱스다.
-- entities 의 종류별 정체성 partial UNIQUE 두 개와 FK 조회용 idx_entity_attr_entity 는 각 표
-- 정의 바로 아래에 있다.
CREATE TABLE IF NOT EXISTS entity_types (
    type_name  TEXT NOT NULL UNIQUE,             -- 새 종류 이름(영문 키 / 예 'vehicle')
    ko_name    TEXT,                              -- 한국어 표시명(예 '탈것')
    id_prefix  TEXT,                              -- entity_id 접두사(예 'veh_')
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS entities (
    entity_id  TEXT PRIMARY KEY,                  -- '<id_prefix>' + crypto.randomUUID()
    type_name  TEXT NOT NULL,                     -- entity_types.type_name (FK 0 — 코드 상수 종류도 담을 수 있어 단일 칸 FK 안 검)
    name       TEXT NOT NULL,                     -- canonical 이름
    ko_name    TEXT,
    medium     TEXT,                              -- 단계4 T1: work 정체성 — 매체(예 '만화'·'애니'·'소설')
    created_by TEXT,                              -- 단계4 T1: work 정체성 — 작가·제작자
    external_refs TEXT,                           -- 단계4 T1: person 신원 — 외부 식별자 JSON(예 트위터·핵사 핸들)
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    -- 단계4 T1: 정체성 UNIQUE 는 테이블 제약이 아니라 종류로 가른 partial UNIQUE 2개로
    -- 둔다(표 아래 idx_entities_nonwork_identity·idx_entities_work_identity). 옛 테이블 제약
    -- UNIQUE(type_name, name) 가 work 행도 먼저 막아
    -- 동명이매체 작품(소설 '괴담' vs 웹툰 '괴담')을 못 넣던 결함 교정 — work 는 4-tuple,
    -- person 은 동명이인 허용(신원=entity_id PK + external_refs)이라 둘 다 (type_name, name)
    -- 유일성에서 면제하고, 나머지 종류만 (type_name, name)으로 가른다.
);

-- 정체성 = 테이블 제약 대신 종류로 가른 partial UNIQUE. 자체 정체성 스킴을 가진
-- 두 종류(work=4-tuple / person=동명이인 허용·신원은 entity_id PK + external_refs)는
-- (type_name, name) 유일성에서 면제한다. 나머지 종류만 (type_name, name)으로 같은
-- 이름을 한 행에 모은다. person 을 면제하지 않으면 둘째 "철수"(다른 어댑터 user_id)가
-- 거부돼 동명이인 보존이 깨진다.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_nonwork_identity
         ON entities (type_name, name)
         WHERE type_name NOT IN ('work', 'person');
-- work 한정 정체성 복합 UNIQUE. COALESCE 로 NULL 매체·작가를 '' 로 정규화해 같은
-- 작품 중복 입력을 막되, 같은 이름 다른 매체는 별개 행으로 보존한다.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_work_identity
         ON entities (type_name, name, COALESCE(medium, ''), COALESCE(created_by, ''))
         WHERE type_name = 'work';

CREATE TABLE IF NOT EXISTS entity_attributes (
    entity_id  TEXT NOT NULL,
    attr_key   TEXT NOT NULL,                     -- 속성 이름(예 '제조사'·'색상')
    attr_value TEXT NOT NULL,
    is_column  INTEGER NOT NULL DEFAULT 0,        -- 1 = 칸(검색 합류) / 0 = 라벨
    PRIMARY KEY (entity_id, attr_key),
    FOREIGN KEY (entity_id) REFERENCES entities(entity_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_entity_attr_entity ON entity_attributes(entity_id);

-- 합성 텍스트 색인(standalone trigram) — 트리거가 합성 본문(이름 + ko_name + 칸값)을
-- 직접 적재한다. concept_nodes_fts/creatures_fts 양식 정합.
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
    entity_id UNINDEXED, text, tokenize='trigram'
);

-- 엔티티(프로젝트 포함) 2글자 검색 복구 보조 색인 (S5 / 사용자 승인 2026-07-03).
-- concept_nodes_uni/persons_uni 양식 정합 — trigram 은 2글자('바라' 프로젝트)를 못 잡으므로
-- unicode61 을 병행 추가(trigram 유지·삭제 0). searchProjectsByFts 가 두 색인을 RRF 합친다
-- (프로젝트는 entities type_name='project' 로 산다). standalone 이라 entities·entity_attributes
-- 트리거가 entities_fts 와 같은 합성 본문(이름 + ko_name + 칸값 is_column=1)을 직접 적재한다.
CREATE VIRTUAL TABLE IF NOT EXISTS entities_uni USING fts5(
    entity_id UNINDEXED, text, tokenize='unicode61'
);

-- 임베딩 ANN — 글 임베딩과 같은 공간(같은 모델·차원). float[1024] 리터럴을
-- applyBaselineSchema 가 selected 모델 차원으로 치환한다(vec_nodes/concept_vec 양식 —
-- image_vec 768 고정과 다른 글 모델 연동). vec0 는 FK 불가 → DELETE 동기화는 트리거.
CREATE VIRTUAL TABLE IF NOT EXISTS entities_vec USING vec0(
    entity_rowid INTEGER PRIMARY KEY,
    embedding float[1024] distance_metric=cosine
);

-- entities 변경 트리거 — 합성 본문(이름 + ko_name + 칸값)을 entities_fts 에 동기화.
-- 칸값은 entity_attributes(is_column=1)에서 서브쿼리로 끌어와 한 덩이로 잇는다.
-- group_concat 은 칸이 없으면 NULL → COALESCE 로 빈 문자열 처리.
CREATE TRIGGER IF NOT EXISTS ent_fts_insert AFTER INSERT ON entities BEGIN
    INSERT INTO entities_fts(rowid, entity_id, text)
    VALUES (new.rowid, new.entity_id,
            new.name || ' ' || COALESCE(new.ko_name,'') || ' ' ||
            COALESCE((SELECT group_concat(attr_value, ' ') FROM entity_attributes
                      WHERE entity_id = new.entity_id AND is_column = 1), ''));
END;
CREATE TRIGGER IF NOT EXISTS ent_fts_delete AFTER DELETE ON entities BEGIN
    DELETE FROM entities_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER IF NOT EXISTS ent_fts_update
AFTER UPDATE OF name, ko_name ON entities BEGIN
    DELETE FROM entities_fts WHERE rowid = old.rowid;
    INSERT INTO entities_fts(rowid, entity_id, text)
    VALUES (new.rowid, new.entity_id,
            new.name || ' ' || COALESCE(new.ko_name,'') || ' ' ||
            COALESCE((SELECT group_concat(attr_value, ' ') FROM entity_attributes
                      WHERE entity_id = new.entity_id AND is_column = 1), ''));
END;
CREATE TRIGGER IF NOT EXISTS ent_vec_delete AFTER DELETE ON entities BEGIN
    DELETE FROM entities_vec WHERE entity_rowid = old.rowid;
END;

-- entity_attributes 변경 트리거 — 칸값(is_column)이 바뀌면 부모 entities_fts 를 다시
-- 합성한다. 칸값이 합성 색인의 일부라 칸 추가·수정·삭제 시 재색인이 필요하다(라벨
-- is_column=0 변경도 재색인하지만 라벨값은 합성에 안 들어가므로 결과 본문은 같다 —
-- 무해). 한 entity 의 fts rowid = entities.rowid 라 entities 에서 rowid 를 찾아 재적재.
CREATE TRIGGER IF NOT EXISTS ent_attr_insert AFTER INSERT ON entity_attributes BEGIN
    DELETE FROM entities_fts
    WHERE rowid = (SELECT rowid FROM entities WHERE entity_id = new.entity_id);
    INSERT INTO entities_fts(rowid, entity_id, text)
    SELECT e.rowid, e.entity_id,
           e.name || ' ' || COALESCE(e.ko_name,'') || ' ' ||
           COALESCE((SELECT group_concat(attr_value, ' ') FROM entity_attributes
                     WHERE entity_id = e.entity_id AND is_column = 1), '')
    FROM entities e WHERE e.entity_id = new.entity_id;
END;
CREATE TRIGGER IF NOT EXISTS ent_attr_update AFTER UPDATE ON entity_attributes BEGIN
    DELETE FROM entities_fts
    WHERE rowid = (SELECT rowid FROM entities WHERE entity_id = new.entity_id);
    INSERT INTO entities_fts(rowid, entity_id, text)
    SELECT e.rowid, e.entity_id,
           e.name || ' ' || COALESCE(e.ko_name,'') || ' ' ||
           COALESCE((SELECT group_concat(attr_value, ' ') FROM entity_attributes
                     WHERE entity_id = e.entity_id AND is_column = 1), '')
    FROM entities e WHERE e.entity_id = new.entity_id;
END;
-- 칸 삭제 시 재합성. 부모 entities 가 함께 지워지는 CASCADE 경로면 entities 행이
-- 이미 없어 SELECT 가 0행 → DELETE 만 일어나고 INSERT 는 건너뛴다(부모 ent_fts_delete
-- 가 이미 정리했으므로 무해). 칸만 단독 삭제면 entities 가 남아 재합성된다.
CREATE TRIGGER IF NOT EXISTS ent_attr_delete AFTER DELETE ON entity_attributes BEGIN
    DELETE FROM entities_fts
    WHERE rowid = (SELECT rowid FROM entities WHERE entity_id = old.entity_id);
    INSERT INTO entities_fts(rowid, entity_id, text)
    SELECT e.rowid, e.entity_id,
           e.name || ' ' || COALESCE(e.ko_name,'') || ' ' ||
           COALESCE((SELECT group_concat(attr_value, ' ') FROM entity_attributes
                     WHERE entity_id = e.entity_id AND is_column = 1), '')
    FROM entities e WHERE e.entity_id = old.entity_id;
END;

-- ── entities_uni 동기화 트리거 (S5) ────────────────────────────────────────────
-- entities_fts(trigram) 트리거 5개(ent_fts_insert/delete/update·ent_attr_insert/update/
-- delete)와 같은 합성 규칙을 unicode61 보조 색인에 별도 적재한다 — trigram 트리거와 별
-- 트리거다. 합성 본문·rowid 규칙은 각 trigram 짝과 byte 동일(INSERT 대상만 entities_uni).
CREATE TRIGGER IF NOT EXISTS ent_uni_insert AFTER INSERT ON entities BEGIN
    INSERT INTO entities_uni(rowid, entity_id, text)
    VALUES (new.rowid, new.entity_id,
            new.name || ' ' || COALESCE(new.ko_name,'') || ' ' ||
            COALESCE((SELECT group_concat(attr_value, ' ') FROM entity_attributes
                      WHERE entity_id = new.entity_id AND is_column = 1), ''));
END;
CREATE TRIGGER IF NOT EXISTS ent_uni_delete AFTER DELETE ON entities BEGIN
    DELETE FROM entities_uni WHERE rowid = old.rowid;
END;
CREATE TRIGGER IF NOT EXISTS ent_uni_update
AFTER UPDATE OF name, ko_name ON entities BEGIN
    DELETE FROM entities_uni WHERE rowid = old.rowid;
    INSERT INTO entities_uni(rowid, entity_id, text)
    VALUES (new.rowid, new.entity_id,
            new.name || ' ' || COALESCE(new.ko_name,'') || ' ' ||
            COALESCE((SELECT group_concat(attr_value, ' ') FROM entity_attributes
                      WHERE entity_id = new.entity_id AND is_column = 1), ''));
END;
CREATE TRIGGER IF NOT EXISTS ent_attr_uni_insert AFTER INSERT ON entity_attributes BEGIN
    DELETE FROM entities_uni
    WHERE rowid = (SELECT rowid FROM entities WHERE entity_id = new.entity_id);
    INSERT INTO entities_uni(rowid, entity_id, text)
    SELECT e.rowid, e.entity_id,
           e.name || ' ' || COALESCE(e.ko_name,'') || ' ' ||
           COALESCE((SELECT group_concat(attr_value, ' ') FROM entity_attributes
                     WHERE entity_id = e.entity_id AND is_column = 1), '')
    FROM entities e WHERE e.entity_id = new.entity_id;
END;
CREATE TRIGGER IF NOT EXISTS ent_attr_uni_update AFTER UPDATE ON entity_attributes BEGIN
    DELETE FROM entities_uni
    WHERE rowid = (SELECT rowid FROM entities WHERE entity_id = new.entity_id);
    INSERT INTO entities_uni(rowid, entity_id, text)
    SELECT e.rowid, e.entity_id,
           e.name || ' ' || COALESCE(e.ko_name,'') || ' ' ||
           COALESCE((SELECT group_concat(attr_value, ' ') FROM entity_attributes
                     WHERE entity_id = e.entity_id AND is_column = 1), '')
    FROM entities e WHERE e.entity_id = new.entity_id;
END;
CREATE TRIGGER IF NOT EXISTS ent_attr_uni_delete AFTER DELETE ON entity_attributes BEGIN
    DELETE FROM entities_uni
    WHERE rowid = (SELECT rowid FROM entities WHERE entity_id = old.entity_id);
    INSERT INTO entities_uni(rowid, entity_id, text)
    SELECT e.rowid, e.entity_id,
           e.name || ' ' || COALESCE(e.ko_name,'') || ' ' ||
           COALESCE((SELECT group_concat(attr_value, ' ') FROM entity_attributes
                     WHERE entity_id = e.entity_id AND is_column = 1), '')
    FROM entities e WHERE e.entity_id = old.entity_id;
END;

-- ── 분류 단계4 T1: entity_concept_edges (범용 통합 라벨·identity 엣지) ───────
-- 전용 라벨·identity 엣지 8종(<type>_concept_edges + person·project)을 대체하는 범용
-- 통합 엣지다. 엔티티 끝점 = entities 단일 FK CASCADE(엔티티가 지워지면 엣지도 함께
-- 사라진다 — C2 구조적 소멸). concept 끝점 = concept_nodes CASCADE. role 은 라벨 종류
-- (tag·classification 등)를 담아 (entity_id, concept_id, role) 세 칸을 PK 로 한다.
-- PK 는 CREATE TABLE 제약이라 자동 인덱스이고, FK 조회용 idx_ece_entity·idx_ece_concept 는
-- 표 아래에 있다.
CREATE TABLE IF NOT EXISTS entity_concept_edges (
    entity_id  TEXT NOT NULL,
    concept_id TEXT NOT NULL,
    role       TEXT NOT NULL,                     -- 라벨 종류(tag·classification 등)
    provenance TEXT NOT NULL,
    source_node_id INTEGER,
    weight     REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    PRIMARY KEY (entity_id, concept_id, role),
    FOREIGN KEY (entity_id) REFERENCES entities(entity_id) ON DELETE CASCADE,
    FOREIGN KEY (concept_id) REFERENCES concept_nodes(concept_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ece_entity ON entity_concept_edges(entity_id);
CREATE INDEX IF NOT EXISTS idx_ece_concept ON entity_concept_edges(concept_id);

-- ── 분류 단계3 T7a: relation_name_user_entries (관계명 동결 해제) ───────────
-- 사용자가 대시보드 설정 탭에서 손으로 추가하는 관계명 한 개 한 개를 보존한다.
-- 기존 8 관계명(created_by·sourced_from…)은 relation_vocabulary.yaml 기본 씨앗이
-- 권위로 남고, 이 테이블에 행을 넣지 않는다. 9번째 이후 새 관계명만 여기 산다.
--
-- 관계명은 *종류 횡단*(work→person created_by)이라 classify_vocab_user_entries
-- 의 (타입, 칸, 값) 3차원에 안 맞는다 — 그래서 별 테이블로 둔다. classify_vocab
-- 로직(merge-classify-vocab 의 isPlacementType 가드)을 안 거쳐 종류 화이트리스트에
-- 예약어가 새지 않는다(EntityTypeRegistryDb 양식 미러 — Database 주입 repo).
--
-- source_types/target_types: 관계의 source(글 주체)·target(가리키는 대상) 허용 타입을
-- tab 으로 이은 PlacementTypeName 목록(예 'schedule\tusable\tintake'). tab 은 타입
-- 이름·관계명에 안 나오는 문자라 토큰 충돌이 0 이다. 새 종류(entity_types)도 source/
-- target 가 될 수 있어 자유 TEXT 로 둔다(코드 상수 ∪ DB 종류를 병합이 검증).
--
-- relation_key UNIQUE 는 CREATE TABLE 안 제약이라 자동 인덱스다. 다른 인덱스는 없다.
CREATE TABLE IF NOT EXISTS relation_name_user_entries (
    entry_id            TEXT PRIMARY KEY,            -- 'rel_user_' + UUID
    relation_key        TEXT NOT NULL UNIQUE,        -- 한국어 태그 키(예 '구독처') — 한 키 = 한 관계
    relation_name       TEXT NOT NULL,               -- 영문 관계명(예 'subscribed_to')
    source_types        TEXT NOT NULL,               -- tab 으로 이은 PlacementTypeName 목록(source)
    target_types        TEXT NOT NULL,               -- tab 으로 이은 PlacementTypeName 목록(target)
    default_target_type TEXT NOT NULL,               -- target 기본 타입(target_types 안의 하나)
    created_at          TEXT NOT NULL                -- TEXT datetime (nowKst)
);

