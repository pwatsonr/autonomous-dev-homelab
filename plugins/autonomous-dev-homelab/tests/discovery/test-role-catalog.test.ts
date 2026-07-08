/**
 * Tests for the data-driven role-classification catalog (issue #28).
 *
 * Covers:
 *  1. SERVICE_ROLE_CATALOG: catalog shape invariants (entries, confidence range).
 *  2. normalizeImageName: strips tag/digest, lower-cases.
 *  3. evaluateSignal: image-substring, image-regex, port, label signals.
 *  4. classifyRole: positive + negative cases for every well-known role.
 *  5. classifyRole with real-world image strings (registries, tags, digests).
 *  6. Dynamic-first invariant #62: a made-up service with a generic image
 *     pattern classifies correctly; an unknown image gets no role.
 *  7. RoleClassifier: annotates entities in GraphStore; unmatched services
 *     remain unchanged; re-classifying updates role.
 *  8. runClassify CLI command: JSON + plain output; empty-graph edge case.
 *
 * No live network or Docker daemon is accessed. Invariant #62: no
 * homelab-specific instance names appear in assertions that would break
 * if this homelab's topology changed. Fixture names are synthetic.
 */

import * as path from 'node:path';
import {
  SERVICE_ROLE_CATALOG,
  KNOWN_ROLES,
  normalizeImageName,
  evaluateSignal,
  classifyRole,
  RoleClassifier,
} from '../../src/discovery/role-catalog';
import { GraphStore } from '../../src/discovery/graph-store';
import { fileMutex } from '../../src/util/file-mutex';
import type { Entity } from '../../src/discovery/graph-types';
import type { RolePattern, RoleSignal } from '../../src/discovery/role-catalog';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';
import { runClassify } from '../../src/cli/commands/classify';
import type { OutputStreams } from '../../src/cli/output';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = '2026-07-08T00:00:00.000Z';

/**
 * Build a minimal service Entity with the given image and optional ports/labels.
 * Names are synthetic — invariant #62.
 */
function makeServiceEntity(
  id: string,
  image: string,
  opts: { ports?: string[]; labels?: string | Record<string, string> } = {},
): Entity {
  return {
    id,
    kind: 'service',
    name: id,
    attributes: {
      image,
      ports: opts.ports ?? [],
      ...(opts.labels !== undefined ? { labels: opts.labels } : {}),
    },
    source: 'test',
    discovered_at: NOW,
    last_seen: NOW,
    status: 'active',
  };
}

/** Build a GraphStore with an isolated mutex to avoid cross-test contention. */
function makeStore(p: string): GraphStore {
  return new GraphStore(p, { mutex: fileMutex() });
}

/** Capture stdout/stderr output for CLI assertions. */
function makeStreams(): { streams: OutputStreams; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const streams: OutputStreams = {
    stdout: (s: string) => { out.push(s); },
    stderr: (s: string) => { err.push(s); },
  };
  return { streams, out, err };
}

// ---------------------------------------------------------------------------
// 1. Catalog shape invariants
// ---------------------------------------------------------------------------

describe('SERVICE_ROLE_CATALOG shape invariants', () => {
  it('has at least one entry per KNOWN_ROLES role', () => {
    const catalogRoles = new Set(SERVICE_ROLE_CATALOG.map((p) => p.role));
    for (const role of Object.values(KNOWN_ROLES)) {
      expect(catalogRoles.has(role)).toBe(true);
    }
  });

  it('every entry has confidence in (0, 1]', () => {
    for (const pattern of SERVICE_ROLE_CATALOG) {
      expect(pattern.confidence).toBeGreaterThan(0);
      expect(pattern.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('every entry has at least one signal', () => {
    for (const pattern of SERVICE_ROLE_CATALOG) {
      expect(pattern.signals.length).toBeGreaterThan(0);
    }
  });

  it('every signal has a recognised kind', () => {
    const validKinds = new Set(['image-substring', 'image-regex', 'port', 'label']);
    for (const pattern of SERVICE_ROLE_CATALOG) {
      for (const signal of pattern.signals) {
        expect(validKinds.has(signal.kind)).toBe(true);
      }
    }
  });

  it('appending a new entry requires no code change (data-only)', () => {
    // Invariant #62: adding a catalog entry is a data-only change.
    // We verify by building a custom catalog that extends the default one.
    const customCatalog: RolePattern[] = [
      ...SERVICE_ROLE_CATALOG,
      {
        role: 'my-custom-role',
        signals: [{ kind: 'image-substring', value: 'my-custom-image' }],
        confidence: 0.85,
      },
    ];
    const entity = makeServiceEntity('e1', 'my-custom-image:latest');
    const result = classifyRole(entity, customCatalog);
    expect(result).not.toBeNull();
    expect(result!.role).toBe('my-custom-role');
  });
});

// ---------------------------------------------------------------------------
// 2. normalizeImageName
// ---------------------------------------------------------------------------

describe('normalizeImageName', () => {
  it('strips tag and returns lower-case', () => {
    expect(normalizeImageName('postgres:15')).toBe('postgres');
    expect(normalizeImageName('Grafana:10.0')).toBe('grafana');
  });

  it('strips digest', () => {
    expect(normalizeImageName('redis:7@sha256:abc123')).toBe('redis');
  });

  it('handles registry prefix', () => {
    expect(normalizeImageName('ghcr.io/goauthentik/server:2024.8.1')).toBe(
      'ghcr.io/goauthentik/server',
    );
  });

  it('handles image with no tag or digest', () => {
    expect(normalizeImageName('nginx')).toBe('nginx');
    expect(normalizeImageName('NGINX')).toBe('nginx');
  });

  it('handles registry + tag + digest', () => {
    expect(normalizeImageName('docker.io/library/postgres:15@sha256:deadbeef')).toBe(
      'docker.io/library/postgres',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. evaluateSignal
// ---------------------------------------------------------------------------

describe('evaluateSignal', () => {
  describe('image-substring signal', () => {
    it('matches when image name contains the substring (case-insensitive)', () => {
      const signal: RoleSignal = { kind: 'image-substring', value: 'postgres' };
      expect(evaluateSignal(signal, makeServiceEntity('e', 'postgres:15'))).toBe(true);
      expect(evaluateSignal(signal, makeServiceEntity('e', 'POSTGRES:15'))).toBe(true);
      expect(evaluateSignal(signal, makeServiceEntity('e', 'docker.io/library/postgres:15'))).toBe(true);
    });

    it('does not match unrelated images', () => {
      const signal: RoleSignal = { kind: 'image-substring', value: 'postgres' };
      expect(evaluateSignal(signal, makeServiceEntity('e', 'redis:7'))).toBe(false);
      expect(evaluateSignal(signal, makeServiceEntity('e', 'nginx:alpine'))).toBe(false);
    });

    it('returns false when entity has no image attribute', () => {
      const signal: RoleSignal = { kind: 'image-substring', value: 'postgres' };
      const entity: Entity = { ...makeServiceEntity('e', ''), attributes: {} };
      expect(evaluateSignal(signal, entity)).toBe(false);
    });
  });

  describe('image-regex signal', () => {
    it('matches via regex pattern', () => {
      const signal: RoleSignal = {
        kind: 'image-regex',
        pattern: 'sqlite|clickhouse',
        flags: 'i',
      };
      expect(evaluateSignal(signal, makeServiceEntity('e', 'clickhouse:23.8'))).toBe(true);
      expect(evaluateSignal(signal, makeServiceEntity('e', 'sqlite:latest'))).toBe(true);
      expect(evaluateSignal(signal, makeServiceEntity('e', 'redis:7'))).toBe(false);
    });

    it('uses default case-insensitive flag when flags omitted', () => {
      const signal: RoleSignal = { kind: 'image-regex', pattern: 'TRAEFIK' };
      expect(evaluateSignal(signal, makeServiceEntity('e', 'traefik:v3'))).toBe(true);
    });

    it('returns false on invalid regex (does not throw)', () => {
      const signal: RoleSignal = { kind: 'image-regex', pattern: '[invalid' };
      expect(() => evaluateSignal(signal, makeServiceEntity('e', 'anything'))).not.toThrow();
      expect(evaluateSignal(signal, makeServiceEntity('e', 'anything'))).toBe(false);
    });
  });

  describe('port signal', () => {
    it('matches when port number appears in ports array', () => {
      const signal: RoleSignal = { kind: 'port', port: 5432 };
      const entity = makeServiceEntity('e', 'unknown:latest', {
        ports: ['*:5432->5432/tcp'],
      });
      expect(evaluateSignal(signal, entity)).toBe(true);
    });

    it('does not match when port is absent', () => {
      const signal: RoleSignal = { kind: 'port', port: 5432 };
      const entity = makeServiceEntity('e', 'unknown:latest', {
        ports: ['*:3000->3000/tcp'],
      });
      expect(evaluateSignal(signal, entity)).toBe(false);
    });

    it('returns false when ports attribute is missing or not an array', () => {
      const signal: RoleSignal = { kind: 'port', port: 5432 };
      const entity: Entity = {
        ...makeServiceEntity('e', 'unknown:latest'),
        attributes: { image: 'unknown:latest' }, // no ports key
      };
      expect(evaluateSignal(signal, entity)).toBe(false);
    });
  });

  describe('label signal', () => {
    it('matches string labels containing the key', () => {
      const signal: RoleSignal = { kind: 'label', key: 'traefik.enable' };
      const entity = makeServiceEntity('e', 'app:latest', {
        labels: 'traefik.enable=true,com.docker.stack.namespace=myapp',
      });
      expect(evaluateSignal(signal, entity)).toBe(true);
    });

    it('does not match when key is absent from string labels', () => {
      const signal: RoleSignal = { kind: 'label', key: 'traefik.enable' };
      const entity = makeServiceEntity('e', 'app:latest', {
        labels: 'com.docker.stack.namespace=myapp',
      });
      expect(evaluateSignal(signal, entity)).toBe(false);
    });

    it('matches object labels containing the key', () => {
      const signal: RoleSignal = { kind: 'label', key: 'mcp.server' };
      const entity = makeServiceEntity('e', 'app:latest', {
        labels: { 'mcp.server': 'true' },
      });
      expect(evaluateSignal(signal, entity)).toBe(true);
    });

    it('checks valueSubstring in object labels', () => {
      const signal: RoleSignal = {
        kind: 'label',
        key: 'mcp.server',
        valueSubstring: 'enabled',
      };
      const entity = makeServiceEntity('e', 'app:latest', {
        labels: { 'mcp.server': 'enabled' },
      });
      expect(evaluateSignal(signal, entity)).toBe(true);
      const entityWrong = makeServiceEntity('e', 'app:latest', {
        labels: { 'mcp.server': 'disabled' },
      });
      expect(evaluateSignal(signal, entityWrong)).toBe(false);
    });

    it('returns false when labels attribute is absent', () => {
      const signal: RoleSignal = { kind: 'label', key: 'traefik.enable' };
      const entity = makeServiceEntity('e', 'app:latest'); // no labels
      expect(evaluateSignal(signal, entity)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. classifyRole: positive + negative cases for every well-known role
// ---------------------------------------------------------------------------

describe('classifyRole: catalog coverage', () => {
  // One positive + one negative test per role.
  const cases: Array<{ role: string; positive: string; negative: string; ports?: string[] }> = [
    {
      role: 'reverse-proxy',
      positive: 'jlesage/nginx-proxy-manager:v2',
      negative: 'nginx:alpine',  // plain nginx is not a proxy manager
    },
    {
      role: 'reverse-proxy',
      positive: 'traefik:v3.1',
      negative: 'redis:7',
    },
    {
      role: 'sso',
      positive: 'ghcr.io/goauthentik/server:2024.8.1',
      negative: 'nginx-proxy-manager:latest',
    },
    {
      role: 'sso',
      positive: 'quay.io/keycloak/keycloak:25.0',
      negative: 'postgres:16',
    },
    {
      role: 'database',
      positive: 'postgres:15',
      negative: 'redis:7',
    },
    {
      role: 'database',
      positive: 'mariadb:11',
      negative: 'grafana:latest',
    },
    {
      role: 'database',
      positive: 'mongo:7',
      negative: 'traefik:v3',
    },
    {
      role: 'cache',
      positive: 'redis:7-alpine',
      negative: 'postgres:15',
    },
    {
      role: 'cache',
      positive: 'valkey/valkey:8',
      negative: 'nginx:latest',
    },
    {
      role: 'mcp-server',
      positive: 'myorg/filesystem-mcp:latest',
      negative: 'postgres:15',
    },
    {
      role: 'mcp-server',
      positive: 'ghcr.io/myorg/mcp-server-git:1.0',
      negative: 'redis:7',
    },
    {
      role: 'media',
      positive: 'linuxserver/sonarr:latest',
      negative: 'postgres:15',
    },
    {
      role: 'media',
      positive: 'linuxserver/radarr:5.0',
      negative: 'grafana:10',
    },
    {
      role: 'media',
      positive: 'linuxserver/jellyfin:10',
      negative: 'redis:7',
    },
    {
      role: 'monitoring',
      positive: 'grafana/grafana:10.0',
      negative: 'redis:7',
    },
    {
      role: 'monitoring',
      positive: 'prom/prometheus:v2',
      negative: 'postgres:15',
    },
    {
      role: 'observability',
      positive: 'docker.io/library/loki:2.9',
      negative: 'redis:7',
    },
    {
      role: 'observability',
      positive: 'fluent/fluent-bit:3',
      negative: 'grafana:10',
    },
    {
      role: 'secrets',
      positive: 'hashicorp/vault:1.16',
      negative: 'redis:7',
    },
    {
      role: 'secrets',
      positive: 'vaultwarden/server:1.31',
      negative: 'postgres:15',
    },
    {
      role: 'dns',
      positive: 'adguard/adguardhome:latest',
      negative: 'redis:7',
    },
    {
      role: 'dns',
      positive: 'pihole/pihole:2024',
      negative: 'grafana:latest',
    },
    {
      role: 'orchestration',
      positive: 'portainer/portainer-ce:2.21',
      negative: 'redis:7',
    },
    {
      role: 'queue',
      positive: 'rabbitmq:3-management',
      negative: 'redis:7',
    },
    {
      role: 'queue',
      positive: 'nats:2.10',
      negative: 'postgres:15',
    },
    {
      role: 'vcs',
      positive: 'gitea/gitea:1.22',
      negative: 'redis:7',
    },
    {
      role: 'code-quality',
      positive: 'sonarqube:10-community',
      negative: 'redis:7',
    },
  ];

  test.each(cases)(
    'role=$role: $positive classifies correctly; $negative does not',
    ({ role, positive, negative, ports }) => {
      const posEntity = makeServiceEntity('pos', positive, { ports: ports ?? [] });
      const negEntity = makeServiceEntity('neg', negative, { ports: [] });

      const posResult = classifyRole(posEntity);
      const negResult = classifyRole(negEntity);

      // Positive: must classify as the expected role.
      expect(posResult).not.toBeNull();
      expect(posResult!.role).toBe(role);

      // Negative: either no match OR a different role (not the expected one).
      if (negResult !== null) {
        expect(negResult.role).not.toBe(role);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// 5. Real-world image string formats (registry, tag, digest)
// ---------------------------------------------------------------------------

describe('classifyRole: real-world image strings', () => {
  it('classifies ghcr.io registry image with tag', () => {
    const entity = makeServiceEntity('e', 'ghcr.io/goauthentik/server:2024.8.1');
    const result = classifyRole(entity);
    expect(result).not.toBeNull();
    expect(result!.role).toBe('sso');
  });

  it('classifies image with digest suffix', () => {
    const entity = makeServiceEntity(
      'e',
      'postgres:15@sha256:deadbeef1234',
    );
    const result = classifyRole(entity);
    expect(result).not.toBeNull();
    expect(result!.role).toBe('database');
  });

  it('classifies image from docker.io/library namespace', () => {
    const entity = makeServiceEntity('e', 'docker.io/library/redis:7-alpine');
    const result = classifyRole(entity);
    expect(result).not.toBeNull();
    expect(result!.role).toBe('cache');
  });
});

// ---------------------------------------------------------------------------
// 6. Dynamic-first invariant #62: generic matching
// ---------------------------------------------------------------------------

describe('classifyRole: dynamic-first invariant (#62)', () => {
  it('classifies a made-up service with a generic postgres image as database', () => {
    // The service name is entirely fictional — only the image signal matters.
    const entity = makeServiceEntity(
      'service:some-host:my-random-postgres-15',
      'my-random-postgres:15',
    );
    const result = classifyRole(entity);
    expect(result).not.toBeNull();
    expect(result!.role).toBe('database');
    expect(result!.confidence).toBeGreaterThan(0);
  });

  it('returns null for a completely unknown image (generic service retained)', () => {
    const entity = makeServiceEntity(
      'service:some-host:totally-unknown-svc',
      'totally-unknown-app:1.0',
    );
    const result = classifyRole(entity);
    // Must return null — not classified, not discarded (invariant #62).
    expect(result).toBeNull();
  });

  it('classifies a custom mcp-server image without any specific instance name', () => {
    // An mcp image that does not appear in any homelab-specific list.
    const entity = makeServiceEntity('e', 'ghcr.io/acmecorp/weather-mcp:v2');
    const result = classifyRole(entity);
    expect(result).not.toBeNull();
    expect(result!.role).toBe('mcp-server');
  });

  it('classifies via port signal when image is opaque', () => {
    // A generic "app:latest" image — but port 6379 signals Redis/cache.
    const entity = makeServiceEntity('e', 'app:latest', {
      ports: ['*:6379->6379/tcp'],
    });
    const result = classifyRole(entity);
    expect(result).not.toBeNull();
    expect(result!.role).toBe('cache');
  });

  it('classifies via label signal when image is opaque', () => {
    const entity = makeServiceEntity('e', 'proprietary-proxy:latest', {
      labels: 'traefik.enable=true',
    });
    const result = classifyRole(entity);
    expect(result).not.toBeNull();
    expect(result!.role).toBe('reverse-proxy');
  });

  it('uses the first-matching pattern when multiple could match', () => {
    // 'grafana' matches 'monitoring' before any later catalog entry.
    const entity = makeServiceEntity('e', 'grafana/grafana:10');
    const result = classifyRole(entity);
    expect(result).not.toBeNull();
    expect(result!.role).toBe('monitoring');
    // And the confidence comes from that pattern.
    expect(result!.confidence).toBe(result!.matchedPattern.confidence);
  });
});

// ---------------------------------------------------------------------------
// 7. RoleClassifier: annotates entities in the GraphStore
// ---------------------------------------------------------------------------

describe('RoleClassifier', () => {
  let tempDir: string;
  let graphPath: string;

  beforeEach(async () => {
    tempDir = await mkTempDir('adh-role-classifier-test-');
    graphPath = path.join(tempDir, 'inventory-graph.yaml');
  });

  afterEach(async () => {
    await rmTempDir(tempDir);
  });

  it('annotates matched service entities with role + role_confidence', async () => {
    const store = makeStore(graphPath);
    await store.upsertEntity(makeServiceEntity('svc:test:postgres', 'postgres:15'));
    await store.upsertEntity(makeServiceEntity('svc:test:redis', 'redis:7'));

    const classifier = new RoleClassifier(store, { clock: () => NOW });
    const summary = await classifier.classify();

    expect(summary.total).toBe(2);
    expect(summary.classified).toBe(2);
    expect(summary.unclassified).toBe(0);
    expect(summary.byRole['database']).toBe(1);
    expect(summary.byRole['cache']).toBe(1);

    const pg = await store.getEntity('svc:test:postgres');
    expect(pg!.attributes['role']).toBe('database');
    expect(typeof pg!.attributes['role_confidence']).toBe('number');

    const rd = await store.getEntity('svc:test:redis');
    expect(rd!.attributes['role']).toBe('cache');
  });

  it('leaves unmatched service entities unchanged', async () => {
    const store = makeStore(graphPath);
    const unknownEntity = makeServiceEntity('svc:test:unknown', 'proprietary-unknown:1.0');
    await store.upsertEntity(unknownEntity);

    const classifier = new RoleClassifier(store, { clock: () => NOW });
    const summary = await classifier.classify();

    expect(summary.total).toBe(1);
    expect(summary.classified).toBe(0);
    expect(summary.unclassified).toBe(1);

    const after = await store.getEntity('svc:test:unknown');
    // No role attribute must have been added.
    expect(after!.attributes['role']).toBeUndefined();
    expect(after!.attributes['role_confidence']).toBeUndefined();
  });

  it('only classifies kind=service entities (ignores nodes, containers, etc.)', async () => {
    const store = makeStore(graphPath);
    await store.upsertEntity(makeServiceEntity('svc:test:pg', 'postgres:15'));
    // A node entity with a postgres-like name — must be ignored.
    await store.upsertEntity({
      id: 'node:test:pg-node',
      kind: 'node',
      name: 'pg-node',
      attributes: { image: 'postgres:15' },
      source: 'test',
      discovered_at: NOW,
      last_seen: NOW,
      status: 'active',
    });

    const classifier = new RoleClassifier(store, { clock: () => NOW });
    const summary = await classifier.classify();

    expect(summary.total).toBe(1); // Only the service entity
    expect(summary.classified).toBe(1);
  });

  it('updates last_seen on classified entities', async () => {
    const T0 = '2026-01-01T00:00:00.000Z';
    const T1 = '2026-07-08T00:00:00.000Z';

    const store = makeStore(graphPath);
    await store.upsertEntity(makeServiceEntity('svc:test:pg', 'postgres:15'));

    const classifier = new RoleClassifier(store, { clock: () => T1 });
    await classifier.classify();

    const entity = await store.getEntity('svc:test:pg');
    expect(entity!.last_seen).toBe(T1);
    void T0; // not used — classification always sets T1
  });

  it('re-classifying an entity updates the role', async () => {
    const store = makeStore(graphPath);
    await store.upsertEntity({
      ...makeServiceEntity('svc:test:pg', 'postgres:15'),
      attributes: {
        image: 'postgres:15',
        ports: [],
        role: 'old-role',
        role_confidence: 0.1,
      },
    });

    const classifier = new RoleClassifier(store, { clock: () => NOW });
    await classifier.classify();

    const entity = await store.getEntity('svc:test:pg');
    expect(entity!.attributes['role']).toBe('database');
    // Confidence must come from the catalog, not the old value.
    expect(entity!.attributes['role_confidence']).toBeGreaterThan(0.5);
  });

  it('handles an empty graph gracefully (zero services)', async () => {
    const store = makeStore(graphPath);
    // Populate only a node — no services.
    await store.upsertEntity({
      id: 'node:test:some-node',
      kind: 'node',
      name: 'some-node',
      attributes: {},
      source: 'test',
      discovered_at: NOW,
      last_seen: NOW,
      status: 'active',
    });

    const classifier = new RoleClassifier(store, { clock: () => NOW });
    const summary = await classifier.classify();

    expect(summary.total).toBe(0);
    expect(summary.classified).toBe(0);
    expect(summary.unclassified).toBe(0);
  });

  it('logs debug events for matched and unmatched entities', async () => {
    const store = makeStore(graphPath);
    await store.upsertEntity(makeServiceEntity('svc:test:pg', 'postgres:15'));
    await store.upsertEntity(makeServiceEntity('svc:test:unk', 'unknown:1.0'));

    const debugLogs: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const infoLogs: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const classifier = new RoleClassifier(store, {
      clock: () => NOW,
      logger: {
        debug: (msg, ctx) => debugLogs.push({ msg, ctx }),
        info: (msg, ctx) => infoLogs.push({ msg, ctx }),
      },
    });
    await classifier.classify();

    const matched = debugLogs.filter((l) => l.msg === 'role_classifier_matched');
    const noMatch = debugLogs.filter((l) => l.msg === 'role_classifier_no_match');
    expect(matched).toHaveLength(1);
    expect(noMatch).toHaveLength(1);

    const completeLogs = infoLogs.filter((l) => l.msg === 'role_classifier_complete');
    expect(completeLogs).toHaveLength(1);
  });

  it('supports a custom catalog override', async () => {
    const store = makeStore(graphPath);
    await store.upsertEntity(makeServiceEntity('svc:test:myapp', 'my-custom-app:1.0'));

    const customCatalog: RolePattern[] = [
      {
        role: 'my-custom-role',
        signals: [{ kind: 'image-substring', value: 'my-custom-app' }],
        confidence: 0.99,
      },
    ];
    const classifier = new RoleClassifier(store, { catalog: customCatalog, clock: () => NOW });
    const summary = await classifier.classify();

    expect(summary.classified).toBe(1);
    const entity = await store.getEntity('svc:test:myapp');
    expect(entity!.attributes['role']).toBe('my-custom-role');
  });
});

// ---------------------------------------------------------------------------
// 8. runClassify CLI command
// ---------------------------------------------------------------------------

describe('runClassify CLI command', () => {
  let tempDir: string;
  let graphPath: string;

  beforeEach(async () => {
    tempDir = await mkTempDir('adh-classify-cli-test-');
    graphPath = path.join(tempDir, 'inventory-graph.yaml');
  });

  afterEach(async () => {
    await rmTempDir(tempDir);
  });

  it('returns EXIT_OK and prints summary in plain mode', async () => {
    const store = makeStore(graphPath);
    await store.upsertEntity(makeServiceEntity('svc:test:pg', 'postgres:15'));
    await store.upsertEntity(makeServiceEntity('svc:test:unk', 'unknown:1.0'));

    const classifier = new RoleClassifier(store, { clock: () => NOW });
    const { streams, out } = makeStreams();

    const code = await runClassify({ json: false }, { roleClassifier: classifier, streams });

    expect(code).toBe(0); // EXIT_OK
    const combined = out.join('');
    expect(combined).toMatch(/1\/2 services/i);
    expect(combined).toContain('database');
  });

  it('returns EXIT_OK and emits valid JSON in --json mode', async () => {
    const store = makeStore(graphPath);
    await store.upsertEntity(makeServiceEntity('svc:test:pg', 'postgres:15'));

    const classifier = new RoleClassifier(store, { clock: () => NOW });
    const { streams, out } = makeStreams();

    const code = await runClassify({ json: true }, { roleClassifier: classifier, streams });

    expect(code).toBe(0);
    const parsed = JSON.parse(out.join('')) as Record<string, unknown>;
    expect(parsed['total']).toBe(1);
    expect(parsed['classified']).toBe(1);
    expect(parsed['unclassified']).toBe(0);
    expect(typeof parsed['by_role']).toBe('object');
  });

  it('returns EXIT_USAGE when no service entities exist (empty graph)', async () => {
    const store = makeStore(graphPath);
    // No entities at all.
    const classifier = new RoleClassifier(store, { clock: () => NOW });
    const { streams, out } = makeStreams();

    const code = await runClassify({ json: false }, { roleClassifier: classifier, streams });

    expect(code).toBe(1); // EXIT_USAGE
    expect(out.join('')).toContain('inventory enumerate');
  });

  it('returns EXIT_USAGE and emits JSON for empty graph with --json', async () => {
    const store = makeStore(graphPath);
    const classifier = new RoleClassifier(store, { clock: () => NOW });
    const { streams, out } = makeStreams();

    const code = await runClassify({ json: true }, { roleClassifier: classifier, streams });

    expect(code).toBe(1);
    const parsed = JSON.parse(out.join('')) as Record<string, unknown>;
    expect(parsed['total']).toBe(0);
  });

  it('mentions unclassified services in plain output', async () => {
    const store = makeStore(graphPath);
    await store.upsertEntity(makeServiceEntity('svc:test:unk', 'totally-unknown:1.0'));

    const classifier = new RoleClassifier(store, { clock: () => NOW });
    const { streams, out } = makeStreams();

    await runClassify({ json: false }, { roleClassifier: classifier, streams });

    const combined = out.join('');
    expect(combined).toMatch(/0\/1 services/i);
    expect(combined).toContain('matched no role pattern');
  });
});
