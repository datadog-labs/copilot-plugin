# Datadog for Microsoft 365 Copilot Cowork — v1.5.0

Cowork plugin that connects Copilot Cowork to Datadog's official MCP Server, with eight
observability skills, the Datadog sign-in service the plugin connects through (`bridge/`), Microsoft
token-store registration (`register/`), a packaging toolchain, draft dashboards/monitors, and a
single-file HTML wiki. Everything the plugin needs is in this folder; VS Code is not involved.

> **Status (2026-09-29):** bridge deployed and tested (20 end-to-end tests with a mock Datadog, plus live
> discovery, registration and sign-in redirect against Datadog US1); Microsoft's token service
> registered its DCR client at the bridge; 1.5.0 accepted by the Microsoft 365 package service and
> installed. Cowork Connect and a live Datadog read are the remaining check. History of every attempt:
> [RELEASES.md](RELEASES.md).

## Why a bridge

Datadog's VS Code extension signs in by running OAuth in its own code (PKCE S256 and a token exchange
that includes `code_verifier`). Microsoft's token store cannot do that with Datadog directly: Datadog's
MCP server sends no `WWW-Authenticate` challenge, Datadog's DCR issues no client secret, and the token
store omits `code_verifier` (RELEASES.md 1.4.1-1.4.5). A plugin package is declarative, so the
extension's sign-in runs as a small service, [bridge/](bridge/README.md), that the connector points at.

## Layout
| Path | What it is |
|---|---|
| `bridge/` | Datadog OAuth bridge: the VS Code extension's sign-in flow as a zero-dependency Node service, Dockerfile, Azure Container Apps deploy script, tests. See [bridge/README.md](bridge/README.md). |
| `register/dcr/`, `register/oauth/` | Agents Toolkit projects that create the Microsoft token-store configuration for the bridge (DCR, or static OAuth with a bridge-issued client). `env/` files stay local. |
| `dist/` | Built packages + `SHA256SUMS`. `us1-readonly` is the recommended candidate. `sites.zip` is a bundle of regional packages (unzip first; not directly uploadable). |
| `skills/` | 8 skills: connection-check, host-health, monitor-triage, incident-brief, log-investigation, dashboard-explorer, service-trace, metric-explorer. Authored, not live-tested. |
| `build.py` | Builds v1.28 packages: `--site us1|us3|us5|eu1|ap1|ap2|uk1 --profile readonly|core [--toolsets] [--subdomain] [--bridge URL] [--auth dcr|oauth|apikey --reference-id ID] --output x.zip`; `--openplugin DIR` for Agent Plugins layout. Refuses to overwrite. |
| `test_build.py` | Offline unit tests for the package builder. |
| `catalog/core-tools.json` | Datadog MCP core tool reference (names/permissions from Datadog docs). |
| `dashboards/` | Generator + 4 draft dashboard JSONs + 6 draft monitors + `push_to_datadog.py`. **Drafts — not deployed or tenant-validated.** |
| `docs/datadog-cowork-build-wiki.html` | Self-contained ClippySlide wiki (36 two-sided cards, searchable). Opens offline. |

## Important limits
- **Read-only is tool filtering, not authorization.** The `readonly` URL omits
  `create_datadog_notebook`, `edit_datadog_notebook`, `upsert_datadog_dashboard`. Enforce with a
  Datadog role that has `mcp_read` and **not** `mcp_write`.
- The `readonly-alerting-llmobs` variant **does not omit `create_datadog_monitor`** from the
  alerting toolset. Don't use it as a read-only rollout.
- Auth: build with `--bridge <url> --auth dcr --reference-id <id>`. A build without `--auth` that points
  straight at `mcp.datadoghq.com` installs but cannot connect (RELEASES.md 1.4.1).
- Only the US1 endpoint is documented-exact; other sites are builder configurations. UK1 is derived.
- Dashboards: metric names come from Datadog integration docs; tag prefixes, template
  variables (`$host` defaults to all hosts), and units still need checking in a real org.
- Monitors use `@REPLACE-WITH-ALERT-RECIPIENT`; set a real recipient before enabling.
- `push_to_datadog.py --apply` is not idempotent (re-runs duplicate) and has no rollback. Prefer
  UI import after review.

## Changes in this check-in vs. earlier local drafts
- Fixed a generator bug that produced a malformed "HP11D CPU with GitHub pushes overlaid" widget
  (one query per character). Dashboards regenerated.
- Replaced personal email recipients in monitors with a placeholder; redacted account emails in the wiki.

## Build, register, install, connect
1. Deploy the bridge: `bridge/deploy/Deploy-Bridge.ps1` (or any HTTPS host; see bridge/README.md).
2. `register/dcr`: set `DATADOG_BRIDGE_URL` in `env/.env.dev`, run `atk provision --env dev`.
3. `python build.py --site us1 --profile readonly --bridge <bridge url> --auth dcr --reference-id <DATADOG_DCR_CONFIGURATION_ID> --output dist/datadog-cowork-1.5.0-us1-readonly-bridge-dcr.zip`
4. Uninstall the previous build (`atk uninstall -i false --mode manifest-id --manifest-id <id> --options m365-app`),
   then `atk install --file-path dist/<zip> --scope Personal`.
5. Cowork → the Datadog plugin → Connect → Datadog sign-in. New task: "Check the Datadog connection."
   Record the tools called and one `search_datadog_monitors` result with the UTC time in RELEASES.md.

Community package by Daryl Yourk (MIT). Not an official Datadog or Microsoft product.
Sources: docs.datadoghq.com/mcp_server/, learn.microsoft.com/microsoft-365/copilot/cowork/cowork-plugin-development.
