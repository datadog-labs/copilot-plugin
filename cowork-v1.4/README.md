# Datadog for Microsoft 365 Copilot Cowork — v1.4.0 (evaluation)

Cowork plugin packages that connect Copilot Cowork to Datadog's official MCP Server, plus
eight observability skills, a packaging toolchain, draft dashboards/monitors, and a
single-file HTML wiki. This folder sits alongside the existing `cowork/` work and does not
replace it.

> **Status: evaluation candidate.** Package structure passes offline checks (18 tests,
> custom validator for Microsoft's published Cowork packaging rules). Tenant upload, Datadog
> OAuth through Cowork, live `tools/list`, and a live read have **not** been verified.

## Layout
| Path | What it is |
|---|---|
| `dist/` | Built packages + `SHA256SUMS`. `us1-readonly` is the recommended candidate. `sites.zip` is a bundle of regional packages (unzip first; not directly uploadable). |
| `skills/` | 8 skills: connection-check, host-health, monitor-triage, incident-brief, log-investigation, dashboard-explorer, service-trace, metric-explorer. Authored, not live-tested. |
| `build.py` | Builds v1.28 packages: `--site us1|us3|us5|eu1|ap1|ap2|uk1 --profile readonly|core [--toolsets] [--subdomain] --output x.zip`; `--openplugin DIR` for Agent Plugins layout. Refuses to overwrite. |
| `validate.py`, `test_build.py` | Offline rule checks and 18 unit tests (`python3 -m unittest test_build`). Not a substitute for platform upload validation. |
| `catalog/core-tools.json` | Datadog MCP core tool reference (names/permissions from Datadog docs). |
| `dashboards/` | Generator + 4 draft dashboard JSONs + 6 draft monitors + `push_to_datadog.py`. **Drafts — not deployed or tenant-validated.** |
| `docs/datadog-cowork-build-wiki.html` | Self-contained ClippySlide wiki (36 two-sided cards, searchable). Opens offline. |

## Important limits
- **Read-only is tool filtering, not authorization.** The `readonly` URL omits
  `create_datadog_notebook`, `edit_datadog_notebook`, `upsert_datadog_dashboard`. Enforce with a
  Datadog role that has `mcp_read` and **not** `mcp_write`.
- The `readonly-alerting-llmobs` variant **does not omit `create_datadog_monitor`** from the
  alerting toolset. Don't use it as a read-only rollout.
- Auth: the connector omits `authorization` (Cowork-only DCR path). Whether Datadog's
  registration meets Microsoft's requirements for this flow is unverified.
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

## Validation runbook (to do)
1. Upload `dist/datadog-cowork-1.4.0-us1-readonly.zip` (personal via ATK, or tenant admin center).
2. Cowork → Sources & Skills → Plugins → Connect → Datadog sign-in (choose Limited if offered).
3. New task: "Check the Datadog connection." Record: tools discovered, one `search_datadog_hosts`
   result with UTC time, and the matching `datadog.mcp.tool.usage` / Audit Trail entry.
4. Only then mark stages as verified.

Community package by Daryl Yourk (MIT). Not an official Datadog or Microsoft product.
Sources: docs.datadoghq.com/mcp_server/, learn.microsoft.com/microsoft-365/copilot/cowork/cowork-plugin-development.
