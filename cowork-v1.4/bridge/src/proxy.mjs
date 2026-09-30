// MCP endpoint: challenge unauthenticated callers (the WWW-Authenticate header Datadog's own MCP server
// omits), then forward MCP Streamable HTTP to Datadog's MCP server with the caller's Datadog bearer token.
// Only the configured upstream URL is ever contacted; the request path never selects a target.
import { Readable, pipeline } from 'node:stream';
import { sendJson } from './http.mjs';

const FORWARD_REQUEST = ['authorization', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'user-agent'];
const FORWARD_RESPONSE = ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'cache-control', 'www-authenticate'];
const BEARER = /^Bearer\s+[A-Za-z0-9._~+/=-]+\s*$/i;

export function createProxy(config, { fetch: fetchImpl = globalThis.fetch, log }) {
  const metadataUrl = `${config.baseUrl}/.well-known/oauth-protected-resource/mcp`;
  const scope = config.upstreamScope ? `, scope="${config.upstreamScope}"` : '';

  /** True when the request carries a bearer token; checked before any request body is read. */
  const hasBearer = req => BEARER.test(req.headers.authorization || '');

  function unauthorized(res, error) {
    const challenge = error
      ? `Bearer error="${error}", resource_metadata="${metadataUrl}"${scope}`
      : `Bearer resource_metadata="${metadataUrl}"${scope}`;
    sendJson(res, 401, { error: error || 'unauthorized', error_description: 'Sign in to Datadog through this bridge (OAuth 2.0 bearer token required)' },
      { 'www-authenticate': challenge, 'cache-control': 'no-store' });
  }

  async function handle(req, res, body, search) {
    if (!hasBearer(req)) return unauthorized(res);

    const target = new URL(config.upstreamMcpUrl);
    for (const [k, v] of new URLSearchParams(search)) target.searchParams.set(k, v);
    const headers = {};
    for (const h of FORWARD_REQUEST) if (typeof req.headers[h] === 'string') headers[h] = req.headers[h];

    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    let upstream;
    try {
      upstream = await fetchImpl(target, {
        method: req.method,
        headers,
        body: req.method === 'POST' ? body : undefined,
        redirect: 'manual',
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted) return;
      log('error', 'mcp_upstream_unreachable', { reason: err.message });
      return sendJson(res, 502, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Datadog MCP server is unreachable' } });
    }

    if (upstream.status === 401) {
      await upstream.body?.cancel().catch(() => {});
      log('info', 'mcp_upstream_401', {});
      return unauthorized(res, 'invalid_token');
    }

    const out = {};
    for (const h of FORWARD_RESPONSE) {
      const v = upstream.headers.get(h);
      if (v) out[h] = v;
    }
    if ((out['content-type'] || '').startsWith('text/event-stream')) out['x-accel-buffering'] = 'no';
    res.writeHead(upstream.status, out);
    if (!upstream.body) return res.end();
    res.flushHeaders?.();
    pipeline(Readable.fromWeb(upstream.body), res, err => {
      if (err && !abort.signal.aborted) log('warn', 'mcp_stream_error', { reason: err.code || err.message });
    });
  }

  return { handle, hasBearer, unauthorized };
}
