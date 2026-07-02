/**
 * TypeScript types for the homelab configuration.
 * SPEC: REQ-000055 TASK-004, §2.1.
 *
 * All types are inferred from the Zod schemas so runtime and static
 * views cannot drift.
 */

import type { z } from 'zod';
import type {
  CredentialRef as CredentialRefSchema,
  Host as HostSchema,
  HomelabConfig as HomelabConfigSchema,
} from './schema.js';

export type PlatformType = 'docker-swarm-manager' | 'docker-swarm-worker' | 'unraid';
export type Role = 'manager' | 'worker' | 'nas';
export type VaultAuthMethod = 'approle' | 'token' | 'oidc' | 'kubernetes';

export type CredentialRef = z.infer<typeof CredentialRefSchema>;
export type Host = z.infer<typeof HostSchema>;
export type HomelabConfig = z.infer<typeof HomelabConfigSchema>;

export interface SSHFallback {
  host: string;
  port: number;
  user: string;
  key_ref: CredentialRef;
  known_hosts_ref?: CredentialRef;
}

export interface VaultConfig {
  address: string;
  auth_method: VaultAuthMethod;
  approle?: { role_id_env: string; secret_id_env: string };
}
