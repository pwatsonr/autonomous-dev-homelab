/**
 * Data-driven service-ROLE classification catalog (issue #28).
 *
 * Dynamic-first invariant (#62): every pattern entry is keyed on OBSERVABLE
 * signals — image-name substring/regex, published port hints, Docker label
 * hints — not on a hard-coded list of this homelab's specific services.
 * Any new service whose image matches a pattern is classified automatically,
 * with no code change required.
 *
 * Roles are OPEN strings (never an enum). The KNOWN_ROLES constant documents
 * the well-known values that ship with v1 of the catalog; callers and future
 * catalog entries may introduce new role strings without touching the store.
 *
 * Services that match no pattern keep no `role` attribute and are still
 * valid generic service entities — they are never discarded (invariant #62).
 *
 * Adding a new role is a data-only append to SERVICE_ROLE_CATALOG; no
 * code changes are required elsewhere.
 */

import type { Entity } from './graph-types.js';
import type { GraphStore } from './graph-store.js';

// ---------------------------------------------------------------------------
// Well-known roles (documentation only — not enforced anywhere)
// ---------------------------------------------------------------------------

/**
 * Well-known role values documented here for callers that want named
 * constants. The classifier accepts and emits any string as a role; this
 * object exists only so portal/rules code can import constants rather than
 * duplicating magic strings.
 *
 * New roles may appear in the catalog without adding entries here.
 */
export const KNOWN_ROLES = {
  /** Ingress / reverse-proxy (e.g. Nginx Proxy Manager, Traefik, Caddy). */
  'reverse-proxy': 'reverse-proxy',
  /** SSO / identity provider (e.g. Authentik, Keycloak). */
  sso: 'sso',
  /** Relational or document database (e.g. Postgres, MySQL, MongoDB). */
  database: 'database',
  /** In-memory cache / message broker (e.g. Redis, Valkey, Memcached). */
  cache: 'cache',
  /** Model Context Protocol server (e.g. any *-mcp / mcp-server image). */
  'mcp-server': 'mcp-server',
  /** Media management / streaming (e.g. Plex, Jellyfin, Sonarr, Radarr). */
  media: 'media',
  /** Metrics / monitoring (e.g. Grafana, Prometheus). */
  monitoring: 'monitoring',
  /** Log aggregation / pipeline (e.g. Loki, Fluent Bit, Fluentd, Logstash). */
  observability: 'observability',
  /** Secrets manager (e.g. Vault, Infisical). */
  secrets: 'secrets',
  /** DNS resolver / ad-blocker (e.g. AdGuard Home, Pi-hole). */
  dns: 'dns',
  /** Container orchestration / management UI (e.g. Portainer). */
  orchestration: 'orchestration',
  /** Message queue / event broker (e.g. RabbitMQ, NATS, Kafka). */
  queue: 'queue',
  /** Version control / code hosting (e.g. Gitea, GitLab). */
  vcs: 'vcs',
  /** Code quality / static analysis (e.g. SonarQube). */
  'code-quality': 'code-quality',
} as const satisfies Record<string, string>;

// ---------------------------------------------------------------------------
// Signal types
// ---------------------------------------------------------------------------

/**
 * A signal that matches against the service entity's image name (the
 * `attributes.image` string). Either a case-insensitive substring or a
 * full `RegExp`.
 */
export type ImageSignal =
  | { kind: 'image-substring'; value: string }
  | { kind: 'image-regex'; pattern: string; flags?: string };

/**
 * A signal that matches a numeric port that appears in `attributes.ports`
 * (any element of the published-ports array contains this port number as a
 * string fragment, e.g. `:5432->` matches port 5432).
 */
export interface PortSignal {
  kind: 'port';
  port: number;
}

/**
 * A signal that matches a Docker label key (and optionally a value
 * substring) present in `attributes.labels`.
 */
export interface LabelSignal {
  kind: 'label';
  /** Label key that must exist. */
  key: string;
  /** Optional substring that the label value must contain. */
  valueSubstring?: string;
}

export type RoleSignal = ImageSignal | PortSignal | LabelSignal;

// ---------------------------------------------------------------------------
// Catalog entry
// ---------------------------------------------------------------------------

/**
 * A single role-classification pattern.
 *
 * When `signals` contains more than one entry they are treated as OR: any
 * matching signal is sufficient. The first matching signal in the signals
 * list is used (patterns list stronger signals first).
 *
 * `notes` cites the upstream project URL so future maintainers can verify
 * the signal is still accurate when the project evolves.
 */
export interface RolePattern {
  /**
   * Open-string role assigned to matching services. Multiple patterns may
   * share the same role (they use different signals to detect the same
   * category of service).
   */
  role: string;
  /**
   * Ordered list of signals to test. Each signal is tested independently;
   * the first signal that matches determines the result. Patterns list
   * higher-confidence signals first.
   */
  signals: RoleSignal[];
  /** Confidence score in (0, 1] for the role assignment when this pattern fires. */
  confidence: number;
  /** Notes: upstream project URL or rationale for the chosen signal. */
  notes?: string;
}

// ---------------------------------------------------------------------------
// Classification result
// ---------------------------------------------------------------------------

/**
 * The result of classifying a single service entity.
 */
export interface RoleClassification {
  /** Open-string role assigned. */
  role: string;
  /** Confidence score in (0, 1] from the matching pattern. */
  confidence: number;
  /** The pattern that fired (for diagnostics). */
  matchedPattern: RolePattern;
}

// ---------------------------------------------------------------------------
// Catalog — v1 entries
// ---------------------------------------------------------------------------

/**
 * Generic, data-driven role-pattern catalog.
 *
 * Invariant #62 compliance checklist:
 * - Every signal tests a GENERIC observable (image name substring/regex,
 *   port number, Docker label key) — never a specific instance name.
 * - Adding a new role is a one-line (or one-block) append here.
 * - Any service whose image matches one of these patterns is classified on
 *   the next enumerate/classify pass with no code change.
 *
 * Signal ordering within each entry: stronger/more-specific signals appear
 * before weaker/broader ones so the first match yields the best confidence.
 */
export const SERVICE_ROLE_CATALOG: RolePattern[] = [
  // -------------------------------------------------------------------------
  // Reverse proxy / ingress
  // -------------------------------------------------------------------------
  {
    role: 'reverse-proxy',
    signals: [
      { kind: 'image-substring', value: 'nginx-proxy-manager' },
      { kind: 'image-substring', value: 'traefik' },
      { kind: 'image-substring', value: 'caddy' },
      { kind: 'image-substring', value: 'haproxy' },
      { kind: 'image-substring', value: 'envoy' },
      { kind: 'label', key: 'traefik.enable' },
    ],
    confidence: 0.92,
    notes:
      'Nginx Proxy Manager: https://nginxproxymanager.com/. Traefik: https://traefik.io/. ' +
      'Caddy: https://caddyserver.com/. HAProxy: https://www.haproxy.org/.',
  },

  // -------------------------------------------------------------------------
  // SSO / identity provider
  // -------------------------------------------------------------------------
  {
    role: 'sso',
    signals: [
      { kind: 'image-substring', value: 'authentik' },
      { kind: 'image-substring', value: 'keycloak' },
      { kind: 'image-substring', value: 'authelia' },
      { kind: 'image-substring', value: 'kanidm' },
      { kind: 'image-substring', value: 'dex' },
    ],
    confidence: 0.93,
    notes:
      'Authentik: https://goauthentik.io/. Keycloak: https://www.keycloak.org/. ' +
      'Authelia: https://www.authelia.com/. Kanidm: https://kanidm.com/.',
  },

  // -------------------------------------------------------------------------
  // Database
  // -------------------------------------------------------------------------
  {
    role: 'database',
    signals: [
      { kind: 'image-substring', value: 'postgres' },
      { kind: 'image-substring', value: 'mysql' },
      { kind: 'image-substring', value: 'mariadb' },
      { kind: 'image-substring', value: 'mongodb' },
      { kind: 'image-substring', value: 'mongo' },
      { kind: 'image-substring', value: 'cockroachdb' },
      { kind: 'image-substring', value: 'timescaledb' },
      { kind: 'image-regex', pattern: 'sqlite|clickhouse|cassandra|couchdb', flags: 'i' },
      // Port hints (secondary — same ports appear in multiple DB flavours)
      { kind: 'port', port: 5432 },
      { kind: 'port', port: 3306 },
      { kind: 'port', port: 27017 },
    ],
    confidence: 0.91,
    notes:
      'PostgreSQL: https://www.postgresql.org/. MariaDB: https://mariadb.org/. ' +
      'MongoDB: https://www.mongodb.com/. Well-known DB ports: 5432 (Postgres), ' +
      '3306 (MySQL/MariaDB), 27017 (MongoDB).',
  },

  // -------------------------------------------------------------------------
  // Cache / in-memory store
  // -------------------------------------------------------------------------
  {
    role: 'cache',
    signals: [
      { kind: 'image-substring', value: 'redis' },
      { kind: 'image-substring', value: 'valkey' },
      { kind: 'image-substring', value: 'memcached' },
      { kind: 'image-substring', value: 'dragonfly' },
      { kind: 'port', port: 6379 },
      { kind: 'port', port: 11211 },
    ],
    confidence: 0.90,
    notes:
      'Redis: https://redis.io/. Valkey: https://valkey.io/ (Redis fork). ' +
      'Memcached: https://memcached.org/. Well-known ports: 6379 (Redis/Valkey), ' +
      '11211 (Memcached).',
  },

  // -------------------------------------------------------------------------
  // MCP server
  // -------------------------------------------------------------------------
  {
    role: 'mcp-server',
    signals: [
      // Naming convention: ends with -mcp or starts with mcp-
      { kind: 'image-regex', pattern: '(^|[/-])mcp[-_]|[-_]mcp($|[:@])', flags: 'i' },
      { kind: 'image-substring', value: 'mcp-server' },
      { kind: 'label', key: 'com.anthropic.mcp' },
      { kind: 'label', key: 'mcp.server' },
    ],
    confidence: 0.88,
    notes:
      'Model Context Protocol: https://modelcontextprotocol.io/. Convention: ' +
      'images follow a *-mcp or mcp-* naming pattern. Labels com.anthropic.mcp ' +
      'or mcp.server may also be set.',
  },

  // -------------------------------------------------------------------------
  // Media management / streaming
  // -------------------------------------------------------------------------
  {
    role: 'media',
    signals: [
      { kind: 'image-substring', value: 'plex' },
      { kind: 'image-substring', value: 'jellyfin' },
      { kind: 'image-substring', value: 'emby' },
      { kind: 'image-substring', value: 'sonarr' },
      { kind: 'image-substring', value: 'radarr' },
      { kind: 'image-substring', value: 'lidarr' },
      { kind: 'image-substring', value: 'readarr' },
      { kind: 'image-substring', value: 'prowlarr' },
      { kind: 'image-substring', value: 'bazarr' },
      { kind: 'image-substring', value: 'whisparr' },
      { kind: 'image-substring', value: 'overseerr' },
      { kind: 'image-substring', value: 'requestrr' },
      { kind: 'image-substring', value: 'tautulli' },
      { kind: 'image-substring', value: 'transmission' },
      { kind: 'image-substring', value: 'qbittorrent' },
      { kind: 'image-substring', value: 'sabnzbd' },
      { kind: 'image-substring', value: 'nzbget' },
      // Common Plex media server port
      { kind: 'port', port: 32400 },
    ],
    confidence: 0.90,
    notes:
      'Plex: https://plex.tv/. Jellyfin: https://jellyfin.org/. ' +
      'Sonarr: https://sonarr.tv/. Radarr: https://radarr.video/. ' +
      '*arr stack: https://wiki.servarr.com/.',
  },

  // -------------------------------------------------------------------------
  // Monitoring / dashboards
  // -------------------------------------------------------------------------
  {
    role: 'monitoring',
    signals: [
      { kind: 'image-substring', value: 'grafana' },
      { kind: 'image-substring', value: 'prometheus' },
      { kind: 'image-substring', value: 'alertmanager' },
      { kind: 'image-substring', value: 'thanos' },
      { kind: 'image-substring', value: 'uptime-kuma' },
      { kind: 'image-substring', value: 'netdata' },
      { kind: 'image-substring', value: 'zabbix' },
      { kind: 'image-substring', value: 'influxdb' },
      { kind: 'image-substring', value: 'victoria-metrics' },
      { kind: 'image-substring', value: 'mimir' },
    ],
    confidence: 0.89,
    notes:
      'Grafana: https://grafana.com/. Prometheus: https://prometheus.io/. ' +
      'InfluxDB: https://www.influxdata.com/. Victoria Metrics: https://victoriametrics.com/.',
  },

  // -------------------------------------------------------------------------
  // Log aggregation / observability pipeline
  // -------------------------------------------------------------------------
  {
    role: 'observability',
    signals: [
      { kind: 'image-substring', value: 'loki' },
      { kind: 'image-substring', value: 'fluent-bit' },
      { kind: 'image-substring', value: 'fluentd' },
      { kind: 'image-substring', value: 'logstash' },
      { kind: 'image-substring', value: 'elasticsearch' },
      { kind: 'image-substring', value: 'opensearch' },
      { kind: 'image-substring', value: 'kibana' },
      { kind: 'image-substring', value: 'tempo' },
      { kind: 'image-substring', value: 'jaeger' },
      { kind: 'image-substring', value: 'zipkin' },
      { kind: 'image-substring', value: 'otelcol' },
      { kind: 'image-substring', value: 'opentelemetry-collector' },
      { kind: 'image-regex', pattern: 'vector[^a-z]|^vector$', flags: 'i' },
    ],
    confidence: 0.90,
    notes:
      'Grafana Loki: https://grafana.com/oss/loki/. Fluent Bit: https://fluentbit.io/. ' +
      'OpenTelemetry Collector: https://opentelemetry.io/. ' +
      'Jaeger: https://www.jaegertracing.io/. Grafana Tempo: https://grafana.com/oss/tempo/.',
  },

  // -------------------------------------------------------------------------
  // Secrets management
  // -------------------------------------------------------------------------
  {
    role: 'secrets',
    signals: [
      { kind: 'image-substring', value: 'vault' },
      { kind: 'image-substring', value: 'infisical' },
      { kind: 'image-substring', value: 'doppler' },
      { kind: 'image-substring', value: 'bitwarden' },
      { kind: 'image-substring', value: 'vaultwarden' },
      { kind: 'image-substring', value: 'passbolt' },
      // Vault default UI port
      { kind: 'port', port: 8200 },
    ],
    confidence: 0.91,
    notes:
      'HashiCorp Vault: https://www.vaultproject.io/. Infisical: https://infisical.com/. ' +
      'Vaultwarden (Bitwarden-compatible): https://github.com/dani-garcia/vaultwarden.',
  },

  // -------------------------------------------------------------------------
  // DNS / ad-blocking
  // -------------------------------------------------------------------------
  {
    role: 'dns',
    signals: [
      { kind: 'image-substring', value: 'adguardhome' },
      { kind: 'image-substring', value: 'adguard-home' },
      { kind: 'image-substring', value: 'pihole' },
      { kind: 'image-substring', value: 'pi-hole' },
      { kind: 'image-substring', value: 'coredns' },
      { kind: 'image-substring', value: 'bind9' },
      { kind: 'image-substring', value: 'unbound' },
      { kind: 'image-regex', pattern: 'technitium.*dns|dns.*technitium', flags: 'i' },
      // DNS port
      { kind: 'port', port: 53 },
    ],
    confidence: 0.90,
    notes:
      'AdGuard Home: https://adguard.com/adguard-home.html. ' +
      'Pi-hole: https://pi-hole.net/. CoreDNS: https://coredns.io/. ' +
      'Unbound: https://nlnetlabs.nl/projects/unbound/.',
  },

  // -------------------------------------------------------------------------
  // Container orchestration / management UI
  // -------------------------------------------------------------------------
  {
    role: 'orchestration',
    signals: [
      { kind: 'image-substring', value: 'portainer' },
      { kind: 'image-substring', value: 'rancher' },
      { kind: 'image-substring', value: 'yacht' },
      { kind: 'image-substring', value: 'dockge' },
      { kind: 'image-substring', value: 'watchtower' },
      { kind: 'image-substring', value: 'ouroboros' },
      // Portainer default ports
      { kind: 'port', port: 9000 },
      { kind: 'port', port: 9443 },
    ],
    confidence: 0.89,
    notes:
      'Portainer: https://www.portainer.io/. Dockge: https://github.com/louislam/dockge. ' +
      'Watchtower: https://containrrr.dev/watchtower/.',
  },

  // -------------------------------------------------------------------------
  // Message queue / event broker
  // -------------------------------------------------------------------------
  {
    role: 'queue',
    signals: [
      { kind: 'image-substring', value: 'rabbitmq' },
      { kind: 'image-substring', value: 'nats' },
      { kind: 'image-substring', value: 'kafka' },
      { kind: 'image-substring', value: 'activemq' },
      { kind: 'image-substring', value: 'pulsar' },
      { kind: 'image-substring', value: 'mosquitto' },
      { kind: 'image-regex', pattern: 'emqx|hivemq', flags: 'i' },
      // Well-known broker ports
      { kind: 'port', port: 5672 },  // AMQP (RabbitMQ)
      { kind: 'port', port: 4222 },  // NATS
      { kind: 'port', port: 9092 },  // Kafka
      { kind: 'port', port: 1883 },  // MQTT
    ],
    confidence: 0.90,
    notes:
      'RabbitMQ: https://www.rabbitmq.com/. NATS: https://nats.io/. ' +
      'Apache Kafka: https://kafka.apache.org/. Eclipse Mosquitto: https://mosquitto.org/.',
  },

  // -------------------------------------------------------------------------
  // Version control / code hosting
  // -------------------------------------------------------------------------
  {
    role: 'vcs',
    signals: [
      { kind: 'image-substring', value: 'gitea' },
      { kind: 'image-substring', value: 'forgejo' },
      { kind: 'image-substring', value: 'gitlab' },
      { kind: 'image-substring', value: 'gogs' },
    ],
    confidence: 0.92,
    notes:
      'Gitea: https://gitea.io/. Forgejo: https://forgejo.org/. ' +
      'GitLab CE: https://about.gitlab.com/install/. Gogs: https://gogs.io/.',
  },

  // -------------------------------------------------------------------------
  // Code quality / static analysis
  // -------------------------------------------------------------------------
  {
    role: 'code-quality',
    signals: [
      { kind: 'image-substring', value: 'sonarqube' },
      { kind: 'image-substring', value: 'sonar-community' },
      { kind: 'label', key: 'sonarqube.version' },
    ],
    confidence: 0.88,
    notes:
      'SonarQube Community: https://www.sonarsource.com/products/sonarqube/.',
  },
];

// ---------------------------------------------------------------------------
// Signal evaluators
// ---------------------------------------------------------------------------

/**
 * Extract the image name (without digest or tag) from a Docker image string.
 * For example `ghcr.io/goauthentik/server:2024.8.1@sha256:abc` →
 * `ghcr.io/goauthentik/server`. Returns lower-cased so all comparisons are
 * case-insensitive by default.
 *
 * @param image - Raw image string from Docker service attributes.
 * @returns Image name portion (registry + repo), lower-cased.
 */
export function normalizeImageName(image: string): string {
  // Strip digest first, then tag.
  const noDigest = image.split('@')[0] ?? image;
  const noTag = noDigest.split(':')[0] ?? noDigest;
  return noTag.toLowerCase();
}

/**
 * Return true when `signal` matches the given service entity.
 *
 * Invariant #62: this function tests GENERIC observable signals only. No
 * homelab-specific instance names appear here.
 *
 * @param signal  - The signal to evaluate.
 * @param entity  - Service entity whose attributes are inspected.
 * @returns True when the signal fires for this entity.
 */
export function evaluateSignal(signal: RoleSignal, entity: Entity): boolean {
  const attrs = entity.attributes;

  if (signal.kind === 'image-substring' || signal.kind === 'image-regex') {
    const rawImage = typeof attrs['image'] === 'string' ? attrs['image'] : '';
    if (rawImage === '') return false;
    const imageName = normalizeImageName(rawImage);
    if (signal.kind === 'image-substring') {
      return imageName.includes(signal.value.toLowerCase());
    }
    try {
      return new RegExp(signal.pattern, signal.flags ?? 'i').test(imageName);
    } catch {
      return false;
    }
  }

  if (signal.kind === 'port') {
    const ports = attrs['ports'];
    if (!Array.isArray(ports)) return false;
    const portStr = String(signal.port);
    return (ports as unknown[]).some((p) => typeof p === 'string' && p.includes(portStr));
  }

  if (signal.kind === 'label') {
    const labels = attrs['labels'];
    if (typeof labels === 'string') {
      // Docker CLI serialises labels as a comma-separated "key=value,..." string.
      const hasKey = labels.includes(signal.key);
      if (!hasKey) return false;
      if (signal.valueSubstring === undefined) return true;
      const entry = labels.split(',').find((l) => l.trim().startsWith(signal.key));
      return entry !== undefined && entry.includes(signal.valueSubstring);
    }
    if (typeof labels === 'object' && labels !== null) {
      // Labels as a key→value map (e.g. from Kubernetes or Portainer API).
      const labelsObj = labels as Record<string, unknown>;
      if (!(signal.key in labelsObj)) return false;
      if (signal.valueSubstring === undefined) return true;
      const val = labelsObj[signal.key];
      return typeof val === 'string' && val.includes(signal.valueSubstring);
    }
    return false;
  }

  return false;
}

// ---------------------------------------------------------------------------
// classifyRole
// ---------------------------------------------------------------------------

/**
 * Classify a service entity against the role catalog.
 *
 * The first pattern (in catalog order) whose ANY signal matches wins.
 * Catalog entries list more-specific/higher-confidence signals first; the
 * first firing pattern's `confidence` is returned.
 *
 * Services that match no pattern return `null`. Unmatched services are
 * valid generic services — callers MUST NOT discard them (invariant #62).
 *
 * @param entity  - A graph entity (expected kind="service"; other kinds are
 *                  also accepted and classified purely on attribute signals).
 * @param catalog - Optional catalog override (defaults to SERVICE_ROLE_CATALOG).
 * @returns Classification with role + confidence, or `null` if no match.
 */
export function classifyRole(
  entity: Entity,
  catalog: RolePattern[] = SERVICE_ROLE_CATALOG,
): RoleClassification | null {
  for (const pattern of catalog) {
    for (const signal of pattern.signals) {
      if (evaluateSignal(signal, entity)) {
        return {
          role: pattern.role,
          confidence: pattern.confidence,
          matchedPattern: pattern,
        };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// RoleClassifier
// ---------------------------------------------------------------------------

/**
 * Logger interface for the classifier (narrow — callers inject their logger).
 */
export interface RoleClassifierLogger {
  info?(msg: string, ctx?: Record<string, unknown>): void;
  debug?(msg: string, ctx?: Record<string, unknown>): void;
  warn?(msg: string, ctx?: Record<string, unknown>): void;
}

const NULL_LOGGER: RoleClassifierLogger = {};

/**
 * Summary of a single classification pass.
 */
export interface ClassificationSummary {
  /** Total service entities inspected. */
  total: number;
  /** Entities that received a role. */
  classified: number;
  /** Entities that matched no pattern (still retained, no role assigned). */
  unclassified: number;
  /** Per-role counts: role → number of entities assigned to that role. */
  byRole: Record<string, number>;
}

/**
 * Annotates graph service entities with `attributes.role` and
 * `attributes.role_confidence` by reading all `kind="service"` entities
 * from the graph store and writing back via `upsertEntity`.
 *
 * Design (invariant #62):
 * - Classification is entirely data-driven; no homelab-specific service
 *   names appear here.
 * - Unmatched services are left unchanged (no role attribute added).
 * - Re-classifying an already-classified entity updates the attributes.
 */
export class RoleClassifier {
  private readonly graphStore: GraphStore;
  private readonly catalog: RolePattern[];
  private readonly logger: RoleClassifierLogger;
  private readonly clock: () => string;

  /**
   * @param graphStore   - Source and target graph store.
   * @param opts.catalog - Optional catalog override (defaults to
   *                       SERVICE_ROLE_CATALOG). Useful for tests.
   * @param opts.logger  - Optional structured logger.
   * @param opts.clock   - Optional clock override (returns ISO-8601 string).
   */
  constructor(
    graphStore: GraphStore,
    opts: {
      catalog?: RolePattern[];
      logger?: RoleClassifierLogger;
      clock?: () => string;
    } = {},
  ) {
    this.graphStore = graphStore;
    this.catalog = opts.catalog ?? SERVICE_ROLE_CATALOG;
    this.logger = opts.logger ?? NULL_LOGGER;
    this.clock = opts.clock ?? (() => new Date().toISOString());
  }

  /**
   * Classify all `kind="service"` entities in the graph store.
   *
   * Each entity is read, classified, and (if a match is found) upserted
   * back with `attributes.role` and `attributes.role_confidence` added.
   * Entities that match no pattern are left unmodified.
   *
   * @returns A summary of the classification pass.
   */
  async classify(): Promise<ClassificationSummary> {
    const now = this.clock();
    const services = await this.graphStore.entitiesByKind('service');
    const summary: ClassificationSummary = {
      total: services.length,
      classified: 0,
      unclassified: 0,
      byRole: {},
    };

    for (const entity of services) {
      const result = classifyRole(entity, this.catalog);
      if (result === null) {
        summary.unclassified++;
        this.logger.debug?.('role_classifier_no_match', {
          entityId: entity.id,
          image: entity.attributes['image'],
        });
        continue;
      }

      // Write role + confidence back to the entity attributes.
      const updated: Entity = {
        ...entity,
        last_seen: now,
        attributes: {
          ...entity.attributes,
          role: result.role,
          role_confidence: result.confidence,
        },
      };
      await this.graphStore.upsertEntity(updated);

      summary.classified++;
      summary.byRole[result.role] = (summary.byRole[result.role] ?? 0) + 1;

      this.logger.debug?.('role_classifier_matched', {
        entityId: entity.id,
        role: result.role,
        confidence: result.confidence,
        image: entity.attributes['image'],
      });
    }

    this.logger.info?.('role_classifier_complete', {
      total: summary.total,
      classified: summary.classified,
      unclassified: summary.unclassified,
      byRole: summary.byRole,
    });

    return summary;
  }
}
