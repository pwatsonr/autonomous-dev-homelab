/**
 * Zod schema for the homelab configuration file.
 * SPEC: REQ-000055 TASK-004, §2.2.
 *
 * All objects use `.strict()` so unknown keys are rejected at parse time.
 * The `approle` sub-config is required when `auth_method === 'approle'`,
 * enforced via `.superRefine`.
 */

import { z } from 'zod';

export const CredentialRef = z
  .object({
    vault_path: z.string().regex(/^[a-zA-Z0-9/_-]+$/, 'vault_path must match /^[a-zA-Z0-9/_-]+$/'),
    vault_field: z.string().min(1),
  })
  .strict();

export const Host = z
  .object({
    hostname: z.string().min(1),
    platform: z.enum(['docker-swarm-manager', 'docker-swarm-worker', 'unraid']),
    role: z.enum(['manager', 'worker', 'nas']),
    mcp_endpoint: z.string().url().optional(),
    ssh_fallback: z
      .object({
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535).default(22),
        user: z.string().min(1),
        key_ref: CredentialRef,
        known_hosts_ref: CredentialRef.optional(),
      })
      .strict(),
  })
  .strict();

export const HomelabConfig = z
  .object({
    version: z.literal(1),
    vault: z
      .object({
        address: z.string().url(),
        auth_method: z.enum(['approle', 'token', 'oidc', 'kubernetes']),
        approle: z
          .object({
            role_id_env: z.string().min(1),
            secret_id_env: z.string().min(1),
          })
          .optional(),
      })
      .strict()
      .superRefine((vault, ctx) => {
        if (vault.auth_method === 'approle' && vault.approle === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['approle'],
            message: "approle sub-config required when auth_method is 'approle'",
          });
        }
      }),
    hosts: z.array(Host).min(1),
  })
  .strict();
