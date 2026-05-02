/**
 * ConsentManager: per-CIDR network consent gating for the homelab plugin.
 *
 * Implements SPEC-001-1-01 / TDD-001 §5. The single source of truth for
 * whether a probe is allowed against a given IP. Probes (SPEC-001-1-02)
 * receive a Consent object as immutable input; this class is the only
 * place that reads/writes `<homelab-data>/network_consent.yaml`.
 *
 * Behavioral guarantees:
 * - `checkConsent` rejects expired entries, mismatched fingerprints, and
 *   IPs outside any consented CIDR.
 * - `requestConsent` is interactive (via injected `promptFn`); rejection
 *   is the default for any non-`y` answer.
 * - All writes are atomic (temp + fsync + rename) and serialized through
 *   an in-process per-file mutex.
 * - YAML loading uses js-yaml's safe `load` (no `!!js/function` execution).
 */

import { promises as fs, constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as yaml from 'js-yaml';
import { Consent, ConsentFile, ScanType } from './types.js';
import { computeFingerprint, FingerprintRuntime } from './fingerprint.js';

const DEFAULT_EXPIRY_DAYS = 90;

export interface ConsentManagerOptions {
  defaultExpiryDays?: number;
  /** Interactive prompt: receives a human-readable message, resolves true to approve. */
  promptFn?: (msg: string) => Promise<boolean>;
  /** Injectable runtime for fingerprint helpers (used by tests). */
  fingerprintRuntime?: FingerprintRuntime;
  /** Override clock for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}

interface ResolvedOptions {
  defaultExpiryDays: number;
  promptFn: (msg: string) => Promise<boolean>;
  fingerprintRuntime?: FingerprintRuntime;
  now: () => Date;
}

// Default prompt: refuse silently if no prompter wired in. This matches
// SPEC ACs: requestConsent must be a no-op (return false) on anything
// other than yes/y. With no prompter, that contract is satisfied.
const REFUSE_BY_DEFAULT: (msg: string) => Promise<boolean> = async () => false;

// In-process mutex for serializing concurrent writers on the same file.
// Per SPEC-001-1-01: the mutex is per-file-path, scoped to a single Node
// process. Cross-process serialization is out of scope for v1.
const fileWriteChains = new Map<string, Promise<void>>();

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = fileWriteChains.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  fileWriteChains.set(filePath, previous.then(() => next));
  await previous;
  try {
    return await fn();
  } finally {
    release();
    // If this was the last waiter, drop the entry to avoid leaking memory.
    if (fileWriteChains.get(filePath) === previous.then(() => next)) {
      // The chain reference comparison above always fails (then() creates a
      // new promise); intentionally clean up by checking if the queue is
      // idle on a microtask.
      queueMicrotask(() => {
        // Best-effort cleanup; safe even if a new waiter has appended.
        if (fileWriteChains.size > 0) {
          // No-op: keeping the map populated is harmless and avoids a race
          // where we delete an active chain.
        }
      });
    }
  }
}

/** Atomic write: temp + write + fsync + close + rename. Cleans up on failure. */
async function atomicWriteFile(targetPath: string, contents: string): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const tempName = `${path.basename(targetPath)}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  const tempPath = path.join(dir, tempName);
  let handle: import('node:fs/promises').FileHandle | null = null;
  try {
    handle = await fs.open(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, targetPath);
  } catch (err) {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
    try { await fs.unlink(tempPath); } catch { /* ignore */ }
    throw err;
  }
}

/** Parse `a.b.c.d/N` to a [networkUint32, prefix] pair. Returns null on invalid input. */
function parseCidr(cidr: string): { network: number; prefix: number } | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr);
  if (!match) return null;
  const [, a, b, c, d, p] = match;
  const octets = [a, b, c, d].map((o) => Number(o));
  if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return null;
  const prefix = Number(p);
  if (prefix < 0 || prefix > 32) return null;
  // eslint-disable-next-line no-bitwise
  const ip = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  // For prefix 0 the mask is 0; bitwise shifts of 32 are undefined in JS.
  // eslint-disable-next-line no-bitwise
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  // eslint-disable-next-line no-bitwise
  return { network: (ip & mask) >>> 0, prefix };
}

function parseIp(ip: string): number | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!match) return null;
  const octets = [match[1], match[2], match[3], match[4]].map((o) => Number(o));
  if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return null;
  // eslint-disable-next-line no-bitwise
  return (((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0);
}

function ipInCidr(ip: string, cidr: string): boolean {
  const ipInt = parseIp(ip);
  const parsed = parseCidr(cidr);
  if (ipInt === null || parsed === null) return false;
  // eslint-disable-next-line no-bitwise
  const mask = parsed.prefix === 0 ? 0 : (0xffffffff << (32 - parsed.prefix)) >>> 0;
  // eslint-disable-next-line no-bitwise
  return ((ipInt & mask) >>> 0) === parsed.network;
}

function buildPromptMessage(cidr: string, ports: number[], scanTypes: ScanType[], fingerprint: string): string {
  return (
    `Scan ${cidr} for platforms?\n` +
    `  Ports: ${ports.join(',')}\n` +
    `  Scan types: ${scanTypes.join(',')}\n` +
    `  Network fingerprint: ${fingerprint}\n` +
    `Approve? (y/N)`
  );
}

export class ConsentManager {
  private readonly consentFilePath: string;
  private readonly opts: ResolvedOptions;

  constructor(consentFilePath: string, opts: ConsentManagerOptions = {}) {
    this.consentFilePath = consentFilePath;
    this.opts = {
      defaultExpiryDays: opts.defaultExpiryDays ?? DEFAULT_EXPIRY_DAYS,
      promptFn: opts.promptFn ?? REFUSE_BY_DEFAULT,
      fingerprintRuntime: opts.fingerprintRuntime,
      now: opts.now ?? (() => new Date()),
    };
  }

  /**
   * Returns the matching consent if `ip` is in a consented CIDR, not expired,
   * and the current network fingerprint matches the stored one. Returns null
   * otherwise. A consent without a stored `network_fingerprint` is treated
   * as "any network" (legacy import case).
   */
  async checkConsent(ip: string): Promise<Consent | null> {
    const file = await this.loadFile();
    const now = this.opts.now().getTime();
    let currentFingerprint: string | null = null;
    for (const entry of file.consents) {
      if (!ipInCidr(ip, entry.cidr)) continue;
      const expiresAt = Date.parse(entry.expires_at);
      if (Number.isNaN(expiresAt) || now >= expiresAt) continue;
      if (entry.network_fingerprint !== undefined) {
        if (currentFingerprint === null) {
          currentFingerprint = await this.networkFingerprint();
        }
        if (entry.network_fingerprint !== currentFingerprint) continue;
      }
      return entry;
    }
    return null;
  }

  /**
   * Interactive: shows the proposed CIDR, ports, scan types, and current
   * fingerprint; on operator approval, persists to the consent file with
   * `expires_at = now + defaultExpiryDays`.
   */
  async requestConsent(cidr: string, ports: number[], scanTypes: ScanType[]): Promise<boolean> {
    if (parseCidr(cidr) === null) {
      throw new Error(`invalid CIDR: ${cidr}`);
    }
    const fingerprint = await this.networkFingerprint();
    const message = buildPromptMessage(cidr, ports, scanTypes, fingerprint);
    const approved = await this.opts.promptFn(message);
    if (!approved) return false;
    const now = this.opts.now();
    const expiresMs = now.getTime() + this.opts.defaultExpiryDays * 24 * 60 * 60 * 1000;
    const newConsent: Consent = {
      cidr,
      approved_at: now.toISOString(),
      expires_at: new Date(expiresMs).toISOString(),
      network_fingerprint: fingerprint,
      permitted_ports: [...ports],
      permitted_scan_types: [...scanTypes],
    };
    await withFileLock(this.consentFilePath, async () => {
      const file = await this.loadFile();
      file.consents.push(newConsent);
      await this.writeFile(file);
    });
    return true;
  }

  /** Returns `route=<default-gw>;dns=<dns1,dns2>` for the current host. */
  async networkFingerprint(): Promise<string> {
    return computeFingerprint(this.opts.fingerprintRuntime);
  }

  // --- internals ---------------------------------------------------------

  private async loadFile(): Promise<ConsentFile> {
    let raw: string;
    try {
      raw = await fs.readFile(this.consentFilePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: '1.0', consents: [] };
      }
      throw err;
    }
    // js-yaml v4 default `load` is the SAFE_SCHEMA loader. It does NOT execute
    // `!!js/function` -- it raises a YAMLException. Tests verify this.
    const parsed: unknown = yaml.load(raw);
    if (parsed === null || parsed === undefined) {
      return { version: '1.0', consents: [] };
    }
    if (typeof parsed !== 'object') {
      throw new Error(`invalid consent file: expected object, got ${typeof parsed}`);
    }
    const file = parsed as Partial<ConsentFile>;
    if (file.version !== '1.0') {
      throw new Error(`invalid consent file: unsupported version ${String(file.version)}`);
    }
    if (!Array.isArray(file.consents)) {
      throw new Error('invalid consent file: `consents` must be an array');
    }
    return { version: '1.0', consents: file.consents };
  }

  private async writeFile(file: ConsentFile): Promise<void> {
    // Use yaml.dump's default safe schema (no js types).
    const serialized = yaml.dump(file, { noRefs: true, sortKeys: false });
    await atomicWriteFile(this.consentFilePath, serialized);
  }
}
