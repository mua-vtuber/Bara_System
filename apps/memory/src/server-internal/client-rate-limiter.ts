/**
 * 접속 주소별 요청 빈도 상한(고정 창 방식).
 *
 * 한 주소가 windowMs 안에 maxRequestsPerWindow 번을 넘게 부르면 다음 창이 열릴
 * 때까지 거절한다. 기록은 메모리에만 두며 서버 재시작 때 비워진다(상한의 목적이
 * 짧은 시간의 폭주를 막는 것이라 재시작 너머로 이어 갈 필요가 없다).
 *
 * 기억하는 주소 수는 maxTrackedClients 로 묶는다. 가득 차면 창이 끝난 기록을 먼저
 * 지우고, 그래도 가득 차면 처음 보는 주소를 거절한다 — 주소를 바꿔 가며 보내는
 * 요청이 기억 공간을 끝없이 늘리지 못하게 하기 위해서다.
 *
 * 쓰는 곳: 무인증 공개 경로 POST /adapter-enroll (routes/adapter-tokens.ts).
 */

import type { AdapterEnrollRateLimits } from "../federation/adapter-enroll-limits.ts";

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

interface WindowRecord {
  windowStartMs: number;
  count: number;
}

export class ClientRateLimiter {
  private readonly records = new Map<string, WindowRecord>();

  /** now 는 현재 시각(ms)을 주는 함수. 테스트는 정해진 시각을 넘겨 창 경계를 검증한다. */
  constructor(
    private readonly limits: AdapterEnrollRateLimits,
    private readonly now: () => number = Date.now,
  ) {
    if (!(limits.maxRequestsPerWindow >= 1) || !(limits.windowMs > 0) || !(limits.maxTrackedClients >= 1)) {
      throw new Error(
        "요청 빈도 상한 설정 오류: maxRequestsPerWindow·maxTrackedClients 는 1 이상, windowMs 는 0 보다 커야 한다",
      );
    }
  }

  /** clientKey 의 요청 하나를 세고 허용 여부를 돌려준다. 거절된 요청도 센다. */
  consume(clientKey: string): RateLimitDecision {
    const nowMs = this.now();
    const { maxRequestsPerWindow, windowMs, maxTrackedClients } = this.limits;
    let record = this.records.get(clientKey);
    if (record !== undefined && nowMs - record.windowStartMs >= windowMs) {
      record = undefined;
      this.records.delete(clientKey);
    }
    if (record === undefined) {
      if (this.records.size >= maxTrackedClients) this.evictExpired(nowMs);
      if (this.records.size >= maxTrackedClients) {
        return { allowed: false, retryAfterMs: this.earliestWindowEnd(nowMs) };
      }
      record = { windowStartMs: nowMs, count: 0 };
      this.records.set(clientKey, record);
    }
    record.count += 1;
    if (record.count > maxRequestsPerWindow) {
      return { allowed: false, retryAfterMs: record.windowStartMs + windowMs - nowMs };
    }
    return { allowed: true };
  }

  private evictExpired(nowMs: number): void {
    for (const [key, record] of this.records) {
      if (nowMs - record.windowStartMs >= this.limits.windowMs) this.records.delete(key);
    }
  }

  /** 추적 공간이 가득 찼을 때 가장 먼저 비는 시각까지 남은 시간. */
  private earliestWindowEnd(nowMs: number): number {
    let earliest = Number.POSITIVE_INFINITY;
    for (const record of this.records.values()) {
      earliest = Math.min(earliest, record.windowStartMs + this.limits.windowMs - nowMs);
    }
    return Math.max(earliest, 0);
  }
}
