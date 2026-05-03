/**
 * LOCAL CredentialProxy contract.
 *
 * The real `CredentialProxy` lives in autonomous-dev SPEC-024-2-01. This
 * homelab plugin cannot import across the repo boundary, so the K3s
 * backend (SPEC-002-3-02) consumes the proxy through this local interface.
 * A future shared package would let both sides depend on a single source
 * of truth.
 */

export interface CredentialProxyScope {
  /** Free-form scope string (e.g. `cluster:foo/namespace:bar`). */
  resource: string;
}

export interface ScopedCredential {
  /** Opaque token (kubeconfig YAML, JWT, etc.) issued for the requested scope. */
  kubeconfig: string;
  /** ISO-8601 expiry timestamp. */
  expiresAt: string;
  /** Token lifetime in seconds. The K3s backend ASSERTS this is <= 900. */
  tokenLifetimeSeconds: number;
}

export interface CredentialProxy {
  /**
   * `kind` is e.g. `'k8s'`; `op` is e.g. `'K8s:Apply'`. The proxy returns a
   * scoped credential or throws.
   */
  acquire(
    kind: string,
    op: string,
    scope: CredentialProxyScope,
  ): Promise<ScopedCredential>;
}
