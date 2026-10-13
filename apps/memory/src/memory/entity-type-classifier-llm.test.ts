/**
 * entity-type-classifier-llm.test.ts — 3단(LLM opt-in) 배치 검증 (2단계 Task 3).
 *
 * Mock 클래스 금지(프로젝트 정책) — 실제 OllamaClient 만 쓴다. 실패 경로는 닿지 않는
 * URL(127.0.0.1:1)로 실제 연결 실패를 일으키고, 성공 경로는 가동 중인 로컬 ollama 로
 * 실제 분류를 받는다(ollama 미가동 환경이면 그 한 케이스만 건너뛴다 — 나머지는 항상 검증).
 */
import { test, expect, afterEach } from "bun:test";
import { classifyEntityType, resetClassifierCache } from "./entity-type-classifier.ts";
import { resetConceptTypeVocabularyCache } from "./concept-type-vocabulary.ts";
import {
  buildClassificationMessages, classificationJsonSchema, parseClassificationResponse,
} from "./entity-type-llm-prompt.ts";
import { placementTypeNames } from "./concept-type-vocabulary.ts";
import { OllamaClient } from "../llm/ollama-client.ts";

afterEach(() => {
  resetConceptTypeVocabularyCache();
  resetClassifierCache();
});

const OLLAMA_URL = "http://127.0.0.1:11434";
const OLLAMA_MODEL = "exaone3.5:2.4b";

async function ollamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { models?: Array<{ name: string }> };
    return (json.models ?? []).some(
      (m) => m.name === OLLAMA_MODEL || m.name.startsWith(OLLAMA_MODEL + ":"),
    );
  } catch {
    return false;
  }
}

// ── 판정 순서 ──────────────────────────────────────────────────────────────

test("llm=null 이면 LLM 안 탐 — 결정 결과만", async () => {
  const r = await classifyEntityType("그냥 평범한 하루 xyzq", null);
  expect(r.source).toBe("none");
  expect(r.typeName).toBeNull();
});

test("llm 미지정(undefined)도 LLM 안 탐 — 결정 결과만", async () => {
  const r = await classifyEntityType("그냥 평범한 하루 xyzq");
  expect(r.source).toBe("none");
  expect(r.typeName).toBeNull();
});

test("1·2단에 걸리면 llm 있어도 안 탐 — 명시 태그", async () => {
  const unreachable = new OllamaClient({ baseUrl: "http://127.0.0.1:1", model: "none" });
  const r = await classifyEntityType("#작품:주술회전", unreachable);
  expect(r.source).toBe("explicit");
  expect(r.typeName).toBe("work");
});

test("LLM 호출 실패는 기타로 degrade + classifier throw 안 함", async () => {
  const unreachable = new OllamaClient({ baseUrl: "http://127.0.0.1:1", model: "none" });
  const r = await classifyEntityType("분류 애매한 무언가 xyzq", unreachable);
  expect(r.typeName).toBeNull();
  expect(r.source).toBe("none");
  expect(r.matched).toContain("llm-error");
});

// ── 프롬프트·스키마·파싱(데이터 fixture — LLM 호출 없음) ──────────────────

test("스키마 enum = 10 배치 타입 + none 을 PLACEMENT_TYPE_NAMES 에서 생성", () => {
  const schema = classificationJsonSchema() as {
    properties: { typeName: { enum: string[] } };
  };
  const enumVals = schema.properties.typeName.enum;
  expect(enumVals).toEqual([...placementTypeNames(), "none"]);
  expect(placementTypeNames().length).toBe(10);
});

test("프롬프트에 10 배치 타입 영문 키가 전부 들어감(하드코딩 0)", () => {
  const messages = buildClassificationMessages("아무 글");
  const systemContent = messages[0]!.content;
  for (const t of placementTypeNames()) {
    expect(systemContent).toContain(t);
  }
  expect(systemContent).toContain("none");
});

test("파싱 — 유효 타입은 그대로", () => {
  const r = parseClassificationResponse('{"typeName":"work","reason":"만화 작품"}');
  expect(r.typeName).toBe("work");
  expect(r.reason).toBe("만화 작품");
});

test("파싱 — none/무효 타입은 typeName null(거짓 타입 안 만듦)", () => {
  expect(parseClassificationResponse('{"typeName":"none"}').typeName).toBeNull();
  expect(parseClassificationResponse('{"typeName":"바나나"}').typeName).toBeNull();
});

test("파싱 — 코드펜스 둘러도 객체만 떼어 파싱", () => {
  const raw = '```json\n{"typeName":"place","reason":"장소"}\n```';
  expect(parseClassificationResponse(raw).typeName).toBe("place");
});

test("파싱 — JSON 깨지면 throw(빈 성공 위장 금지)", () => {
  expect(() => parseClassificationResponse("응답이 그냥 텍스트")).toThrow();
  expect(() => parseClassificationResponse("{깨진 json")).toThrow();
});

// ── 실제 ollama 성공 경로(가동 시에만) ──────────────────────────────────────

test("1·2단 안 걸리고 ollama 응답하면 분류 결과를 받는다(실제 OllamaClient)", async () => {
  if (!(await ollamaAvailable())) {
    console.warn(`[skip] ollama(${OLLAMA_MODEL}) 미가동 — 실제 분류 케이스 건너뜀`);
    return;
  }
  const llm = new OllamaClient({ baseUrl: OLLAMA_URL, model: OLLAMA_MODEL });
  // 어휘 씨앗에 안 걸리되 사람을 분명히 가리키는 글 — 결정 단 none → LLM 단 진입.
  const r = await classifyEntityType("어제 만난 그 분은 정말 친절한 사람이었어", llm);
  // 거짓 타입을 만들지 않는 게 핵심 — source 는 llm(타입 채움) 또는 none(모름) 둘 중 하나.
  expect(["llm", "none"]).toContain(r.source);
  if (r.source === "llm") {
    expect(r.typeName).not.toBeNull();
    expect(placementTypeNames()).toContain(r.typeName!);
    expect(r.subcategory).toBeNull();
    expect(r.confidence).toBe(0.6);
  } else {
    expect(r.typeName).toBeNull();
  }
  console.warn(`[ollama 실제 분류] source=${r.source} typeName=${r.typeName} matched=${r.matched}`);
}, 30000);
