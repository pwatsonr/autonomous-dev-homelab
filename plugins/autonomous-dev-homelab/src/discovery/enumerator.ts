/**
 * PlatformEnumerator: interface + registry for deep post-fingerprint
 * enumeration of platform children into the inventory graph.
 *
 * Implements issue #27 (deep enumeration) in compliance with the
 * dynamic-first invariant (issue #62):
 *
 *  - `platformKind` is an open string matched against `Platform.type`;
 *    the registry dispatches by kind without coupling to any hard-coded list
 *    of homelab services or nodes.
 *  - New platforms plug in by calling `registerEnumerator` — no changes to
 *    core logic required.
 *  - `enumerate` receives a live `Connection` (from the pool) and the
 *    Platform record; it returns raw entity+edge arrays that the caller
 *    (DeepEnumerator) feeds into GraphStore.upsertEntity / upsertEdge.
 */

import type { Connection } from '../connection/base.js';
import type { Platform } from './inventory-types.js';
import type { Entity, Edge } from './graph-types.js';

// ---------------------------------------------------------------------------
// Enumeration context
// ---------------------------------------------------------------------------

/**
 * Context handed to each enumerator for a single enumeration pass.
 *
 * `connection` is a live, already-connected `Connection` obtained from the
 * pool. Enumerators must NOT call `connection.connect()` or
 * `connection.disconnect()` — that lifecycle is managed by the caller.
 */
export interface EnumerationContext {
  /** Live connection to the platform. Ready for `exec()` calls. */
  connection: Connection;
  /** The platform record being enumerated. */
  platform: Platform;
  /** ISO-8601 timestamp to stamp on discovered_at / last_seen (injected by caller). */
  now: string;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Raw entities and edges produced by a single enumeration pass.
 * The caller upserts all of them into the GraphStore.
 */
export interface EnumerationResult {
  entities: Entity[];
  edges: Edge[];
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * A PlatformEnumerator knows how to query one platform kind's live API
 * and map the response to generic graph entities + edges.
 *
 * Design contract (invariant #62):
 * - Classification uses observable signals only (image, labels, ports).
 * - No instance-specific homelab node/service names may appear in
 *   production code. Fixtures (tests) may use arbitrary names.
 * - `enumerate` must not throw on partial data — return what is available
 *   and log warnings; the caller handles graceful degradation.
 */
export interface PlatformEnumerator {
  /**
   * Open-string platform kind this enumerator handles.
   * Matches `Platform.type` values from the inventory
   * (e.g. 'docker-swarm', 'portainer', 'kubernetes', 'proxmox-ve', 'unraid').
   */
  readonly platformKind: string;

  /**
   * Enumerate all child entities and their relationships for the given
   * platform, using the pre-connected `ctx.connection`.
   *
   * @param ctx - Enumeration context with live connection and platform record.
   * @returns Entities and edges to upsert into the graph.
   */
  enumerate(ctx: EnumerationContext): Promise<EnumerationResult>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Global enumerator registry. Maps platform kind -> PlatformEnumerator.
 *
 * Call `registerEnumerator(e)` to register a new enumerator. Multiple
 * registrations for the same kind replace the previous entry (last-write
 * wins), enabling test overrides.
 */
const REGISTRY = new Map<string, PlatformEnumerator>();

/**
 * Register a PlatformEnumerator for its `platformKind`.
 * Safe to call multiple times; later calls override earlier ones for the
 * same kind.
 *
 * @param enumerator - The enumerator to register.
 */
export function registerEnumerator(enumerator: PlatformEnumerator): void {
  REGISTRY.set(enumerator.platformKind, enumerator);
}

/**
 * Look up the registered enumerator for a platform kind.
 *
 * @param platformKind - Open-string platform kind (matches Platform.type).
 * @returns The registered enumerator, or `undefined` if none is registered.
 */
export function getEnumerator(platformKind: string): PlatformEnumerator | undefined {
  return REGISTRY.get(platformKind);
}

/**
 * Returns all currently-registered platform kinds.
 * Useful for diagnostics and CLI output.
 */
export function registeredKinds(): string[] {
  return Array.from(REGISTRY.keys());
}
