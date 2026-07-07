/**
 * Discovery types: platform fingerprints and matched-platform results.
 *
 * Implements SPEC-001-1-02. The fingerprint catalog is consumed by the
 * PlatformProber; matches are returned to callers (the discover CLI in
 * SPEC-001-1-04) which translate them into inventory entries.
 */

export type PlatformType =
  | 'unraid'
  | 'proxmox-ve'
  | 'docker'
  | 'kubernetes'
  | 'docker-swarm'
  | 'portainer'
  | 'unifi'
  | 'truenas';

export interface FingerprintProbe {
  protocol: 'http' | 'https';
  port: number;
  path: string;
  method?: 'GET';
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface RegexMatch {
  kind: 'regex';
  pattern: string;
  flags?: string;
  confidence: number;
}

export interface JsonPathMatch {
  kind: 'jsonPath';
  path: string;
  equals?: unknown;
  exists?: true;
  confidence: number;
}

export type ExpectedResponse = RegexMatch | JsonPathMatch;

export interface Fingerprint {
  platformType: PlatformType;
  probe: FingerprintProbe;
  expectedResponse: ExpectedResponse;
  notes?: string;
}

export interface MatchedPlatform {
  platformType: PlatformType;
  ip: string;
  port: number;
  protocol: 'http' | 'https';
  confidence: number;
  matchedAt: string;
  responseSnippet?: string;
}

export interface HttpResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
}

export interface HttpClientGetOpts {
  headers: Record<string, string>;
  timeoutMs: number;
  allowSelfSigned: boolean;
}

export interface HttpClient {
  get(url: string, opts: HttpClientGetOpts): Promise<HttpResponse>;
}
