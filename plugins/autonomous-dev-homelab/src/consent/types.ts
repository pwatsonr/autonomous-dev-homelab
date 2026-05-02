/**
 * Type definitions matching the network-consent-v1.json schema.
 *
 * These are the runtime contract between ConsentManager and its callers
 * (the prober in SPEC-001-1-02 and the CLI in SPEC-001-1-04).
 */

export type ScanType = 'http_probe' | 'ssh_probe' | 'tcp_connect';

export interface Consent {
  cidr: string;
  approved_at: string;
  expires_at: string;
  approved_by?: string;
  note?: string;
  network_fingerprint?: string;
  permitted_ports: number[];
  permitted_scan_types: ScanType[];
}

export interface ConsentFile {
  version: '1.0';
  consents: Consent[];
}
