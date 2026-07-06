/**
 * HashiCorp Vault secret resolver using the KV v2 API.
 * SPEC: REQ-000055 §2.5.
 *
 * - Uses Node built-in `fetch` (Node 20+). No external Vault SDK (ADR-02).
 * - Supports AppRole auth with token caching and refresh at 90% TTL.
 * - All secret material is held in `Buffer`; `refHash` is logged instead.
 * - `dispose()` zeroes the cached token and cancels in-flight requests.
 */

import * as crypto from 'node:crypto';
import type { VaultConfig } from '../config/types.js';
import type { CredentialRef } from '../config/types.js';
import type { ResolvedSecret, SecretResolver } from './types.js';
import {
  VaultUnreachableError,
  VaultAuthError,
  VaultPermissionError,
  SecretMissingError,
} from './errors.js';

export interface VaultResolverOptions {
  /** Override fetch (for testing). Signature matches global fetch. */
  fetchImpl?: typeof fetch;
  /** Default 5000 ms. */
  requestTimeoutMs?: number;
  /** Token refresh at (leaseDuration * ratio). Default 0.9. */
  tokenRefreshRatio?: number;
  /** Clock (for testing). Default () => Date.now(). */
  now?: () => number;
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

export class VaultSecretResolver implements SecretResolver {
  private readonly cfg: VaultConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly tokenRefreshRatio: number;
  private readonly now: () => number;
  private tokenCache: TokenCache | null = null;
  private abortController: AbortController;

  constructor(cfg: VaultConfig, env: NodeJS.ProcessEnv, opts: VaultResolverOptions = {}) {
    this.cfg = cfg;
    this.env = env;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5000;
    this.tokenRefreshRatio = opts.tokenRefreshRatio ?? 0.9;
    this.now = opts.now ?? (() => Date.now());
    this.abortController = new AbortController();
  }

  /** Test/lifecycle hook. Cancels in-flight AbortController and zeroes cached token. */
  dispose(): void {
    this.abortController.abort();
    this.abortController = new AbortController();
    this.tokenCache = null;
  }

  /**
   * Health check — queries `/v1/sys/health`.
   * Treats 200, 429, and 473 as reachable.
   * @throws VaultUnreachableError on network failure or 5xx.
   * @throws VaultAuthError on 400/403.
   */
  async ping(): Promise<void> {
    const url = `${this.cfg.address}/v1/sys/health`;
    let resp: Response;
    try {
      resp = await this.doFetch(url, { method: 'GET' });
    } catch (err) {
      if (err instanceof VaultUnreachableError || err instanceof VaultAuthError) throw err;
      throw new VaultUnreachableError(this.cfg.address, this.cfg.auth_method, err);
    }
    // 200, 429 (standby), 473 (performance standby) → reachable
    if (resp.status === 200 || resp.status === 429 || resp.status === 473) return;
    // 501, 503 → standby; treat as reachable-but-standby
    if (resp.status === 501 || resp.status === 503) return;
    // Any other status is an error
    throw new VaultUnreachableError(this.cfg.address, this.cfg.auth_method);
  }

  /**
   * Resolve a secret from Vault KV v2.
   * @throws VaultUnreachableError, VaultAuthError, VaultPermissionError, SecretMissingError
   */
  async resolve(ref: CredentialRef): Promise<ResolvedSecret> {
    const token = await this.getToken();
    const url = `${this.cfg.address}/v1/${ref.vault_path}`;
    let resp: Response;
    try {
      resp = await this.doFetch(url, {
        method: 'GET',
        headers: { 'X-Vault-Token': token },
      });
    } catch (err) {
      if (
        err instanceof VaultUnreachableError ||
        err instanceof VaultAuthError ||
        err instanceof VaultPermissionError ||
        err instanceof SecretMissingError
      ) {
        throw err;
      }
      throw new VaultUnreachableError(this.cfg.address, this.cfg.auth_method, err);
    }

    if (resp.status === 403) {
      throw new VaultPermissionError(ref.vault_path);
    }
    if (resp.status === 404) {
      throw new SecretMissingError(ref);
    }
    if (resp.status >= 500) {
      throw new VaultUnreachableError(this.cfg.address, this.cfg.auth_method);
    }
    if (!resp.ok) {
      throw new VaultUnreachableError(this.cfg.address, this.cfg.auth_method);
    }

    const body = (await resp.json()) as {
      data?: {
        data?: Record<string, string>;
        metadata?: { version?: number };
      };
    };

    const data = body.data?.data;
    if (data === undefined || !(ref.vault_field in data)) {
      throw new SecretMissingError(ref);
    }

    const rawValue = data[ref.vault_field];
    if (rawValue === undefined) {
      throw new SecretMissingError(ref);
    }

    const version = body.data?.metadata?.version ?? 0;
    const refHash = computeRefHash(ref.vault_path, ref.vault_field, version);

    return {
      value: Buffer.from(rawValue, 'utf8'),
      refHash,
      ref,
    };
  }

  /** Get or refresh the Vault token. */
  private async getToken(): Promise<string> {
    const now = this.now();
    if (this.tokenCache !== null && now < this.tokenCache.expiresAt) {
      return this.tokenCache.token;
    }
    return this.login();
  }

  /** Authenticate with Vault using the configured auth method. */
  private async login(): Promise<string> {
    if (this.cfg.auth_method === 'approle') {
      return this.loginApprole();
    }
    if (this.cfg.auth_method === 'token') {
      // Token auth: read from env VAULT_TOKEN
      const token = this.env['VAULT_TOKEN'];
      if (!token) {
        throw new VaultAuthError(this.cfg.auth_method, 'VAULT_TOKEN');
      }
      this.tokenCache = { token, expiresAt: this.now() + 24 * 60 * 60 * 1000 };
      return token;
    }
    throw new VaultAuthError(this.cfg.auth_method);
  }

  private async loginApprole(): Promise<string> {
    const approle = this.cfg.approle;
    if (!approle) {
      throw new VaultAuthError(this.cfg.auth_method);
    }
    const roleId = this.env[approle.role_id_env];
    const secretId = this.env[approle.secret_id_env];
    if (!roleId || !secretId) {
      throw new VaultAuthError(
        this.cfg.auth_method,
        approle.role_id_env,
        approle.secret_id_env,
      );
    }

    const url = `${this.cfg.address}/v1/auth/approle/login`;
    let resp: Response;
    try {
      resp = await this.doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role_id: roleId, secret_id: secretId }),
      });
    } catch (err) {
      if (err instanceof VaultAuthError) throw err;
      throw new VaultUnreachableError(this.cfg.address, this.cfg.auth_method, err);
    }

    if (resp.status === 400 || resp.status === 403) {
      throw new VaultAuthError(
        this.cfg.auth_method,
        approle.role_id_env,
        approle.secret_id_env,
      );
    }
    if (!resp.ok) {
      throw new VaultUnreachableError(this.cfg.address, this.cfg.auth_method);
    }

    const body = (await resp.json()) as {
      auth?: { client_token?: string; lease_duration?: number };
    };

    const clientToken = body.auth?.client_token;
    const leaseDuration = body.auth?.lease_duration ?? 3600;

    if (!clientToken) {
      throw new VaultAuthError(
        this.cfg.auth_method,
        approle.role_id_env,
        approle.secret_id_env,
      );
    }

    const expiresAt = this.now() + leaseDuration * this.tokenRefreshRatio * 1000;
    this.tokenCache = { token: clientToken, expiresAt };
    return clientToken;
  }

  /**
   * Make a fetch request with timeout support using Promise.race.
   * The timeout race fires regardless of whether the fetch implementation
   * responds to the AbortSignal (important for test mocks).
   *
   * @throws VaultUnreachableError on network/timeout failures.
   */
  private async doFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();

    const timeoutPromise = new Promise<never>((_, reject) => {
      // .unref() ensures this timer does not prevent the process (or Jest worker)
      // from exiting if no other work is pending.
      const t = setTimeout(() => {
        controller.abort();
        reject(
          Object.assign(new Error('Vault request timed out'), { name: 'AbortError' }),
        );
      }, this.requestTimeoutMs);
      if (typeof t === 'object' && t !== null && typeof (t as NodeJS.Timeout).unref === 'function') {
        (t as NodeJS.Timeout).unref();
      }
    });

    try {
      return await Promise.race([
        this.fetchImpl(url, { ...init, signal: controller.signal }),
        timeoutPromise,
      ]);
    } catch (err) {
      const e = err as Error & { name?: string };
      if (e.name === 'AbortError') {
        throw new VaultUnreachableError(this.cfg.address, this.cfg.auth_method, err);
      }
      throw err;
    }
  }
}

/** Compute refHash: sha256:hex(sha256("vault:path:field:version")) */
function computeRefHash(vaultPath: string, vaultField: string, version: number): string {
  const material = `vault:${vaultPath}:${vaultField}:${version}`;
  const hash = crypto.createHash('sha256').update(material, 'utf8').digest('hex');
  return `sha256:${hash}`;
}
