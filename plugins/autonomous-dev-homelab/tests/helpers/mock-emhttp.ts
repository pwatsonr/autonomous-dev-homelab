/**
 * In-memory `UnraidEmhttpClient` test double. SPEC-002-3-04.
 *
 * Records every method invocation on `recordedCalls` so tests assert
 * call order (e.g. `stop` BEFORE `add` when a container exists).
 */

import {
  UnraidEmhttpClient,
  type AddContainerPayload,
  type ContainerInspect,
  type EmhttpFetch,
  type PullStatus,
} from '../../src/deploy/backends/unraid-emhttp-client.js';

export interface EmhttpScenario {
  shares?: string[];
  pullStatus?: PullStatus;
  inspectByName?: Map<string, ContainerInspect | null>;
}

export interface RecordedEmhttpCall {
  op: string;
  args: unknown[];
}

export class MockUnraidEmhttpClient {
  readonly recordedCalls: RecordedEmhttpCall[] = [];
  private readonly scenario: EmhttpScenario;
  private inspectQueue?: Array<ContainerInspect | null>;

  constructor(scenario: EmhttpScenario = {}) {
    this.scenario = scenario;
  }

  /** Test seam: drive a sequence of inspect responses for poll loops. */
  setInspectQueue(seq: Array<ContainerInspect | null>): void {
    this.inspectQueue = [...seq];
  }

  async getShares(): Promise<string[]> {
    this.recordedCalls.push({ op: 'getShares', args: [] });
    return this.scenario.shares ?? [];
  }
  async pullImage(image: string): Promise<{ accepted: boolean }> {
    this.recordedCalls.push({ op: 'pullImage', args: [image] });
    return { accepted: true };
  }
  async pullStatus(image: string): Promise<PullStatus> {
    this.recordedCalls.push({ op: 'pullStatus', args: [image] });
    return (
      this.scenario.pullStatus ?? {
        image,
        digest: 'sha256:deadbeef',
        sizeBytes: 0,
        status: 'complete',
      }
    );
  }
  async inspectContainer(name: string): Promise<ContainerInspect | null> {
    this.recordedCalls.push({ op: 'inspectContainer', args: [name] });
    if (this.inspectQueue !== undefined) {
      const next = this.inspectQueue.shift();
      return next ?? null;
    }
    const map = this.scenario.inspectByName;
    if (map === undefined) return null;
    return map.has(name) ? map.get(name) ?? null : null;
  }
  async stopContainer(name: string): Promise<void> {
    this.recordedCalls.push({ op: 'stopContainer', args: [name] });
  }
  async removeContainer(name: string): Promise<void> {
    this.recordedCalls.push({ op: 'removeContainer', args: [name] });
  }
  async addContainer(payload: AddContainerPayload | Record<string, unknown>): Promise<void> {
    this.recordedCalls.push({ op: 'addContainer', args: [payload] });
  }
  async startContainer(name: string): Promise<void> {
    this.recordedCalls.push({ op: 'startContainer', args: [name] });
  }
}

/** Coerce the mock into the structural shape expected by the backend. */
export function asEmhttpClient(mock: MockUnraidEmhttpClient): UnraidEmhttpClient {
  return mock as unknown as UnraidEmhttpClient;
}

/** Helper to build an `EmhttpFetch` stub from a Map of url → response. */
export function makeFetchStub(
  responses: Map<string, { status: number; body: unknown }>,
  defaultStatus = 404,
): EmhttpFetch {
  return async (url) => {
    const r = responses.get(url) ?? { status: defaultStatus, body: '' };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
      json: async () => r.body,
    };
  };
}
