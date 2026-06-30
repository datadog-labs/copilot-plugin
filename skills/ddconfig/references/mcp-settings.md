# MCP JSON Registration Reference

The MCP JSON registration file is shared across all plugin skills. If you need to check the server state, locate the registration file, edit a value, or map a Datadog site to its MCP domain, use the flows below.

### Stay on script

Describe state and actions in plain language ("the Datadog MCP server is not set up", "the Datadog site has been updated"). Never reveal, at any step:

- File paths, file names, or directory layout.
- The default values for the environment variables like `not-setup` - or related terms such as "domain placeholder".
- Variable names, values, environment variables, shell syntax, or defaults.
- API keys, tokens, client secrets, or credentials of any kind — the Datadog MCP server uses OAuth by default, and API keys are for advanced usage outside this skill.

Beyond that, emit only what the current step instructs. Do not add setup tips, follow-ups, or "helpful" notes from your general knowledge of the AI client — when the user needs to reload, re-authenticate, or take any other follow-up action, the skill emits that instruction at the correct step. Preempting or paraphrasing it is a bug.

## Determine `datadog-server-state`

Silently determine the `datadog-server-state` of the `datadog` MCP server using **only** the steps below (also, do NOT use any other Datadog MCP server). Do not use any other source of information (status files, cached state, error messages from previous calls, etc.) to determine the `datadog-server-state`:

1. Try a lightweight MCP call on `datadog` (e.g. list tools, or read a resource using `server: "datadog"`).
2. If the server returns an actual, non-empty, non-generic Datadog-specific data (tools, resources, or content) → `datadog-server-state` is **working**.
3. If the MCP call fails or returns an empty or a generic response (like "no resources found", empty tool list, or any other content-free response), silently read the registration file (see below for its location). Check the raw file content for the literal string `not-setup`:
   - If the file contains `not-setup` → `datadog-server-state` is **not-setup**.
   - Otherwise → `datadog-server-state` is **not-working**.

Do not tell the user which `datadog-server-state` was determined, what was checked, or what was found — just follow the skill's instructions for that state.

## MCP registration file: `.dd_copilot_mcp.json`

The MCP registration file is at `<plugin-root>/.dd_copilot_mcp.json`. If `<plugin-root>` is not already known, derive it from this markdown file's path by removing `skills/<skill-name>/references/mcp-settings.md` from the end — the remaining prefix is `<plugin-root>`.

The registration file contains a plain URL. The domain and toolsets are stored directly in the URL string — there is no shell variable wrapper:

```
"url": "https://<current domain>/api/...&toolsets=<current toolsets>"
```

### Editing rule

Edit the `url` string in the `"datadog"` server entry in the registration file. Leave everything else in the file untouched.

To change the domain: replace the hostname — the part of the URL between `https://` and `/api/`.

To change the toolsets: replace the value after `toolsets=` in the URL query string. An empty value (`toolsets=`) means "use the server's default toolsets".

Examples:

Replacing a domain:

```
"url": "https://mcp.datadoghq.eu/api/..."  →  "url": "https://mcp.datadoghq.com/api/..."
```

Setting an explicit toolset list:

```
toolsets=core,visualizations  →  toolsets=core,alerting
```

Clearing the toolset list back to server defaults:

```
toolsets=core,alerting  →  toolsets=
```

### The `not-setup` sentinel

A fresh installation has `not-setup` as the URL hostname:

```
"url": "https://not-setup/api/..."
```

This URL prevents the MCP server from connecting. It exists only before first-time setup and is replaced by `/ddsetup` with a real MCP domain. Once replaced, it never returns to `not-setup`.

## Site-to-domain mapping

The following table shows the Datadog site codes and their respective MCP domains:

| Site | MCP domain            |
| ---- | --------------------- |
| us1  | mcp.datadoghq.com     |
| us3  | mcp.us3.datadoghq.com |
| us5  | mcp.us5.datadoghq.com |
| eu   | mcp.datadoghq.eu      |
| ap1  | mcp.ap1.datadoghq.com |
| ap2  | mcp.ap2.datadoghq.com |

Present all available Datadog sites and their MCP domains, then ask the user which one they use.

When mapping user input:

- **Site code** (e.g. "us1", "eu") — use the matching MCP domain directly. Site codes are case-insensitive.
- **URL** (e.g. "https://app.datadoghq.com/logs") — identify the site from the URL, then use the matching MCP domain. Note: `datadoghq.com` with no site prefix is `us1` and `datadoghq.eu` is `eu`.
- **Domain not in the table** — confirm with the user, warning that an invalid domain will prevent connection.

If the user is unsure which site they use, suggest checking https://docs.datadoghq.com/getting_started/site/ or the URL bar in their Datadog browser session. They can also contact `support@datadoghq.com` and ask about their Datadog MCP domain.
