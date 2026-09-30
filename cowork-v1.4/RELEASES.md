# Datadog for Copilot Cowork: release log

Every build is uninstalled from Cowork before the next version is uploaded. Each entry has three
statements: what did not work in the previous version, the evidence, and how this version fixes it.
"Live result" is what Cowork actually did, not what a local check predicted.

| Version | Connector authorization | Live result in Cowork |
| --- | --- | --- |
| 1.4.0 | none (omitted) | Rejected at upload by the Microsoft package service |
| 1.4.1 | none (omitted) | Installed; skills loaded; no Connect button, 0 Datadog tools |
| 1.4.2 | `DynamicClientRegistration` | Installed; "Could not verify connection" |
| 1.4.3 | `OAuthPluginVault` (Datadog public client + PKCE) | Connect and Datadog consent OK; Microsoft token exchange failed |
| 1.4.4 | `OAuthPluginVault` against Datadog's MCP authorization server (`/api/unstable/mcp-server`) | Installed; Connect opened Datadog, which returned "Invalid redirect_uri" before sign-in |
| 1.4.5 | `OAuthPluginVault`, `app.datadoghq.com` sign-in, **PKCE off**, token at `/oauth2/v1/token` | Microsoft callback: `Error: 'invalid_request'` (Datadog requires PKCE for this client) |
| 1.5.0 | `DynamicClientRegistration` via a Datadog OAuth bridge that runs the VS Code extension's flow server-side | Building |
| 1.4.6 | `ApiKeyPluginVault` (Datadog access token as bearer) | Pending API key registration ID |

## 1.4.0 (published in PR #3)

1. Did not work: the four packages in `dist/` could not be installed.
2. Evidence: `atk install` returned `Manifest is not valid: Required properties are missing from object:
   mcpToolDescription` from the Microsoft 365 package service (2026-09-29). The local validator treated
   the field as optional.
3. Fix: none in this version; superseded by 1.4.1.

## 1.4.1

1. Did not work in 1.4.0: the package service rejected every package, and `build.py` failed on Windows
   checkouts because `SKILL.md` files arrive with CRLF line endings.
2. Evidence: the package-service error above; the offline test suite failed 4 of 18 tests on a Windows
   checkout (`ASKILL-P003: SKILL.md must start with --- frontmatter`).
3. Fix: `build.py` generates `tools/datadog-tools.json` from `catalog/core-tools.json` (read-only builds
   list only read tools), references it from the connector, and normalizes packaged text files to LF.

Live result: installed and enabled. Cowork answered "Datadog MCP tools are not listed in this session"
and called no tools. The plugin page showed no Connect control.

## 1.4.2

1. Did not work in 1.4.1: with `authorization` omitted, Cowork never offered a sign-in, so no Datadog
   token existed and no tools were bound.
2. Evidence: an unauthenticated `GET https://mcp.datadoghq.com/v1/mcp` returns 401 without a
   `WWW-Authenticate` header, which Cowork's automatic discovery depends on. Datadog's
   `/.well-known/oauth-protected-resource/v1/mcp` and `/.well-known/oauth-authorization-server` do
   return 200.
3. Fix attempted: declare `authorization.type = DynamicClientRegistration` with the tenant's existing
   DCR auth config so Cowork does not rely on header discovery.

Live result: "Could not verify connection. Try again."; Retry opened no sign-in. Root cause, verified the
same day: Microsoft documents that "DCR without a client secret isn't supported yet. The authorization
server must issue a client secret during registration." Datadog's registration endpoint returns
`token_endpoint_auth_method: "none"` and a shared public client even when `client_secret_basic` or
`client_secret_post` is requested.

## 1.4.3

1. Did not work in 1.4.2: Microsoft's DCR requires a secret-issuing authorization server; Datadog issues
   public clients only.
2. Evidence: Microsoft Learn "Configure dynamic client registration" (updated 2026-08-31) and the live
   Datadog registration responses above.
3. Fix attempted: use the tenant's static `OAuthPluginVault` auth config (Datadog public client,
   `scope: mcp_read`, PKCE enabled), which does not need DCR.

Live result: Cowork showed Connect; Datadog's authorize page approved and redirected to
`https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect` with a code; Microsoft then returned
"Something went wrong. Please try again." (RequestId `RoutingAdded-55c2242c-…`, 2026-09-29 23:50 UTC).
This matches `cowork/ROOT_CAUSE_ANALYSIS.md` (2026-09-25): the token-store backchannel exchange omits the
PKCE `code_verifier`, which Datadog requires (`pkce_required: true`).

## 1.4.4

1. Did not work in 1.4.3: Microsoft's token exchange against `app.datadoghq.com/api/v2/oauth2/token`
   failed after Datadog consent (the PKCE `code_verifier` omission).
2. Evidence: 1.4.3 live result above. Separately, PR #4 pointed at a second Datadog authorization server
   at `https://mcp.datadoghq.com/api/unstable/mcp-server/*` (issuer `https://mcp.datadoghq.com`, resource
   `…/api/unstable/mcp-server/mcp`). A live registration there on 2026-09-30 returned 201 with
   `token_endpoint_auth_method: client_secret_post`, `pkce_required: true`, and no `client_secret`.
3. Fix attempted: a token-store OAuth config for that server's client (public ID, PKCE, no secret),
   created with `atk provision` (`oauth/register`, AnyApp, HomeTenant, base URL
   `https://mcp.datadoghq.com`), and the connector pointed at the matching resource
   `https://mcp.datadoghq.com/api/unstable/mcp-server/mcp`. This tests a different token endpoint than 1.4.3.

Live result (2026-09-30): installed; Connect opened
`https://mcp.datadoghq.com/api/unstable/mcp-server/authorize` with `redirect_uri` exactly equal to the
registered `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect`, and Datadog answered
`400 Invalid redirect_uri` before any sign-in. Reproduced with curl: the same client and redirect return
400; a client registered with a loopback redirect (`http://127.0.0.1:33418/callback`) returns 302 to
Datadog's consent page; an unregistered redirect returns 400. This server only honors loopback redirects
(the pattern local IDE and CLI clients use), so it cannot serve a cloud callback such as Microsoft's.
The token endpoint was never reached. 1.4.3's `app.datadoghq.com` authorize step does accept the
Microsoft callback, so 1.4.3 remains the furthest any OAuth build has gone.

## 1.4.5

1. Did not work in 1.4.4: Datadog's `/api/unstable/mcp-server` authorization server rejects any
   non-loopback redirect, including Microsoft's callback, before sign-in.
2. Evidence: 1.4.4 live result and curl reproduction above. The furthest any build has reached is 1.4.3:
   `app.datadoghq.com/oauth2/v1/authorize` accepts the Microsoft callback and issues a code; only
   Microsoft's backchannel token exchange (sent as `PostRequestBody`) failed.
3. Fix attempted: keep the part of 1.4.3 that worked (Datadog's `app.datadoghq.com` sign-in, client
   `51ea5567-…`, `mcp_read`, Microsoft callback accepted) and remove the part Microsoft breaks: PKCE is
   **disabled** in a new token-store config (`atk provision`, `isPKCEEnabled: false`), so no
   `code_verifier` exists to be dropped, and the token exchange goes to `/oauth2/v1/token`, the endpoint
   Datadog's own VS Code extension (2.37.0) uses.

Why not repeat earlier routes: a Basic-header variant of 1.4.3 was built and withdrawn before install,
because the analysis below shows the missing verifier fails regardless of how client credentials are sent.
- Datadog VS Code extension 2.37.0 (`.output.bundle/desktop/extension.js`): client
  `cc3ff60e-7620-11ed-8a97-da7ad0900002`, sign-in via
  `app.datadoghq.com/account/login?next=/oauth2/v1/authorize` with S256, redirect to a local loopback
  listener (fallback `vscode.dev/redirect` or `app.datadoghq.com/api/v2/ide/vscode-redirect`), and its
  own code POSTs `code_verifier` to `app.datadoghq.com/oauth2/v1/token`. Its client cannot be reused
  (redirects do not include Microsoft's callback; it is Datadog's first-party app).
- Dummy-code probes: `/api/v2/oauth2/token` without a verifier returns "This client must include a
  code_verifier" (the exact 1.4.3 failure); `/oauth2/v1/token` returns a generic `invalid_grant`.
- Unauthenticated `/oauth2/v1/authorize` redirects to login with or without `code_challenge`, so whether
  Datadog accepts this client without PKCE is only decided after sign-in: this build tests exactly that.

Live result (2026-09-30 02:59 UTC): published and connected; after Datadog sign-in the Microsoft callback
showed `Error: 'invalid_request'` (RequestId `RoutingAdded-32458a02-…`). Datadog returned
`invalid_request` because the authorization request had no `code_challenge`: this client requires PKCE.

What the OAuth builds prove together (no further token-store variant is worth a build):

| Condition | Result |
| --- | --- |
| PKCE on (1.4.3) | Datadog signs in and issues a code; Microsoft's token store omits `code_verifier`; `/api/v2/oauth2/token` rejects it |
| PKCE off (1.4.5) | Datadog rejects the authorization request (`invalid_request`) |
| Datadog MCP AS `/api/unstable/mcp-server` (1.4.4) | Rejects any non-loopback redirect, including Microsoft's |
| DCR (1.4.2) | Datadog issues public clients only; Microsoft DCR requires a client secret |
| No authorization (1.4.1) | Datadog sends no `WWW-Authenticate` challenge, so Cowork never offers Connect |

## 1.5.0

1. Did not work in 1.4.x: in every OAuth build, Microsoft's token store runs the OAuth exchange with
   Datadog itself, and the two sides are incompatible (table above).
2. Evidence: the live results above, plus Datadog's VS Code extension 2.37.0, which works because the
   extension's own code runs the flow: it signs in at `app.datadoghq.com` with PKCE S256, keeps the
   verifier, and posts `code_verifier` to Datadog's token endpoint. A Cowork plugin is declarative (manifest,
   skills, connector) and cannot run that code.
3. Fix: run the VS Code flow as a small service, the Datadog OAuth bridge (`cowork/bridge/`), and point
   the plugin's connector at it. Toward Microsoft the bridge is a standard MCP authorization server: it
   sends the `WWW-Authenticate` challenge, publishes RFC 9728/8414 metadata, and issues client secrets via
   RFC 7591 registration, which is what Microsoft DCR requires. Toward Datadog it does what the VS Code
   extension does: PKCE S256 sign-in, then a token exchange that includes `code_verifier`. Every MCP call is
   forwarded to `https://mcp.datadoghq.com/v1/mcp` with the signed-in user's own Datadog token. The bridge
   keeps no token store: codes and refresh tokens are sealed with AES-256-GCM.

Live result: pending.

## 1.4.6

1. Did not work in 1.4.3: every OAuth route fails on a platform gap outside the package: header
   discovery (1.4.1), secret-less DCR (1.4.2), and the PKCE token exchange (1.4.3).
2. Evidence: the three live results above, each reproduced in Cowork on 2026-09-29.
3. Fix: `authorization.type = ApiKeyPluginVault`. Datadog's MCP server accepts a Personal or Service
   Access Token as `Authorization: Bearer <token>` (docs.datadoghq.com/mcp_server/setup, Authentication).
   The token lives in Microsoft's Enterprise Token Store through a Teams Developer Portal API key
   registration, so no OAuth code exchange happens and the package still contains no secret.

Build: `python build.py --site us1 --profile readonly --auth apikey --reference-id <registration id>
--output dist/datadog-cowork-1.4.6-us1-readonly-apikey.zip`

Trade-off: every user of one registration acts as that token's Datadog identity. Per-user sign-in needs
a DCR-compliant authorization bridge in front of Datadog.

Setup steps: [docs/CONNECT-WITH-ACCESS-TOKEN.md](docs/CONNECT-WITH-ACCESS-TOKEN.md).
