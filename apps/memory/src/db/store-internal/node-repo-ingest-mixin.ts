/**
 * store-internal/node-repo-ingest-mixin.ts — 노드 저장(멱등·배치) 묶음
 * (P3 G5-a 분해 — 옛 node-repository.ts 에서 이동, 내용 무변경).
 *
 * P0-A 입력 멱등성의 단일 출처(addNodeIdempotent)와 그 파생 통로(addNode·
 * findNodeIdByContentHash·addNodesBatch), 재언급 신호(bumpMention)를 담는다.
 * emit 보존: addNode → 'raw-memory-added'.
 */

import type { Database } from "bun:sqlite";
import type { MemoryType, SourceType } from "../../memory/types.ts";
import type {
  AddNodeArgs,
  AddNodeResult,
} from "./args-types.ts";
import { nowKst } from "./helpers.ts";
import { contentHash } from "../../memory/content-hash.ts";
import { toNfc } from "../../memory/nfc.ts";
import type { NodeProvenance, NodeSourceRef } from "../../memory/node-sources/source-ref.ts";
import type { Constructor, NodeRepoInternals } from "./node-repo-base.ts";
import { lineageInvalidatedSql } from "./extraction-state-sql.ts";
import {
  absorptionExcludedId,
  bumpMentionSync,
  resolveNodeProvenance,
  type AbsorbInputResult,
} from "./node-absorption.ts";

// 정확-중복 흡수 대상 — (content_hash, project_id) 가 같은 가장 오래된 행. project_id NULL
// 안전 비교(SQLite `= NULL` 은 항상 UNKNOWN)라 NULL 스코프와 특정 project 를 따로 둔다.
// 계보 무효화로 철회된 행(원문 편집·철회가 거둔 파생 기억)은 흡수하지 않는다(SL-2): 거기
// 흡수되면 같은 본문을 다시 저장·추출해도 기본 조회에 나오지 않는다. 사용자가 직접 철회·
// 대체한 행은 계속 흡수한다(철회된 내용의 재전송이 기억을 되살리지 않는다).
// 파생 입력의 원문(extractionOriginId)은 흡수 후보에서 뺀다(WP-B1-20T 설계 3.6) — 원문과 같은
// 주장은 자기 주장 규칙이 따로 처리한다.
const ABSORBABLE = `NOT ${lineageInvalidatedSql("knowledge_nodes")}`;
const ABSORB_SQL = {
  withoutProject: `SELECT id FROM knowledge_nodes
    WHERE content_hash = ? AND project_id IS NULL AND ${ABSORBABLE} ORDER BY id ASC LIMIT 1`,
  inProject: `SELECT id FROM knowledge_nodes
    WHERE content_hash = ? AND project_id = ? AND ${ABSORBABLE} ORDER BY id ASC LIMIT 1`,
  withoutProjectExcluding: `SELECT id FROM knowledge_nodes
    WHERE content_hash = ? AND project_id IS NULL AND id <> ? AND ${ABSORBABLE} ORDER BY id ASC LIMIT 1`,
  inProjectExcluding: `SELECT id FROM knowledge_nodes
    WHERE content_hash = ? AND project_id = ? AND id <> ? AND ${ABSORBABLE} ORDER BY id ASC LIMIT 1`,
} as const;

function findAbsorbingNodeId(
  db: Database,
  hash: string,
  projectId: string | null,
  excludedId: number | null = null,
): number | null {
  let row: unknown;
  if (excludedId === null) {
    row = projectId === null
      ? db.query(ABSORB_SQL.withoutProject).get(hash)
      : db.query(ABSORB_SQL.inProject).get(hash, projectId);
  } else {
    row = projectId === null
      ? db.query(ABSORB_SQL.withoutProjectExcluding).get(hash, excludedId)
      : db.query(ABSORB_SQL.inProjectExcluding).get(hash, projectId, excludedId);
  }
  return row ? (row as { id: number }).id : null;
}

export function NodeRepoIngestMixin<
  TBase extends Constructor<NodeRepoInternals>,
>(Base: TBase) {
  return class NodeRepoIngestMixed extends Base {
    /**
     * Insert a new knowledge node, embed its content, and store the vector
     * in vec_nodes. Returns the new node id.
     *
     * If `args.embedding` is provided it's used directly (and validated
     * against the embedder's expected dimension); otherwise the embedder is
     * invoked here. Inserts are wrapped in a transaction so a vec_nodes
     * failure rolls back the knowledge_nodes row.
     *
     * Phase 11a T3 note — `source_type='image_asset'` 노드는 본 메서드를 거치지
     * 않는다. 이미지는 텍스트 임베딩이 없어 `embedding_text=NULL` + `vec_nodes`
     * skip + `image_vec` 별도 합류 흐름이 필요하다. 전용 helper =
     * `memory/image-asset.ts::addImageAssetNode`. SourceType 합집합에 'image_asset'
     * 가 추가됐지만 본 `addNode` 통로로 호출하면 `vec_nodes` 에 텍스트 임베딩이
     * 합류돼 디자인이 어긋난다 — image_asset 노드는 항상 `addImageAssetNode`
     * 사용.
     */
    async addNode(args: AddNodeArgs): Promise<number> {
      return (await this.addNodeIdempotent(args)).id;
    }

    /**
     * P0-A 입력 멱등성 — `addNode` 와 같되 정확-중복이면 기존 노드를 재사용하고
     * 재사용 여부(`reused`)까지 반환한다.
     *
     * 진입 시 NFC 로컬 `content`(아래 정규화 경계 문단 참조)를 만들고
     * `contentHash(content)`(그 위에 추가 trim + sha256, content-hash.ts 단일 출처)를
     * 계산해 `content_hash` 로 기존 노드를 조회한다. 히트(정확 중복)면 새
     * INSERT·임베딩 계산 없이 `bumpMention` 만 하고 기존 id 를 `reused: true` 로
     * 반환한다 — 같은 정규화 내용을 N번 넣어도 knowledge_nodes·vec_nodes·FTS·
     * trigram 이 각 1행이고 mention_count 만 오른다(오염 방지 + 재언급 신호 보존).
     * 미스면 기존 INSERT 흐름 그대로 실행하되 `content_hash` 칸도 채운다.
     *
     * 동시성 전제: bun:sqlite 동기 + 단일 Bun 스레드라 SELECT → INSERT 사이에 다른
     * 호출이 끼어들지 않는다(setEventAt 등 read-modify-write 선례와 동일 근거,
     * node-repository.ts setEventAt 주석). 다중 프로세스/Worker 로 같은 DB 를 공유하게
     * 되면 UNIQUE + `INSERT ... ON CONFLICT` 로 승격한다(그 시점 별 결정 — spec §4.1).
     *
     * 해시 조회 실패는 삼키지 않고 그대로 던진다 — 조용히 새 노드를 만드는 silent
     * fallback 을 두지 않는다(입력 저장 실패를 정직히 알린다 / spec §5.3).
     *
     * NFC 정규화 경계(G3-a) — `args.content` 를 진입 시점에 한 번 NFC 로 통일해 로컬
     * `content` 로 고정한다. 이 로컬 하나를 content_hash 계산·임베딩·INSERT 세 곳이
     * 모두 사용한다 — 세 곳이 각각 `args.content` 를 따로 읽으면 NFC/NFD 입력에 따라
     * 저장 content 와 저장 임베딩·해시가 서로 다른 정규화 상태로 갈릴 수 있다.
     * trim 은 하지 않는다(저장 content 는 앞뒤 공백 보존이 기존 계약).
     */
    async addNodeIdempotent(args: AddNodeArgs): Promise<AddNodeResult> {
      const content = toNfc(args.content);
      const hash = contentHash(content);
      const sourceType: SourceType = args.sourceType ?? "auto_capture";
      const projectId = args.project_id ?? null;

      // 정확-중복 조회 — content_hash 로 기존 노드를 찾는다. 히트면 재사용(흡수).
      // 최저 id 를 재사용한다(장수 DB 에 이미 정확 중복이 쌓여 같은 해시 다수 행이
      // 있을 수 있으므로 ORDER BY id ASC LIMIT 1 로 결정적 선택 — spec §7.4).
      //
      // 흡수 키는 (content_hash, project_id) 다. 같은 정규화 내용이라도 project_id 가
      // 다르면 별 노드다 — bara 는 D8 다중 프로젝트 어휘 가르마로 project_id 를 노드
      // 정체성의 1급 스코프로 둔다(knowledge_nodes.project_id). project 를 무시하고
      // content 만으로 흡수하면 "프로젝트 A 의 같은 문장"과 "프로젝트 B 의 같은 문장"이
      // 한 노드로 뭉쳐 프로젝트 분리 계약이 깨진다(extractor findDedupTarget 이 author +
      // projectId 로 dedup 하는 선례와 정합 — extractor.ts:961). project_id 는 NULL(무소속)
      // 도 하나의 스코프라, NULL 끼리만 흡수하고 NULL 과 특정 project 는 안 섞는다.
      //
      // document_chunk 는 흡수 대상에서 제외한다(content_hash 는 채우되 재사용은 안 함).
      // 근거: (1) 청크는 원문의 *검색용 조각*이라 같은 조각이 한 글 안 여러 위치에
      // 나오면 각각 별 위치를 대표해야 검색 커버리지가 유지된다 — 한 입력 안에서 반복
      // 조각을 한 노드로 흡수하면 chunkNodeIds 에 같은 id 가 겹쳐 들어가고 위치 대표성이
      // 깨진다. (2) 청크는 항상 부모 origin 에 종속되고(parent_of), 긴 글 재입력 시
      // origin 이 흡수(reused)되면 save-input 이 saveChunks 자체를 skip 하므로 "긴 글
      // 재입력 시 청크 흡수"(spec §8 기준 4)는 origin 흡수로 이미 달성된다 — 청크에
      // 개별 content_hash 흡수는 불필요하다. spec §6 트레이드오프("코어에 걸면 청크도
      // 흡수 대상 → source_type 별 적용 범위 명시")의 청크 판단을 여기서 확정한다.
      //
      // 계보 무효화로 철회된 행은 흡수 대상이 아니다(findAbsorbingNodeId 주석).
      //
      // WP-B1-20T — 출처(args.provenance, 비면 인자에서 도출)를 여기서 한 번 정해 흡수·새 노드
      // 양쪽이 같은 값을 기록한다(node-absorption.ts).
      const provenance = resolveNodeProvenance(args);
      if (sourceType !== "document_chunk") {
        const existingId = findAbsorbingNodeId(this.db, hash, projectId, absorptionExcludedId(provenance));
        if (existingId !== null) {
          // 재언급 신호와 출처 기록만 남기고 흡수 — 새 INSERT·임베딩 계산 없음(중복 임베딩
          // 낭비 제거). 언급은 dbRevision 을 안 올린다(데이터 노드 수 불변 — 검색 캐시
          // 무효화 불필요한 메타 변경). updated_at 도 안 건드린다(재언급 ≠ 본문 수정 /
          // spec §4.3). 출처 행·재전송·계보 규칙은 absorbInputSync(node-absorption.ts)가 정한다.
          this.absorbInputSync(existingId, provenance);
          return { id: existingId, reused: true };
        }
      }

      const vector =
        args.embedding ?? (await this.embedder.embed(content));
      if (vector.length !== this.embedder.dimension) {
        throw new Error(
          `addNode embedding dim mismatch: got ${vector.length}, expected ${this.embedder.dimension}`,
        );
      }

      const tx = this.db.transaction(() =>
        this.insertNodeWithVecSync({ ...args, provenance }, content, hash, vector),
      );
      const newId = tx();
      this.emitRawMemoryAdded();
      return { id: newId, reused: false };
    }

    /**
     * addNodeIdempotent 의 INSERT 본체(동기·트랜잭션 미포함) — knowledge_nodes 1행 +
     * vec_nodes 1행을 넣고 새 id 를 돌려준다. `content`/`hash` 는 호출자가 이미
     * NFC·contentHash 로 확정한 값을 받는다(정규화 경계 G3-a — 저장 content 와
     * 해시·벡터가 같은 문자열에서 나오도록 호출자 한 곳에서 고정). 트랜잭션·흡수
     * 판정·차원 검증·emit·dbRevision 은 호출자 몫이다 — addNodeIdempotent(단건 tx)와
     * DocumentGraphRepository(문서 단위 큰 tx / addConceptEdgeSync M-5 동기 본체
     * 패턴)가 이 한 본체를 공유해 INSERT 규칙이 두 곳으로 갈라지지 않게 한다.
     *
     * WP-B1-20T — 새 노드의 출처(args.provenance, 비면 인자에서 도출)도 같은 트랜잭션에서
     * 기록한다: source 면 출처 행, 부모 있는 derived 면 계보 엣지(node-absorption.ts).
     */
    insertNodeWithVecSync(
      args: AddNodeArgs,
      content: string,
      hash: string,
      vector: Float32Array,
    ): number {
      const sourceType: SourceType = args.sourceType ?? "auto_capture";
      const memoryType: MemoryType = args.memoryType ?? "fact";
      const importance = args.importance ?? 0.5;
      const confidence = args.confidence ?? 0.7;
      const platform = args.platform ?? "";
      const author = args.author ?? "";
      const metadataJson = JSON.stringify(args.metadata ?? {});

      // created_at / last_accessed_at 명시 — schema DEFAULT의 datetime()이
      // WSL → Windows bun 경계에서 UTC로 떨어지므로 application 측에서 KST로.
      // content 칸 — NFC 정규화 후 저장(trim 은 안 함, 앞뒤 공백 보존은 기존 계약).
      // content_hash — 그 NFC 문자열에 추가로 trim 후 sha256(흡수 키 전용 규칙).
      const insertNode = this.db.query(
        `INSERT INTO knowledge_nodes
          (content, memory_type, source_type, importance, confidence,
           platform, author, metadata_json, project_id, polarity, event_at, content_hash, created_at, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertVec = this.db.query(
        "INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)",
      );

      const now = nowKst();
      insertNode.run(
        content,
        memoryType,
        sourceType,
        importance,
        confidence,
        platform,
        author,
        metadataJson,
        args.project_id ?? null,
        args.polarity ?? null,
        args.eventAt ?? null,
        hash,
        now,
        now,
      );
      const idRow = this.db
        .query("SELECT last_insert_rowid() AS id")
        .get() as { id: number };
      insertVec.run(idRow.id, vector);
      this.absorption.recordNewNodeSync(idRow.id, resolveNodeProvenance(args));
      return idRow.id;
    }

    /**
     * 노드 INSERT 성공 신호 한 묶음 — Phase 5.7.3 W3 데이터 변동 신호(trigger
     * 미주입 시 no-op) + Phase 6b T3 (R4) 검색 캐시 키용 변동 카운터 상승(같은
     * 지점 합류). addNodeIdempotent 와 DocumentGraphRepository 가 *삽입된* 노드
     * 1개당 1회, 트랜잭션 commit 후에 호출한다 — 롤백된 삽입에 신호가 나가지
     * 않는다. 흡수(reused)는 호출 안 함(데이터 노드 수 불변 — 기존 계약).
     */
    emitRawMemoryAdded(): void {
      this.autoCleanupTrigger?.emit("raw-memory-added");
      this.dbRevision += 1;
    }

    /**
     * P0-A 입력 멱등성 — (정규화 content_hash, project_id) 로 기존 노드 id 를 조회한다
     * (없으면 null). 최저 id 를 돌려준다(장수 DB 정확 중복 다수 대비 — addNodeIdempotent
     * 와 동일 규칙). project_id 를 흡수 키에 포함하는 근거·NULL 안전 비교는
     * addNodeIdempotent 주석 참조(프로젝트 분리 계약 보존).
     *
     * immediate 추출 갈래(save-input.ts)가 무거운 LLM 추출 *전에* 재입력을 미리
     * 감지해 추출·원본 저장·atomic 자식 생성을 통째 skip 하는 프리체크에 쓴다 —
     * addNodeIdempotent 는 origin INSERT 시점에야 재사용을 알지만, 추출은 그보다
     * 앞 단계라 별도 프리체크가 필요하다(같은 흡수 키 단일 출처 조회). project 를
     * 무시하면 다른 project 의 같은 글을 재입력으로 오인해 추출을 잘못 skip 한다.
     */
    async findNodeIdByContentHash(
      content: string,
      projectId: string | null = null,
    ): Promise<number | null> {
      return this.findNodeIdByContentHashSync(content, projectId);
    }

    /**
     * findNodeIdByContentHash 의 동기 본체 — embed/await 없는 순수 SELECT 라
     * 호출자가 `db.transaction(() => {...})` 동기 콜백 안에서 흡수 판정에 쓸 수
     * 있다(addConceptEdgeSync M-5 패턴 — DocumentGraphRepository 문서 단위 원자
     * 쓰기가 소비). 외부 호출자는 그대로 findNodeIdByContentHash(async)를 쓴다.
     */
    findNodeIdByContentHashSync(
      content: string,
      projectId: string | null = null,
    ): number | null {
      return findAbsorbingNodeId(this.db, contentHash(content), projectId);
    }

    /**
     * P3 G5-d — 배치 입력 통로. argsList 전체의 임베딩을 embedBatch 1회로 계산한 뒤
     * 입력 순서대로 addNodeIdempotent 를 실행한다. 반환 배열은 입력 순서와 같다.
     *
     * 의미론은 같은 인자로 addNodeIdempotent 를 순차 호출한 것과 동일하다 — 흡수
     * (content_hash, project_id)·document_chunk 흡수 제외·mention bump·NFC 정규화가
     * 전부 그 단일 출처(addNodeIdempotent)에서 실행된다. 이 메서드는 2차 pass 진입
     * 전에 "어느 항목이 실제 INSERT 에 도달해 임베딩이 필요한가"만 선판정해, 그
     * 항목들의 *NFC 정규화 content* 를 embedBatch 로 모아 계산·주입한다 — 원문
     * 그대로 임베딩하면 NFD 입력에서 저장 content(NFC)와 벡터가 어긋난다(G3-a
     * 정규화 경계와 같은 문자열이어야 한다).
     *
     * 임베딩 필요 판정(1차 pass): (a) args.embedding 미주입이고, (b) DB 에
     * (content_hash, project_id) 기존 노드가 없고, (c) 배치 내 같은 키의 첫
     * 등장이거나 document_chunk(흡수 제외라 항상 INSERT). 같은 정규화 content 는
     * 벡터가 같으므로 embedBatch 입력에서 한 번만 계산한다.
     *
     * 1차 pass 판정은 최적화일 뿐 정합의 권위가 아니다 — embedBatch await 사이에
     * 다른 호출이 DB 를 바꿔 판정이 빗나가도 2차 pass 의 addNodeIdempotent 가
     * 흡수/INSERT 를 다시 판정한다(주입 임베딩이 안 쓰이면 버려지고, 필요한데
     * 없으면 그 항목만 embed 단건 계산으로 떨어진다 — 결과는 항상 정확).
     */
    async addNodesBatch(
      argsList: readonly AddNodeArgs[],
    ): Promise<AddNodeResult[]> {
      if (argsList.length === 0) return [];

      // 1차 pass — 정규화·해시 선계산 + 임베딩 필요 항목 산출.
      const prepared = argsList.map((args) => {
        const content = toNfc(args.content);
        const sourceType: SourceType = args.sourceType ?? "auto_capture";
        return {
          args,
          content,
          sourceType,
          projectId: args.project_id ?? null,
        };
      });

      // 배치 내 같은 (content_hash, project_id) 의 첫 등장만 임베딩 대상 — 뒤 중복은
      // 2차 pass 에서 앞 항목이 INSERT 한 행(또는 DB 기존 행)을 흡수한다. 키 구분자는
      // NUL — content_hash 는 hex 라 NUL 을 안 담고, NULL 스코프는 별 접두사로 가른다.
      const seenInBatch = new Set<string>();
      const embedTexts: string[] = [];
      const embedIndexByContent = new Map<string, number>();
      const queueEmbed = (content: string): void => {
        if (!embedIndexByContent.has(content)) {
          embedIndexByContent.set(content, embedTexts.length);
          embedTexts.push(content);
        }
      };

      for (const p of prepared) {
        if (p.sourceType === "document_chunk") {
          // 흡수 제외(addNodeIdempotent 계약) — 항상 INSERT 에 도달하므로 주입이
          // 없으면 항상 임베딩이 필요하다.
          if (!p.args.embedding) queueEmbed(p.content);
          continue;
        }
        const key =
          p.projectId === null
            ? `\u0000${contentHash(p.content)}`
            : `p\u0000${p.projectId}\u0000${contentHash(p.content)}`;
        if (seenInBatch.has(key)) continue; // 뒤 중복 — 앞 항목의 행을 흡수 예정.
        seenInBatch.add(key);
        const existingId = findAbsorbingNodeId(
          this.db,
          contentHash(p.content),
          p.projectId,
          absorptionExcludedId(resolveNodeProvenance(p.args)),
        );
        if (existingId !== null) continue; // DB 기존 노드 흡수 예정 — 임베딩 불필요.
        if (!p.args.embedding) queueEmbed(p.content);
      }

      const vectors =
        embedTexts.length > 0 ? await this.embedder.embedBatch(embedTexts) : [];
      if (vectors.length !== embedTexts.length) {
        throw new Error(
          `addNodesBatch embedBatch count mismatch: got ${vectors.length}, expected ${embedTexts.length}`,
        );
      }

      // 2차 pass — 입력 순서대로 기존 멱등 흐름 실행(임베딩 주입). 차원 검증은
      // addNodeIdempotent 의 기존 dim mismatch loud throw 가 그대로 담당한다.
      const results: AddNodeResult[] = [];
      for (const p of prepared) {
        const idx =
          p.args.embedding === undefined
            ? embedIndexByContent.get(p.content)
            : undefined;
        const args =
          idx === undefined ? p.args : { ...p.args, embedding: vectors[idx]! };
        results.push(await this.addNodeIdempotent(args));
      }
      return results;
    }

    /**
     * 흡수 한 번 — 재언급 신호와 이번 입력의 출처(출처 행 또는 계보 엣지)를 한 트랜잭션으로
     * 남긴다(WP-B1-20T 설계 3.6). 같은 본문·유사 본문 흡수 통로는 모두 이 메서드를 쓴다: 입력
     * 저장(addNodeIdempotent·문서 그래프), 즉시 추출 재입력, 공유 기억 쓰기, 추출 dedup.
     *
     * source 입력은 출처 행을 INSERT OR IGNORE 한다. 같은 메시지 행이 이미 있으면 재전송이라
     * 아무것도 바꾸지 않는다(언급·metadata·가시성 번호 그대로). derived 입력은 언급을 올리고
     * 부모가 있으면 흡수한 노드 → 부모 계보 엣지를 더한다(자기·조상으로는 만들지 않는다).
     * 출처는 서버 전용 표에 있어 흡수가 metadata_json 을 바꾸지 않는다. 규칙 본체는
     * node-absorption.ts 다.
     */
    async absorbInput(id: number, provenance: NodeProvenance): Promise<AbsorbInputResult> {
      return this.absorbInputSync(id, provenance);
    }

    /** absorbInput 의 동기 본체 — 트랜잭션 동기 콜백 안 흡수(문서 그래프·공유 기억 쓰기)가 쓴다. */
    absorbInputSync(id: number, provenance: NodeProvenance): AbsorbInputResult {
      return this.absorption.absorbInputSync(id, provenance);
    }

    /**
     * 출처 행만 남긴다(언급·계보 없음). 철회된 기억에 같은 본문의 AI 저장이 흡수될 때 공유 기억
     * 쓰기가 쓴다 — 되살리지 않되, 이 저장이 노드를 붙잡는다(설계 5.1). 새 행이면 true.
     */
    recordSourceSync(id: number, ref: NodeSourceRef): boolean {
      return this.absorption.recordSourceSync(id, ref);
    }

    /**
     * Increment mention_count and apply a small importance boost, capped at
     * MAX_IMPORTANCE. Used when an existing node is re-mentioned in new
     * input — keeps recurring topics relevant without unbounded inflation.
     * 흡수 통로는 이것 대신 absorbInput 을 쓴다 — 흡수는 언급과 함께 입력의 출처를 기록한다.
     */
    async bumpMention(id: number): Promise<void> {
      this.bumpMentionSync(id);
    }

    /**
     * bumpMention 의 동기 본체 — 문장 본체는 node-absorption.ts 의 bumpMentionSync(흡수 규칙과 공유).
     */
    bumpMentionSync(id: number): void {
      bumpMentionSync(this.db, id);
    }
  };
}
