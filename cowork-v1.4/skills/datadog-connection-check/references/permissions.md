# Datadog MCP permissions (from docs.datadoghq.com/mcp_server/setup/)

- Every MCP tool call runs as the signed-in Datadog user. The connector cannot see
  anything that user cannot see in the Datadog UI.
- Read tools require the `mcp_read` role permission **plus** the resource permission
  (for example Monitors Read, Hosts Read, Logs Read Data).
- Write tools require `mcp_write` plus the resource write permission. A read-only
  user's call to a write tool is rejected by Datadog.
- Users with the Datadog Standard Role have both MCP permissions by default. Custom
  roles: Organization Settings > Roles > edit role > check MCP Read (and MCP Write only
  if truly needed).
- Organization admins can turn MCP access and MCP write access on or off for the whole
  org under Organization Settings > Preferences, and can enable an IP allowlist.
- Fair-use limits: 50 tool calls per 10 seconds; 100,000 tool calls per month.
- All MCP tool calls are recorded in Datadog Audit Trail with tool name, arguments,
  user and client. Metrics: `datadog.mcp.session.starts`, `datadog.mcp.tool.usage`.

## Typical failures and what they mean
| Symptom | Meaning | Fix |
|---|---|---|
| No Datadog tools in session | Plugin not installed/enabled, or connector not authorized | Sources & Skills > Plugins > enable, then Connect |
| Sign-in loop / consent error | OAuth not completed for this Datadog org or site | Reconnect; confirm the org's site matches the package (US1, EU1, ...) |
| 403 on a read tool | Missing `mcp_read` or resource permission | Admin adds permission to the user's role |
| Empty host list | No agents reporting in the time window, or filter too narrow | Widen filter; check Infrastructure > Host List in Datadog |
