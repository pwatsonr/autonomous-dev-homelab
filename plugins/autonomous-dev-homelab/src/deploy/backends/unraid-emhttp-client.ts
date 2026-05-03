/**
 * `UnraidEmhttpClient` — HTTP client wrapping the subset of `emhttp`
 * endpoints used by `UnraidHomelabBackend`. SPEC-002-3-01.
 *
 * The Unraid host's session token is owned by `UnraidConnection`
 * (PLAN-001-2); this client is a thin wrapper that adapts the existing
 * connection to the request shapes the backend expects. The transport is
 * pluggable (`fetchImpl`) so tests can inject a deterministic stub
 * without using `nock`.
 */

import { DeployError } from '../errors.js';

export interface EmhttpFetch {
  (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
  }>;
}

export interface UnraidEmhttpClientOptions {
  /** Base URL of the emhttp endpoint (e.g. `http://unraid.local`). */
  baseUrl: string;
  /** Pluggable transport. Default: global `fetch`. */
  fetchImpl?: EmhttpFetch;
}

export interface ContainerInspect {
  name: string;
  image?: string;
  state: { running: boolean; health?: { status: 'healthy' | 'starting' | 'unhealthy'; failingStreak?: number } };
  /** Raw config payload echoed by emhttp; used for rollback round-trips. */
  config?: Record<string, unknown>;
}

export interface AddContainerPayload {
  name: string;
  image: string;
  network_mode: string;
  ports: string[];
  volumes: Array<{ host_path: string; container_path: string; readonly?: boolean }>;
  env: Record<string, string>;
}

export interface PullStatus {
  image: string;
  digest: string;
  sizeBytes: number;
  status: 'in-progress' | 'complete' | 'failed';
  error?: string;
}

const DEFAULT_FETCH: EmhttpFetch = (...args) => {
  // Direct lookup so tests can shadow `globalThis.fetch`.
  const f = (globalThis as { fetch?: unknown }).fetch;
  if (typeof f !== 'function') {
    throw new Error('global fetch is not available; pass fetchImpl to UnraidEmhttpClient');
  }
  return (f as EmhttpFetch)(...args);
};

export class UnraidEmhttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: EmhttpFetch;
  private cachedShares?: string[];

  constructor(opts: UnraidEmhttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? DEFAULT_FETCH;
  }

  async getShares(force = false): Promise<string[]> {
    if (!force && this.cachedShares !== undefined) return this.cachedShares;
    const res = await this.fetchImpl(`${this.baseUrl}/Shares`);
    if (!res.ok) {
      throw new DeployError({
        code: 'DEPLOY_FAILED',
        message: `emhttp /Shares returned ${res.status}`,
      });
    }
    const body = (await res.json()) as { shares?: Array<{ path?: string }> } | string[];
    const shares = Array.isArray(body)
      ? body
      : (body.shares ?? []).map((s) => s.path ?? '').filter((p) => p.length > 0);
    this.cachedShares = shares;
    return shares;
  }

  async pullImage(image: string): Promise<{ accepted: boolean }> {
    const res = await this.fetchImpl(`${this.baseUrl}/Docker/PullImage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image }),
    });
    return { accepted: res.ok };
  }

  async pullStatus(image: string): Promise<PullStatus> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/Docker/PullStatus?image=${encodeURIComponent(image)}`,
    );
    if (!res.ok) {
      throw new DeployError({
        code: 'IMAGE_PULL_FAILED',
        message: `emhttp /Docker/PullStatus returned ${res.status}`,
        retriable: res.status >= 500,
      });
    }
    return (await res.json()) as PullStatus;
  }

  async inspectContainer(name: string): Promise<ContainerInspect | null> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/Docker/InspectContainer?name=${encodeURIComponent(name)}`,
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new DeployError({
        code: 'DEPLOY_FAILED',
        message: `emhttp /Docker/InspectContainer returned ${res.status}`,
      });
    }
    return (await res.json()) as ContainerInspect;
  }

  async stopContainer(name: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/Docker/StopContainer?name=${encodeURIComponent(name)}`,
      { method: 'POST' },
    );
    if (!res.ok && res.status !== 404) {
      throw new DeployError({
        code: 'DEPLOY_FAILED',
        message: `emhttp /Docker/StopContainer returned ${res.status}`,
      });
    }
  }

  async removeContainer(name: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/Docker/RemoveContainer?name=${encodeURIComponent(name)}`,
      { method: 'POST' },
    );
    if (!res.ok && res.status !== 404) {
      throw new DeployError({
        code: 'DEPLOY_FAILED',
        message: `emhttp /Docker/RemoveContainer returned ${res.status}`,
      });
    }
  }

  async addContainer(payload: AddContainerPayload | Record<string, unknown>): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/Docker/AddContainer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new DeployError({
        code: 'DEPLOY_FAILED',
        message: `emhttp /Docker/AddContainer returned ${res.status}: ${text.slice(0, 500)}`,
      });
    }
  }

  async startContainer(name: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/Docker/StartContainer?name=${encodeURIComponent(name)}`,
      { method: 'POST' },
    );
    if (!res.ok) {
      throw new DeployError({
        code: 'DEPLOY_FAILED',
        message: `emhttp /Docker/StartContainer returned ${res.status}`,
      });
    }
  }
}
