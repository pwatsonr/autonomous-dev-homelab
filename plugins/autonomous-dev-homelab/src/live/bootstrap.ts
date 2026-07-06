/**
 * Runtime assembly: fail-closed bootstrap for live homelab operations.
 * SPEC: REQ-000055 §2.9.
 *
 * Steps:
 *   1. loadHomelabConfig()         — throws exit 11/12 on invalid/missing.
 *   2. new VaultSecretResolver()
 *   3. resolver.ping()             — throws exit 20/21 on unreachable/auth.
 *   4. Construct MCPDiscovery, ConnectionPool, AuditWriter (with redactor sink).
 *   5. Return Runtime.
 *
 * On any step failure, the underlying HomelabError is propagated.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import type { HomelabConfig } from '../config/types.js';
import type { PlatformType } from '../discovery/inventory-types.js';
import type { SecretResolver } from '../secrets/types.js';
import { loadHomelabConfig } from '../config/loader.js';
import { VaultSecretResolver } from '../secrets/vault-resolver.js';
import { MCPDiscovery } from '../connection/mcp-discovery.js';
import { ConnectionPool } from '../connection/pool.js';
import { createConnection } from '../connection/factory.js';
import { AuditWriter } from '../audit/writer.js';
import { AuditKeyStore } from '../audit/key-store.js';
import { installRedactorSink } from '../secrets/redactor.js';
import type { InventoryEntry } from '../connection/factory.js';
import { InventoryManager } from '../discovery/inventory.js';

export interface Runtime {
  config: HomelabConfig;
  resolver: SecretResolver;
  pool: ConnectionPool;
  mcpDiscovery: MCPDiscovery;
  audit: AuditWriter;
  /** Zero all held credential buffers, close pool, dispose resolver. */
  shutdown(): Promise<void>;
}

export interface AssembleRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  configPath?: string;
}

/**
 * Fail-closed runtime bootstrap.
 * @throws ConfigNotFoundError (exit 12) — config file missing.
 * @throws ConfigInvalidError (exit 11) — config invalid.
 * @throws VaultUnreachableError (exit 20) — Vault unreachable.
 * @throws VaultAuthError (exit 21) — Vault auth failed.
 */
/** Map a config `platform` value to the inventory `PlatformType`. */
function configPlatformToType(platform: string): PlatformType {
  switch (platform) {
    case 'docker-swarm-manager':
    case 'docker-swarm-worker':
      return 'docker-swarm';
    case 'unraid':
      return 'unraid';
    default:
      // Config schema restricts platform to the cases above; fall back to
      // docker-swarm rather than throwing so an unknown value degrades to SSH.
      return 'docker-swarm';
  }
}

export async function assembleRuntime(opts?: AssembleRuntimeOptions): Promise<Runtime> {
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ?? process.cwd();

  // Step 1: Load and validate config
  const config = await loadHomelabConfig({ path: opts?.configPath, env });

  // Step 2: Create Vault resolver
  const resolver = new VaultSecretResolver(config.vault, env);

  // Step 3: Ping Vault — fail fast if unreachable
  await resolver.ping();

  // Step 4: Construct supporting services
  const mcpDiscovery = new MCPDiscovery({ env });

  const dataDir = path.join(os.homedir(), '.autonomous-dev-homelab');
  const inventoryPath = path.join(dataDir, 'inventory.yaml');
  const inventoryManager = new InventoryManager(inventoryPath);

  const preloaded = new Map<string, InventoryEntry>();
  const pool = new ConnectionPool({}, (id: string) => {
    const entry = preloaded.get(id);
    if (entry === undefined) {
      throw new Error(`platform '${id}' not in preloaded map`);
    }
    return createConnection(id, entry);
  });

  // Seed the pool from the operator-declared config hosts. Each host's SSH
  // private key is resolved from Vault and materialized to a 0600 temp file so
  // the SSH transport (which shells out to `ssh -i`) can use it. This is what
  // lets `connect`/`observe` operate on declared hosts without a prior
  // `discover` run. Per-host failures are non-fatal: a host that can't resolve
  // its key is simply left unseeded and will surface as a connect failure.
  const keysDir = path.join(dataDir, '.keys');
  await fs.mkdir(keysDir, { recursive: true, mode: 0o700 });
  const tempKeyPaths: string[] = [];
  const nowIso = new Date().toISOString();
  for (const host of config.hosts) {
    try {
      const resolved = await resolver.resolve(host.ssh_fallback.key_ref);
      const keyPath = path.join(keysDir, `${host.hostname}.key`);
      await fs.writeFile(keyPath, resolved.value, { mode: 0o600 });
      tempKeyPaths.push(keyPath);
      const connection: Record<string, unknown> = {
        ssh_user: host.ssh_fallback.user,
        ssh_key_path: keyPath,
      };
      if (typeof host.mcp_endpoint === 'string' && host.mcp_endpoint.length > 0) {
        connection['mcp_endpoint'] = host.mcp_endpoint;
        connection['prefer'] = 'mcp';
      } else {
        connection['prefer'] = 'ssh';
      }
      preloaded.set(host.hostname, {
        id: host.hostname,
        type: configPlatformToType(host.platform),
        host: host.ssh_fallback.host,
        port: host.ssh_fallback.port,
        ssh_host: host.ssh_fallback.host,
        ssh_port: host.ssh_fallback.port,
        discovered_at: nowIso,
        last_seen: nowIso,
        connection,
      });
    } catch {
      // Leave this host unseeded; connect/observe will report it as failed.
    }
  }

  const auditLogPath = path.join(dataDir, 'audit.log');
  const keyStore = new AuditKeyStore({ keyPath: path.join(dataDir, '.audit-key') });
  const audit = new AuditWriter({ logPath: auditLogPath, keyStore });

  // Step 5: Wire redactor sink on a thin adapter
  // AuditWriter uses .append(), not .write(); we need a wrapper
  // that exposes .write() for the redactor sink.
  const writerAdapter = {
    write: async (event: Record<string, unknown>): Promise<void> => {
      const eventType = typeof event['type'] === 'string' ? event['type'] : 'unknown';
      await audit.append(eventType as Parameters<AuditWriter['append']>[0], event);
    },
  };
  installRedactorSink(writerAdapter);

  // Replace the adapter's write so future calls go through redactor
  // (the audit object itself is the canonical writer; adapter is the sink)

  return {
    config,
    resolver,
    pool,
    mcpDiscovery,
    audit,
    async shutdown(): Promise<void> {
      resolver.dispose();
      await pool.closeAll();
      // Best-effort removal of materialized private-key temp files.
      await Promise.all(
        tempKeyPaths.map((p) => fs.rm(p, { force: true }).catch(() => undefined)),
      );
    },
  };
}
