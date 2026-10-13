/**
 * App Federation Registry (Phase 5.5 / spec section 6.1)
 *
 * 본 모듈 코어가 디스커버리 산출 어댑터를 보관. *메모리 단위만* —
 * DB 미사용 (어댑터는 부팅 시 1회 스캔 정신, spec section 12).
 */

import type { AppManifest } from "./manifest-schema";

export type HealthStatus = "ok" | "down" | "unknown";

export interface RegisteredApp {
  manifest: AppManifest;
  /** 부팅 시 스캔된 source 디렉토리 (디버깅용). */
  sourceDir: string;
  /** 등록 시각 (ms epoch). */
  registeredAt: number;
  /** 마지막 health poll 결과. 초기 = `unknown`. */
  health: HealthStatus;
  /** 마지막 health poll 시각 (ms epoch). 0 = 미시도. */
  lastHealthCheckAt: number;
  /** 마지막 health poll 응답 시간 (ms). -1 = 미측정. */
  lastHealthLatencyMs: number;
}

export class FederationRegistry {
  private apps = new Map<string, RegisteredApp>();

  register(manifest: AppManifest, sourceDir: string): RegisteredApp {
    const existing = this.apps.get(manifest.id);
    if (existing) {
      throw new Error(
        `App id '${manifest.id}' 이미 등록되어 있다 (sourceDir=${existing.sourceDir})`,
      );
    }
    const entry: RegisteredApp = {
      manifest,
      sourceDir,
      registeredAt: Date.now(),
      health: "unknown",
      lastHealthCheckAt: 0,
      lastHealthLatencyMs: -1,
    };
    this.apps.set(manifest.id, entry);
    return entry;
  }

  unregister(id: string): boolean {
    return this.apps.delete(id);
  }

  get(id: string): RegisteredApp | undefined {
    return this.apps.get(id);
  }

  list(): RegisteredApp[] {
    return Array.from(this.apps.values());
  }

  setHealth(
    id: string,
    status: HealthStatus,
    latencyMs: number,
  ): RegisteredApp | undefined {
    const entry = this.apps.get(id);
    if (!entry) return undefined;
    entry.health = status;
    entry.lastHealthCheckAt = Date.now();
    entry.lastHealthLatencyMs = latencyMs;
    return entry;
  }

  clear(): void {
    this.apps.clear();
  }

  size(): number {
    return this.apps.size;
  }
}
