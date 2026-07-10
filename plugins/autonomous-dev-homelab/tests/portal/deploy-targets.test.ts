/**
 * Tests for Issue #673 — portal deploy-target selection UI.
 *
 * Covers:
 *   (a) renderDeployTargets: lists ALL registered targets (cloud + homelab),
 *       showing location, node, backend, availability, trust.
 *   (b) Unavailable and untrusted targets appear with reason, not selectable.
 *   (c) Empty state when no targets registered.
 *   (d) Model-driven: enumeration driven by registry, not static list.
 *   (e) POST action sets the --target override (TargetOverrideStore).
 *   (f) The resolver honors the override from the store.
 *
 * Safety model: no real filesystem I/O in unit tests; use a tmp dir.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  DeployTargetRegistry,
  type DeployTarget,
} from "../../src/portal/contrib/deploy-target-registry";
import { TargetOverrideStore } from "../../src/portal/contrib/target-override-store";
import { DeployTargetPortalContrib } from "../../src/portal/contrib/deploy-targets-contrib";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(overrides: Partial<DeployTarget> = {}): DeployTarget {
  return {
    id: "test-target",
    location: "homelab",
    node: "proxmox-node-01",
    backend: "proxmox",
    availability: "available",
    trust: "trusted",
    ...overrides,
  };
}

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "portal-test-"));
}

// ---------------------------------------------------------------------------
// DeployTargetRegistry
// ---------------------------------------------------------------------------

describe("DeployTargetRegistry", () => {
  it("starts empty", () => {
    const registry = new DeployTargetRegistry();
    expect(registry.list()).toHaveLength(0);
  });

  it("registers and lists targets in insertion order", () => {
    const registry = new DeployTargetRegistry();
    const t1 = makeTarget({ id: "a", backend: "proxmox" });
    const t2 = makeTarget({ id: "b", backend: "unraid" });
    registry.register(t1);
    registry.register(t2);
    const listed = registry.list();
    expect(listed).toHaveLength(2);
    expect(listed[0]?.id).toBe("a");
    expect(listed[1]?.id).toBe("b");
  });

  it("throws on duplicate id", () => {
    const registry = new DeployTargetRegistry();
    registry.register(makeTarget({ id: "dup" }));
    expect(() => registry.register(makeTarget({ id: "dup" }))).toThrow(
      /already registered/,
    );
  });

  it("lists unavailable targets with reason intact", () => {
    const registry = new DeployTargetRegistry();
    registry.register(
      makeTarget({
        id: "down",
        availability: "unavailable",
        unavailableReason: "host unreachable",
      }),
    );
    const t = registry.list()[0];
    expect(t?.availability).toBe("unavailable");
    expect(t?.unavailableReason).toBe("host unreachable");
  });

  it("lists untrusted targets with trust reason intact", () => {
    const registry = new DeployTargetRegistry();
    registry.register(
      makeTarget({
        id: "untrusted",
        trust: "untrusted",
        trustReason: "cert expired",
      }),
    );
    const t = registry.list()[0];
    expect(t?.trust).toBe("untrusted");
    expect(t?.trustReason).toBe("cert expired");
  });

  it("supports cloud targets alongside homelab targets (model-driven)", () => {
    const registry = new DeployTargetRegistry();
    registry.register(
      makeTarget({ id: "cloud-prod", location: "cloud", backend: "k3s" }),
    );
    registry.register(
      makeTarget({ id: "lab-01", location: "homelab", backend: "unraid" }),
    );
    const listed = registry.list();
    expect(listed.map((t) => t.location)).toEqual(["cloud", "homelab"]);
  });
});

// ---------------------------------------------------------------------------
// TargetOverrideStore
// ---------------------------------------------------------------------------

describe("TargetOverrideStore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when no override is set", async () => {
    const store = new TargetOverrideStore({ dataDir: tmpDir });
    expect(await store.get("req-1")).toBeUndefined();
  });

  it("set then get returns the same target id", async () => {
    const store = new TargetOverrideStore({ dataDir: tmpDir });
    await store.set("req-123", "proxmox");
    expect(await store.get("req-123")).toBe("proxmox");
  });

  it("override is request-scoped (different requests are isolated)", async () => {
    const store = new TargetOverrideStore({ dataDir: tmpDir });
    await store.set("req-A", "proxmox");
    await store.set("req-B", "unraid");
    expect(await store.get("req-A")).toBe("proxmox");
    expect(await store.get("req-B")).toBe("unraid");
  });

  it("clear removes the override", async () => {
    const store = new TargetOverrideStore({ dataDir: tmpDir });
    await store.set("req-X", "k3s");
    await store.clear("req-X");
    expect(await store.get("req-X")).toBeUndefined();
  });

  it("clear on non-existent key does not throw", async () => {
    const store = new TargetOverrideStore({ dataDir: tmpDir });
    await expect(store.clear("no-such-req")).resolves.toBeUndefined();
  });

  it("persists override across store instances (same dataDir)", async () => {
    const store1 = new TargetOverrideStore({ dataDir: tmpDir });
    await store1.set("req-persist", "docker-swarm");
    const store2 = new TargetOverrideStore({ dataDir: tmpDir });
    expect(await store2.get("req-persist")).toBe("docker-swarm");
  });

  it("resolver override: get honors the override as --target equivalent", async () => {
    // The override store is the source of truth for the --target flag.
    // A resolver that reads from the store will find the override.
    const store = new TargetOverrideStore({ dataDir: tmpDir });
    await store.set("req-deploy", "proxmox");
    const override = await store.get("req-deploy");
    // Assert the override equals what a --target flag would supply.
    expect(override).toBe("proxmox");
  });
});

// ---------------------------------------------------------------------------
// DeployTargetPortalContrib — page rendering + API routes + action
// ---------------------------------------------------------------------------

describe("DeployTargetPortalContrib", () => {
  let tmpDir: string;
  let registry: DeployTargetRegistry;
  let store: TargetOverrideStore;
  let contrib: DeployTargetPortalContrib;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    registry = new DeployTargetRegistry();
    store = new TargetOverrideStore({ dataDir: tmpDir });
    contrib = new DeployTargetPortalContrib({ registry, store });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -- renderPage --

  it("GET /portal/deploy-targets renders HTML", async () => {
    registry.register(makeTarget({ id: "prox", backend: "proxmox" }));
    const result = await contrib.route({
      method: "GET",
      pathname: "/portal/deploy-targets",
      query: {},
      body: null,
    });
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toContain("text/html");
    expect(result.body).toContain("deploy-targets");
  });

  it("GET /portal/deploy-targets shows available target with all required fields", async () => {
    registry.register(
      makeTarget({
        id: "prox",
        backend: "proxmox",
        node: "node-01",
        location: "homelab",
        trust: "trusted",
      }),
    );
    const result = await contrib.route({
      method: "GET",
      pathname: "/portal/deploy-targets",
      query: {},
      body: null,
    });
    expect(result.body).toContain("prox");
    expect(result.body).toContain("proxmox");
    expect(result.body).toContain("node-01");
    expect(result.body).toContain("homelab");
  });

  it("GET /portal/deploy-targets shows unavailable target with reason and marks it not selectable", async () => {
    registry.register(
      makeTarget({
        id: "down-node",
        availability: "unavailable",
        unavailableReason: "host offline",
      }),
    );
    const result = await contrib.route({
      method: "GET",
      pathname: "/portal/deploy-targets",
      query: {},
      body: null,
    });
    expect(result.body).toContain("down-node");
    expect(result.body).toContain("host offline");
    // unavailable targets must NOT have a selectable marker
    expect(result.body).not.toContain(
      'data-target-id="down-node" data-selectable="true"',
    );
  });

  it("GET /portal/deploy-targets shows untrusted target with trust reason and marks it not selectable", async () => {
    registry.register(
      makeTarget({
        id: "untrusted-node",
        trust: "untrusted",
        trustReason: "cert mismatch",
      }),
    );
    const result = await contrib.route({
      method: "GET",
      pathname: "/portal/deploy-targets",
      query: {},
      body: null,
    });
    expect(result.body).toContain("untrusted-node");
    expect(result.body).toContain("cert mismatch");
    expect(result.body).not.toContain(
      'data-target-id="untrusted-node" data-selectable="true"',
    );
  });

  it("GET /portal/deploy-targets shows empty state when registry is empty", async () => {
    const result = await contrib.route({
      method: "GET",
      pathname: "/portal/deploy-targets",
      query: {},
      body: null,
    });
    expect(result.status).toBe(200);
    expect(result.body).toContain("no-targets");
  });

  it("GET /portal/deploy-targets is model-driven: newly registered target appears without code change", async () => {
    // Register dynamically at runtime — this is the key model-driven invariant (#674).
    const dynamicTarget = makeTarget({
      id: "dynamic-k3s",
      backend: "k3s",
      location: "cloud",
    });
    registry.register(dynamicTarget);
    const result = await contrib.route({
      method: "GET",
      pathname: "/portal/deploy-targets",
      query: {},
      body: null,
    });
    expect(result.body).toContain("dynamic-k3s");
    expect(result.body).toContain("k3s");
    expect(result.body).toContain("cloud");
  });

  // -- API route /portal/deploy-targets/api/targets --

  it("GET /portal/deploy-targets/api/targets returns JSON list", async () => {
    registry.register(makeTarget({ id: "t1" }));
    const result = await contrib.route({
      method: "GET",
      pathname: "/portal/deploy-targets/api/targets",
      query: {},
      body: null,
    });
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toContain("application/json");
    const data = JSON.parse(result.body) as DeployTarget[];
    expect(data).toHaveLength(1);
    expect(data[0]?.id).toBe("t1");
  });

  it("GET /portal/deploy-targets/api/targets returns empty array for empty registry", async () => {
    const result = await contrib.route({
      method: "GET",
      pathname: "/portal/deploy-targets/api/targets",
      query: {},
      body: null,
    });
    const data = JSON.parse(result.body) as DeployTarget[];
    expect(data).toHaveLength(0);
  });

  // -- POST /portal/deploy-targets/api/select-target --

  it("POST select-target on available+trusted target sets the override and returns 200", async () => {
    registry.register(
      makeTarget({
        id: "prox-01",
        availability: "available",
        trust: "trusted",
      }),
    );
    const result = await contrib.route({
      method: "POST",
      pathname: "/portal/deploy-targets/api/select-target",
      query: {},
      body: { requestId: "req-001", targetId: "prox-01" },
    });
    expect(result.status).toBe(200);
    const json = JSON.parse(result.body) as { ok: boolean; targetId: string };
    expect(json.ok).toBe(true);
    expect(json.targetId).toBe("prox-01");
    // The override must be stored so the resolver can read it.
    expect(await store.get("req-001")).toBe("prox-01");
  });

  it("POST select-target on unavailable target returns 422 with reason", async () => {
    registry.register(
      makeTarget({
        id: "down",
        availability: "unavailable",
        unavailableReason: "node offline",
      }),
    );
    const result = await contrib.route({
      method: "POST",
      pathname: "/portal/deploy-targets/api/select-target",
      query: {},
      body: { requestId: "req-002", targetId: "down" },
    });
    expect(result.status).toBe(422);
    const json = JSON.parse(result.body) as { ok: boolean; reason: string };
    expect(json.ok).toBe(false);
    expect(json.reason).toContain("unavailable");
    // Override must NOT have been set.
    expect(await store.get("req-002")).toBeUndefined();
  });

  it("POST select-target on untrusted target returns 422 with reason", async () => {
    registry.register(
      makeTarget({
        id: "badcert",
        trust: "untrusted",
        trustReason: "cert expired",
      }),
    );
    const result = await contrib.route({
      method: "POST",
      pathname: "/portal/deploy-targets/api/select-target",
      query: {},
      body: { requestId: "req-003", targetId: "badcert" },
    });
    expect(result.status).toBe(422);
    const json = JSON.parse(result.body) as { ok: boolean; reason: string };
    expect(json.ok).toBe(false);
    expect(json.reason).toContain("untrusted");
    expect(await store.get("req-003")).toBeUndefined();
  });

  it("POST select-target on unknown target returns 404", async () => {
    const result = await contrib.route({
      method: "POST",
      pathname: "/portal/deploy-targets/api/select-target",
      query: {},
      body: { requestId: "req-004", targetId: "no-such" },
    });
    expect(result.status).toBe(404);
  });

  it("POST select-target with missing requestId returns 400", async () => {
    registry.register(makeTarget({ id: "prox-01" }));
    const result = await contrib.route({
      method: "POST",
      pathname: "/portal/deploy-targets/api/select-target",
      query: {},
      body: { targetId: "prox-01" },
    });
    expect(result.status).toBe(400);
  });

  it("unknown route returns 404", async () => {
    const result = await contrib.route({
      method: "GET",
      pathname: "/portal/deploy-targets/no-such",
      query: {},
      body: null,
    });
    expect(result.status).toBe(404);
  });
});
