/**
 * 첫 설치 모델 다운로드 진행 줄(@@bara-progress) 포맷·throttle 헬퍼.
 *
 * 설치 프로그램(Pet)은 prefetch 스크립트의 stdout 에서 아래 한 줄 형식을 읽어
 * 진행률 막대를 그린다. 이 파일이 그 형식의 단일 출처이고, 순수 모듈(시계·출력을
 * 주입, 다른 모듈 import 없음)이라 apps/setup 의 스크립트도 그대로 가져다 쓴다.
 *
 *   @@bara-progress {"part":P,"parts":N,"loaded":L,"total":T}
 *
 * - P: 1부터 시작하는 현재 단계 번호, N: 스크립트가 받는 단계 수(실행 내내 고정).
 * - L: 이 단계에서 지금까지 받은 바이트(파일들의 합), T: 지금까지 알려진 예상
 *   바이트(다운로더가 보고한 파일별 total 의 합, 모르면 0).
 * - T > 0 이면 L <= T 로 맞춘다. L 이 T 를 넘는 건 T 가 0 일 때만 가능하다.
 * - 500ms 에 최대 한 줄. 단계의 첫 줄과 단계가 끝날 때의 마지막 줄은 항상 낸다.
 * - 설치 프로그램이 읽을 때만 낸다(환경 변수 `BARA_INSTALL_PROGRESS=1`). CLI setup 의 터미널이나
 *   원격 설치의 출력에는 이 줄이 섞이지 않는다.
 */

export const PROGRESS_LINE_PREFIX = "@@bara-progress ";
export const PROGRESS_THROTTLE_MS = 500;
/** 진행 줄을 켜는 환경 변수. Pet 설치 프로그램만 "1" 로 넘긴다. */
export const PROGRESS_ENV = "BARA_INSTALL_PROGRESS";

/** 이 실행이 진행 줄을 내야 하는지 — 읽는 쪽(Pet)이 켰을 때만. */
export function progressLinesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[PROGRESS_ENV] === "1";
}
/** 계약상 단계 수 상한. */
export const MAX_PROGRESS_PARTS = 10;

export interface ProgressSnapshot {
  part: number;
  parts: number;
  loaded: number;
  total: number;
}

/** 음수·NaN·Infinity·비숫자는 0, 나머지는 내림한 안전 정수. */
function toSafeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

/** 진행 줄 한 개(개행 제외)를 만든다. 키 순서와 공백이 계약이라 고정이다. */
export function formatProgressLine(snapshot: ProgressSnapshot): string {
  return (
    PROGRESS_LINE_PREFIX +
    JSON.stringify({
      part: snapshot.part,
      parts: snapshot.parts,
      loaded: snapshot.loaded,
      total: snapshot.total,
    })
  );
}

/**
 * `@huggingface/transformers` 의 ProgressInfo 중 이 헬퍼가 읽는 필드만 뽑은 구조 타입.
 * (라이브러리 타입을 import 하지 않아 transformers 가 없는 곳에서도 쓸 수 있다.)
 */
export interface DownloaderProgressLike {
  status: string;
  name?: string;
  file?: string;
  loaded?: number;
  total?: number;
}

export interface PartProgress {
  /** 다운로더가 보고한 파일 하나의 현재 바이트 수를 반영한다. */
  setFile(file: string, loaded: number, total: number): void;
  /** transformers progress_callback 에 그대로 넘길 수 있는 콜백. */
  onProgress(info: DownloaderProgressLike): void;
  /** 단계 종료. throttle 과 무관하게 마지막 줄을 낸다(T > 0 이면 L == T). */
  finish(): void;
}

export interface InstallProgress {
  /** 1 부터 시작하는 단계 번호로 단계 추적기를 연다. */
  startPart(part: number): PartProgress;
}

export interface InstallProgressOptions {
  parts: number;
  /** 줄 하나를(개행 없이) 출력한다. 스크립트에서는 stdout 에 개행을 붙여 쓴다. */
  write: (line: string) => void;
  /** 단조 시계(ms). 기본 Date.now. 테스트에서 가짜 시계를 주입한다. */
  now?: () => number;
  throttleMs?: number;
}

export function createInstallProgress(options: InstallProgressOptions): InstallProgress {
  const { parts, write } = options;
  if (!Number.isInteger(parts) || parts < 1 || parts > MAX_PROGRESS_PARTS) {
    throw new RangeError(`parts must be an integer in 1..${MAX_PROGRESS_PARTS}`);
  }
  const now = options.now ?? Date.now;
  const throttleMs = options.throttleMs ?? PROGRESS_THROTTLE_MS;
  // throttle 시각은 단계를 열 때마다 비운다 — 앞 단계의 마지막 줄 직후라도 새 단계의 첫 줄은 바로 나간다.
  let lastEmitAt: number | null = null;

  return {
    startPart(part: number): PartProgress {
      if (!Number.isInteger(part) || part < 1 || part > parts) {
        throw new RangeError(`part must be an integer in 1..${parts}`);
      }
      lastEmitAt = null;
      const files = new Map<string, { loaded: number; total: number }>();

      const sums = (): { loaded: number; total: number } => {
        let loaded = 0;
        let total = 0;
        for (const f of files.values()) {
          loaded += f.loaded;
          total += f.total;
        }
        loaded = Math.min(loaded, Number.MAX_SAFE_INTEGER);
        total = Math.min(total, Number.MAX_SAFE_INTEGER);
        // 총량을 아는 동안에는 받은 양이 그것을 넘지 않게 맞춘다.
        if (total > 0 && loaded > total) loaded = total;
        return { loaded, total };
      };

      const emit = (force: boolean): void => {
        const at = now();
        if (!force && lastEmitAt !== null && at - lastEmitAt < throttleMs) return;
        lastEmitAt = at;
        const { loaded, total } = sums();
        write(formatProgressLine({ part, parts, loaded, total }));
      };

      const setFile = (file: string, loaded: number, total: number): void => {
        const t = toSafeInt(total);
        let l = toSafeInt(loaded);
        if (t > 0 && l > t) l = t;
        files.set(file, { loaded: l, total: t });
        emit(false);
      };

      return {
        setFile,
        onProgress(info: DownloaderProgressLike): void {
          if (typeof info.file !== "string") return;
          const key = `${info.name ?? ""}|${info.file}`;
          if (info.status === "progress") {
            setFile(key, info.loaded as number, info.total as number);
          } else if (info.status === "done") {
            // 파일 하나가 끝났다 — 총량을 아는 파일이면 전부 받은 것으로 맞춘다.
            const prev = files.get(key);
            if (prev && prev.total > 0) {
              prev.loaded = prev.total;
              emit(false);
            }
          }
        },
        finish(): void {
          // 단계가 정상 종료됐으면 총량을 아는 파일은 전부 받은 것이다.
          for (const f of files.values()) {
            if (f.total > 0) f.loaded = f.total;
          }
          emit(true);
        },
      };
    },
  };
}
