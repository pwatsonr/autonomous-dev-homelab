/**
 * Plugin entry point. SPEC-002-3-02 §"`activate(ctx)`".
 *
 * Conforms to autonomous-dev's plugin lifecycle (PLAN-019-1):
 *   - `ctx.registry` is the live `BackendRegistry`
 *   - `ctx.config` exposes the resolved operator config
 *   - `ctx.logger` is structured
 *
 * Activation is idempotent: re-running against an already-populated
 * registry produces zero new registrations and does not throw — failures
 * are surfaced via the `result.rejected` summary which the lifecycle
 * logs at WARN.
 */

import {
  registerHomelabBackends,
  type RegistryDeps,
} from './deploy/registry-wiring.js';
import type { BackendRegistry } from './deploy/backend-registry.js';

export interface PluginLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
}

export interface PluginConfig {
  get<T>(key: string, defaultValue: T): T;
}

export interface PluginActivateContext {
  registry: BackendRegistry;
  config: PluginConfig;
  logger: PluginLogger;
  /** Plugin-host-supplied dependencies for the homelab backends. */
  deps: RegistryDeps;
}

export interface ActivateResult {
  registered: string[];
  rejected: { name: string; reason: string }[];
}

export async function activate(ctx: PluginActivateContext): Promise<ActivateResult> {
  const allowlist = ctx.config.get<string[]>('extensions.privileged_backends', []);
  const result = registerHomelabBackends({
    registry: ctx.registry,
    allowlist,
    deps: ctx.deps,
  });
  for (const name of result.registered) {
    ctx.logger.info(`registered backend: ${name}`);
  }
  for (const r of result.rejected) {
    ctx.logger.warn(`backend ${r.name} not registered: ${r.reason}`);
  }
  return result;
}

export { registerHomelabBackends } from './deploy/registry-wiring.js';
export {
  InMemoryBackendRegistry,
} from './deploy/backend-registry.js';
export type { BackendRegistry } from './deploy/backend-registry.js';
