# TDD-001: Platform Discovery & Connection Layer

| Field        | Value                                              |
|--------------|----------------------------------------------------|
| **Title**    | Platform Discovery & Connection Layer              |
| **TDD ID**   | TDD-001                                            |
| **Version**  | 1.0                                                |
| **Date**     | 2026-04-28                                         |
| **Status**   | Draft                                              |
| **Author**   | Patrick Watson                                     |
| **Parent PRD** | PRD-001: Homelab Platform                        |
| **Plugin**   | autonomous-dev-homelab                             |

---

## 1. Summary

This TDD specifies platform auto-detection (with explicit per-CIDR operator consent), inventory management, and the connection layer (MCP-first when available, SSH+CLI fallback) for the autonomous-dev-homelab plugin.

It honors PRD-001 §25 binding updates: per-CIDR consent with 90-day expiry (§25.1), per-platform SSH certificates with 7-day rotation (§25.3), and explicit acknowledgment that 5/7 platforms are SSH-primary for MVP (§25.4).

## 2. Goals & Non-Goals

| ID    | Goal                                                                       |
|-------|-----------------------------------------------------------------------------|
| G-01  | Auto-detect 7 platforms (Unraid/Proxmox/Docker/k8s/Swarm/UniFi/TrueNAS).   |
| G-02  | Strict per-CIDR network-scan consent with 90-day expiry.                    |
| G-03  | Per-platform SSH certificates signed by operator-managed CA, 7-day rotation. |
| G-04  | MCP-first connection where available, SSH+CLI primary for MVP.              |
| G-05  | HMAC-chained audit log (cite autonomous-dev TDD-014 §22.3).                |

| ID     | Non-Goal                                                                |
|--------|--------------------------------------------------------------------------|
| NG-01  | Observation loop, fault detection, auto-fix (TDD-002).                  |
| NG-02  | Migration capability, backup orchestration (TDD-002).                   |
| NG-03  | Specialist agents (TDD-002).                                            |

## 3. Background

Operators run multi-platform homelabs. Discovering and connecting to each platform is platform-specific. The plugin must be respectful: never scan without explicit consent, use short-lived certificates rather than long-lived passwords, and audit every action.

## 4. Architecture

```
First-run discovery flow:
    Operator → CLI: discover --network 192.168.1.0/24
    Plugin → Operator: "I want to scan 192.168.1.0/24 for platforms. Approve?" (prompts ports + scan types)
    Operator: yes
    Plugin → consent.yaml: persist {cidr, approved_at, approved_by, expires_at, ports, types}
    Plugin → fingerprinter: parallel probe each IP × each port
    Plugin → operator: "Detected 4 platforms; approve to add to inventory?"
    Operator: yes
    Plugin → inventory.yaml: persist platforms with discovered metadata

Connection flow:
    User CLI: connect proxmox-001 --test
    Plugin → inventory.yaml: lookup platform
    Plugin → MCP discovery: is mcp-server-proxmox running locally?
        yes → use MCP
        no → SSH+CLI fallback using per-platform cert
    Plugin → audit.log: HMAC-chained record
```

## 5. Network Consent Model

```yaml
# <homelab-data>/network_consent.yaml
version: "1.0"
consents:
  - cidr: 192.168.1.0/24
    approved_at: "2026-04-28T10:00:00Z"
    approved_by: "patrick@homelab"
    expires_at: "2026-07-27T10:00:00Z"
    permitted_ports: [22, 80, 443, 2375, 2376, 6443, 8006, 8443]
    permitted_scan_types: [http_probe, ssh_probe, tcp_connect]
    network_fingerprint: "default_route=192.168.1.1; dns_servers=192.168.1.1"
  - cidr: 10.10.0.0/16
    approved_at: "2026-04-28T10:05:00Z"
    expires_at: "2026-07-27T10:05:00Z"
    note: "tailnet — approved for MCP discovery"
```

### ConsentManager TS

```typescript
class ConsentManager {
  async checkConsent(cidr: string): Promise<ConsentRecord | null> {
    const consents = await this.loadConsents();
    const matching = consents.find(c => cidrContains(c.cidr, cidr));
    if (!matching) return null;
    if (new Date(matching.expires_at) < new Date()) return null;
    if (await this.networkChanged(matching)) {
      // operator must re-approve when network topology changes
      return null;
    }
    return matching;
  }

  async requestConsent(cidr: string, ports: number[], scanTypes: string[]): Promise<boolean> {
    const fingerprint = await this.networkFingerprint();
    const granted = await prompt(
      `Scan ${cidr} for platforms? Ports: ${ports.join(",")}. Scan types: ${scanTypes.join(",")}.\n` +
      `Network fingerprint: ${fingerprint}. Approve? (y/N)`
    );
    if (!granted) return false;
    await this.saveConsent({ cidr, approved_at: new Date().toISOString(), expires_at: in90Days(), ports, scanTypes, fingerprint });
    return true;
  }

  async networkFingerprint(): Promise<string> {
    const route = await execFile("ip", ["route", "show", "default"]);
    const dns = await fs.readFile("/etc/resolv.conf", "utf8");
    return `route=${route.stdout.match(/via (\S+)/)?.[1]};dns=${dns.match(/nameserver (\S+)/g)?.join(",")}`;
  }
}
```

## 6. Platform Fingerprints

| Platform | Probe | Expected Response | Confidence |
|----------|-------|-------------------|------------|
| Unraid | HTTP 80 GET / | `<title>Unraid` in HTML | 0.95 |
| Proxmox VE | HTTPS 8006 GET / | `<title>Proxmox` in HTML | 0.95 |
| Docker | TCP 2375 GET /version | JSON with `ApiVersion`, `Os: linux` | 0.99 |
| Kubernetes | HTTPS 6443 GET /healthz | `ok` text | 0.90 |
| Docker Swarm | HTTP 2376 GET /info | JSON with `Swarm.LocalNodeState` | 0.95 |
| UniFi | HTTPS 8443 GET / | `<title>UniFi` + cert SAN | 0.85 |
| TrueNAS | HTTPS 443 GET /api/v2.0/system/info | JSON with `version: TrueNAS-SCALE` | 0.95 |

## 7. Inventory Schema

```yaml
# <homelab-data>/inventory.yaml
version: "1.0"
platforms:
  - id: proxmox-prod-01
    type: proxmox-ve
    host: 192.168.1.10
    port: 8006
    ssh_host: 192.168.1.10
    ssh_port: 22
    discovered_at: "2026-04-28T10:00:00Z"
    last_seen: "2026-04-28T10:30:00Z"
    metadata:
      version: "7.4-3"
      cluster_name: "homelab"
      node_count: 3
    connection:
      preferred: ssh   # or "mcp" if mcp-server-proxmox installed
      mcp_endpoint: null
      ssh_cert_path: "<homelab-data>/keys/proxmox-prod-01.cert"
```

## 8. Connection Layer

```typescript
abstract class Connection {
  abstract async connect(): Promise<void>;
  abstract async exec(command: string): Promise<{stdout: string; stderr: string; exitCode: number}>;
  abstract async disconnect(): Promise<void>;
}

class ProxmoxConnection extends Connection {
  private mcp?: MCPClient;
  private ssh?: SSHClient;

  async connect(): Promise<void> {
    if (await this.tryMCP()) return;
    await this.fallbackSSH();
  }

  private async tryMCP(): Promise<boolean> {
    try {
      this.mcp = await MCPClient.connect("mcp-server-proxmox", { host: this.platform.host });
      return true;
    } catch {
      return false;
    }
  }

  private async fallbackSSH(): Promise<void> {
    this.ssh = new SSHClient({
      host: this.platform.ssh_host,
      port: this.platform.ssh_port,
      username: "root",
      privateKey: await fs.readFile(this.platform.connection.ssh_cert_path)
    });
    await this.ssh.connect();
  }

  async exec(command: string) {
    if (this.mcp) return this.mcp.invoke("proxmox.exec", { command });
    return this.ssh!.exec(command);
  }
}

// Similar implementations for DockerConnection, K8sConnection, UnifiConnection, TrueNasConnection, UnraidConnection
```

## 9. SSH Certificate Authority

Operator-managed CA at `<homelab-data>/ca/`. CA private key encrypted at rest with operator-supplied passphrase.

```typescript
class SSHCertificateManager {
  private caKeyPath = "<homelab-data>/ca/homelab_ca.key";
  private caPubPath = "<homelab-data>/ca/homelab_ca.pub";

  async initializeCA(passphrase: string): Promise<void> {
    if (await fileExists(this.caKeyPath)) throw new Error("CA already exists");
    await execFile("ssh-keygen", ["-t", "ed25519", "-f", this.caKeyPath, "-N", passphrase, "-C", "autonomous-dev-homelab-ca"]);
  }

  async signPlatformCert(platformId: string, validityDays: number = 7): Promise<string> {
    const userKeyPath = `<homelab-data>/keys/${platformId}.key`;
    const certPath = `<homelab-data>/keys/${platformId}.cert`;

    // Generate user keypair if not exists
    if (!await fileExists(userKeyPath)) {
      await execFile("ssh-keygen", ["-t", "ed25519", "-f", userKeyPath, "-N", ""]);
    }

    // Sign with CA
    await execFile("ssh-keygen", [
      "-s", this.caKeyPath,
      "-I", `${platformId}-${Date.now()}`,
      "-n", "root",
      "-V", `+${validityDays}d`,
      "-O", "force-command=/bin/sh",  // optional command restriction
      `${userKeyPath}.pub`
    ]);

    return certPath;
  }

  async revokeKeys(platformId: string): Promise<void> {
    // Add to revocation list at <homelab-data>/ca/revocation.list
    // Notify all platforms to refresh authorized_keys (out-of-band)
    await this.appendRevocationList(platformId);
  }

  async rotateKey(platformId: string): Promise<void> {
    await this.revokeKeys(platformId);
    await this.signPlatformCert(platformId);
    // Operator must distribute new pub key to platform's authorized_keys
  }
}
```

CA public key (`homelab_ca.pub`) gets added to each platform's `/etc/ssh/sshd_config` as `TrustedUserCAKeys`. This is a one-time manual setup; subsequent cert rotations require no platform-side change.

## 10. MCP Integration

At first run, plugin probes for installed MCP servers via the standard MCP discovery mechanism (config in `.mcp.json` of operator's Claude Code install). Available MCP servers per platform:

| Platform | MCP Server | Status |
|----------|-----------|--------|
| Proxmox VE | mcp-server-proxmox (community) | Available |
| Kubernetes | mcp-server-kubernetes (community) | Available |
| Unraid | mcp-server-unraid | Future |
| Docker | mcp-server-docker | Future (community work) |
| UniFi | mcp-server-unifi | Future |
| TrueNAS | mcp-server-truenas | Future |
| Docker Swarm | (none) | SSH-primary permanent |

When an MCP server is available, the connection prefers it. Otherwise SSH+CLI is used.

## 11. Authentication

| Platform | Primary | Notes |
|----------|---------|-------|
| Proxmox | API token (env: `PROXMOX_API_TOKEN`) + SSH cert | Token for API calls; SSH for shell ops |
| Docker | TLS client cert (env: `DOCKER_TLS_CERT_PATH`) | Or unix socket if local |
| Kubernetes | kubeconfig file path (env: `KUBECONFIG`) | Standard k8s auth |
| UniFi | API key (env: `UNIFI_API_KEY`) | Controller API |
| TrueNAS | API token (env: `TRUENAS_API_TOKEN`) | |
| Unraid | Session cookie via web auth + SSH cert | Unraid lacks API tokens |

All secrets via env-var references; never stored plaintext in inventory.yaml.

## 12. Audit Log

HMAC-SHA256 chained, `<homelab-data>/audit.log`. Same model as autonomous-dev TDD-014 §22.3.

```typescript
class AuditLogger {
  private hmacKey: Buffer;          // loaded from <homelab-data>/.audit-key (mode 0600)
  private lastHash: string = "";

  async log(event: { actor: string; action: string; resource: string; details: any }): Promise<void> {
    const entry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...event,
      previous_hash: this.lastHash
    };
    const data = JSON.stringify(entry);
    const hash = createHmac("sha256", this.hmacKey).update(data).digest("hex");
    await fs.appendFile(this.logPath, JSON.stringify({ ...entry, entry_hash: hash }) + "\n");
    this.lastHash = hash;
  }

  async verify(): Promise<{valid: boolean; errors: string[]}> { /* walks chain, validates each HMAC */ }
}
```

## 13. CLI Commands

```bash
autonomous-dev-homelab discover --network 192.168.1.0/24
autonomous-dev-homelab inventory list
autonomous-dev-homelab inventory show proxmox-prod-01
autonomous-dev-homelab connect proxmox-prod-01 --test
autonomous-dev-homelab consent list
autonomous-dev-homelab consent approve --cidr 10.0.0.0/8
autonomous-dev-homelab consent revoke --cidr 192.168.1.0/24
autonomous-dev-homelab keys init    # one-time CA bootstrap
autonomous-dev-homelab keys rotate --platform proxmox-prod-01
autonomous-dev-homelab keys revoke --platform old-server
autonomous-dev-homelab audit verify
```

## 14. Test Strategy

- Mock-probe fixtures per platform (5+ per): valid response, missing service, slow response, malformed response, false positive (e.g., generic Apache returning Unraid-like html — must not match)
- Consent flow: refusal, expiry, network change detection
- SSH cert lifecycle: generate, sign, distribute, rotate, revoke
- Audit log integrity: tamper detection on every chain entry

## 15. Performance

- Discovery scan: <30s for /24 with 8 ports each
- Connection establishment p95: <5s (SSH); <2s (MCP if available)
- SSH cert generation: <2s per platform

## 16. Migration & Rollout

- Phase 1 (Weeks 1-2): SSH+CLI for all 7 platforms; consent + inventory + cert authority
- Phase 2 (Weeks 3-4): MCP integration for Proxmox + Kubernetes (where servers exist)
- Phase 3 (later): Add MCP servers as they mature in the community

## 17. Open Questions

1. CA distribution: how is the CA pub key initially deployed to each platform's sshd_config? (Manual at install, then auto-rotation works)
2. Multi-operator homelabs: per-operator certs or shared?
3. Network segmentation: discovery across VLANs requires multi-CIDR consent — workflow?
4. Platform IP changes (DHCP): re-probing strategy?

## 18. References

- Homelab PRD-001 §25 (whole, especially §25.1 / §25.3 / §25.4)
- autonomous-dev TDD-014 §22.3 (HMAC chain audit pattern)
- autonomous-dev PRD-009 §22.3 (audit log pattern reference)
- RFC 4716 (SSH public key file format)
