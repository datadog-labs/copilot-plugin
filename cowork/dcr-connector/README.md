# Datadog MCP connection for Microsoft 365 Copilot Cowork

**Status: DCR connector builder and diagnostics.** The source folder has no
`manifest.json` at its root; `build.py` generates one. Cowork uses Microsoft's **Unified App
Manifest v1.28**, not the AgentPlugins 1.0 files in the three CLI/editor
packages. This connector targets Datadog's existing, direct **US1 remote MCP**
endpoint; it includes no proxy, telemetry sender, token, or auth broker.

## Short path to a Cowork-only candidate

1. Confirm the intended Datadog site is US1 and obtain an approved Microsoft
   365 app publisher identity, privacy policy, terms page, and website. The
   pages must be real, publisher-controlled HTTPS URLs. This project cannot
   verify ownership or tenant policy for you.
2. From `cowork/dcr-connector/`, use the guided **offline** builder:

   ```sh
   python3 build.py wizard --output ../cowork-candidate.zip
   ```

   Python 3.9+ standard library only. It asks for an app **manifest UUID**
   (blank generates a new local package UUID, *not* an OAuth client ID),
   publisher name, and the three HTTPS URLs. It requires an explicit publisher
   confirmation, never asks for OAuth credentials, and refuses to overwrite a
   file. Keep a generated app UUID stable for later updates. For automation,
   `python3 build.py package --help` lists the equivalent explicit flags.
   **Never paste an OAuth URL, state, challenge, token, secret, or client
   identifier** into either route.
3. Review the candidate ZIP before considering upload. It has exactly
   `manifest.json`, `color.png` (192×192), and `outline.png` (32×32) at its
   root. The original generic spectrum icons are not Datadog branding. Its
   connector points to `https://mcp.datadoghq.com/v1/mcp`; no local process or
   third-party proxy is installed. For the documented **Cowork-only
   connector** route, `authorization` is intentionally **omitted**. Do not
   add a guessed OAuth client ID, secret, or `OAuthPluginVault` reference.
4. Have the Microsoft 365 publisher/admin validate the current v1.28 schema,
   real publisher URLs, tenant upload policy and Information Barriers. Only an
   authorized user should try an import. A generated candidate is **not**
   proof of Cowork support, discovery, OAuth, or DCR compatibility.
5. In the *fresh client-launched* Datadog consent flow, choose **Limited
   (read-only)** if Datadog offers it and the goal is read access. A prior
   screen showed Limited with 88 read tools and no writes versus Full with
   88 reads, 68 writes and sensitive actions; those observed counts can
   change and do not prove this direct Cowork flow works. Inspect the actual
   permissions and cancel if unexpected. Choose Full only for an independently
   approved write use case. This manifest **cannot force** Datadog's
   authorization profile. Never replay a copied authorization URL.
6. Confirm an authenticated MCP `initialize` and `tools/list` in Cowork, then
   one explicitly approved, bounded read-only query. For enforced read-only
   access, use a Datadog role with `mcp_read` and the underlying resource-read
   permissions **without `mcp_write`**; retain client tool approvals. The
   default core tool list can contain write tools even when the intended
   behavior is read-only. Test restart/reuse through the normal client UI,
   never by reading token storage.

## Two authorized Cowork paths — neither provisioned here

| Path | Appropriate handoff |
| --- | --- |
| **DCR first** (Cowork-only connector) | Use the v1.28 `agentConnectors` candidate above, with `authorization` omitted as documented for Cowork-only DCR. Run read-only metadata diagnostics first; a registration endpoint and secret-capable methods are not proof that registration issues the **client secret Microsoft requires**. Publisher and tenant checks precede user-approved import. This path remains unverified. |
| **Static OAuth, conditional** | Only if Datadog provisions a real OAuth client for this Microsoft integration and approves the Microsoft callback `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect` in **Organization Preferences → MCP OAuth Redirect URLs**. Microsoft 365 Agents Toolkit or the **Teams developer portal** must create the real Enterprise token-store auth config and its `OAuthPluginVault` reference. For a single-tenant test, Microsoft's setup guidance says **My organization only** and **Any Teams app** for the auth config; none has been created here. Have the publisher confirm the tooling supports this exact Cowork target and generates the correct manifest/auth binding. No ID, secret, or reference is supplied by this connector package. |

For a separate **Copilot Chat MCP plugin using DCR**, Agents Toolkit or the
declarative-agent-developer skill creates the Enterprise token-store auth
config and writes the actual `OAuthPluginVault` reference. The Teams
developer portal supports the **static OAuth** setup above but **not DCR**.
Do not paste a Copilot Chat auth reference into the Cowork-only candidate.
Do not reuse another app's OAuth client, redirect link, or browser session.

Microsoft's MCP DCR currently requires registration to issue a **client
secret**. Datadog's public authorization-server metadata advertises a
registration endpoint, PKCE S256, and secret-capable token authentication
methods; those fields **do not prove a secret is actually issued**. Public
web fetch returned no HTTP status for protected-resource metadata, so that
stage is inconclusive, not a confirmed 404. No diagnostic registration or
Microsoft token-store provisioning was performed.

## Diagnose by stage, without exposing credentials

The included `docs/DCR.md` and `scripts/Test-DatadogMcpDiscovery.ps1` provide
a read-only, explicit `-Live` metadata probe. Without `-Live`, no network
request occurs. The separately guarded DCR script can create **one** test
client only with an approved redirect URI, `-RegisterClient`, and PowerShell
confirmation; coordinate it with an administrator. Neither script connects
Cowork or prints credentials.

| Stage / safe result | Next action and owner |
| --- | --- |
| Candidate generation or v1.28 import rejected | Publisher checks the app UUID, verified website/privacy/terms URLs, root ZIP structure and icons; Microsoft 365 admin checks tenant policy and Information Barriers. Do not bypass policy or fabricate URLs. |
| `protected_resource_probe: missing_http_404` | Only explicit HTTP 404s at every attempted well-known location justify this result. Ask Datadog about RFC 9728 availability for this endpoint; include sanitized HTTP status, not raw headers. |
| `tool_unreachable`, `fixture_unavailable`, `http_unavailable`, or a web fetch with no result | **Inconclusive**, not proof metadata is missing. Check network/proxy/TLS and rerun from an approved environment; ask IT or the client vendor if the probe tool cannot reach it. |
| Authorization metadata passes, but registration/secret issuance unknown | Do not claim DCR works. Microsoft requires a secret-issuing registration; ask Datadog/Microsoft for supported Cowork DCR guidance. A one-time diagnostic POST needs admin approval and a genuine redirect URI; advertised auth methods alone are insufficient. If DCR cannot meet that requirement, evaluate the **conditional static OAuth path above**, not a guessed client ID. |
| Consent screen offers Limited versus Full | For read-only onboarding select Limited if available. If permissions are unexpected, cancel and consult the Datadog admin. The connector cannot preselect or enforce that vendor-side choice. |
| Consent completes but Cowork cannot initialize or list tools | Record only the stage, numeric status and client version. Have the Microsoft 365 admin check the actual token-store/tenant flow and Datadog check endpoint access; do not transplant browser tokens or reuse a prior app's OAuth URL. |
| MCP `403` or no authorized read tool | Datadog admin checks `mcp_read`, underlying resource permissions, organization controls and IP allowlists. Do not grant `mcp_write` simply to make a read test pass. |

When escalating, share only sanitized stage, status code, probe outcome,
client version and relevant policy category. **Do not send raw OAuth URLs,
headers, state, challenge, codes, client IDs, secrets, or account data** in a
ticket, chat, package, or log. The PowerShell diagnostics **do not
provision either Microsoft auth path** or choose a vendor consent profile.

References: [Cowork plugin development](https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/cowork-plugin-development),
[Microsoft MCP DCR requirements](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-dynamic-client-registration),
[Microsoft static OAuth setup](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-oauth),
and [Datadog MCP setup](https://docs.datadoghq.com/mcp_server/setup/).

Original MIT-licensed community implementation, not an official Datadog or
Microsoft publisher package.
