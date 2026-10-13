/**
 * App Federation Health Poller (Phase 5.5 / spec section 6.1)
 *
 * 등록된 어댑터들의 `endpoint + health` 를 주기적으로 호출하여 레지스트리의
 * health 상태를 갱신한다. 디폴트 30초 간격 + 5초 timeout.
 */

import type { FederationRegistry, RegisteredApp } from "./registry";

export interface HealthPollerOptions {
  /** poll 간격 (ms). 디폴트 30_000 = 30초. */
  intervalMs?: number;
  /** 한 어댑터당 fetch timeout (ms). 디폴트 5_000 = 5초. */
  timeoutMs?: number;
  /** fetch 주입 (테스트에서 stub 가능). 디폴트 = 전역 fetch. */
  fetchImpl?: typeof fetch;
  /** 시계 주입 (테스트에서 stub 가능). 디폴트 = Date.now. */
  nowImpl?: () => number;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;

export class HealthPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly registry: FederationRegistry;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly nowImpl: () => number;

  constructor(
    registry: FederationRegistry,
    options: HealthPollerOptions = {},
  ) {
    this.registry = registry;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nowImpl = options.nowImpl ?? Date.now;
  }

  /** 시작 — 즉시 1회 poll + interval 등록. */
  start(): void {
    if (this.timer) return;
    void this.pollAll();
    this.timer = setInterval(() => {
      void this.pollAll();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 등록된 모든 어댑터에 대해 1 round poll. 테스트에서 직접 호출 가능. */
  async pollAll(): Promise<void> {
    const apps = this.registry.list();
    await Promise.all(apps.map((app) => this.pollOne(app)));
  }

  /** 1 어댑터에 대해 health 호출 1회. 테스트에서 직접 호출 가능. */
  async pollOne(app: RegisteredApp): Promise<void> {
    const url = `${app.manifest.endpoint}${app.manifest.health}`;
    const start = this.nowImpl();
    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: "GET",
        signal: controller.signal,
      });
      const latency = this.nowImpl() - start;
      if (res.ok) {
        this.registry.setHealth(app.manifest.id, "ok", latency);
      } else {
        this.registry.setHealth(app.manifest.id, "down", latency);
      }
    } catch {
      const latency = this.nowImpl() - start;
      this.registry.setHealth(app.manifest.id, "down", latency);
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}
