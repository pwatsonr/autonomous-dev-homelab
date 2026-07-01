/**
 * Load and validate a homelab configuration file.
 * SPEC: REQ-000055 TASK-004, §2.3.
 *
 * Precedence for config path resolution:
 *   1. `opts.path` if provided.
 *   2. `opts.env?.AUTONOMOUS_DEV_HOMELAB_CONFIG` if set.
 *   3. `${os.homedir()}/.autonomous-dev-homelab/homelab.config.yaml`.
 *
 * Errors:
 *   - `ConfigNotFoundError` (exit 12) — file absent or unreadable.
 *   - `ConfigInvalidError` (exit 11) — YAML parse error, Zod violation,
 *     or inline secret detected.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import { ZodError } from 'zod';
import { HomelabConfig } from './schema.js';
import type { HomelabConfig as HomelabConfigT } from './types.js';
import { ConfigInvalidError, ConfigNotFoundError } from './errors.js';

const CONFIG_ENV_KEY = 'AUTONOMOUS_DEV_HOMELAB_CONFIG';

/**
 * Leaf keys that MUST NOT appear in the config with plain-text values.
 * `key` is intentionally NOT in this set because `key_ref` is legitimate;
 * detection is triggered only on string leaf values under these key names.
 */
export const DISALLOWED_LEAF_KEYS: ReadonlySet<string> = new Set([
  'value',
  'password',
  'secret',
  'token',
  'private_key',
  'privateKey',
  'passphrase',
]);

export interface LoaderOptions {
  /** Absolute path to config file. Overrides env var. */
  path?: string;
  /** Environment (for env var lookup). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Load and validate a homelab config file.
 * @throws ConfigNotFoundError (exit 12) — file absent or unreadable
 * @throws ConfigInvalidError (exit 11) — YAML parse error or Zod violation or inline-secret
 */
export async function loadHomelabConfig(opts?: LoaderOptions): Promise<HomelabConfigT> {
  const env = opts?.env ?? process.env;
  const configPath = resolveConfigPath(opts?.path, env);

  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT' || e.code === 'EACCES') {
      throw new ConfigNotFoundError(configPath);
    }
    throw new ConfigNotFoundError(configPath);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new ConfigInvalidError(configPath, `YAML parse error: ${(err as Error).message}`);
  }

  // Check for inline secrets before Zod validation (strict() on CredentialRef
  // rejects extra fields, but we also want to catch them in top-level arbitrary objects).
  assertNoInlineSecrets(parsed);

  let config: HomelabConfigT;
  try {
    config = HomelabConfig.parse(parsed) as HomelabConfigT;
  } catch (err) {
    if (err instanceof ZodError) {
      const msg = formatZodError(err, configPath);
      throw new ConfigInvalidError(configPath, msg);
    }
    throw new ConfigInvalidError(configPath, String(err));
  }

  return config;
}

/**
 * Deep-walk a parsed value and reject any string leaf whose key is in
 * DISALLOWED_LEAF_KEYS. Runs to catch inline secrets before the Zod parse.
 *
 * @throws ConfigInvalidError with `code: 'CONFIG_INVALID'` describing the
 *   disallowed key and its path.
 */
export function assertNoInlineSecrets(
  cfg: unknown,
  _keyPath: string[] = [],
): void {
  walkForSecrets(cfg, _keyPath);
}

function walkForSecrets(value: unknown, keyPath: string[]): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walkForSecrets(value[i], [...keyPath, String(i)]);
    }
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    const fullPath = [...keyPath, k];
    if (DISALLOWED_LEAF_KEYS.has(k) && typeof v === 'string') {
      throw new ConfigInvalidError(
        fullPath.join('.'),
        `inline secret detected at key '${k}' (path: ${fullPath.join('.')}); use a vault_ref instead`,
        { disallowedKey: k, path: fullPath.join('.') },
      );
    }
    walkForSecrets(v, fullPath);
  }
}

/**
 * Resolve the config file path.
 * Precedence: explicit path > env var > default.
 */
function resolveConfigPath(
  explicitPath: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  if (explicitPath !== undefined) return explicitPath;
  const fromEnv = env[CONFIG_ENV_KEY];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return `${os.homedir()}/.autonomous-dev-homelab/homelab.config.yaml`;
}

/**
 * Format a ZodError into a human-readable string.
 * Redacts values from sensitive paths.
 */
function formatZodError(err: ZodError, _configPath: string): string {
  const SENSITIVE_SUFFIXES = ['.vault_field', '.role_id_env', '.secret_id_env'];

  return err.issues
    .map((issue) => {
      const pathStr = 'config.' + issue.path
        .map((p) => (typeof p === 'number' ? `[${p}]` : p))
        .join('.')
        .replace(/\.\[/g, '[');

      let received = '';
      if ('received' in issue && issue.received !== undefined) {
        const raw = String(issue.received);
        const isSensitive = SENSITIVE_SUFFIXES.some((s) => pathStr.endsWith(s));
        received = isSensitive
          ? ', received <redacted>'
          : `, received ${raw.length > 40 ? raw.slice(0, 40) + '…' : raw}`;
      }

      return `${pathStr}: ${issue.message}${received}`;
    })
    .join('\n');
}
