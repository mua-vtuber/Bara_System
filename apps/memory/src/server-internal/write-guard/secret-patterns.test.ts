/**
 * secret-patterns.test.ts — 비밀값 검출기 패턴별 검증 (T15 / 결정 D-C).
 *
 * **테스트 값 관례**: 여기 쓰이는 "비밀값"은 전부 명백한 가짜다 — 실제 자격증명
 * 양식만 흉내내고 값은 EXAMPLE·x 반복 같은 눈에 띄는 채움 문자로 채웠다. 저장소를
 * 훑는 비밀값 스캐너가 진짜 유출로 오인해 경보를 울리지 않게 하려는 것이다. 진짜
 * 키는 어떤 이유로도 테스트에 넣지 않는다.
 *
 * 두 방향을 모두 본다: 진짜 양식은 잡히는가(검출), 그리고 값 없이 키워드만 언급하는
 * 평범한 글은 통과하는가(오탐 방어). 오탐 쪽이 특히 중요하다 — 게이트가 정상 기억
 * 저장을 막기 시작하면 사용자가 게이트 자체를 꺼 버리게 된다.
 */

import { describe, expect, test } from "bun:test";
import {
  detectSecret,
  SECRET_PATTERN_NAMES,
} from "./secret-patterns.ts";

describe("detectSecret — 패턴별 검출", () => {
  const cases: ReadonlyArray<{ name: string; patternName: string; content: string }> = [
    {
      name: "AWS 액세스 키 ID",
      patternName: "aws-access-key-id",
      content: "배포 설정에 AKIAEXAMPLEEXAMPLE99 를 넣었다",
    },
    {
      name: "GitHub personal token",
      patternName: "github-token",
      content: `토큰: ghp_${"x".repeat(36)}`,
    },
    {
      name: "GitHub fine-grained token",
      patternName: "github-token",
      content: `github_pat_${"x".repeat(30)} 로 받았다`,
    },
    {
      name: "Slack 봇 토큰",
      patternName: "slack-token",
      content: `xoxb-000000000000-${"x".repeat(24)}`,
    },
    {
      name: "PEM 개인키 블록",
      patternName: "private-key-block",
      content: "-----BEGIN RSA PRIVATE KEY-----\n(생략)",
    },
    {
      name: "JWT 3 조각",
      patternName: "jwt",
      content: `eyJhbGciOiJIUzI1NiJ9.${"e".repeat(20)}.${"s".repeat(20)}`,
    },
    {
      name: "api key 할당 형태",
      patternName: "api-key-assignment",
      content: `api_key = "${"K".repeat(24)}"`,
    },
    {
      name: "api-key 하이픈 + 콜론 변형",
      patternName: "api-key-assignment",
      content: `API-KEY: ${"Z".repeat(20)}`,
    },
    {
      name: "password 할당 형태",
      patternName: "password-assignment",
      content: "password = hunter2placeholder",
    },
    {
      name: "password 할당 — ASCII 특수문자 섞인 값(좁힌 문자 집합에도 잡힘)",
      patternName: "password-assignment",
      content: "password: Str0ng!Pass#2026",
    },
  ];

  for (const c of cases) {
    test(`${c.name} → ${c.patternName} 검출`, () => {
      const found = detectSecret(c.content);
      expect(found).not.toBeNull();
      expect(found!.patternName).toBe(c.patternName);
      expect(found!.matchLength).toBeGreaterThan(0);
    });
  }

  test("검출 결과에 매치된 값 자체가 담기지 않는다(종류 + 길이만)", () => {
    const secret = `ghp_${"x".repeat(36)}`;
    const found = detectSecret(`토큰은 ${secret} 이다`);
    expect(found).not.toBeNull();
    // 반환 객체를 통째로 직렬화해도 값이 어디에도 없어야 한다.
    expect(JSON.stringify(found)).not.toContain(secret);
    expect(Object.keys(found!).sort()).toEqual(["matchLength", "patternName"]);
  });

  test("등록된 패턴 이름 전건이 최소 한 번씩 검증된다", () => {
    const covered = new Set(cases.map((c) => c.patternName));
    for (const name of SECRET_PATTERN_NAMES) {
      expect(covered.has(name)).toBe(true);
    }
  });
});

describe("detectSecret — 오탐 방어(정상 글은 통과)", () => {
  const passthrough: ReadonlyArray<{ name: string; content: string }> = [
    {
      name: "API key 를 값 없이 언급하는 산문",
      content: "오늘 서비스에서 API key 를 발급받았다. 내일 설정에 넣어야지.",
    },
    {
      name: "api_key 라는 이름만 말하는 문장",
      content: "설정 파일의 api_key 항목이 뭘 의미하는지 찾아봐야 한다",
    },
    {
      name: "password 정책을 논하는 문장",
      content: "password 정책을 12자 이상으로 바꾸자는 의견이 나왔다",
    },
    // 수정 1회차(리뷰어 실측) — 한국어는 단어를 붙여 쓰는 일이 흔해 "공백만 아니면 값"
    // 이던 옛 규칙이 정상 메모를 8자 이상 연속 한글이라는 이유만으로 거부했다. 값
    // 문자 집합을 ASCII 자격증명 문자로 좁혀 해결했고, 아래가 그 회귀 가드다.
    {
      name: "password 뒤 붙여 쓴 한글 메모(실측 오탐 재발 방지)",
      content: "password: 아직미정이라비워둠",
    },
    {
      name: "password 뒤 긴 한글 문장(공백 없음)",
      content: "password = 비밀번호는나중에정하기로했다",
    },
    {
      name: "password 뒤 짧은 한글",
      content: "password: 설정해야함",
    },
    {
      name: "api_key 뒤 한글 서술",
      content: "api_key: 발급받는중이라아직없음",
    },
    {
      name: "짧은 플레이스홀더는 값으로 보지 않는다",
      content: "api_key = TODO",
    },
    {
      name: "AKIA 로 시작하지만 양식이 아닌 단어",
      content: "AKIA 라는 약어가 무슨 뜻인지 검색했다",
    },
    {
      name: "평범한 한국어 기억",
      content: "내일 오후 3시에 치과 예약이 있다. 보험 서류도 챙길 것.",
    },
    {
      name: "JWT 를 개념으로만 언급",
      content: "JWT 토큰 만료 시간을 어떻게 정할지 고민 중이다",
    },
    {
      name: "코드 예시지만 값이 비어 있음",
      content: 'const config = { apiKey: "" };',
    },
  ];

  for (const c of passthrough) {
    test(`${c.name} → 무매치`, () => {
      expect(detectSecret(c.content)).toBeNull();
    });
  }
});
