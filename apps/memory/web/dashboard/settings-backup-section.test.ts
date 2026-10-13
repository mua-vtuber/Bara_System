/**
 * settings-backup-section 단위 테스트 (P4 T6).
 *
 * 검증 정신 — Mock 클래스 0:
 *   renderBackupSection 은 주입형(deps)이다. fetchStatus / downloadBlob 두 함수를
 *   데이터 fixture 로 주입해 DOM 조립·상태 반영·다운로드 트리거만 검증한다. 인터페이스
 *   구현체(Mock 클래스)는 만들지 않는다 — 함수 교체는 데이터 주입이다. 실제 apiFetch
 *   호출은 default deps 가 감싸고 통합 검증 + 사용자 수동 sanity 가 맡는다.
 *
 * 검증 갈래:
 *   1) 이력 없음 상태 정직 표기 + 다운로드 버튼 존재 + 비밀값·자산 제외 안내.
 *   2) 상태 fetch 실패 = 에러 문구 노출 (silent 빈칸 금지).
 *   3) appVersion·schemaVersion 한 줄 노출 (spec D4-b).
 *   4) 마지막 백업 성공 결과 반영.
 *   5) 다운로드 버튼 클릭 → downloadBlob 호출 + <a download> 트리거.
 */

import "../../test-setup-dom";
import { describe, test, expect } from "bun:test";
import { renderBackupSection } from "./settings-backup-section.ts";
import { BACKUP_LABELS } from "./settings-backup-labels.ts";

/** 다음 microtask + timer tick 까지 기다려 상태 fetch 반영을 보장한다. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("renderBackupSection — 상태 표시 + 다운로드", () => {
  test("복원 안내는 ZIP과 서버 회차를 구분하고 안전한 새 위치 명령을 선택해 복사할 수 있다", async () => {
    const el = renderBackupSection({
      fetchStatus: async () => ({ lastResult: null, nextRunAt: null, appVersion: "0.1.0", schemaVersion: 39, rounds: [] }),
      downloadBlob: async () => new Blob([]),
    });
    const command = el.querySelector<HTMLTextAreaElement>("textarea[data-backup-restore-command]");
    expect(command).not.toBeNull();
    expect(command!.readOnly).toBe(true);
    expect(command!.value).toContain("restore-backup.ts");
    expect(command!.value).toContain('"bara-backup.zip" --data-dir "data-restored" --yes');
    expect(el.textContent).toContain("서버 회차");
    expect(el.textContent).toContain("문서 원본");
    expect(el.textContent).toContain("API 키");
    expect(el.textContent).toContain("비어 있는");
    const copy = Array.from(el.querySelectorAll("button")).find((button) => button.textContent === BACKUP_LABELS.restoreCopy)!;
    copy.click();
    await flush();
    expect(await navigator.clipboard.readText()).toBe(command!.value);
    expect(el.querySelector('[role="status"]')?.textContent).toBe(BACKUP_LABELS.restoreCopied);
  });
  test("이력 없음 상태 정직 표기 + 다운로드 버튼 존재 + 제외 안내", async () => {
    const el = renderBackupSection({
      fetchStatus: async () => ({
        lastResult: null,
        nextRunAt: null,
        appVersion: "0.1.0",
        schemaVersion: 39,
        rounds: [],
      }),
      downloadBlob: async () => new Blob(["zip"]),
    });
    document.body.appendChild(el);
    await flush();

    expect(el.textContent).toContain(BACKUP_LABELS.noHistory);
    expect(el.querySelector("button")!.textContent).toBe(
      BACKUP_LABELS.downloadBtn,
    );
    expect(el.textContent).toContain(BACKUP_LABELS.downloadNote);
  });

  test("상태 fetch 실패 = 에러 문구 (silent 빈칸 금지)", async () => {
    const el = renderBackupSection({
      fetchStatus: async () => {
        throw new Error("HTTP 500");
      },
      downloadBlob: async () => new Blob([]),
    });
    document.body.appendChild(el);
    await flush();

    expect(el.textContent).toContain("HTTP 500");
    expect(el.textContent).toContain(BACKUP_LABELS.statusFailPrefix);
  });

  test("appVersion·schemaVersion 한 줄 노출 (spec D4-b)", async () => {
    const el = renderBackupSection({
      fetchStatus: async () => ({
        lastResult: null,
        nextRunAt: null,
        appVersion: "0.1.0",
        schemaVersion: 39,
        rounds: [],
      }),
      downloadBlob: async () => new Blob(["zip"]),
    });
    document.body.appendChild(el);
    await flush();

    const text = el.textContent ?? "";
    expect(text).toContain(BACKUP_LABELS.appVersionPrefix);
    expect(text).toContain("0.1.0");
    expect(text).toContain("39");
  });

  test("마지막 백업 성공 결과 반영", async () => {
    const el = renderBackupSection({
      fetchStatus: async () => ({
        lastResult: { ok: true, at: "2026-07-03T10:00:00Z", roundDir: "r-42" },
        nextRunAt: "2026-07-04T03:00:00Z",
        appVersion: "0.1.0",
        schemaVersion: 39,
        rounds: [
          {
            dir: "r-42",
            timestamp: "2026-07-03T10:00:00Z",
            files: 3,
            assets: 5,
            bytes: 1024,
          },
        ],
      }),
      downloadBlob: async () => new Blob(["zip"]),
    });
    document.body.appendChild(el);
    await flush();

    const text = el.textContent ?? "";
    expect(text).toContain(BACKUP_LABELS.lastResultPrefix);
    // 회차 이력 1건이 반영돼 "이력 없음" 이 아님.
    expect(text).not.toContain(BACKUP_LABELS.noHistory);
  });

  test("다운로드 버튼 클릭 → downloadBlob 호출 + <a download> 트리거", async () => {
    let called = 0;
    // happy-dom 은 실제 다운로드를 못 하므로 anchor click 을 가로채 트리거만 확인.
    let anchorClicked = false;
    const origCreate = document.createElement.bind(document);
    (document as unknown as { createElement: typeof document.createElement }).createElement =
      ((tag: string) => {
        const node = origCreate(tag) as HTMLElement;
        if (tag === "a") {
          node.addEventListener("click", (e) => {
            e.preventDefault();
            anchorClicked = true;
          });
        }
        return node;
      }) as typeof document.createElement;

    try {
      const el = renderBackupSection({
        fetchStatus: async () => ({
          lastResult: null,
          nextRunAt: null,
          appVersion: "0.1.0",
          schemaVersion: 39,
          rounds: [],
        }),
        downloadBlob: async () => {
          called += 1;
          return new Blob(["zip"]);
        },
      });
      document.body.appendChild(el);
      await flush();

      const btn = el.querySelector("button") as HTMLButtonElement;
      btn.click();
      await flush();

      expect(called).toBe(1);
      expect(anchorClicked).toBe(true);
    } finally {
      (document as unknown as { createElement: typeof document.createElement }).createElement =
        origCreate;
    }
  });
});
