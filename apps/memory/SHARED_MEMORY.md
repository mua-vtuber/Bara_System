# 여러 AI가 공유하는 기억

기존 SQLite와 MCP 서버를 사용한다. MCP 도구는 18개이며 새 도구는 `recall_context`, `update_memory`, `supersede_memory`, `retract_memory`다. 기본 검색·저장·프로필과 정리 도구는 유지된다.

## 적용 범위와 현재 기억

`search_memory`의 기존 `project`는 검색 어휘 확장이다. 결과의 프로젝트 범위를 제한하려면 `scope`를 사용한다.

```json
{
  "query": "배포 결정",
  "scope": { "projectId": "bara", "includeGlobal": true },
  "responseMode": "index"
}
```

- `scope: {"projectId": null}`: 전역 기억만.
- `scope: {"projectId": "bara", "includeGlobal": false}`: 해당 프로젝트만.
- 검색/list_recent의 scope 생략: 기존처럼 프로젝트 전체를 대상으로 한다.
- get_profile/recall_context의 scope 생략: 전역 기억만. 프로젝트 scope를 주면 includeGlobal 기본값은 true다.
- 기본 조회는 active 상태이면서 유효기간 안에 있고 근거가 현재 사용 가능한 기억만 포함한다. `includeInactive: true`는 명시적인 역사 조회에 사용한다.
- 직접 ID를 지정하는 get_memory는 철회·대체된 기억도 반환한다. `current`로 현재 활용 가능 여부, `sharedMemory`로 원래 상태/개정/주장 종류를 확인한다.
- 검색 응답의 부가 출력(부모 치환·이웃 청크·요약·엔티티·개념 확장·이미지 캡션)은 항목마다 실제 출처 노드·문서를 그 응답과 같은 조회 규칙(scope·includeInactive)으로 판정한다. 출처가 허용되지 않은 항목만 빼고, 이번 응답에서 실제로 뺀 항목이 있는 종류만 `omittedAncillary`에 적는다. 응답과 무관한 비활성 노드는 부가 출력을 끄지 않는다. 출처 노드가 없는 엔티티(대시보드에서 만든 것)는 scope 없는 검색에서만 싣는다. 범위를 넘어선 자료로 결과를 채우지 않는다.

`recall_context`는 프로필과 검색 결과를 한 문맥으로 조립한다. `budget` 기본값 2000, 상한 16000이며 문자 기반 토큰 **추정**값이다. 실제 모델별 토크나이저의 엄격한 상한을 보장하지 않는다. 너무 긴 항목은 건너뛰고 다음 근거를 고려하며, 실제 포함한 기억 ID만 반환한다.

```json
{ "scope": { "projectId": "bara" }, "query": "현재 배포 방식", "budget": 2000 }
```

## 근거를 포함한 저장

store_memory와 save_decision/save_idea/save_question/save_preference에 `evidence`를 전달할 수 있다. REST `POST /memories`도 같은 evidence 계약을 받는다.

```json
{
  "content": "바라 프로젝트 런타임은 Bun으로 정했다.",
  "project": "bara",
  "evidence": {
    "assertionKind": "user_statement",
    "sourceEventId": "conversation-2026-09-20/message-8",
    "claimKey": "runtime-choice",
    "sessionRef": "conversation-2026-09-20"
  }
}
```

- assertionKind: unknown / user_statement / observation / ai_inference. 생략하면 unknown이다. 이는 저장 클라이언트의 출처 분류이며 서버가 내용의 진위를 인증하는 값이 아니다.
- sourceEventId: 원래 발언/사건의 안정적인 ID. 같은 사건을 여러 AI가 읽으면 같은 값을 사용한다. 다른 사건이면 다른 값이다.
- claimKey: 한 사건에서 서로 다른 주장을 저장할 때 구분한다. sourceEventId 없이는 사용할 수 없다.
- sessionRef: 출처 대화 참조.
- evidenceRefs: 기존 기억 ID 배열. 그 기억을 직접 저장한 작성자가 선언한 근거다. 독립적으로 뒷받침하는 근거의 대안 집합이며, 하나라도 현재의 독립 근거가 있으면 유지한다. 여러 자료의 조합이 필수인 주장은 조합을 기록한 별도 근거 노드를 참조한다. 서버가 원문에서 만든 파생 기억(청크 `document_chunk`, 추출 기억 `llm_extract`, 이미지 캡션 `image_caption`)은 자기 evidenceRefs를 갖지 않고 계보 부모(`merged_into`·`parent_of` 연결과 부모의 `extractedTo`)로만 근거를 얻는다. 원문의 근거는 원문을 거쳐서만 파생 기억에 전달되므로, 원문을 철회·대체하면 원문의 근거가 살아 있어도 그 원문에만 기댄 파생 기억은 함께 빠진다.
- validFrom / validUntil: 시간대가 있는 ISO 시각. 시작 포함, 종료 제외. 사건 날짜와 사실의 유효기간은 별개다.

같은 프로젝트·sourceEventId·claimKey의 재전송은 원래 ID를 반환하며 언급 횟수와 중요도를 반복해서 올리지 않는다. 내용이 같은 별도 사건은 기존 노드에 흡수하되 사건별 근거와 producer를 별도 원장에 남긴다. get_memory의 `evidence`에서 읽을 수 있다. 철회된 내용의 재전송은 기억을 부활시키지 않는다.

작성 AI는 검증된 토큰에서 식별한다. MCP나 근거가 있는 인증 REST 입력의 `author`를 임의 신고로 바꾸지 않는다. 본문뿐 아니라 새 근거 문자열과 MCP 수정 사유에도 기존 비밀값 검사를 적용한다. REST 저장 세 경로(근거 없는 `POST /memories`, `POST /memories/:id/append`, `POST /memories/from-text`)도 같은 규칙을 따른다.

- 서버 관리 metadata 칸 `sharedMemory`·`extracted`·`extractedTo`는 가시성과 백필 판정이 믿는 서버 기록이다. `extracted`가 1이면 현재 본문 주장을 추출했고 `extractedTo`에 그때 만든 자식이 있다. 0이면 편집으로 본문 주장이 바뀌어 다시 추출을 기다린다. 세 REST 경로는 토큰 권한과 상관없이 이 칸이 든 `metadata`를 400으로 거부하고 아무것도 저장하지 않는다. 근거는 `evidence`로 보낸다. MCP `store_memory`의 자유 metadata에 든 sharedMemory는 서버가 만든 상태로 바뀌고, `extracted`·`extractedTo`는 INVALID_INPUT으로 거부된다.
- 제한 토큰(mcp-standard)의 작성자는 토큰 adapterId다. 다른 `author`나 `metadata.user_id`(사람 노드 연결용 작성자 ID)를 보내면 403으로 거부한다. author를 생략하면 adapterId로 저장한다.
- full 토큰(scope 없는 옛 토큰 포함)은 Discord 봇처럼 다른 사람의 글을 중계하므로 근거 없는 저장에서 `author`와 `metadata.user_id`를 지정할 수 있다. 근거가 있는 저장은 full 토큰도 adapterId로 기록한다.

## 정정·대체·철회

먼저 get_memory로 현재 `sharedMemory.revision`을 읽는다. 새 도구는 `expectedRevision`, `requestId`를 요구한다. 요청 ID는 재시도할 때만 동일하게 쓰며, 다른 내용·다른 행위자가 같은 ID를 재사용하면 CONFLICT다.

```json
{
  "id": 42,
  "content": "정정한 본문",
  "expectedRevision": 0,
  "requestId": "client-a-correction-20260920-001",
  "reason": "사용자가 원래 기록의 오기를 정정함"
}
```

- update_memory: 같은 ID의 본문 정정. 기존 해시태그는 보존하므로 content에는 해시태그를 넣지 않는다. 문서/이미지 자산 본체는 직접 편집하지 않는다.
- supersede_memory: 대체 기억을 먼저 저장한 뒤 `replacementId`를 지정한다. 같은 프로젝트의 현재 유효한 기억이어야 하며 순환 대체는 거부한다. 예외는 충돌 후보 채택이다: 대체 기억이 disputed이고 대상 기억과 contradicts 엣지(대체 기억 → 대상)로 연결돼 있으면, 같은 변경 안에서 대체 기억을 active로 바꾸고(revision+1) 대상을 superseded로 바꾼다. 응답의 `affectedNodeIds`에 대체 기억 ID가 추가된다. 그 밖의 disputed 기억은 대체 기억이 될 수 없고 INVALID_INPUT으로 거부한다.
- retract_memory: 사용을 철회한다. 물리적 삭제가 아니므로 이력과 백업은 남는다. 철회된 텍스트의 명시적인 정정은 다시 활성화할 수 있지만, 무효화된 파생물까지 자동 부활시키지는 않는다. 다시 현재 기억이 된 원문은 백필이 새 파생물을 만든다(긴 글은 정정 직후 다시 청크로 나눈다).
- 기존 REST PATCH에도 expectedRevision을 선택적으로 전달할 수 있다. 생략한 기존 클라이언트는 호환된다. 모든 편집은 개정 번호를 올린다. 본문 주장(추출기가 읽는 본문, 해시태그 제외)이 바뀐 편집은 관련 파생물을 무효화하고 원문을 재추출·재청크 대상으로 되돌린다. 태그·분류만 바뀐 편집은 파생물을 유지하고, 분류만 바뀐 편집은 임베딩도 다시 계산하지 않는다.

버전 충돌은 최신 revision을 포함해 반환한다. 최신 내용을 다시 읽고 의도를 재판단해야 한다. 여러 클라이언트의 비동기 임베딩·저장·재연결은 데이터베이스별 쓰기 큐로 순서를 보장한다. 이는 단일 서버 프로세스의 계약이며 여러 프로세스에서 동일 DB를 동시에 서비스하는 구성을 위한 분산 잠금은 아니다.

유사도만으로 옛 사실을 확정적으로 대체하지 않는다. 자동 충돌 감지는 disputed 후보를 만들며 명시적 대체와 구분된다. 추출 기억(fact·preference)과 본문이 바뀐 편집을 검사해, 같은 주체·프로젝트·기억 종류의 현재 기억 중 유사도가 충돌 범위(설정 `search.conflictCheckMin` 이상 `search.conflictSameMax` 미만, 미지정이면 글 모델별 기본 임계)인 것이 있으면 새 기억 → 옛 기억 contradicts 엣지를 만들고 새 기억을 disputed로 바꾼다. 옛 기억은 active로 남는다. 해소는 사용자에게 확인한 뒤 supersede_memory(옛 기억, replacementId = 충돌 후보)로 새 기억을 채택하거나, retract_memory로 충돌 후보를 버려 옛 기억을 유지한다.

충돌 비교의 주체는 작성 AI(author)가 아니라 기억이 누구에 대한 주장인가다. `metadata.user_id`가 있으면(Discord 봇처럼 다른 사람의 글을 중계한 기억) 그 사람이 주체이고, 없으면 사용자 본인이다. 그래서 Claude 토큰과 Codex 토큰이 각각 기록한 사용자 본인의 선호는 서로 비교되고, 서로 다른 Discord 사용자의 선호는 비교되지 않는다. 알려진 한계: 소유자가 Discord에 직접 쓴 글은 `user_id`가 소유자의 Discord ID라서 AI가 기록한 본인 기억과 비교되지 않는다. 코어는 소유자의 Discord ID를 모른다(봇 설정 `ownerUserId`에만 있다).

유사도가 충돌 범위 상한(`search.conflictSameMax`) 이상인 "거의 같은 문장" 쌍은 작성 AI(author)로 가른다. 같은 AI가 남긴 쌍은 새 추출 기억을 만들지 않고 기존 기억에 흡수하며(유사 중복 흡수, 설정 `search.mergeSimThreshold`) 충돌로 보지 않는다. 다른 AI가 남긴 쌍은 흡수하지 않고, 같은 주체·프로젝트·기억 종류이면 충돌 후보(새 기억 → 옛 기억 contradicts 엣지, 새 기억 disputed)로 표시한다. 예: Claude 토큰의 "답변은 한국어로 해 주세요"와 Codex 토큰의 "답변은 영어로 해 주세요"(bge-m3 유사도 약 0.87). 해소 방법은 위와 같다. 정규화(NFC + 앞뒤 공백 제거) 후 같은 본문은 같은 주장이라 충돌이 아니다 — 저장 때는 같은 본문 흡수로 기존 기억 하나에 모이고, 편집으로 같은 본문이 된 경우도 충돌 후보로 만들지 않는다. 알려진 약점: 두 AI가 같은 생각을 거의 같은 문장(토씨만 다름)으로 저장하면 반대 주장이 아니어도 충돌 후보로 표시되어 사용자가 한 번 확인해야 한다. 추가 LLM 호출로 뜻을 가리지 않기 때문이다.

원문 정정/철회는 근거로만 지지되던 파생 기억, 관련 요약에 전파된다. 다른 독립적인 현재 근거가 있는 기억은 보존한다. 만료·누락된 근거만 남은 파생 기억도 기본 조회에서 제외한다. 백필은 현재 사용 가능한 원문만 재추출한다. 추출 이후 본문 주장이 바뀐 원문과, 추출 자식이 모두 계보 무효화(`invalidatedBy`가 기록된 철회)로 빠진 원문은 다시 추출 후보가 된다. 계보 무효화로 빠진 기억은 새 추출의 유사 중복 흡수와 같은 본문 저장의 흡수 대상이 아니다 — 거기 흡수되면 다시 만든 주장이 기본 조회에 나오지 않는다. 클라이언트가 직접 철회·대체한 파생 기억과 충돌 후보는 처리된 추출로 남아, 그 원문을 다시 추출하지 않는다.

이전 버전은 청크·추출 기억을 만들 때 원문의 evidenceRefs를 복사해 저장했다. 이 복사 값은 가시성 판정과 무효화에서 근거로 세지 않고, get_memory·get_profile의 `sharedMemory`에도 표시하지 않는다. 저장 행은 고치지 않는다(비파괴). 그래서 원문이 이미 철회·대체된 옛 파생 기억은 저장 status가 active로 남아 있어도 기본 조회에서 빠지고 get_memory의 `current`는 false다. 저장 행을 고치지 않아 남는 차이가 하나 있다: 원문을 같은 본문 그대로 다시 활성화하면 무효화 표시가 없던 옛 파생 기억도 다시 보인다. 본문이 원문과 같아 내용 오류는 없다. 원문의 본문 주장이 바뀌는 정정은 편집 무효화가 옛 파생 기억을 철회한다.

## 출처 목록과 삭제·수정 동기화

기억마다 서버가 관리하는 "이 내용을 저장한 출처" 목록(`memory_node_sources`, 휴지통 쪽은 `memory_node_sources_archive`)을 둔다. 클라이언트가 보내는 `metadata`와 분리된 서버 전용 표라서 REST·MCP 입력으로 쓸 수 없다. 기억은 자기 출처 행이 있거나 살아 남는 계보 부모(`merged_into`·`parent_of` 연결)가 있으면 남는다.

- 출처 행의 종류: `message`(입력 metadata에 `messageId`가 있는 저장, 키는 플랫폼과 `messageId`이고, 첨부는 첨부 id까지 더한 키), `direct_save`(메시지 id 없는 저장 — 대시보드·REST·MCP·Pet·봇 명령·문서·이미지, 저장 통로와 작성자 한 쌍마다 행 하나), `restore`(휴지통에서 되살림). 휴지통 표에는 파생 기억이 어느 계보 부모에서 왔는지 적는 `archived_lineage` 행이 더 있고, 복원 때 출처로 돌아가지 않는다.
- 파생 기억(청크·추출 기억·이미지 캡션·regex 원자)은 부모의 출처를 물려받지 않고 계보 연결로만 남는다. 파생 입력이 이미 있는 기억에 흡수되면 출처 행 대신 그 기억에서 이번 부모로 가는 계보 연결이 더해진다. 직접 저장이 파생 기억에 흡수되면 그 기억이 직접 저장의 출처 행을 가진다.
- 같은 플랫폼·`messageId`의 재전송은 아무것도 바꾸지 않는다(언급 횟수·metadata·가시성 번호 그대로). 다른 `messageId`의 같은 본문은 같은 기억에 출처 행을 하나 더한다. 같은 통로·작성자의 반복 저장은 행을 늘리지 않고 언급 횟수만 올린다.
- Discord 첨부: 봇이 첨부를 `POST /ingest`로 보낼 때 `sourceMessage`(플랫폼·`messageId`·채널·서버·첨부 id)를 싣는다. 코어는 첨부마다 `message` 출처 행(키 `msg:<platform>:<messageId>:att:<attachmentId>`)을 문서 노드(텍스트·문서 파일)나 이미지 노드에 남기고, 파일 이름 없는 글은 첨부 id 없는 `message` 행을 받는다. 그래서 메시지 삭제가 글 행과 첨부 행을 함께 찾아 지운다. 모양이 틀린 `sourceMessage`는 어느 칸이 틀렸는지 적어 400으로 거절한다. 같은 파일이 두 메시지로 오면 문서 노드 하나가 두 메시지의 행을 받아 두 메시지를 모두 지워야 지워진다. 청크·캡션은 문서·이미지 노드의 계보 파생으로만 남는다. 글 수정(`PATCH /memories/by-source`)이 말하는 "이 메시지의 행"은 글 행뿐이라, 글을 고쳐도 첨부 기억과 파일은 그대로다.
- 메시지 삭제(`DELETE /memories/by-source`): 한 트랜잭션에서 그 메시지의 행을 모두 지우고, 출처 행도 살아 남는 계보 부모도 없는 기억을 계보 자손과 함께 영구 삭제한다. 같은 본문의 두 메시지가 한 기억을 가졌다면 두 메시지를 모두 지워야 기억이 지워진다. 다른 출처(다른 메시지·대시보드·AI 저장)로 남는 기억은 `messageId`·`channelId`·`guildId` 표시만 거둔다. 그 메시지 때문에 휴지통에 가 있던 기억(과 그 기억에만 기댄 파생 기억)도 휴지통 표에서 영구 삭제한다. 휴지통으로 옮기는 갈래는 없다. 응답 `DeleteBySourceResult`: `deletedCount`·`deletedIds`(그 메시지의 행을 가졌고 삭제됨), `derivedDeletedIds`(계보로 함께 삭제됨), `keptIds`(다른 출처로 남음), `archivePurgedIds`(휴지통 표에서 삭제됨), `revisionBodiesCleared`(본문을 비운 수정 이력 행 수), `retractedDerivedDeletedIds`(남은 기억 아래에서 지운 철회된 파생 기억), `assetCleanup`(첨부 파일 정리, 아래).
- 남는 기억의 수정 이력 본문: 메시지 수정 동기화(`PATCH /memories/by-source`)가 남기는 수정 이력 행(같은 id 수정과 분리 이력)은 메시지 칸(`source_message_id`·`source_platform`, v45)을 함께 적는다. 메시지를 지우면 같은 트랜잭션에서 그 칸으로 행을 찾아 `old_content`·`new_content`와 메시지 칸을 비운다. 누가·언제·왜(`editor`·`reason`·`edit_source`·`created_at`)는 남고, `GET /memories/:id/revisions`는 그 행의 본문을 null로 돌려준다. 메시지가 유일한 출처이던 동안 대시보드·AI·봇 `/edit`이 id로 고친 행은 메시지 동기 수정이 아니라 본문이 남는다(예: Discord 기억을 대시보드에서 오탈자 수정한 뒤 같은 문장을 대시보드가 저장하고 메시지를 지우면, 수정 전 메시지 원문이 그 행의 `old_content`에 남는다).
- 남는 기억의 철회된 파생 기억: 같은 id 메시지 수정으로 본문 주장이 바뀌면 옛 문장에서 뽑은 파생 기억이 철회되고, 철회된 노드의 `sharedMemory`에 그 수정 이력 행 id(`invalidatedByRevision`)가 적힌다. 원문이 다른 출처로 메시지 삭제에서 살아남으면, 그 메시지의 수정이 철회한 파생 기억 중 자기 출처 행이 없는 것을 그에만 기대던 자손과 함께 영구 삭제한다(`retractedDerivedDeletedIds`). 대시보드·AI의 id 지정 편집이 철회한 파생 기억은 지우지 않는다.
- 메시지 수정(`PATCH /memories/by-source`): 그 메시지의 행을 가진 `auto_capture` 기억마다, 본문이 같으면 건너뛰고, 그 메시지 말고 다른 출처 행이 없으면 같은 id로 고친다. 다른 출처 행이 있으면 덮어쓰지 않고 분리한다 — 새 본문으로 새 원문 기억을 만들고(같은 본문 기억이 이미 있으면 그 기억이 메시지 행을 받는다), 메시지 행을 새 기억으로 옮기고, 옛 기억의 메시지 표시를 거두며, 수정 이력에 옛 기억에서 새 기억으로 가는 한 줄(`reason`이 `message edit split:`로 시작)을 남긴다. 옛 기억의 본문과 파생 기억은 그대로다. 새 기억은 추출 대기 상태로 저장되어 백필이 쓰기 잠금 밖에서 추출한다. 응답 `EditBySourceResult`의 `splits` 항목은 `fromNodeId`·`newNodeId`·`reused`이고, `editedIds`·`editedCount`는 같은 id로 고친 기억만 센다. 이후 그 메시지를 지우면 새 기억만 지워진다.
- 수정에서 뺀 첨부: `PATCH /memories/by-source`에 `attachmentIds`(수정 뒤 그 메시지에 남은 첨부 id 전부)를 보내면, 그 메시지의 첨부 행 중 목록에 없는 것을 메시지 삭제와 같은 규칙으로 지운다. 응답 `EditBySourceResult.attachmentRemoval`: `removedAttachmentKeys`·`deletedIds`·`derivedDeletedIds`·`keptIds`·`archivePurgedIds`·`assetCleanup`(뺀 첨부가 없으면 빈 배열). `content`와 `attachmentIds` 중 하나는 있어야 하고(둘 다 없으면 400), `attachmentIds`만 보내면 글은 고치지 않는다(첨부만 있는 메시지). 봇은 항상 목록을 보내고 글이 비면 `content` 없이 보낸다. 첨부 목록을 모르는 부분 메시지는 보내지 않는다 — 빈 목록은 "첨부가 하나도 남지 않았다"는 뜻이라 그 메시지의 첨부 기억을 모두 지우기 때문이다.
- id 지정 편집(REST `PATCH /memories/:id`, MCP `update_memory`)은 같은 id를 고치고 출처 행을 더하거나 바꾸지 않는다(편집자는 출처가 아니다). Discord 메시지에서 온 기억을 대시보드에서 고쳐도 그 메시지를 지우면 함께 지워진다. 본문 주장이 바뀐 편집과 철회가 일으키는 계보 무효화는 자기 출처 행이 있는 기억을 철회하지 않고, 철회되는 계보로 가는 계보 연결을 모두 끊고 부모의 `extractedTo`에서 뺀다.
- 휴지통과 복원: 휴지통으로 옮길 때 출처 행이 보관 표로 함께 가고, 복원은 그 행을 되돌린다. 되돌릴 행이 없으면 되살린 행위자(인증 토큰의 adapterId, 인증 관문이 없는 구성에서는 빈 문자열)의 `restore:<actor>` 행을 더한다. 복원이 계보 연결을 되살리지 않는 기존 동작은 그대로다.
- 메시지 삭제가 아닌 통로로 원문이 먼저 사라져도 파생 기억이 출처 없이 남지 않는다. 모든 명시적 제거는 고른 기억(뿌리)에 같은 규칙을 적용한다: 파생 기억은 자기 출처 행이 있거나 계획 밖에서 살아 남는 계보 부모가 있으면 남고, 아니면 함께 없앤다.
  - 휴지통 이동(`POST /memories/:id/trash`, 함께 옮긴 파생 기억은 응답 `cascadeTrashedIds`)과 중복 원문 정리 스크립트(`scripts/cleanup-duplicates.ts`, dry-run도 같은 계획으로 센다)는 뿌리와 함께 출처 없는 파생 기억을 옮긴다.
  - 자동 정리(기본 켜짐)는 가치 점수가 낮은 기억만 옮기고, 옮기면 고르지 않은 기억(아직 가치가 남은 추출 사실 등)이 마지막 부모를 잃게 될 때 그 기억은 이번 주기에 옮기지 않는다. 원문과 자식이 모두 고른 기억이면 함께 옮긴다. 남긴 수는 정리 요약의 `nodesKeptForLineage`로 알린다.
  - 단건 영구 삭제(`DELETE /memories/:id`, 봇 `/forget`, OCR 청크 교체)는 존재 확인과 삭제를 쓰기 잠금 안에서 하고 뿌리와 출처 없는 계보 자손을 영구 삭제한다. 그 기억들의 수정 이력과 그에만 기대던 휴지통 기억도 함께 지운다. 응답 `ForgetResult`: `deleted`·`derivedDeletedIds`·`archivePurgedIds`·`assetCleanup`(없으면 404). 봇 `/forget` 답은 함께 지운 파생 기억 수를 덧붙인다.
- 영구 삭제(메시지 삭제·단건 영구 삭제·보관 기간 만료 삭제·휴지통 표 정리)는 삭제하는 기억을 `old_node_id` 또는 `new_node_id`로 가리키는 `memory_revisions` 행도 같은 트랜잭션에서 지운다. 지운 본문이 `old_content`·`new_content`에 남지 않는 대신 누가 언제 고쳤는지도 함께 사라진다. 휴지통 이동과 복원은 이력을 건드리지 않는다.
- 첨부 파일 정리: 첨부 파일은 내용 sha256 이름으로 `assets/content/`에 하나만 저장되고 같은 내용은 여러 저장이 함께 쓴다. 문서 첨부(OCR 변환본 포함)와 이미지는 쓰는 파일을 `asset_file_imports`에 `document:<documentId>`·`image:<nodeId>` 행으로 적는다. 휴지통 이동과 복원은 이 행을 건드리지 않아 휴지통의 기억도 파일을 붙잡는다. 영구 삭제(메시지 삭제, 수정에서 뺀 첨부, 단건 영구 삭제와 `/forget`, OCR 청크 교체, 휴지통 보관 기간 만료)는 같은 트랜잭션에서 지운 문서·이미지 노드가 주인인 문서 기록(주인은 아래 주인 표가 정한다)과 원장 행을 지우고, 커밋 뒤 같은 쓰기 잠금 안에서 문서 기록·원장·이미지 어디에서도 더는 쓰지 않는 파일을 디스크에서 지운다. 다른 기억이 같은 파일을 쓰면 남긴다. 결과는 각 응답(과 휴지통 정리 요약)의 `assetCleanup`(`documentIds`·`removedSha256s`·`missingSha256s`·`failed`)에 실린다. 파일을 못 지워도(권한·잠김) 기억 삭제는 이미 끝났고, `failed`에 경로와 원인이 실리며 서버와 봇이 로그를 남긴다. 그 파일의 `asset_files` 행은 지우기 대기 표시로 남고 서버가 시작할 때 참조 없는 행의 파일을 다시 지운다(시작 정리 순서는 아래). 이미 없던 파일(`missingSha256s`)은 목표 상태라 행만 지우되 알린다. 데이터 초기화(`POST /admin/reset-memory`)는 자산 표와 `content/` 전체를 비우므로 이 규칙을 따로 거치지 않는다.
  - 문서 기록의 주인(v46): 문서 기록(`documents` 행)마다 주인 노드가 하나이고, 서버 전용 표 `document_record_owners`(기록 id → 주인 노드 번호)가 그것을 적는다. 새 문서 노드를 저장하거나 같은 본문의 노드가 문서를 흡수하는 트랜잭션이 주인 행을 쓴다. 영구 삭제는 지운 노드 번호로 이 표를 찾아 그 노드가 주인인 기록만 지운다. 노드 `metadata`의 `documentId`·`absorbedDocumentIds`는 클라이언트가 쓸 수 있는 칸이라 주인 판정에 쓰지 않는다(예전에는 이 칸에 남의 문서 id를 넣어 그 문서와 파일을 지우게 하거나, 형식이 틀린 값 하나로 삭제와 보관 기간 만료를 멈출 수 있었다). 청크와 추출 기억은 주인이 아니라 지워도 기록은 남는다. 주인 행은 기록이 지워질 때 함께 지워져 "주인은 있는데 기록이 없는" 상태가 생기지 않는다. 외래 키를 끈 외부 도구가 DB를 바꿔 그 상태가 되면 해제는 기록 id를 담은 오류로 멈춘다. 주인 행 없이 저장된 기존 문서 기록은 추측해 채우지 않고 v46 이 시작을 멈춘다([README](README.md)).
  - `/ingest` 문서 보상: `/ingest`는 문서 기록·원장 행·파일을 먼저 커밋하고 그다음 문서 노드를 저장한다. 그 사이가 실패하면(파싱 실패 갈래 포함) 기록과 원장 행과 파일을 되돌린다. 주인 행이 이미 있으면(노드 저장이 커밋된 뒤의 실패) 아무것도 지우지 않는다. 응답은 그대로 500이고 문구 끝에 결과가 붙는다: `문서 기록 되돌림(<id>)`, `문서 기록은 되돌렸으나 파일 N개를 지우지 못함(다음 시작 때 다시 지움): ...`, `문서 기록 되돌리기도 실패: <원인>(다음 시작 때 정리)`, `문서 노드는 저장됨(기록 유지)`. 같은 문구를 서버 오류 로그에도 남긴다. 같은 파일을 다른 기록이 쓰면 파일은 남는다.
  - 시작 정리 순서(서버가 시작할 때, 요청을 받기 전, 쓰기 잠금 안): (0) DB·첨부 폴더 짝 확인 — 짝이 맞지 않으면 아무것도 지우지 않고 멈추며 아래 (1)~(3)을 하나도 하지 않는다([README의 DB·첨부 폴더 짝 절](README.md)). (1) 문서 기록 정리 — 주인 행 없는 기록과 주인 노드가 살아 있는 표·휴지통 표 어디에도 없는 기록을 영구 삭제와 같은 루틴으로 지우고, 기록 없는 주인 행과 그 기록의 `document:<id>` 원장 행을 지운다(수를 로그). `/ingest` 보상이 실패했거나 그 사이 프로세스가 멈춰 남은 기록이 여기서 정리된다. (2) 참조 없는 `asset_files` 행(지우기 대기 표시 포함)의 파일과 행을 지운다. (1)이 푼 기록과 (1)이 지운 원장 행이 가리키던 파일도 여기서 지워진다. (3) `content/` 훑기 — `asset_files` 행이 없는 `{sha256}.{확장자}` 파일, 행의 확장자와 다른 같은 바이트 사본, 쓰다 중단된 `.tmp-` 조각을 지운다. 위 이름 형식이 아닌 항목은 건드리지 않고 "알 수 없는 이름"으로 로그하고, 지우지 못한 항목(파일 자리의 디렉터리 등)은 이름과 원인을 오류로 로그한다. `content/`는 서버 전용 디렉터리라 손으로 넣은 파일도 이름 형식이 같으면 지워진다. 비용은 부팅마다 `readdir` 한 번과 파일당 `asset_files` 조회 한 번이다.
  - OCR 변환본: OCR 결과 적용(`POST /api/documents/:id/ocr-result`)은 변환본(Markdown) 파일을 `/ingest`와 같은 자산 묶음으로 쓴다 — 쓰기 잠금 안 한 트랜잭션에서 `asset_files` 행(그 sha256의 행이 이미 있으면 그 행의 확장자를 쓴다. `.txt` 행이면 같은 바이트의 `.md` 사본을 만들지 않는다), 그 문서 기록의 원장 행(`document:<id>`, source·author `document-ocr`, 사용자는 문서 노드 `metadata.user_id`), 파일을 쓴다. 그래서 변환본은 쓰는 순간부터 기록에 묶여 다른 문서의 삭제가 지우지 못하고, 기록이 지워질 때 함께 지워진다. 같은 Markdown을 다시 적용하면 원장 행을 겹쳐 쓰지 않는다. 다른 Markdown으로 다시 적용하면 밀려난 옛 변환본은 기록이 지워질 때까지 남는다. 기록이 그 사이 지워졌으면 아무것도 쓰지 않고 404, 문서 노드에 `user_id`가 없으면 사용자를 정할 수 없어 409로 멈춘다.
  - 출처 키 구분자: 출처 키는 `:`로 칸을 나누므로 메시지 id·첨부 id·플랫폼 이름에 `:`가 들어 있으면 서로 다른 (메시지, 첨부) 쌍이 한 키로 섞인다(예: 메시지 `m1:att:a1`의 글과 메시지 `m1`의 첨부 `a1`). 경계가 400 `messageId must not contain ":" (source key delimiter)`(칸 이름만 `attachmentId`·`platform`으로 바뀐다)으로 거절한다: `POST /memories`·append·from-text, `POST /ingest`의 `sourceMessage`, `DELETE`·`PATCH /memories/by-source`, MCP 저장 도구(같은 문구의 도구 오류). `:`가 든 id를 쓰는 플랫폼은 거절된다(Discord id는 숫자라 봇은 그대로다).
  - 파일 바이트 확인: 자산 묶음(`/ingest` 문서·이미지, OCR 변환본)은 쓰기 전에 파일마다 바이트의 sha256과 길이가 선언한 값과 같은지 다시 확인한다. 다르면 `AssetBundleBytesMismatchError`(선언한 sha256·길이와 실제 길이·sha256)로 멈추고 행도 파일도 쓰지 않는다(요청은 500). PDF 읽기 라이브러리가 넘겨받은 버퍼를 비워, 원본 sha256 이름으로 0바이트 파일이 저장되던 결함을 고치면서 더했다. PDF 파서는 이제 자기 복사본만 쓴다. 비용은 파일당 해시 한 번이다(이 PC에서 16MB에 약 7ms).
- 즉시 추출과 `POST /memories/from-text`(`preserveRaw`)는 원문을 먼저 저장하고 그 뒤에 추출 기억을 저장한다. 추출 항목이 원문과 같은 본문이거나 유사 흡수 대상이 원문 자신이면 자식 기억을 만들지 않고 원문 자신의 주장으로 본다(추출 저장 결과의 `selfClaimNodeIds`). 충돌 검사는 이때 원문을 새 주장으로 돌린다.
- 같은 계보 안에서는 충돌 후보로 잇지 않는다. 추출 기억의 검사는 원문과 그 조상을, 자기 주장의 검사는 원문의 조상·자손을, 편집 재검사는 편집한 기억의 조상·자손을 후보에서 뺀다(같은 원문의 형제 기억끼리는 비교한다). 새 기억과 충돌 쌍인 후보 중 원문과 그 자식이 둘 다 쌍이면 자식만 잇고, 원문만 쌍이면 원문을 잇는다.
- 알려진 한계: 분리로 만든 새 기억은 옛 기억의 중요도를 이어받지 않는다. 분리는 쓰기 잠금 안에서 두 트랜잭션(새 기억 저장, 출처 행 이동·표시 거두기·이력 기록)으로 나뉜다. 충돌 후보는 본문 전문 검색 상위 10건에서 고르므로, 같은 계보라서 빠지는 기억이 그 10건을 채우면 그 밖의 후보를 놓칠 수 있다. 메시지를 지워도 남는 기억 중 그 메시지의 행을 가졌던 기억이 아닌 것(추출 기억이 입력 metadata에서 복사해 가진 `messageId` 등)의 표시는 거두지 않는다. 삭제 범위는 표시가 아니라 출처 행으로 정하므로 지워지는 기억에는 영향이 없다.
- 알려진 한계(삭제·첨부): 자동 정리에서 가치가 남은 추출 사실을 가진 낮은 가치 원문은 그 사실들도 낮아질 때까지 검색에 남는다. 메시지를 지워도 남는 기억의 철회된 파생 기억 중 휴지통에 가 있는 것은 보관 기간 만료로 지워질 때까지 남는다(기본 조회·검색 밖). 흡수된 문서 노드가 남는 동안 그 노드가 가진 문서 기록 전부와 원본 파일도 남는다(내용이 같은 다른 형식 파일이면 지운 메시지의 원본이 노드가 사라질 때까지 남는다). 문서 노드가 지워져도 따로 살아 남은 청크(복원 출처 행이 있는 것)의 `parentId`·`assetSha256`은 없는 기록을 가리킨다(본문은 그대로). 서버(`createMemoryApi`) 밖에서 저장소를 열어 영구 삭제하면 파일 지우기 함수가 없어 `failed`로 알리고, 파일은 다음 서버 시작 때 지운다. 지우지 못한 파일도 다음 서버 시작까지 남는다. OCR을 다른 Markdown으로 다시 적용해 밀려난 옛 변환본은 그 문서 기록이 지워질 때까지 남는다.

## 클라이언트별 권한

| scope | 허용 |
|---|---|
| read-only | 검색·조회·프로필·진단·recall 및 정리 조회 |
| mcp-standard | 위 기능 + 일반 저장·정정·대체·철회·정리 제안/무산출 신고 |
| full | 관리·설정·승인·영구 삭제·백업을 포함한 기존 전체 권한 |

기존 scope 없는 토큰은 full로 해석해 연결을 보존하고, 어댑터 목록(`GET /adapter-tokens`)에 `legacyScope: true`로 표시한다. 새 어댑터 승인 기본값은 mcp-standard다. 관리자는 승인 body의 `scope`나 `PATCH /adapter-tokens/:adapterId/scope`로 권한을 지정한다. 같은 토큰으로 REST를 호출해 MCP 제한을 우회할 수 없다.

Discord 봇·OCR companion 같은 관리 어댑터는 영구 삭제 동기화·`/stats`·`/cleanup`·일정 알림·OCR 작업 경로를 쓰므로 full 권한이 필요하다. 이런 어댑터는 등록 요청에 `requestedScope: "full"`을 싣고, 관리자가 승인 화면에서 권한을 직접 고른다. `requestedScope`는 목록에 표시될 뿐 권한을 주지 않는다. 승인 때 `scope`를 생략하면 새 어댑터는 mcp-standard를 받는다.

이미 토큰이 발급된 어댑터 ID로 들어온 재등록 요청은 목록의 `existingAdapter`에 현재 권한(`scope`)과 옛 토큰 여부(`legacyScope`)가 실린다. 관리자는 승인 전에 이 정보로 기존 토큰 공유 여부와 기존 권한을 확인하고, 승인 body의 `existingToken`으로 처리 방식을 고른다.

- `share`(생략 시 기본): 기존 토큰을 요청자에게 그대로 전달한다. 같은 어댑터 ID를 여러 기기가 함께 쓰는 연결(Pet의 `pet`)을 서로 끊지 않는다. `scope`를 생략하면 현재 권한을 유지한다. Pet 설치기의 `{"scope":"mcp-standard"}` 승인은 이 방식으로 그대로 동작한다.
- `rotate`: 새 토큰을 발급하고 옛 토큰을 즉시 무효로 만든다. 같은 어댑터의 다른 승인 요청은 거절 상태로 바뀌어 옛 요청자가 새 토큰을 회수하지 못한다. 옛 토큰(scope 없음)을 교체하면 새 토큰에는 현재 유효 권한(full)을 명시해 기록한다. 어댑터 주소(endpoint)와 봇 관리 토큰은 승인한 요청의 값만 기록하고 끊어 낸 옛 연결의 값은 잇지 않는다.
- 어댑터 하나에는 토큰이 하나다. 승인 때 지정한 `scope`는 그 토큰을 쓰는 모든 연결에 적용된다.
- 토큰이 없는 어댑터 요청에 `existingToken`을 보내면 409다. 목록을 다시 읽고 새 어댑터로 승인한다.

재등록 자동 승인은 기존 토큰 소유 증명을 요구하며, `requestedScope`를 무시하고 현재 권한과 토큰을 그대로 유지한다. 회수한 토큰은 이전 pickup 요청으로 다시 발급되지 않는다. 토큰 회수·교체·권한 변경은 그 어댑터의 열린 `/events/stream` 연결에 즉시 반영된다. 서버가 토큰과 권한을 다시 확인하고, 맞지 않으면 ping 주기를 기다리지 않고 스트림을 닫는다.

대시보드의 초기 관리 접속은 [README의 dashboard:link 절차](README.md)를 사용한다. 무인증으로 관리자 토큰을 받는 옛 loopback 경로는 제거됐다. 토큰을 URL query나 공유 메시지에 넣지 않는다. 접속 링크의 fragment도 자격증명이므로 공유하지 않는다.

## Codex / Claude Code 연결

승인된 AI별 토큰을 서로 다른 환경 변수에 넣은 뒤 설정 조각을 출력한다. 이 명령은 클라이언트 설정 파일을 직접 덮어쓰지 않으며 실제 토큰 대신 환경 변수 이름만 출력한다.

```sh
bun run mcp:config --client codex --url http://127.0.0.1:3001/mcp --token-env BARA_CODEX_TOKEN
bun run mcp:config --client claude-code --url http://127.0.0.1:3001/mcp --token-env BARA_CLAUDE_TOKEN
bun run mcp:config --client codex --url http://127.0.0.1:3001/mcp --token-env BARA_CODEX_TOKEN --check
```

출력은 각각 Codex의 MCP TOML 설정과 Claude Code의 `.mcp.json`에 병합한다. --check는 HTTP 연결·필요한 도구·instructions·예산 0의 읽기 호출만 확인하며 기억을 쓰지 않는다. instructions가 없으면 --check는 종료 코드 1로 실패한다. 실제 사용하는 호스트/터널 주소로 URL을 바꿔야 한다.

클라이언트 사용 규칙은 서버의 MCP instructions로 제공한다. 세션 시작과 프로젝트 작업 전에 recall_context, 결정/선호가 확정될 때 저장, 사실이 바뀌면 정정/대체를 사용한다. 연결되었다고 모든 AI가 동일하게 규칙을 준수한다고 보장되는 것은 아니므로 실제 제품별 동작은 확인해야 한다.

클라이언트 호환성은 `GET /client-info` 응답으로 공지한다. `protocolVersion`은 현재 1이다. `capabilities`는 서버가 지원하는 기능 목록(ingest-receipts, capture, memory-deeplink, cleanup-proposals, editable-memory-body)이고, `captureKinds`는 능동 저장이 받는 분류 목록(idea, decision, question, preference, task)이다. 두 목록은 서로 다른 것을 나타낸다 — 클라이언트는 이 응답을 읽고 지원되지 않는 기능이나 분류는 비활성화해야 한다.

설정 형식 근거: [OpenAI MCP 문서](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude Code MCP 문서](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson).

## 검증과 운영

회귀 테스트는 실제 SQLite/bge-m3/HTTP/SDK 클라이언트를 사용해 두 클라이언트의 교차 저장·조회, 동시 수정, 출처 사건 재전송, 범위 제한, 철회, 권한 차단, 만료, 파생 기억 무효화를 검사한다. 실제 AI 모델의 자연어 답변 품질을 평가한 것과는 구분한다.

이 문서가 설명하는 표는 모두 기준 스키마(v47)에 들어 있다: source-event와 mutation 원장(`memory_source_events`, `memory_mutations`), 조회 가시성 번호(`memory_visibility_state`), 기억 출처 목록(`memory_node_sources`, 휴지통용 `memory_node_sources_archive`), 메시지 동기 수정 칸(`memory_revisions`의 `source_message_id`·`source_platform`과 부분 색인), 문서 기록 주인 표(`document_record_owners`와 색인 둘), DB·첨부 파일 폴더 짝 표(`asset_folder_pairing`). `schema_version`이 47 미만인 DB는 열리지 않고 `SchemaVersionTooOldError`로 시작이 멈추므로, 출처 목록이나 주인 표 없이 저장된 옛 기억의 출처·주인을 추측해 채우는 일은 없다. 비우고 새로 시작하는 방법은 [README의 기준 스키마(v47)와 옛 DB 절](README.md)을 따른다. 옛 기억을 남겨 두려면 DB 파일과 첨부 파일 폴더(`assets.dir`, env `BARA_ASSET_DIR`)를 함께 옮겨야 한다. 두 곳에는 같은 짝 표시가 있어 서버는 짝이 맞지 않는 폴더를 만나면 아무 파일도 지우지 않고 멈추므로, DB만 옮기고 폴더를 그대로 두면 새 DB의 시작이 멈춘다([README의 DB·첨부 폴더 짝 절](README.md)).

현재 규모상의 한계: 조회 가시성은 ID/프로젝트/메타데이터와 근거 관계를 훑어 판정한다. 대규모 데이터에서 병목이 측정되면 동일 계약을 유지하며 인덱스/물질화된 가시성으로 개선할 수 있다. 토큰 예산은 추정이며 완전한 개인정보 삭제나 백업 삭제를 뜻하는 기능은 없다.
