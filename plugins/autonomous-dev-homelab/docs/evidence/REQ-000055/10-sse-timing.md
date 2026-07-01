# Evidence: Portal SSE Timing — REQ-000055
# Status: PENDING LIVE EXECUTION

## Procedure
1. Run `homelab discover` and `homelab observe scan` against live homelab.
2. Run `homelab portal` to start the panel server.
3. Open the homelab panel URL in a browser (default: http://localhost:3000).
4. Open browser dev-tools → Network tab, filter to EventStream.
5. Measure time from page load to first SSE metrics event.

## Expected Results
- No console errors.
- Inventory populated with 3 hosts.
- Observations listed (at least 1 per host).
- SSE metric updates within 5 seconds (per NFR-08).

## Screenshot
See 09-portal-panel.png (PENDING LIVE EXECUTION).

## Status
This evidence requires live homelab connectivity. Once the operator has:
1. Configured homelab.config.yaml
2. Set VAULT_ROLE_ID and VAULT_SECRET_ID
3. Run `homelab discover` + `homelab observe scan`
4. Started `homelab portal`

...then capture the screenshot and SSE timing here.
