/**
 * Homelab portal panel routes per SPEC-002-3-03.
 *
 * Exposes a transport-neutral handler API that adapts to autonomous-dev's
 * portal router (PLAN-013-3) without owning the HTTP server. Tests
 * exercise the routes directly by calling `routePortalRequest`.
 *
 * READ-ONLY: every route is a GET. The spec acceptance criterion forbids
 * `<form>` / `POST` from the client; the static template guarantees this
 * (verified by tests scanning the file).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  HomelabDataLoader,
  type DataLoaderOptions,
  type ObservationRecord,
} from './data-loader.js';

export type PortalSseEvent =
  | 'observation.new'
  | 'observation.resolved'
  | 'action.status-changed'
  | 'migration.phase-changed';

export interface PortalRouteResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface PortalSseSink {
  send(event: PortalSseEvent, data: Record<string, unknown>): void;
}

export interface PortalRequest {
  /** Path WITHOUT query string. */
  pathname: string;
  /** Parsed query params. */
  query: Record<string, string | undefined>;
}

export interface PortalPanelOptions extends DataLoaderOptions {
  /**
   * Path to the rendered HTML shell. Default: bundled
   * `templates/homelab.html`.
   */
  templatePath?: string;
}

const DEFAULT_TEMPLATE_PATH = path.resolve(__dirname, '../../templates/homelab.html');

export class HomelabPortalPanel {
  private readonly loader: HomelabDataLoader;
  private readonly templatePath: string;
  private readonly subscribers = new Set<(event: PortalSseEvent, data: Record<string, unknown>) => void>();

  constructor(opts: PortalPanelOptions = {}) {
    this.loader = new HomelabDataLoader(opts);
    this.templatePath = opts.templatePath ?? DEFAULT_TEMPLATE_PATH;
  }

  /**
   * Notify SSE subscribers of an event. Production wiring calls this from
   * the file-watcher / state-change emitters in PLAN-002-1/2.
   */
  notify(event: PortalSseEvent, data: Record<string, unknown>): void {
    for (const sub of this.subscribers) sub(event, data);
  }

  /** Subscribe to SSE events. Returns an unsubscribe function. */
  subscribe(fn: (event: PortalSseEvent, data: Record<string, unknown>) => void): () => void {
    this.subscribers.add(fn);
    return (): void => {
      this.subscribers.delete(fn);
    };
  }

  async route(req: PortalRequest): Promise<PortalRouteResult> {
    const p = req.pathname;
    if (p === '/portal/homelab' || p === '/portal/homelab/') {
      return this.serveTemplate();
    }
    if (p === '/portal/homelab/api/inventory') {
      return this.json(await this.loader.loadInventory());
    }
    if (p === '/portal/homelab/api/observations') {
      const filter: { sinceMs?: number; platform?: string; severity?: string } = {};
      if (req.query['since'] !== undefined) {
        const ts = Date.parse(req.query['since'] as string);
        if (!Number.isNaN(ts)) filter.sinceMs = ts;
      }
      if (req.query['platform'] !== undefined) filter.platform = req.query['platform'] as string;
      if (req.query['severity'] !== undefined) filter.severity = req.query['severity'] as string;
      return this.json(await this.loader.loadObservations(filter));
    }
    if (p === '/portal/homelab/api/pending-actions') {
      return this.json(await this.loader.loadPendingActions());
    }
    if (p === '/portal/homelab/api/migrations') {
      return this.json(await this.loader.loadMigrations());
    }
    if (p === '/portal/homelab/api/audit') {
      const filter: { sinceMs?: number } = {};
      if (req.query['since'] !== undefined) {
        const ts = Date.parse(req.query['since'] as string);
        if (!Number.isNaN(ts)) filter.sinceMs = ts;
      }
      return this.json(await this.loader.loadAudit(filter));
    }
    return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' };
  }

  // -- internals --------------------------------------------------------

  private async serveTemplate(): Promise<PortalRouteResult> {
    let html: string;
    try {
      html = await fs.readFile(this.templatePath, 'utf8');
    } catch {
      html = '<!doctype html><body><h1>Homelab</h1><p>template missing</p></body>';
    }
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: html,
    };
  }

  private json(value: unknown): PortalRouteResult {
    return {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(value),
    };
  }
}

/** Helper used by tests to format an SSE frame. */
export function formatSseFrame(event: PortalSseEvent, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Re-export the observation type so route consumers don't import from the loader. */
export type { ObservationRecord };
