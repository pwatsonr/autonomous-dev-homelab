/**
 * `BackupOverdueProbe`: reads `<homelab-data>/backup-manifest.json` and
 * emits `backup_overdue` observations for any backup whose age exceeds
 * its declared `max_age_hours`. Implements SPEC-002-1-03.
 *
 * The data-directory path is injected via constructor — do NOT
 * hard-code; bootstrap resolves it from `userConfig`.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Observation } from '../types.js';
import { BaseProbe } from './base.js';

const MANIFEST_FILE = 'backup-manifest.json';
const MS_PER_HOUR = 3_600_000;

export interface BackupManifestEntry {
  id: string;
  last_run: string;
  max_age_hours: number;
}

interface BackupManifestFile {
  backups?: BackupManifestEntry[];
}

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
    let manifest: BackupManifestFile;
    try {
      manifest = JSON.parse(raw) as BackupManifestFile;
    } catch (err) {
      return [
        this.unreachable(err, 'backup-overdue', `backup-manifest/${this.dataDir}`),
      ];
    }
    const backups = Array.isArray(manifest.backups) ? manifest.backups : [];
    const now = this.now();
    const out: Observation[] = [];
    for (const b of backups) {
      const lastRun = Date.parse(b.last_run);
      if (Number.isNaN(lastRun)) continue;
      const ageHours = (now - lastRun) / MS_PER_HOUR;
      if (ageHours > b.max_age_hours) {
        out.push(
          this.makeObservation({
            platform: this.platformId,
            pattern: 'backup_overdue',
            resource: `backup/${b.id}`,
            severity: 'P1',
            details: {
              last_run: b.last_run,
              max_age_hours: b.max_age_hours,
              age_hours: Number(ageHours.toFixed(2)),
            },
          }),
        );
      }
    }
    return out;
  }
}
