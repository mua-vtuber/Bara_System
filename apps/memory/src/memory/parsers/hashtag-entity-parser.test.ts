/**
 * hashtag-entity-parser.test.ts — 공통 인프라 1.2 T9.
 *
 * 해시태그 규칙 입력 네 갈래 파서 단위 검증 (순수 함수 — DB·임베딩·LLM 의존 0).
 *
 *  (1) 네 갈래 한 번에 — 사람 선언 + 칸 + 라벨 + 별칭
 *  (2) 사람 선언 둘 — 길이만 드러내고 경고는 안 함(주 엔티티 결정은 T10)
 *  (3) 프로젝트 선언
 *  (4) 빈 값 예약 키(`#생일:`) → errors, 다른 정상 태그는 그대로 처리
 *  (5) `#생일@철수` 인라인 @ 귀속은 매치 안 됨
 *  (6) 매핑에 없는 키(`#언어:TS`) → 라벨
 *  (7) settings 덮어쓰기 — 새 예약 키가 다른 갈래로 들어감
 *  (8) 빈 글자 / 해시태그 0개
 */

import { describe, test, expect } from "bun:test";
import { parseHashtagEntities } from "./hashtag-entity-parser.ts";
import {
  loadReservedKeys,
  type ReservedKeyMap,
} from "./hashtag-reserved-keys.ts";

describe("parseHashtagEntities", () => {
  test("네 갈래 한 번에 — 사람 선언 + 칸 + 라벨 + 별칭", () => {
    const result = parseHashtagEntities(
      "#사람:민수 #생일:3월5일 #직업:개발자 #닉네임:민짱",
    );
    expect(result.personDeclarations).toEqual(["민수"]);
    expect(result.attributes).toEqual([{ column: "birthday", value: "3월5일" }]);
    expect(result.labels).toEqual([
      { category: "직업", value: "개발자", rawCategory: "직업" },
    ]);
    expect(result.aliases).toEqual(["민짱"]);
    expect(result.projectDeclarations).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("사람 선언 둘 — 길이만 드러내고 경고는 안 함", () => {
    const result = parseHashtagEntities("#사람:민수 #사람:철수 #생일:3월");
    expect(result.personDeclarations).toEqual(["민수", "철수"]);
    expect(result.personDeclarations.length).toBe(2);
    expect(result.attributes).toEqual([{ column: "birthday", value: "3월" }]);
    // 주 엔티티 결정·경고는 T10 권위 — 여기서는 경고를 만들지 않는다.
    expect(result.errors).toEqual([]);
  });

  test("프로젝트 선언 + 라벨 동반", () => {
    const result = parseHashtagEntities("#프로젝트:바라 #엔진:bun");
    expect(result.projectDeclarations).toEqual(["바라"]);
    expect(result.labels).toEqual([
      { category: "엔진", value: "bun", rawCategory: "엔진" },
    ]);
    expect(result.personDeclarations).toEqual([]);
  });

  test("주소·성별 칸도 attribute 갈래로", () => {
    const result = parseHashtagEntities("#사람:민수 #주소:서울 #성별:남");
    expect(result.attributes).toEqual([
      { column: "address", value: "서울" },
      { column: "gender", value: "남" },
    ]);
  });

  test("attribute 값 안 공백은 쉼표/다음 # 전까지 보존한다", () => {
    const result = parseHashtagEntities(
      "#사람:홍길동, #생일:0000년 0월 0일, #직업:2D 산골 나무꾼",
    );
    expect(result.personDeclarations).toEqual(["홍길동"]);
    expect(result.attributes).toEqual([
      { column: "birthday", value: "0000년 0월 0일" },
    ]);
    expect(result.labels).toEqual([
      { category: "직업", value: "2D 산골 나무꾼", rawCategory: "직업" },
    ]);
  });

  test("별칭/별명 키도 별칭 갈래로", () => {
    const result = parseHashtagEntities("#별칭:짱구 #별명:신짱");
    expect(result.aliases).toEqual(["짱구", "신짱"]);
  });

  test("빈 값 예약 키(#생일:) → errors, 다른 정상 태그는 그대로 처리", () => {
    const result = parseHashtagEntities("#사람:민수 #생일: #직업:개발자");
    // 정상 태그는 정상 처리.
    expect(result.personDeclarations).toEqual(["민수"]);
    expect(result.labels).toEqual([
      { category: "직업", value: "개발자", rawCategory: "직업" },
    ]);
    // 빈 값은 칸을 거짓으로 채우지 않고 실패로 올린다.
    expect(result.attributes).toEqual([]);
    expect(result.errors).toEqual([
      { tag: "#생일:", reason: "예약 키 '생일' 의 값이 비어 있음" },
    ]);
  });

  test("#생일@철수 인라인 @ 귀속은 매치 안 됨", () => {
    const result = parseHashtagEntities("#생일@철수");
    expect(result.attributes).toEqual([]);
    expect(result.labels).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.personDeclarations).toEqual([]);
  });

  test("매핑에 없는 키(#언어:TS) → 라벨", () => {
    const result = parseHashtagEntities("#언어:TS #회사:바라컴퍼니");
    expect(result.labels).toEqual([
      { category: "언어", value: "TS", rawCategory: "언어" },
      { category: "회사", value: "바라컴퍼니", rawCategory: "회사" },
    ]);
    expect(result.personDeclarations).toEqual([]);
    expect(result.attributes).toEqual([]);
    expect(result.aliases).toEqual([]);
  });

  test("엔티티 파서는 이미지 분류 동의어 대신 원본 키를 라벨 키로 보존한다", () => {
    const result = parseHashtagEntities("#작가:백덕수");
    expect(result.labels).toEqual([
      { category: "작가", value: "백덕수", rawCategory: "작가" },
    ]);
  });

  test("settings 덮어쓰기 — 새 예약 키가 다른 갈래로 들어감", () => {
    // settings 로 '회사' 를 별칭 갈래로 더한다(흩어진 하드코딩 아닌 단일 통로).
    const overridden: ReservedKeyMap = loadReservedKeys({
      회사: { kind: "alias" },
    });
    const result = parseHashtagEntities("#회사:바라 #언어:TS", overridden);
    // 덮어쓴 '회사' 는 이제 별칭으로 들어간다.
    expect(result.aliases).toEqual(["바라"]);
    // 덮어쓰지 않은 '언어' 는 여전히 라벨.
    expect(result.labels).toEqual([
      { category: "언어", value: "TS", rawCategory: "언어" },
    ]);
  });

  test("settings 덮어쓰기 — 기본 키를 다른 칸으로 바꿈", () => {
    const overridden: ReservedKeyMap = loadReservedKeys({
      생일: { kind: "attribute", column: "address" },
    });
    const result = parseHashtagEntities("#생일:서울", overridden);
    expect(result.attributes).toEqual([{ column: "address", value: "서울" }]);
  });

  test("빈 글자 / 해시태그 0개", () => {
    const empty = parseHashtagEntities("");
    expect(empty.personDeclarations).toEqual([]);
    expect(empty.labels).toEqual([]);
    expect(empty.errors).toEqual([]);

    const plain = parseHashtagEntities("그냥 글, 해시태그 없음 #봄");
    expect(plain.personDeclarations).toEqual([]);
    expect(plain.labels).toEqual([]);
    expect(plain.aliases).toEqual([]);
  });
});

describe("directFields — 직접 입력 칸 (활용 단계2 ②)", () => {
  test("#날짜·#일정종료 → directFields 두 칸", () => {
    const out = parseHashtagEntities(
      "여행 #일정시작:6월 1일, #일정종료:6월 5일,",
    );
    expect(out.directFields).toEqual([
      { column: "event_at", value: "6월 1일" },
      { column: "event_until", value: "6월 5일" },
    ]);
    expect(out.errors).toEqual([]);
  });

  test("#날짜+#일정시작 다른 값 → 충돌 errors(저장 안 함)", () => {
    const out = parseHashtagEntities("#날짜:6월 1일, #일정시작:6월 3일,");
    expect(out.directFields.find((f) => f.column === "event_at")).toBeUndefined();
    expect(out.errors.some((e) => e.tag === "#event_at")).toBe(true);
  });

  test("#날짜+#일정시작 같은 값 → 충돌 아님(한 번 반영)", () => {
    const out = parseHashtagEntities("#날짜:6월 1일, #일정시작:6월 1일,");
    expect(out.directFields).toEqual([{ column: "event_at", value: "6월 1일" }]);
    expect(out.errors).toEqual([]);
  });

  test("기존 엔티티 태그와 공존 — 사람은 personDeclarations, 일정은 directFields", () => {
    const out = parseHashtagEntities("#사람:민수, #날짜:6월 25일,");
    expect(out.personDeclarations).toEqual(["민수"]);
    expect(out.directFields).toEqual([{ column: "event_at", value: "6월 25일" }]);
  });
});

describe("placeFields — 직접 입력 장소 (활용 단계2 ③)", () => {
  test("#장소 한 개 → placeFields", () => {
    const out = parseHashtagEntities("여행 #장소:강남 A마트,");
    expect(out.placeFields).toEqual(["강남 A마트"]);
  });

  test("여러 #장소 → 다 받음(충돌 아님)", () => {
    const out = parseHashtagEntities("#장소:서울, #장소:부산,");
    expect(out.placeFields).toEqual(["서울", "부산"]);
  });

  test("같은 장소 두 번 → 한 번만(dedup)", () => {
    const out = parseHashtagEntities("#장소:속초, #장소:속초,");
    expect(out.placeFields).toEqual(["속초"]);
  });

  test("일정 + 장소 공존 — node_field 와 place 갈래 분리", () => {
    const out = parseHashtagEntities("#일정시작:6월 1일, #장소:속초,");
    expect(out.directFields).toEqual([{ column: "event_at", value: "6월 1일" }]);
    expect(out.placeFields).toEqual(["속초"]);
  });

  test("빈 값 #장소:, → errors(거짓 채움 0)", () => {
    const out = parseHashtagEntities("#장소:, 본문");
    expect(out.placeFields).toEqual([]);
    expect(out.errors.some((e) => e.tag === "#장소:")).toBe(true);
  });
});

describe("loadReservedKeys", () => {
  test("settings 없음 = 기본 예약 키", () => {
    const keys = loadReservedKeys();
    expect(keys["사람"]).toEqual({ kind: "entity_person" });
    expect(keys["프로젝트"]).toEqual({ kind: "entity_project" });
    expect(keys["생일"]).toEqual({ kind: "attribute", column: "birthday" });
    expect(keys["주소"]).toEqual({ kind: "attribute", column: "address" });
    expect(keys["성별"]).toEqual({ kind: "attribute", column: "gender" });
    expect(keys["별칭"]).toEqual({ kind: "alias" });
    expect(keys["닉네임"]).toEqual({ kind: "alias" });
    expect(keys["별명"]).toEqual({ kind: "alias" });
    expect(keys["직업"]).toBeUndefined();
  });

  test("덮어쓰기는 새 객체 — 기본 묶음을 더럽히지 않음", () => {
    const a = loadReservedKeys({ 회사: { kind: "alias" } });
    expect(a["회사"]).toEqual({ kind: "alias" });
    const b = loadReservedKeys();
    expect(b["회사"]).toBeUndefined();
  });
});
