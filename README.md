# autonomous-dev-homelab

A sibling plugin repo for [`autonomous-dev`](https://github.com/pwatson/autonomous-dev) that
brings the same spec-driven, audited automation pipeline to homelab
infrastructure: discovery, connection, observation, safety-gated autofix,
migration, and deployment across Proxmox VE, Kubernetes/k3s, Unraid, TrueNAS,
UniFi, Docker / Docker Swarm.

## What's in here

- **`plugins/autonomous-dev-homelab/`** — the plugin itself. See its
  [README](plugins/autonomous-dev-homelab/README.md) for the full guide:
  features, CLI surface, configuration, architecture, and the 7 specialist
  agents bundled with the plugin.
- **`docs/`** — the design corpus driving the plugin:
  - **PRD**: [`docs/prd/PRD-001-homelab-platform.md`](docs/prd/PRD-001-homelab-platform.md)
    — product requirements (150 FRs, 10 NFRs, security model, 7-platform
    support matrix).
  - **TDDs**:
    - [`TDD-001-platform-discovery-connection.md`](docs/tdd/TDD-001-platform-discovery-connection.md)
      — network-consent model, fingerprint catalog, inventory schema,
      MCP-first / SSH-fallback connection layer, SSH CA, audit log.
    - [`TDD-002-observation-autofix-migration.md`](docs/tdd/TDD-002-observation-autofix-migration.md)
      — fault-pattern catalog, 9 platform probes, observation→request
      promotion, destructiveness ladder, typed-CONFIRM modal + 24h delay,
      specialist agents, migration framework, deploy backends, portal
      integration.
  - **Plans**: 6 implementation plans in [`docs/plans/`](docs/plans/) decompose
    the two TDDs into 29 specs. All 6 plans merged.
  - **Specs**: 29 implementation specs in [`docs/specs/`](docs/specs/) — each
    one a `Files to Create/Modify` table plus Given/When/Then acceptance
    criteria, fully traceable to its parent TDD section.

## Status

- TDD-001 ✅ complete (3 plans, 14 specs).
- TDD-002 ✅ complete (3 plans, 15 specs).
- Test suite: **697 passing / 37 skipped** across 65 suites
  (`cd plugins/autonomous-dev-homelab && npx jest`).
  Skipped suites are integration tests requiring `kind`, OpenSSH containers,
  or live MCP servers; they're opt-in via environment.

## Quick start

```bash
cd plugins/autonomous-dev-homelab
npm install
npx jest                         # run unit tests
npx tsc --noEmit                 # typecheck
node dist/cli/index.js --help    # after build, see all subcommands
```

See the [plugin README](plugins/autonomous-dev-homelab/README.md) for the full
operator workflow (discover → connect → observe → fix), env-var configuration,
and architecture diagram.

## License

[MIT](LICENSE).
