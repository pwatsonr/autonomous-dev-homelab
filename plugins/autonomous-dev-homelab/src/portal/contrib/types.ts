/**
 * Portal contribution contract types.
 *
 * A `PortalContrib` is a self-contained contribution to the homelab portal.
 * Each contribution can handle HTTP-like requests routed to it by the portal
 * dispatch layer. The interface is transport-neutral (no Hono / Express imports)
 * so contributions can be unit-tested without spinning up an HTTP server.
 *
 * Implements Issue #673 (deploy-target selection UI) and Issue #681 (gated
 * action execution) as the first two concrete contributions.
 */

export interface PortalContribRequest {
  /** HTTP method (uppercase). */
  method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
  /** Request pathname (no query string). */
  pathname: string;
  /** Parsed query parameters. */
  query: Record<string, string | undefined>;
  /** Parsed request body (JSON-decoded). Null for GET/DELETE. */
  body: Record<string, unknown> | null;
}

export interface PortalContribResponse {
  /** HTTP status code. */
  status: number;
  /** Response headers. */
  headers: Record<string, string>;
  /** Response body as a string (HTML or JSON). */
  body: string;
}

/**
 * A portal contribution can route requests to its own sub-paths.
 */
export interface PortalContrib {
  /**
   * Handle a portal request. Returns a response or null if this contribution
   * does not own the given path (enables chained dispatch).
   */
  route(req: PortalContribRequest): Promise<PortalContribResponse>;
}
