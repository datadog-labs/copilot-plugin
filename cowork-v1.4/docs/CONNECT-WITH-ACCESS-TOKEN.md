# Connect Datadog for Copilot Cowork with a Datadog access token

Used by release 1.4.6+ (`authorization.type = ApiKeyPluginVault`). The token is created in Datadog and
pasted directly into Microsoft's Enterprise Token Store. It never goes into the package, a file, a
ticket or a chat. Why this route: see [RELEASES.md](../RELEASES.md) (1.4.1-1.4.3 live results).

Roles: **Datadog admin** creates the token; **Microsoft 365 admin/developer** registers it; the
**package builder** only needs the resulting registration ID, which is not a secret.

## 1. Create the Datadog access token (Datadog admin)

1. Datadog → **Organization Settings → Access Tokens** (`/organization-settings/access-tokens`)
   → **New Access Token**.
2. **Name:** `Copilot Cowork - Datadog MCP (read-only)`.
3. **Expiration:** 1 month for a pilot (rotate before expiry; set a reminder).
4. **Select Scopes:** filter `mcp` → tick **`mcp_read`** (leave `mcp_write` off). Then add the read
   scopes for the data Cowork should see, for example `monitors_read`, `dashboards_read`,
   `logs_read_data`, `incident_read`, `apm_read`, `timeseries_query`, `hosts_read`. The MCP server
   only returns data the token's scopes and owner role allow.
5. **Create**, then copy the token once. Do not paste it anywhere except step 2.4.
   If a token is ever pasted into chat, email or a ticket, revoke it and create a new one.

## 2. Register the token in the Microsoft token store (Microsoft 365 admin/developer)

1. Teams Developer Portal → **Tools → API key registration**
   (`https://dev.teams.microsoft.com/api-key-registration`) → **New API key**.
2. **API key name:** `Datadog MCP US1 (Cowork)`.
3. **Base URL:** `https://mcp.datadoghq.com` (must be a prefix of the connector URL
   `https://mcp.datadoghq.com/v1/mcp`).
4. **Add secret:** paste the Datadog token (primary key). Microsoft stores it; the portal will not
   show it again.
5. **Target tenant:** Home tenant. **Restrict usage by app:** Any Teams app (or the Cowork package's
   app ID once it is stable).
6. **Save**, then copy the **API key registration ID**. This ID is safe to share; it is what goes into
   the package.

## 3. Build, install and connect (package builder)

```powershell
cd cowork-v1.4
python build.py --site us1 --profile readonly --auth apikey --reference-id <registration id> `
  --output dist/datadog-cowork-1.4.6-us1-readonly-apikey.zip
```

1. Cowork → **Customize** → uninstall the previous Datadog build.
2. **Add plugin → choose a file** → the 1.4.6 ZIP → **Only you** → **Publish**.
3. Open the plugin details; the Datadog MCP (US1) connector should not show a Connect error.

## 4. Verify with a real read (anyone who installed the plugin)

New Cowork task:

> Use the Datadog (US1) plugin. Call search_datadog_hosts and search_datadog_monitors and report the
> exact tool names, the hosts returned, the monitors in Alert or No Data, and the UTC retrieval time.

Pass criteria: the answer names the tools it called and returns real hosts or monitors from the org.
Record the result in [RELEASES.md](../RELEASES.md).

## Rotate or revoke

- Datadog: **Access Tokens → Revoke** on the old token, create a new one (step 1).
- Developer Portal: edit the API key registration → replace the secret. The registration ID and the
  installed package stay the same, so no rebuild is needed.

## Limits

- Everyone using one registration acts as the token owner's Datadog identity; there is no per-user
  Datadog sign-in on this route.
- Per-user sign-in needs an authorization server that meets Microsoft's DCR rules (issues client
  secrets, sends the `WWW-Authenticate` challenge) in front of Datadog. That is a separate component.
