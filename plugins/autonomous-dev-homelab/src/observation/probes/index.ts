/**
 * Barrel export for every probe shipped by PLAN-002-1.
 * The collector (SPEC-002-1-04) accepts probes via constructor
 * injection; bootstrap code imports from here.
 */

export { BaseProbe } from './base.js';
export { K8sProbe } from './k8s.js';
export { DockerProbe } from './docker.js';
export { ProxmoxProbe } from './proxmox.js';
export { UnifiProbe } from './unifi.js';
export type { UnifiEvent, UnifiEventSource } from './unifi.js';
export { ZFSProbe, parseZpoolStatus } from './zfs.js';
export type { ZpoolExecSource } from './zfs.js';
export { SMARTProbe, parseSmartctl } from './smart.js';
export type { SmartExecSource } from './smart.js';
export { CertExpiryProbe } from './cert-expiry.js';
export type {
  CertEndpoint,
  CertFetcher,
  CertInfo,
  CertExpiryProbeOptions,
} from './cert-expiry.js';
export { BackupOverdueProbe } from './backup-overdue.js';
export type { BackupOverdueProbeOptions } from './backup-overdue.js';
// BackupManifestEntry is now the canonical v2 type from src/backup/types.ts (#46).
export type { BackupManifestEntry } from '../../backup/types.js';
export { DaemonHeartbeatProbe } from './daemon-heartbeat.js';
export type { DaemonHeartbeatProbeOptions } from './daemon-heartbeat.js';
export { AlertProbe, FetchAlertHttpSource, alertSeverity, alertResource, discoverEndpoint } from './alert.js';
export type {
  AlertHttpResponse,
  AlertHttpSource,
  AlertmanagerAlert,
  PrometheusAlert,
  AlertProbeOptions,
} from './alert.js';
