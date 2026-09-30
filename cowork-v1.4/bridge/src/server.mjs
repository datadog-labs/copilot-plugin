#!/usr/bin/env node
// Datadog OAuth bridge for Copilot Cowork.
//
// Datadog's VS Code extension signs in by running OAuth itself: PKCE S256 at app.datadoghq.com, then a
// token exchange that includes code_verifier. A Cowork plugin is declarative and cannot run that code, and
// Microsoft's token store cannot talk to Datadog directly (no WWW-Authenticate challenge, public-only DCR,
// code_verifier omitted; see ../RELEASES.md). This service runs the extension's flow server-side and
// presents a standard MCP authorization server to Microsoft.
//
//   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728
//   GET  /.well-known/oauth-authorization-server       RFC 8414 (also /.well-known/openid-configuration)
//   POST /register                                     RFC 7591, issues client secrets
//   GET  /authorize -> Datadog sign-in -> GET /callback -> Microsoft redirect with code
//   POST /token                                        authorization_code, refresh_token
//   POST|GET|DELETE /mcp                               Datadog MCP with the user's own Datadog token
//   GET  /healthz
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { createSealer } from './seal.mjs';
import { createUpstream } from './upstream.mjs';
import { createOAuth } from './oauth.mjs';
import { createProxy } from './proxy.mjs';
import { HttpError, baseHeaders, parseQuery, readBody, sendJson, sendOAuthError } from './http.mjs';

const OAUTH_BODY_LIMIT = 64 * 1024;
const MCP_BODY_LIMIT = 5 * 1024 * 1024;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = 'info', sink = line => console.log(line)) {
  const min = LEVELS[level] ?? LEVELS.info;
  return (lvl, evt, fields = {}) => {
    if ((LEVELS[lvl] ?? 20) < min) return;
    sink(JSON.stringify({ t: new Date().toISOString(), level: lvl, evt, ...fields }));
  };
}

export function createBridge(config, deps = {}) {
  const log = deps.log || createLogger(config.logLevel);
  const fetchImpl = deps.fetch || globalThis.fetch;
  const sealer = createSealer(config.secret);
  const upstream = createUpstream(config, { fetch: fetchImpl, log });
  const oauth = createOAuth(config, { sealer, upstream, log });
  const proxy = createProxy(config, { fetch: fetchImpl, log });
  const secure = config.baseUrl.startsWith('https://');

  async function route(req, res, url) {
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const m = req.method;

    if (path === '/mcp') {
      if (m !== 'POST' && m !== 'GET' && m !== 'DELETE') return methodNotAllowed(res, 'GET, POST, DELETE');
      const body = m === 'POST' ? await readBody(req, MCP_BODY_LIMIT) : undefined;
      return proxy.handle(req, res, body, url.search);
    }
    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
      if (m !== 'GET' && m !== 'HEAD') return methodNotAllowed(res, 'GET');
      return sendJson(res, 200, oauth.protectedResourceMetadata(), { 'cache-control': 'public, max-age=300' });
    }
    if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/oauth-authorization-server/mcp'
        || path === '/.well-known/openid-configuration') {
      if (m !== 'GET' && m !== 'HEAD') return methodNotAllowed(res, 'GET');
      return sendJson(res, 200, oauth.authorizationServerMetadata(), { 'cache-control': 'public, max-age=300' });
    }
    if (path === '/register') {
      if (m !== 'POST') return methodNotAllowed(res, 'POST');
      return oauth.register(req, res, await readBody(req, OAUTH_BODY_LIMIT));
    }
    if (path === '/authorize') {
      if (m !== 'GET') return methodNotAllowed(res, 'GET');
      return oauth.authorize(req, res, parseQuery(url));
    }
    if (path === '/callback') {
      if (m !== 'GET') return methodNotAllowed(res, 'GET');
      return oauth.callback(req, res, parseQuery(url));
    }
    if (path === '/token') {
      if (m !== 'POST') return methodNotAllowed(res, 'POST');
      return oauth.token(req, res, await readBody(req, OAUTH_BODY_LIMIT));
    }
    if (path === '/healthz') return sendJson(res, 200, { ok: true });
    if (path === '/') {
      return sendJson(res, 200, {
        name: 'Datadog OAuth bridge for Copilot Cowork',
        mcp: config.resource,
        protected_resource_metadata: `${config.baseUrl}/.well-known/oauth-protected-resource/mcp`,
        authorization_server_metadata: `${config.baseUrl}/.well-known/oauth-authorization-server`,
        datadog_site: config.site,
      });
    }
    sendJson(res, 404, { error: 'not_found' });
  }

  const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    const started = process.hrtime.bigint();
    for (const [k, v] of Object.entries(baseHeaders(secure))) res.setHeader(k, v);
    let url;
    try { url = new URL(req.url, config.baseUrl); } catch { url = new URL('/', config.baseUrl); }
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      log('info', 'http', { method: req.method, path: url.pathname, status: res.statusCode, ms: Math.round(ms) });
    });
    route(req, res, url).catch(err => {
      if (res.headersSent) { res.destroy(); return; }
      if (err instanceof HttpError) {
        res.setHeader('connection', 'close');
        return sendOAuthError(res, err.status, err.status === 413 ? 'invalid_request' : 'server_error', err.message);
      }
      log('error', 'unhandled', { path: url.pathname, reason: err?.message });
      sendOAuthError(res, 500, 'server_error', 'internal error');
    });
  });
  server.requestTimeout = 0; // MCP SSE responses are long-lived; headersTimeout still applies
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 65000;

  return { server, upstream, sealer };
}

function methodNotAllowed(res, allow) {
  res.setHeader('allow', allow);
  sendJson(res, 405, { error: 'method_not_allowed' });
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`datadog-cowork-bridge: ${err.message}`);
    process.exit(2);
  }
  const log = createLogger(config.logLevel);
  const { server, upstream } = createBridge(config, { log });
  server.listen(config.port, () => {
    log('info', 'listening', { port: config.port, base_url: config.baseUrl, mcp: config.resource, upstream_mcp: config.upstreamMcpUrl });
    upstream.ready()
      .then(({ metadata, clientId }) => log('info', 'upstream_ready', { authorization_endpoint: metadata.authorization_endpoint, token_endpoint: metadata.token_endpoint, client_id: clientId }))
      .catch(err => log('error', 'upstream_not_ready', { reason: err.message }));
  });
  const stop = () => { log('info', 'shutdown', {}); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
