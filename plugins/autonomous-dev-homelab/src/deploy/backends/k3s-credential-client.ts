/**
 * `k3s-credential-client` per SPEC-002-3-02.
 *
 * Wraps the local `CredentialProxy` interface (mirror of autonomous-dev
 * SPEC-024-2-01). Asserts the issued token lifetime is <= 900 seconds; a
 * misconfigured proxy that issues longer-lived tokens triggers a hard
 * failure rather than silently expanding the daemon's blast radius.
 */

import { DeployError } from '../errors.js';
import type {
  CredentialProxy,
  ScopedCredential,
} from '../credential-proxy-types.js';

export interface ScopedKubeconfigRequest {
  clusterId: string;
  op: 'K8s:Apply' | 'K8s:Patch' | 'K8s:Read';
  scope: string;
}

const MAX_TOKEN_LIFETIME_SECONDS = 900;

export interface K3sCredentialClient {
  acquire(req: ScopedKubeconfigRequest): Promise<ScopedCredential>;
}

export function createK3sCredentialClient(proxy: CredentialProxy): K3sCredentialClient {
  return {
    async acquire(req: ScopedKubeconfigRequest): Promise<ScopedCredential> {
      const cred = await proxy.acquire('k8s', req.op, { resource: req.scope });
      if (cred.tokenLifetimeSeconds > MAX_TOKEN_LIFETIME_SECONDS) {
        throw new DeployError({
          code: 'CREDENTIAL_INVALID',
          message:
            `proxy issued credential with lifetime ${cred.tokenLifetimeSeconds}s ` +
            `(max ${MAX_TOKEN_LIFETIME_SECONDS}s); refusing to use long-lived token`,
        });
      }
      return cred;
    },
  };
}
