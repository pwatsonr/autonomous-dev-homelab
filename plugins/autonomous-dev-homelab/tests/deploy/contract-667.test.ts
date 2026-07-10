/**
 * Tests for Issue #667 — deploy-time secret binding via CredentialProxy.
 *
 * Coverage:
 *   - SecretBinding model: credentialRef, injectAs ('env'|'file'), name
 *   - resolveSecretBindings resolves via CredentialProxy JIT
 *   - Only refHash is persisted — never secret material
 *   - injectAs 'env' path
 *   - injectAs 'file' path
 *   - Per-target permission check: rejects credentialRef not permitted for target
 *   - Works with the homelab plugin's local CredentialProxy shim
 *   - Resolved bindings are not logged (no secret material in returned structure)
 *
 * These are WIRING tests — real resolution path, injected CredentialProxy.
 */

import {
  type SecretBinding,
  type SecretBindingRequest,
  type ResolvedBinding,
  type ResolvedBindingEnv,
  type ResolvedBindingFile,
  resolveSecretBindings,
  hashCredentialRef,
} from "../../src/deploy/secret-binding";

import { ensureHmacSecret } from "../helpers/hmac-secret";

// ---------------------------------------------------------------------------
// Mock CredentialProxy (mirrors local shim interface)
// ---------------------------------------------------------------------------

interface MockProxyCall {
  kind: string;
  op: string;
  resource: string;
}

class MockCredentialProxy {
  readonly calls: MockProxyCall[] = [];
  private readonly responses: Map<string, string>;

  constructor(responses: Record<string, string> = {}) {
    this.responses = new Map(Object.entries(responses));
  }

  async acquire(
    kind: string,
    op: string,
    scope: { resource: string },
  ): Promise<{
    kubeconfig: string;
    expiresAt: string;
    tokenLifetimeSeconds: number;
  }> {
    this.calls.push({ kind, op, resource: scope.resource });
    const key = `${kind}:${scope.resource}`;
    const val = this.responses.get(key);
    if (val === undefined) {
      throw new Error(`MockCredentialProxy: no response for ${key}`);
    }
    return {
      kubeconfig: val,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      tokenLifetimeSeconds: 300,
    };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TARGET_ID = "target-667-test";

const ENV_BINDING: SecretBinding = {
  credentialRef: "vault:secret/myapp/db-password",
  injectAs: "env",
  name: "DB_PASSWORD",
  permittedTargets: [TARGET_ID],
};

const FILE_BINDING: SecretBinding = {
  credentialRef: "vault:secret/myapp/tls-cert",
  injectAs: "file",
  name: "/run/secrets/tls.crt",
  permittedTargets: [TARGET_ID],
};

const RESTRICTED_BINDING: SecretBinding = {
  credentialRef: "vault:secret/admin/root-key",
  injectAs: "env",
  name: "ROOT_KEY",
  permittedTargets: ["other-target-only"], // NOT TARGET_ID
};

function makeRequest(
  bindings: SecretBinding[],
  targetId: string = TARGET_ID,
): SecretBindingRequest {
  return {
    bindings,
    targetId,
    operationKind: "deploy",
  };
}

// ---------------------------------------------------------------------------
// hashCredentialRef
// ---------------------------------------------------------------------------

describe("hashCredentialRef", () => {
  it("returns a non-empty hex string", () => {
    const hash = hashCredentialRef("vault:secret/myapp/db-password");
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic for the same input", () => {
    const a = hashCredentialRef("ref-abc");
    const b = hashCredentialRef("ref-abc");
    expect(a).toBe(b);
  });

  it("produces different hashes for different refs", () => {
    const a = hashCredentialRef("ref-one");
    const b = hashCredentialRef("ref-two");
    expect(a).not.toBe(b);
  });

  it("does NOT include the original ref in the hash output", () => {
    const ref = "vault:secret/myapp/db-password";
    const hash = hashCredentialRef(ref);
    expect(hash).not.toContain("vault");
    expect(hash).not.toContain("secret");
  });
});

// ---------------------------------------------------------------------------
// resolveSecretBindings — injectAs 'env'
// ---------------------------------------------------------------------------

describe("resolveSecretBindings — injectAs env", () => {
  beforeAll(() => {
    ensureHmacSecret();
  });

  it("resolves an env binding via CredentialProxy", async () => {
    const proxy = new MockCredentialProxy({
      "deploy:vault:secret/myapp/db-password": "super-secret-value",
    });

    const result = await resolveSecretBindings(
      makeRequest([ENV_BINDING]),
      proxy,
    );
    expect(result.resolved).toHaveLength(1);
    const binding = result.resolved[0] as ResolvedBindingEnv;
    expect(binding.injectAs).toBe("env");
    expect(binding.name).toBe("DB_PASSWORD");
    expect(binding.value).toBe("super-secret-value");
  });

  it("records the refHash, not the original credentialRef", async () => {
    const proxy = new MockCredentialProxy({
      "deploy:vault:secret/myapp/db-password": "secret123",
    });

    const result = await resolveSecretBindings(
      makeRequest([ENV_BINDING]),
      proxy,
    );
    const binding = result.resolved[0] as ResolvedBindingEnv;
    expect(binding.refHash).toBeDefined();
    expect(binding.refHash).not.toContain("vault");
    expect(binding.refHash).not.toContain("secret");
    // refHash should equal hashCredentialRef of the original ref
    expect(binding.refHash).toBe(hashCredentialRef(ENV_BINDING.credentialRef));
  });

  it("persists only refHash in the record output (no secret material)", async () => {
    const proxy = new MockCredentialProxy({
      "deploy:vault:secret/myapp/db-password": "do-not-persist-me",
    });

    const result = await resolveSecretBindings(
      makeRequest([ENV_BINDING]),
      proxy,
    );
    const recordSafe = result.recordSafeBindings;
    expect(recordSafe).toHaveLength(1);
    const safe = recordSafe[0];
    expect(safe).not.toHaveProperty("value");
    expect(safe).toHaveProperty("refHash");
    expect(JSON.stringify(safe)).not.toContain("do-not-persist-me");
  });

  it("calls CredentialProxy.acquire with the correct kind and resource", async () => {
    const proxy = new MockCredentialProxy({
      "deploy:vault:secret/myapp/db-password": "val",
    });

    await resolveSecretBindings(makeRequest([ENV_BINDING]), proxy);
    expect(proxy.calls).toHaveLength(1);
    expect(proxy.calls[0]?.kind).toBe("deploy");
    expect(proxy.calls[0]?.resource).toBe(ENV_BINDING.credentialRef);
  });
});

// ---------------------------------------------------------------------------
// resolveSecretBindings — injectAs 'file'
// ---------------------------------------------------------------------------

describe("resolveSecretBindings — injectAs file", () => {
  it("resolves a file binding via CredentialProxy", async () => {
    const proxy = new MockCredentialProxy({
      "deploy:vault:secret/myapp/tls-cert":
        "-----BEGIN CERTIFICATE-----\nMIIC...",
    });

    const result = await resolveSecretBindings(
      makeRequest([FILE_BINDING]),
      proxy,
    );
    expect(result.resolved).toHaveLength(1);
    const binding = result.resolved[0] as ResolvedBindingFile;
    expect(binding.injectAs).toBe("file");
    expect(binding.name).toBe("/run/secrets/tls.crt");
    expect(binding.content).toContain("BEGIN CERTIFICATE");
  });

  it("file binding refHash is stored, not file content", async () => {
    const proxy = new MockCredentialProxy({
      "deploy:vault:secret/myapp/tls-cert": "cert-content",
    });

    const result = await resolveSecretBindings(
      makeRequest([FILE_BINDING]),
      proxy,
    );
    const safe = result.recordSafeBindings[0];
    expect(safe).not.toHaveProperty("content");
    expect(safe).toHaveProperty("refHash");
    expect(JSON.stringify(safe)).not.toContain("cert-content");
  });
});

// ---------------------------------------------------------------------------
// resolveSecretBindings — multiple bindings
// ---------------------------------------------------------------------------

describe("resolveSecretBindings — multiple bindings", () => {
  it("resolves both env and file bindings in one call", async () => {
    const proxy = new MockCredentialProxy({
      "deploy:vault:secret/myapp/db-password": "db-pass",
      "deploy:vault:secret/myapp/tls-cert": "tls-cert-pem",
    });

    const result = await resolveSecretBindings(
      makeRequest([ENV_BINDING, FILE_BINDING]),
      proxy,
    );
    expect(result.resolved).toHaveLength(2);
    expect(proxy.calls).toHaveLength(2);
  });

  it("recordSafeBindings has no secret material for either binding", async () => {
    const proxy = new MockCredentialProxy({
      "deploy:vault:secret/myapp/db-password": "db-secret",
      "deploy:vault:secret/myapp/tls-cert": "tls-secret",
    });

    const result = await resolveSecretBindings(
      makeRequest([ENV_BINDING, FILE_BINDING]),
      proxy,
    );
    const safeJson = JSON.stringify(result.recordSafeBindings);
    expect(safeJson).not.toContain("db-secret");
    expect(safeJson).not.toContain("tls-secret");
    expect(result.recordSafeBindings).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// resolveSecretBindings — permission check
// ---------------------------------------------------------------------------

describe("resolveSecretBindings — permission check", () => {
  it("rejects a binding not permitted for the resolved target", async () => {
    const proxy = new MockCredentialProxy();

    await expect(
      resolveSecretBindings(
        makeRequest([RESTRICTED_BINDING], TARGET_ID),
        proxy,
      ),
    ).rejects.toThrow(/not permitted/i);
  });

  it("does NOT call CredentialProxy for a permission-denied binding", async () => {
    const proxy = new MockCredentialProxy();
    try {
      await resolveSecretBindings(
        makeRequest([RESTRICTED_BINDING], TARGET_ID),
        proxy,
      );
    } catch {
      // expected
    }
    expect(proxy.calls).toHaveLength(0);
  });

  it("allows binding when target is in permittedTargets", async () => {
    const proxy = new MockCredentialProxy({
      "deploy:vault:secret/myapp/db-password": "allowed-val",
    });
    const result = await resolveSecretBindings(
      makeRequest([ENV_BINDING], TARGET_ID),
      proxy,
    );
    expect(result.resolved).toHaveLength(1);
  });

  it("rejects when permittedTargets is empty (deny-all)", async () => {
    const proxy = new MockCredentialProxy();
    const denyAllBinding: SecretBinding = {
      ...ENV_BINDING,
      permittedTargets: [],
    };
    await expect(
      resolveSecretBindings(makeRequest([denyAllBinding], TARGET_ID), proxy),
    ).rejects.toThrow(/not permitted/i);
  });
});

// ---------------------------------------------------------------------------
// resolveSecretBindings — empty bindings
// ---------------------------------------------------------------------------

describe("resolveSecretBindings — empty bindings", () => {
  it("returns empty arrays when no bindings are provided", async () => {
    const proxy = new MockCredentialProxy();
    const result = await resolveSecretBindings(makeRequest([]), proxy);
    expect(result.resolved).toHaveLength(0);
    expect(result.recordSafeBindings).toHaveLength(0);
    expect(proxy.calls).toHaveLength(0);
  });
});
