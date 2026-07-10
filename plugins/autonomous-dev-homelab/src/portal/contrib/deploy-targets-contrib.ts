/**
 * Portal contribution for deploy-target selection (Issue #673).
 *
 * Handles:
 *   GET  /portal/deploy-targets              — HTML page listing all targets
 *   GET  /portal/deploy-targets/api/targets  — JSON list of all targets
 *   POST /portal/deploy-targets/api/select-target — set request-level --target override
 *
 * Model-driven (invariant #674): enumerates from the shared DeployTargetRegistry,
 * never from a static list. A newly registered target appears with zero code
 * changes.
 *
 * Implements Issue #673.
 */

import type {
  PortalContrib,
  PortalContribRequest,
  PortalContribResponse,
} from "./types.js";
import type {
  DeployTargetRegistry,
  DeployTarget,
} from "./deploy-target-registry.js";
import type { TargetOverrideStore } from "./target-override-store.js";

export interface DeployTargetPortalContribOptions {
  /** The shared deploy-target registry. Enumerated on every request. */
  registry: DeployTargetRegistry;
  /** Store for persisting request-level --target overrides. */
  store: TargetOverrideStore;
}

/**
 * Portal contribution that provides the deploy-target selection UI and API.
 */
export class DeployTargetPortalContrib implements PortalContrib {
  private readonly registry: DeployTargetRegistry;
  private readonly store: TargetOverrideStore;

  constructor(opts: DeployTargetPortalContribOptions) {
    this.registry = opts.registry;
    this.store = opts.store;
  }

  async route(req: PortalContribRequest): Promise<PortalContribResponse> {
    const { method, pathname } = req;

    if (
      method === "GET" &&
      (pathname === "/portal/deploy-targets" ||
        pathname === "/portal/deploy-targets/")
    ) {
      return this.renderPage();
    }

    if (method === "GET" && pathname === "/portal/deploy-targets/api/targets") {
      return this.apiListTargets();
    }

    if (
      method === "POST" &&
      pathname === "/portal/deploy-targets/api/select-target"
    ) {
      return this.apiSelectTarget(req.body);
    }

    return {
      status: 404,
      headers: { "content-type": "text/plain" },
      body: "not found",
    };
  }

  // ---------------------------------------------------------------------------
  // GET /portal/deploy-targets — HTML page
  // ---------------------------------------------------------------------------

  private renderPage(): PortalContribResponse {
    const targets = this.registry.list();

    const targetRows = targets.map((t) => this.renderTargetRow(t)).join("\n");
    const isEmpty = targets.length === 0;

    const emptySection = isEmpty
      ? `<div id="no-targets" class="empty-state">No deploy targets registered. Register targets via the plugin activation API.</div>`
      : "";

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Deploy Targets — Homelab Portal</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ccc; padding: 0.5rem 1rem; text-align: left; }
    th { background: #f0f0f0; }
    .badge-available { color: green; }
    .badge-unavailable { color: red; }
    .badge-trusted { color: green; }
    .badge-untrusted { color: orange; }
    .reason { font-size: 0.85em; color: #666; }
    .empty-state { padding: 2rem; color: #888; font-style: italic; }
    button[disabled] { opacity: 0.5; cursor: not-allowed; }
  </style>
</head>
<body>
  <h1>Deploy Targets</h1>
  <section id="deploy-targets">
${emptySection}
${
  !isEmpty
    ? `<table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Location</th>
          <th>Node</th>
          <th>Backend</th>
          <th>Availability</th>
          <th>Trust</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${targetRows}
      </tbody>
    </table>`
    : ""
}
  </section>
  <script>
    function selectTarget(requestId, targetId) {
      fetch('/portal/deploy-targets/api/select-target', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, targetId })
      })
      .then(r => r.json())
      .then(data => { alert(data.ok ? 'Target selected: ' + targetId : 'Error: ' + data.reason); })
      .catch(e => alert('Request failed: ' + e.message));
    }
  </script>
</body>
</html>`;

    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: html,
    };
  }

  private renderTargetRow(t: DeployTarget): string {
    const isSelectable =
      t.availability === "available" && t.trust === "trusted";
    const availClass =
      t.availability === "available" ? "badge-available" : "badge-unavailable";
    const trustClass =
      t.trust === "trusted" ? "badge-trusted" : "badge-untrusted";

    const unavailReason =
      t.unavailableReason !== undefined
        ? `<br><span class="reason">${escapeHtml(t.unavailableReason)}</span>`
        : "";
    const trustReason =
      t.trustReason !== undefined
        ? `<br><span class="reason">${escapeHtml(t.trustReason)}</span>`
        : "";

    // Selectable button uses data-target-id + data-selectable="true" so tests
    // can assert the presence / absence of selectable markers.
    const actionCell = isSelectable
      ? `<button onclick="selectTarget(prompt('Enter request ID'), '${escapeHtml(t.id)}')" data-target-id="${escapeHtml(t.id)}" data-selectable="true">Select</button>`
      : `<button disabled title="Target is ${t.availability === "unavailable" ? "unavailable" : "untrusted"}">Select</button>`;

    return `<tr>
          <td>${escapeHtml(t.id)}</td>
          <td>${escapeHtml(t.location)}</td>
          <td>${escapeHtml(t.node)}</td>
          <td>${escapeHtml(t.backend)}</td>
          <td class="${availClass}">${t.availability}${unavailReason}</td>
          <td class="${trustClass}">${t.trust}${trustReason}</td>
          <td>${actionCell}</td>
        </tr>`;
  }

  // ---------------------------------------------------------------------------
  // GET /portal/deploy-targets/api/targets — JSON list
  // ---------------------------------------------------------------------------

  private apiListTargets(): PortalContribResponse {
    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(this.registry.list()),
    };
  }

  // ---------------------------------------------------------------------------
  // POST /portal/deploy-targets/api/select-target — set override
  // ---------------------------------------------------------------------------

  private async apiSelectTarget(
    body: Record<string, unknown> | null,
  ): Promise<PortalContribResponse> {
    if (body === null) {
      return this.jsonError(400, "request body is required");
    }

    const requestId = body["requestId"];
    const targetId = body["targetId"];

    if (typeof requestId !== "string" || requestId === "") {
      return this.jsonError(
        400,
        "requestId is required and must be a non-empty string",
      );
    }
    if (typeof targetId !== "string" || targetId === "") {
      return this.jsonError(
        400,
        "targetId is required and must be a non-empty string",
      );
    }

    const target = this.registry.get(targetId);
    if (target === undefined) {
      return {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          ok: false,
          reason: `target '${targetId}' not found`,
        }),
      };
    }

    if (target.availability !== "available") {
      return this.jsonError(
        422,
        `target '${targetId}' is unavailable: ${target.unavailableReason ?? "no reason given"}`,
      );
    }

    if (target.trust !== "trusted") {
      return this.jsonError(
        422,
        `target '${targetId}' is untrusted: ${target.trustReason ?? "no reason given"}`,
      );
    }

    await this.store.set(requestId, targetId);

    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: true, targetId, requestId }),
    };
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  private jsonError(status: number, reason: string): PortalContribResponse {
    return {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, reason }),
    };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
