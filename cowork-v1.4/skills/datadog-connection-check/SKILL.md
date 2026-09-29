---
name: datadog-connection-check
description: |
  Verifies that the Datadog connector is connected and working, then reports what it
  can see with real evidence. Use when user asks to "check the Datadog connection",
  "is Datadog connected", "verify the Datadog plugin", "what Datadog tools do I have",
  "test Datadog", or before any Datadog task when the connection state is unknown.
license: MIT
metadata:
  author: Daryl Yourk
  version: "1.4"
---

# Datadog connection check

## What this skill does
Proves, with an actual tool result, that Cowork can reach the user's Datadog
organization through the Datadog MCP connector - and says plainly when it cannot.

## Workflow
1. Confirm the Datadog connector tools are present in this session. Expected core
   tools include `search_datadog_hosts`, `search_datadog_monitors`,
   `search_datadog_dashboards`, `get_datadog_metric`, `search_datadog_logs`.
   If none are present, stop and report **Not connected** with the stage that is
   missing (plugin not installed, connector not authorized, or tools not listed).
   Never simulate results.
2. Run one small read: `search_datadog_hosts` with a tight filter (a host name the
   user gave, otherwise the 5 most recently reporting hosts).
3. If step 2 is denied (403 / permission error), report **Connected, insufficient
   permissions** and name the missing permission: MCP tools need `mcp_read` plus the
   resource permission (Hosts Read here). See `references/permissions.md`.
4. Run one second read to show breadth: `search_datadog_monitors` (limit 5).
5. Report.

## Output format
**Datadog connection: Connected / Not connected / Connected, insufficient permissions**

| Check | Tool | Result |
|---|---|---|
| Tools discovered | (session) | 19 tools listed |
| Host read | search_datadog_hosts | 1 host: HP11D, last reported 10:14 UTC |
| Monitor read | search_datadog_monitors | 5 monitors, 0 alerting |

Retrieved at: <UTC timestamp>. Datadog site: <site inferred from results or unknown>.
Then one line on what the user can do next with the other Datadog skills.

## Rules
- A tool result is the only acceptable proof. Never describe a connection as working
  from a plugin icon, a manifest, or an earlier session.
- Distinguish "no data returned" from "not connected" from "not permitted".
- Never ask for API keys, application keys, tokens or OAuth URLs; the connector
  authenticates through Datadog's own sign-in.

## Additional resources
- `references/permissions.md` - Datadog MCP permission model and fixes.
- `references/tool-catalog.md` - core tools, what each returns, required permissions.
