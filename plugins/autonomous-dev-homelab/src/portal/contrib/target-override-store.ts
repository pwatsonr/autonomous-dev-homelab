/**
 * Target override store — persists the portal's `--target` selection per
 * deploy request.
 *
 * When an operator selects a deploy target in the portal UI (#673), the
 * selection is written here. The core target resolver reads this store to
 * honor the `--target` override, exactly as if `--target <id>` had been
 * passed on the command line.
 *
 * Persistence: one JSON file per request id under
 * `<dataDir>/portal/target-overrides/<requestId>.json`.
 * Atomic write (tmp → rename) to avoid partial reads.
 *
 * Implements Issue #673.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface TargetOverrideStoreOptions {
  /** Directory that owns portal state. Defaults to ~/.autonomous-dev-homelab */
  dataDir: string;
}

interface OverrideRecord {
  targetId: string;
  setAt: string;
}

/**
 * Reads and writes per-request deploy-target overrides.
 *
 * The store is the single source of truth for the `--target` override on the
 * portal code path. A fresh instance can be created per-request; all instances
 * sharing the same `dataDir` see the same state.
 */
export class TargetOverrideStore {
  private readonly overridesDir: string;

  constructor(opts: TargetOverrideStoreOptions) {
    this.overridesDir = path.join(opts.dataDir, "portal", "target-overrides");
  }

  /**
   * Retrieve the target override for a deploy request. Returns `undefined`
   * when no override is set.
   *
   * @param requestId - The deploy request identifier.
   */
  async get(requestId: string): Promise<string | undefined> {
    const filePath = this.filePath(requestId);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const record = JSON.parse(raw) as OverrideRecord;
      return record.targetId;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  /**
   * Set (or replace) the target override for a deploy request. Uses an
   * atomic tmp-then-rename write so concurrent readers never see a partial
   * file.
   *
   * @param requestId - The deploy request identifier.
   * @param targetId - The selected deploy target id (the `--target` value).
   */
  async set(requestId: string, targetId: string): Promise<void> {
    await fs.mkdir(this.overridesDir, { recursive: true });
    const filePath = this.filePath(requestId);
    const tmpPath = `${filePath}.tmp`;
    const record: OverrideRecord = {
      targetId,
      setAt: new Date().toISOString(),
    };
    await fs.writeFile(tmpPath, JSON.stringify(record), {
      mode: 0o600,
      encoding: "utf8",
    });
    await fs.rename(tmpPath, filePath);
  }

  /**
   * Remove the target override for a deploy request. Idempotent (no-op when
   * the file does not exist).
   *
   * @param requestId - The deploy request identifier.
   */
  async clear(requestId: string): Promise<void> {
    try {
      await fs.unlink(this.filePath(requestId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /** Resolve the per-request override file path. */
  private filePath(requestId: string): string {
    // Sanitise the request id so it is safe as a file name component.
    const safe = requestId.replace(/[^a-zA-Z0-9_\-]/g, "_");
    return path.join(this.overridesDir, `${safe}.json`);
  }
}
