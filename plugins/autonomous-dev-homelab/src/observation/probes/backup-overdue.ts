/**
 * `BackupOverdueProbe`: reads `<homelab-data>/backup-manifest.json` and
 * emits `backup_overdue` observations for any backup whose age exceeds
 * its declared `max_age_seconds`. Implements SPEC-002-1-03 + issue #46.
 *
 * Now reads the v2 canonical schema (issue #46). Legacy v1 files — both
 * the verifier shape (`{entries: [...]}`) and the original overdue-probe
 * shape (`{backups: [...]}`) — are transparently upgraded via
 * `convertLegacyManifest` so both probe and gate always read the same file.
 *
 * The data-directory path is injected via constructor — do NOT
 * hard-code; bootstrap resolves it from `userConfig`.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Observation } from '../types.js';
import { BaseProbe } from './base.js';
import { convertLegacyManifest } from '../../backup/types.js';
import type { BackupManifestEntry } from '../../backup/types.js';

const MANIFEST_FILE = 'backup-manifest.json';
const MS_PER_SECOND = 1_000;

export interface BackupOverdueProbeOptions {
  platformId: string;
  dataDir: string;
  /** Test seam; defaults to `() => Date.now()`. */
  now?: () => number;
}

export class BackupOverdueProbe extends BaseProbe {
  readonly id = 'backup-overdue';
  readonly cadence = 'slow' as const;
  readonly platformId: string;

  private readonly dataDir: string;
  private readonly now: () => number;

  constructor(opts: BackupOverdueProbeOptions) {
    super();
    this.platformId = opts.platformId;
    this.dataDir = opts.dataDir;
    this.now = opts.now ?? ((): number => Date.now());
  }

  async scan(): Promise<Observation[]> {
    const manifestPath = path.join(this.dataDir, MANIFEST_FILE);
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, 'utf8');
    } catch (err) {
      return [
        this.unreachable(err, 'backup-overdue', `backup-manifest/${this.dataDir}`),
      ];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (err) {
      return [
        this.unreachable(err, 'backup-overdue', `backup-manifest/${this.dataDir}`),
      ];
    }
    // Upgrade any legacy shape to v2.
    const manifest = convertLegacyManifest(parsed);
    const entries: BackupManifestEntry[] = manifest.entries;

    const now = this.now();
    const out: Observation[] = [];
    for (const e of entries) {
      const takenAt = Date.parse(e.taken_at);
      if (Number.isNaN(takenAt)) continue;
      const ageSeconds = (now - takenAt) / MS_PER_SECOND;
      const maxAgeSeconds = e.max_age_seconds ?? 86_400;
      if (ageSeconds > maxAgeSeconds) {
        const ageHours = Number((ageSeconds / 3600).toFixed(2));
        const maxAgeHours = Number((maxAgeSeconds / 3600).toFixed(2));
        out.push(
          this.makeObservation({
            platform: this.platformId,
            pattern: 'backup_overdue',
            resource: `backup/${e.target_id}`,
            severity: 'P1',
            details: {
              last_run: e.taken_at,
              max_age_hours: maxAgeHours,
              age_hours: ageHours,
            },
          }),
        );
      }
    }
    return out;
  }
}
