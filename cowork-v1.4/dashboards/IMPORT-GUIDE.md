# Darbotlabs Datadog dashboards & monitors — import guide

Built for the integrations installed in the Darbotlabs org (US1): GitHub, GitHub Copilot,
Microsoft Copilot, Microsoft 365 Audit Logs, Microsoft Entra ID, Microsoft Graph, Microsoft
Teams, plus the Datadog Agent on HP11D. Every metric name comes from Datadog's integration
documentation; nothing is synthetic. Panels stay empty until the integration actually ships data.

## Dashboards
| File | What it shows | Data source |
|---|---|---|
| `darbotlabs-ai-copilot-adoption.dashboard.json` | DAU/WAU/MAU, prompts→generations→acceptances, lines suggested vs added, by IDE / feature / language / model, PR lifecycle, seats, CLI tokens, AI credits; M365 Copilot enabled vs active by app, prompts, responses, guardrails | `github_copilot.*`, `microsoft_copilot.*` |
| `darbotlabs-github-activity-security.dashboard.json` | PRs, pushes, releases, issues; Dependabot/advisory events; audit-log stream; change overlay on HP11D CPU | GitHub webhook events (`source:github`), audit logs |
| `darbotlabs-hp11d-infrastructure.dashboard.json` | CPU, memory, disk, network, load, uptime, NTP offset, agent health for HP11D | Datadog Agent `system.*`, `ntp.offset`, `datadog.agent.*` |
| `darbotlabs-datadog-mcp-usage.dashboard.json` | MCP sessions and tool calls by client / tool / user — **shows the Cowork plugin's calls once it connects** | `datadog.mcp.session.starts`, `datadog.mcp.tool.usage`, Audit Trail |

## Monitors (`darbotlabs-monitors.json`)
HP11D stopped reporting · HP11D disk > 85% · GitHub Copilot DAU dropped > 50% WoW ·
GitHub Copilot seats inactive this cycle · Datadog MCP tool-call burst · New GitHub security event.

## Three ways to create them
1. **UI import** — Dashboards → New Dashboard → ⚙ (top right) → *Import dashboard JSON* → paste a
   file. Monitors: Monitors → New Monitor → *Import Monitor from JSON* (one monitor object each).
2. **Script** — on HP11D: set `DD_API_KEY` and `DD_APP_KEY` (app key scoped to dashboards_write,
   monitors_write) then `python push_to_datadog.py --site datadoghq.com --apply`.
3. **From Cowork** — with `datadog-cowork-1.4.0-us1-core.zip` connected (the profile that includes
   `upsert_datadog_dashboard`), attach a dashboard JSON to a task and say
   "create this dashboard in Datadog". The read-only package cannot do this by design.

## Known gaps (honest)
- GitHub Code Scan / Secret Scan metric names are not printed in Datadog's public doc page;
  the dashboard leaves a note widget to pin them from Metrics Explorer.
- Integrations showing a warning triangle (Active Directory, Hugging Face TGI, Fabric, NVIDIA
  DCGM/NVML/Triton, Ray, Unifi) need an Agent check configured on a host before any metric exists;
  no dashboards were built for them to avoid empty, misleading boards.
- Entra ID, Graph, Teams and M365 Audit Logs integrations are log-based; their data lands in Logs
  (source: `microsoft-entra-id`, `microsoft-graph`, `microsoft-teams`, `microsoft-365-audit-logs`).
  Add log widgets once you confirm the exact source names in Log Explorer.
