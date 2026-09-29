# Dynamic client registration diagnostics

These PowerShell scripts are **diagnostics**, not an OAuth broker or a
Microsoft Enterprise token-store provisioning tool. They run on Windows
PowerShell 5.1 or PowerShell 7 without extra modules. This release did not
execute them on Windows; inspect and run them in your controlled environment.
They use only the official US1 origin and currently documented registration
path, system TLS validation, no credentials, no redirects, bounded timeouts and
response sizes, and sanitized JSON output. A changed registration endpoint
requires code review before any diagnostic POST.
They do not turn an HTTP 401 into a claim of authenticated MCP success.

From an extracted platform plugin folder (or from the source root):

```powershell
# No arguments means no network and an inconclusive plan (exit 3).
.\scripts\Test-DatadogMcpDiscovery.ps1

# Synthetic fixture exercises metadata parsing without network.
.\scripts\Test-DatadogMcpDiscovery.ps1 -OfflineFixture .\scripts\fixtures\discovery-valid.json

# Explicit unauthenticated, read-only live metadata probe.
.\scripts\Test-DatadogMcpDiscovery.ps1 -Live
```

The probe GETs the MCP URL without a token, checks a safe `resource_metadata`
challenge if one is offered, then tries the endpoint-specific and root RFC 9728
well-known locations. A missing challenge is not by itself noncompliance: MCP
clients must support both challenge and well-known discovery. It validates
`resource`, an exact US1 authorization-server issuer, OAuth endpoints,
authorization-code grant, PKCE `S256`, a registration endpoint, and advertised
secret-capable token authentication. A pass means **metadata advertised**, not
that DCR issued a secret or that Microsoft can use the connection. No redirects
are followed. Exit 0 means metadata checks passed, 2 a definitive metadata
failure, and 3 inconclusive/no run.

The JSON distinguishes `protected_resource_probe: "missing_http_404"` from
`"tool_unreachable"`, `"fixture_unavailable"` and `"http_unavailable"`.
`missing_http_404` requires **explicit HTTP 404 responses from every attempted
well-known location**. A timeout, transport failure, omitted offline fixture
response, or a fetch tool returning no result is **inconclusive**, even if a
different location returned 404. `authorization_metadata_probe` uses the same
HTTP-404-versus-unavailable distinction. The unauthenticated MCP GET status
alone does not prove authenticated initialization or protected-resource
metadata availability. A fixture entry with `{"unreachable":true}` simulates
an unreachable probe without pretending it returned HTTP 404.

## Public metadata observation — 24 September 2026

A read-only public fetch of Datadog's **authorization-server metadata**
reported issuer `https://mcp.datadoghq.com`, authorization and token endpoints
under `/api/unstable/mcp-server/`, `authorization_code` and `refresh_token`
grants, PKCE `S256` required, registration endpoint
`https://mcp.datadoghq.com/api/unstable/mcp-server/register`, and token
authentication methods `client_secret_basic`, `client_secret_post`, and
`none`. Both protected-resource metadata URL attempts (root and `/v1/mcp`)
returned **“No fetch results found” from the public web-fetch tool**. That
tool response contains no confirmed HTTP status: it is **inconclusive**, not
evidence of 404 or a missing endpoint. The PowerShell `-Live` probe was not
run. **No registration POST was made.** Neither the advertised methods nor
PKCE support proves that registration actually issues a client secret.
Datadog/Microsoft compatibility remains conditional on a successful,
authorized end-to-end validation.

For Cowork onboarding, see `cowork/README.md` in the source ZIP or the
DCR connector README (cowork/dcr-connector/README.md). Datadog's observed consent choices include a Limited
read-only profile and a broader Full profile. Recommend Limited for a
read-only goal, but **the connector manifest cannot force or preselect
Datadog's authorization profile**. A consent screen for another app or proxy
does not establish this direct official MCP connector's OAuth outcome.

Microsoft's MCP DCR support currently requires a **client secret issued by
registration**; `registration_endpoint` and advertised
`client_secret_basic`/`client_secret_post` alone do not prove that. An
administrator can perform **one** diagnostic registration only after obtaining
and approving a real redirect URI for the diagnostic client:

```powershell
.\scripts\Test-DatadogDcrRegistration.ps1 -Live -RegisterClient `
  -RedirectUri '<OPERATOR_APPROVED_HTTPS_REDIRECT_URI>' -WhatIf
# After separately reviewing the exact URI and impact, remove -WhatIf.
# ConfirmImpact is High, so PowerShell asks for confirmation by default.
```

The bracketed value must be replaced; it is not a supplied or verified
Microsoft redirect URI. The script only POSTs after
`-RegisterClient` **and** `ShouldProcess` approval. The URI must be supplied by
the operator and use HTTPS or a local loopback HTTP URI. It requests a
secret-capable OAuth client once; it does not request a token, complete browser
authorization, save the returned client ID/secret, or retry. Its output reports
only numeric HTTP status and whether both ID and secret were present. Even a
positive result does **not** prove compatibility with Microsoft's actual
registration payload, redirect, tenant policies, token store, or Cowork. A
diagnostic registration may leave a persistent client server-side; coordinate
cleanup with the Datadog administrator. Never paste returned credentials or
raw responses into tickets, chats, or logs.

`Install-DatadogConnection.ps1` checks one of this project's platform ZIPs and
an existing destination directory without writing by default:

```powershell
.\scripts\Install-DatadogConnection.ps1 -Platform VSCode `
  -PackageZip '.\datadog-connection-vscode-0.1.0.zip' `
  -DestinationDirectory 'C:\approved\plugins'

# Only after review, extract under the chosen directory; it does not change
# VS Code settings or install/launch any client.
.\scripts\Install-DatadogConnection.ps1 -Platform VSCode `
  -PackageZip '.\datadog-connection-vscode-0.1.0.zip' `
  -DestinationDirectory 'C:\approved\plugins' -Apply
```

`-Apply` uses PowerShell confirmation. Existing target folders and unexpected,
oversized, symlink-like, or traversal ZIP members are blocked. If extraction
fails, inspect the target folder before retrying; the script never deletes
existing data. Follow the platform README to merge a native config fragment or
register the plugin manually. Neither script edits client settings.

**Microsoft 365 is a different package format.** A Cowork-only connector can
omit `authorization` for the documented DCR route. For a separate Copilot
Chat MCP plugin using DCR, Microsoft 365 Agents Toolkit or the
declarative-agent-developer skill creates the Enterprise token-store auth
config and writes the *real* `OAuthPluginVault` reference. The Teams developer
portal does **not** support DCR. Do not fabricate a reference. DCR is distinct
from refresh-token reuse, CIMD, and Datadog telemetry ingestion.

**Conditional static OAuth alternative for Cowork:** Datadog must provision
an authorized OAuth client and allowlist the Microsoft callback
`https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect` in its
**Organization Preferences → MCP OAuth Redirect URLs**. Microsoft 365 Agents
Toolkit or the **Teams developer portal** must create a real Enterprise
token-store auth config and its `OAuthPluginVault` reference for the supported
target. Microsoft's single-tenant test instructions specify **My organization
only** and **Any Teams app** for the auth config; this project has not created
one, verified the redirect ownership or confirmed the Cowork binding. No
PowerShell script here provisions DCR or static OAuth in Microsoft. Do not
reuse a client identifier or browser authorization link from another app,
and do not put a secret/reference into the Cowork-only DCR candidate.
Escalate sanitized discovery, registration or token-store failures to the
appropriate Datadog/Microsoft owner rather than inventing credentials.

References:

- [Microsoft Cowork plugin development](https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/cowork-plugin-development)
- [Microsoft DCR requirements](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-dynamic-client-registration)
- [Microsoft static OAuth setup](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-oauth)
- [MCP authorization discovery](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Datadog MCP setup](https://docs.datadoghq.com/mcp_server/setup/)
