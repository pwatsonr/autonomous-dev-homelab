/**
 * Built-in enumerator registration.
 *
 * Importing this module registers all built-in PlatformEnumerators into the
 * global registry. Callers that need deep enumeration should import this
 * module (or individual enumerators) before constructing a DeepEnumerator.
 *
 * Docker Swarm is registered for three platform kinds that all share the
 * same Docker daemon API:
 *  - 'docker-swarm' — native Swarm manager
 *  - 'docker'       — standalone Docker host running in Swarm mode
 *  - 'portainer'    — Portainer management layer over a Swarm/Docker host
 *
 * Other platform stubs (proxmox-ve, kubernetes, unraid) are registered so
 * the architecture is complete; they return empty until fully implemented
 * (see individual stub files for TODO notes referencing issue #27).
 */

import { registerEnumerator } from '../enumerator.js';
import { DockerSwarmEnumerator } from './docker-swarm.js';
import { ProxmoxEnumerator } from './proxmox.js';
import { K3sEnumerator } from './k3s.js';
import { UnraidEnumerator } from './unraid.js';

// Docker / Swarm (primary homelab platform) — three kind aliases.
registerEnumerator(new DockerSwarmEnumerator('docker-swarm'));
registerEnumerator(new DockerSwarmEnumerator('docker'));
registerEnumerator(new DockerSwarmEnumerator('portainer'));

// Stubs — architecture complete, implementation deferred (issue #27).
registerEnumerator(new ProxmoxEnumerator());
registerEnumerator(new K3sEnumerator());
registerEnumerator(new UnraidEnumerator());
