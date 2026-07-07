/**
 * Static catalog of platform fingerprints. Implements SPEC-001-1-02 §
 * "Catalog Contents".
 *
 * v1 catalog: 7 entries, all confidences in [0.85, 0.99]. Each entry
 * cites the upstream documentation URL in `notes` so future maintainers
 * can verify the probe still works when a platform changes its API.
 *
 * Adding a platform post-v1 is a one-line append. New scan types
 * (currently only `http_probe`) require coordinated changes elsewhere.
 */

import type { Fingerprint } from './types.js';

export const PROBER_USER_AGENT = 'autonomous-dev-homelab-prober/0.1';

export const PLATFORM_FINGERPRINTS: Fingerprint[] = [
  {
    platformType: 'unraid',
    probe: { protocol: 'https', port: 443, path: '/login' },
    expectedResponse: {
      kind: 'regex',
      pattern: 'Unraid\\.net|/webGui/styles/',
      confidence: 0.92,
    },
    notes:
      'Unraid login page typically references /webGui/styles/ assets and Unraid.net account integration. Docs: https://docs.unraid.net/',
  },
  {
    platformType: 'proxmox-ve',
    probe: { protocol: 'https', port: 8006, path: '/api2/json/version' },
    expectedResponse: {
      kind: 'jsonPath',
      path: '$.data.version',
      exists: true,
      confidence: 0.98,
    },
    notes:
      'Proxmox VE API: GET /api2/json/version returns { data: { version, repoid, release } }. Docs: https://pve.proxmox.com/pve-docs/api-viewer/',
  },
  {
    platformType: 'docker',
    probe: { protocol: 'http', port: 2375, path: '/_ping' },
    expectedResponse: {
      kind: 'regex',
      pattern: '^OK$',
      confidence: 0.95,
    },
    notes:
      'Docker Engine API: GET /_ping returns 200 with body "OK". Docs: https://docs.docker.com/engine/api/',
  },
  {
    platformType: 'kubernetes',
    probe: { protocol: 'https', port: 6443, path: '/version' },
    expectedResponse: {
      kind: 'jsonPath',
      path: '$.gitVersion',
      exists: true,
      confidence: 0.99,
    },
    notes:
      'Kubernetes API server: GET /version returns { major, minor, gitVersion, ... }. Docs: https://kubernetes.io/docs/reference/using-api/',
  },
  {
    platformType: 'docker-swarm',
    probe: { protocol: 'http', port: 2377, path: '/info' },
    expectedResponse: {
      kind: 'jsonPath',
      path: '$.Swarm.NodeID',
      exists: true,
      confidence: 0.95,
    },
    notes:
      'Docker Swarm cluster management endpoint exposes /info with Swarm.NodeID populated when active. Docs: https://docs.docker.com/engine/swarm/',
  },
  {
    platformType: 'unifi',
    probe: { protocol: 'https', port: 8443, path: '/manage/account/login' },
    expectedResponse: {
      kind: 'regex',
      pattern: 'UniFi|ubiquiti',
      flags: 'i',
      confidence: 0.9,
    },
    notes:
      'UniFi Network Application login page references UniFi/Ubiquiti branding. Docs: https://help.ui.com/hc/en-us/articles/360012282453',
  },
  {
    platformType: 'truenas',
    probe: { protocol: 'https', port: 443, path: '/api/v2.0/system/info' },
    expectedResponse: {
      kind: 'jsonPath',
      path: '$.system_serial',
      exists: true,
      confidence: 0.97,
    },
    notes:
      'TrueNAS REST API v2: GET /api/v2.0/system/info returns hardware/serial info. Docs: https://www.truenas.com/docs/api/',
  },
  {
    platformType: 'portainer',
    probe: { protocol: 'https', port: 9443, path: '/api/status' },
    expectedResponse: {
      kind: 'jsonPath',
      path: '$.InstanceID',
      exists: true,
      confidence: 0.97,
    },
    notes:
      'Portainer CE/EE management UI: GET /api/status returns { Version, InstanceID, ... } over HTTPS (self-signed cert common in homelabs). This is the reliable fingerprint for a Portainer instance managing a Docker Swarm. Port 9443 is the default HTTPS port for Portainer CE v2.x+. Docs: https://docs.portainer.io/api/access',
  },
];

/**
 * Returns the union of all `probe.port` values in the default catalog.
 * Used by the discover CLI to construct the default `permitted_ports`
 * list when requesting a new consent.
 */
export function getDefaultPermittedPorts(catalog: Fingerprint[] = PLATFORM_FINGERPRINTS): number[] {
  const ports = new Set<number>();
  for (const fp of catalog) ports.add(fp.probe.port);
  return Array.from(ports).sort((a, b) => a - b);
}
