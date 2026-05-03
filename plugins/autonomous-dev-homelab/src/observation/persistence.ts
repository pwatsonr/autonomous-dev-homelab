/**
 * `ObservationStore`: atomic-write, list, and time-based retention for
 * persisted observations. Implements SPEC-002-1-04.
 *
 * Files live at `<dataDir>/observations/<id>.json`. Writes use the
 * shared atomic-write helper (temp file + fsync + rename) so torn
 * writes never produce partial JSON. Reads validate the on-disk shape
 * loosely (JSON.parse only); schema validation is consumer-side.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFile } from '../util/atomic-write.js';
import type { Observation } from './types.js';

const OBS_SUBDIR = 'observations';
export const RETENTION_DAYS = 90;
const MS_PER_DAY = 86_400_000;

export interface ObservationListFilter {
  since?: Date;
  platform?: string;
  severity?: string;
}

export class ObservationStore {
  private readonly observationsDir: string;

  constructor(private readonly dataDir: string) {
    this.observationsDir = path.join(dataDir, OBS_SUBDIR);
  }

  /** Returns the directory under which observations are persisted. */
  getDir(): string {
    return this.observationsDir;
  }

  /** Atomically persist an observation. Returns the absolute file path. */
  async save(obs: Observation): Promise<string> {
    await fs.mkdir(this.observationsDir, { recursive: true });
    const finalPath = path.join(this.observationsDir, `${obs.id}.json`);
    await atomicWriteFile(finalPath, JSON.stringify(obs, null, 2));
    return finalPath;
  }

  async load(id: string): Promise<Observation> {
    const raw = await fs.readFile(path.join(this.observationsDir, `${id}.json`), 'utf8');
    return JSON.parse(raw) as Observation;
  }

  async list(filter: ObservationListFilter = {}): Promise<Observation[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.observationsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: Observation[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      if (f.includes('.tmp.')) continue;
      let obs: Observation;
      try {
        const raw = await fs.readFile(path.join(this.observationsDir, f), 'utf8');
        obs = JSON.parse(raw) as Observation;
      } catch {
        continue; // Skip unreadable / malformed files; do not abort the listing.
      }
      if (filter.since !== undefined && new Date(obs.discovered_at) < filter.since) continue;
      if (filter.platform !== undefined && obs.platform !== filter.platform) continue;
      if (filter.severity !== undefined && obs.severity !== filter.severity) continue;
      out.push(obs);
    }
    out.sort((a, b) => b.discovered_at.localeCompare(a.discovered_at));
    return out;
  }

  /**
   * Remove observation files whose mtime is older than `RETENTION_DAYS`
   * relative to `now`. Returns the count of files removed.
   */
  async cleanup(now: Date = new Date()): Promise<number> {
    let files: string[];
    try {
      files = await fs.readdir(this.observationsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
    const cutoff = now.getTime() - RETENTION_DAYS * MS_PER_DAY;
    let removed = 0;
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(this.observationsDir, f);
      let stat: import('node:fs').Stats;
      try {
        stat = await fs.stat(p);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoff) {
        try {
          await fs.unlink(p);
          removed++;
        } catch {
          // ignore
        }
      }
    }
    return removed;
  }
}
