// Bridge configuration from environment variables. Validated once at startup; the process refuses to
// start on a bad value instead of failing on the first sign-in.

export const MICROSOFT_REDIRECT = 'https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function loadConfig(env = process.env) {
  const baseUrl = String(env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('PUBLIC_BASE_URL is required (the bridge public origin, e.g. https://bridge.example.com)');
  let base;
  try { base = new URL(baseUrl); } catch { throw new Error('PUBLIC_BASE_URL is not a valid URL'); }
  if (base.pathname !== '/' || base.search || base.hash) throw new Error('PUBLIC_BASE_URL must be an origin without path, query or fragment');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && LOOPBACK.has(base.hostname))) {
    throw new Error('PUBLIC_BASE_URL must use https (http is allowed only for localhost)');
  }

  const secret = decodeSecret(env.BRIDGE_SECRET);

  const site = String(env.DD_SITE || 'datadoghq.com').toLowerCase();
  if (!/^[a-z0-9]+([.-][a-z0-9]+)*\.[a-z]{2,}$/.test(site)) throw new Error('DD_SITE must be a Datadog site domain such as datadoghq.com');

  const upstreamMcpUrl = env.UPSTREAM_MCP_URL || `https://mcp.${site}/v1/mcp`;
  const mcp = new URL(upstreamMcpUrl);
  if (mcp.protocol !== 'https:' && !LOOPBACK.has(mcp.hostname)) throw new Error('UPSTREAM_MCP_URL must use https');

  const allowedRedirectUris = String(env.ALLOWED_REDIRECT_URIS || MICROSOFT_REDIRECT)
    .split(',').map(s => s.trim()).filter(Boolean);
  for (const uri of allowedRedirectUris) {
    const u = new URL(uri);
    if (u.protocol !== 'https:' && !LOOPBACK.has(u.hostname)) throw new Error(`ALLOWED_REDIRECT_URIS entry must use https: ${uri}`);
    if (u.hash) throw new Error(`ALLOWED_REDIRECT_URIS entry must not contain a fragment: ${uri}`);
  }

  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer 0-65535');

  return Object.freeze({
    baseUrl,
    resource: `${baseUrl}/mcp`,
    callbackUrl: `${baseUrl}/callback`,
    secret,
    site,
    // Datadog authorization server discovery (the metadata Datadog's MCP server publishes).
    upstreamMetadataUrl: env.UPSTREAM_METADATA_URL || `https://mcp.${site}/.well-known/oauth-authorization-server`,
    upstreamFallback: {
      authorization_endpoint: `https://app.${site}/oauth2/v1/authorize`,
      token_endpoint: `https://app.${site}/api/v2/oauth2/token`,
      registration_endpoint: `https://app.${site}/api/v2/oauth2/register`,
    },
    upstreamClientId: env.UPSTREAM_CLIENT_ID || '',
    upstreamScope: env.UPSTREAM_SCOPE ?? 'mcp_read',
    upstreamMcpUrl: mcp.toString(),
    allowedRedirectUris: Object.freeze(allowedRedirectUris),
    requireDownstreamPkce: /^(1|true|yes)$/i.test(env.REQUIRE_DOWNSTREAM_PKCE || ''),
    port,
    logLevel: env.LOG_LEVEL || 'info',
  });
}

function decodeSecret(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('BRIDGE_SECRET is required (32+ random bytes, base64 or base64url)');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) throw new Error('BRIDGE_SECRET must be base64 or base64url');
  const buf = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (buf.length < 32) throw new Error('BRIDGE_SECRET must decode to at least 32 bytes');
  return buf;
}
