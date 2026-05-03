/**
 * `registerHomelabBackends` per SPEC-002-3-02.
 *
 * Single entrypoint that registers the four homelab deploy backends with
 * an autonomous-dev `BackendRegistry`. Allowlist-gated; per-backend
 * failures NEVER throw — the function returns a `{ registered, rejected }`
 * summary so the plugin still loads when only some backends are usable.
 */

import { DockerSwarmHomelabBackend } from './backends/docker-swarm.js';
import { K3sHomelabBackend, type K8sBackendLike } from './backends/k3s.js';
import {
  createK3sCredentialClient,
  type K3sCredentialClient,
} from './backends/k3s-credential-client.js';
import { ProxmoxHomelabBackend } from './backends/proxmox.js';
import { UnraidHomelabBackend } from './backends/unraid.js';
import type { Connection } from '../connection/base.js';
import type { CredentialProxy } from './credential-proxy-types.js';
import type { UnraidEmhttpClient } from './backends/unraid-emhttp-client.js';
import type { BackendRegistry } from './backend-registry.js';
import type { DeploymentBackend } from './types.js';

export interface RegistryDeps {
  /** Connection factory shared by Proxmox + Swarm backends. */
  getConnection: (id: string) => Promise<Connection>;
  /** Resolves an `UnraidEmhttpClient` for a given Unraid host id. */
  getUnraidClient: (hostId: string) => Promise<UnraidEmhttpClient>;
  /** Real autonomous-dev `K8sBackend` instance (or test stub). */
  k8sBackend: K8sBackendLike;
  /** Credential proxy (autonomous-dev SPEC-024-2-01 mirror). */
  credentialProxy: CredentialProxy;
  /** Resolves a k3s cluster id → kubeconfig context name. */
  resolveK3sContextName: (clusterId: string) => Promise<string>;
}

export interface RegisterOptions {
  registry: BackendRegistry;
  /** Value of `extensions.privileged_backends`. */
  allowlist: ReadonlyArray<string>;
  deps: RegistryDeps;
}

export interface RegisterResult {
  registered: string[];
  rejected: { name: string; reason: string }[];
}

const REGISTRATION_ORDER = ['proxmox', 'unraid', 'docker-swarm', 'k3s'] as const;

export function registerHomelabBackends(opts: RegisterOptions): RegisterResult {
  const { registry, allowlist, deps } = opts;
  const result: RegisterResult = { registered: [], rejected: [] };

  const credentialClient: K3sCredentialClient = createK3sCredentialClient(deps.credentialProxy);

  const constructors: Record<(typeof REGISTRATION_ORDER)[number], () => DeploymentBackend> = {
    proxmox: () => new ProxmoxHomelabBackend({ getConnection: deps.getConnection }),
    unraid: () => new UnraidHomelabBackend({ getClient: deps.getUnraidClient }),
    'docker-swarm': () =>
      new DockerSwarmHomelabBackend({ getConnection: deps.getConnection }),
    k3s: () =>
      new K3sHomelabBackend({
        k8sBackend: deps.k8sBackend,
        credentialClient,
        resolveContextName: deps.resolveK3sContextName,
      }),
  };

  for (const name of REGISTRATION_ORDER) {
    if (!allowlist.includes(name)) {
      result.rejected.push({ name, reason: 'not in extensions.privileged_backends allowlist' });
      continue;
    }
    let backend: DeploymentBackend;
    try {
      backend = constructors[name]();
    } catch (err) {
      result.rejected.push({ name, reason: (err as Error).message });
      continue;
    }
    try {
      registry.register(backend);
      result.registered.push(name);
    } catch (err) {
      result.rejected.push({ name, reason: (err as Error).message });
    }
  }
  return result;
}
