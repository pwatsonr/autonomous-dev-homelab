/**
 * Local mirror of autonomous-dev SPEC-023-1-04's `BackendRegistry`
 * interface. The homelab plugin cannot import the real registry across
 * the repo boundary; this structural type captures the contract the
 * plugin's `activate(ctx)` consumes. Production wiring (when both repos
 * unify under a shared package) injects the real registry; tests inject
 * an in-memory implementation.
 */

import type { DeploymentBackend } from './types.js';

export interface BackendRegistry {
  /** Throws on duplicate name OR when SPEC-019-3 trust validation fails. */
  register(backend: DeploymentBackend): void;
  /** Returns all registered backends. */
  list(): DeploymentBackend[];
}

/**
 * Reference in-memory implementation. Used in tests and as the default
 * when the plugin runs standalone (no autonomous-dev host available).
 */
export class InMemoryBackendRegistry implements BackendRegistry {
  private readonly entries = new Map<string, DeploymentBackend>();

  register(backend: DeploymentBackend): void {
    const name = backend.metadata.name;
    if (this.entries.has(name)) {
      throw new Error(`backend '${name}' is already registered`);
    }
    this.entries.set(name, backend);
  }

  list(): DeploymentBackend[] {
    return [...this.entries.values()];
  }
}
