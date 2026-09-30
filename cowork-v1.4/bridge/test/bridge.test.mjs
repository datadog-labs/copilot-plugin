// End-to-end tests: a mock Datadog (authorization server + MCP server) and the bridge on loopback ports.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { loadConfig, MICROSOFT_REDIRECT } from '../src/config.mjs';
import { createBridge } from '../src/server.mjs';

const b64u = b => Buffer.from(b).toString('base64url');
const s256 = v => b64u(createHash('sha256').update(v).digest());

// ---------- mock Datadog ----------
const dd = { codes: new Map(), tokenCalls: [], registered: [], mcpCalls: [] };
const mock = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = await new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });
  const json = (s, o, h = {}) => { res.writeHead(s, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/.well-known/oauth-authorization-server') {
    return json(200, {
      issuer: `${dd.base}/v1/mcp`, authorization_endpoint: `${dd.base}/oauth2/v1/authorize`, token_endpoint: `${dd.base}/api/v2/oauth2/token`,
      registration_endpoint: `${dd.base}/api/v2/oauth2/register`, pkce_required: true, token_endpoint_auth_methods_supported: ['none'],
    });
  }
  if (url.pathname === '/api/v2/oauth2/register') {
    const meta = JSON.parse(body);
    dd.registered.push(meta);
    return json(201, { client_id: 'dd-public-client', redirect_uris: meta.redirect_uris, token_endpoint_auth_method: 'none' });
  }
  if (url.pathname === '/api/v2/oauth2/token') {
    const f = Object.fromEntries(new URLSearchParams(body));
    dd.tokenCalls.push(f);
    if (f.client_id !== 'dd-public-client') return json(401, { error: 'invalid_client' });
    if (f.grant_type === 'authorization_code') {
      const c = dd.codes.get(f.code);
      if (!c) return json(400, { error: 'invalid_grant' });
      if (!f.code_verifier) return json(400, { error: 'invalid_request', error_description: 'This client must include a code_verifier' });
      if (s256(f.code_verifier) !== c.challenge || f.redirect_uri !== c.redirect_uri) return json(400, { error: 'invalid_grant' });
      dd.codes.delete(f.code);
      return json(200, { access_token: 'dd-access-1', refresh_token: 'dd-refresh-1', expires_in: 3600, scope: 'mcp_read', token_type: 'Bearer' });
    }
    if (f.grant_type === 'refresh_token') {
      if (f.refresh_token !== 'dd-refresh-1') return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: 'dd-access-2', refresh_token: 'dd-refresh-2', expires_in: 3600, token_type: 'Bearer' });
    }
    return json(400, { error: 'unsupported_grant_type' });
  }
  if (url.pathname === '/v1/mcp') {
    dd.mcpCalls.push({ method: req.method, search: url.search, headers: req.headers, body });
    if (req.headers.authorization !== 'Bearer dd-access-1' && req.headers.authorization !== 'Bearer dd-access-2') return json(401, { error: 'unauthorized' });
    if (req.method === 'POST') {
      return json(200, { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'search_datadog_hosts' }] } }, { 'mcp-session-id': 'sess-1' });
    }
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('event: message\ndata: {"n":1}\n\n');
      setTimeout(() => { res.write('event: message\ndata: {"n":2}\n\n'); res.end(); }, 150);
      return;
    }
    if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
  }
  json(404, { error: 'not_found' });
});

// Simulates the user signing in at Datadog: read the bridge's redirect to Datadog, mint a code.
function datadogSignIn(location) {
  const u = new URL(location);
  assert.equal(u.origin + u.pathname, `${dd.base}/oauth2/v1/authorize`);
  assert.equal(u.searchParams.get('client_id'), 'dd-public-client');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.match(u.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  const code = 'dd-code-' + b64u(randomBytes(6));
  dd.codes.set(code, { challenge: u.searchParams.get('code_challenge'), redirect_uri: u.searchParams.get('redirect_uri') });
  return { code, state: u.searchParams.get('state'), redirectUri: u.searchParams.get('redirect_uri'), scope: u.searchParams.get('scope') };
}

// ---------- bridge ----------
let base, bridge, logs = [];
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

async function startBridge(extraEnv = {}) {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise(r => probe.close(r));
  const config = loadConfig({
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    BRIDGE_SECRET: b64u(randomBytes(32)),
    DD_SITE: 'datadoghq.com',
    UPSTREAM_METADATA_URL: `${dd.base}/.well-known/oauth-authorization-server`,
    UPSTREAM_MCP_URL: `${dd.base}/v1/mcp?omit_tools=upsert_datadog_dashboard`,
    ...extraEnv,
  });
  const b = createBridge(config, { log: (level, evt, fields) => logs.push({ level, evt, ...fields }) });
  await new Promise(r => b.server.listen(port, '127.0.0.1', r));
  return { ...b, base: `http://127.0.0.1:${port}` };
}

before(async () => {
  dd.base = `http://127.0.0.1:${await listen(mock)}`;
  bridge = await startBridge();
  base = bridge.base;
});
after(() => { bridge.server.close(); mock.close(); });

const get = (path, opts = {}) => fetch(base + path, { redirect: 'manual', ...opts });
const postForm = (path, form, headers = {}, b = base) => fetch(b + path, {
  method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(form),
});
const postJson = (path, obj, b = base) => fetch(b + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });

async function registerClient(extra = {}, b = base) {
  const res = await postJson('/register', { client_name: 'Microsoft Enterprise Token Store', redirect_uris: [MICROSOFT_REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'client_secret_post', ...extra }, b);
  assert.equal(res.status, 201);
  return res.json();
}

const cookieHeader = res => res.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !c.endsWith('=')).join('; ');

/** GET /authorize: returns the consent page's sealed value and the CSRF cookie. */
async function consentPage(client, { challenge, state = 'ms-state-123', b = base } = {}) {
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: MICROSOFT_REDIRECT, state, scope: 'mcp_read' });
  if (challenge) { q.set('code_challenge', challenge); q.set('code_challenge_method', 'S256'); }
  const page = await fetch(`${b}/authorize?${q}`, { redirect: 'manual' });
  assert.equal(page.status, 200);
  const html = await page.text();
  const consent = /name="consent" value="([^"]+)"/.exec(html)[1].replace(/&amp;/g, '&');
  return { consent, cookie: cookieHeader(page), html };
}

/** Consent page -> Continue -> 302 to Datadog. Returns the Datadog URL and the browser's cookies. */
async function toDatadog(client, opts = {}) {
  const { consent, cookie } = await consentPage(client, opts);
  const r = await fetch(`${opts.b || base}/authorize`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ consent, decision: 'allow' }),
  });
  assert.equal(r.status, 302);
  return { location: r.headers.get('location'), cookie: cookieHeader(r) };
}

/** Full Microsoft-side flow up to the downstream authorization code. */
async function signIn(client, { challenge, b = base } = {}) {
  const { location, cookie } = await toDatadog(client, { challenge, b });
  const dd1 = datadogSignIn(location);
  assert.equal(dd1.redirectUri, `${b}/callback`);
  const cb = await fetch(`${b}/callback?code=${dd1.code}&state=${encodeURIComponent(dd1.state)}`, { redirect: 'manual', headers: { cookie } });
  assert.equal(cb.status, 302);
  const back = new URL(cb.headers.get('location'));
  assert.equal(back.origin + back.pathname, MICROSOFT_REDIRECT);
  assert.equal(back.searchParams.get('state'), 'ms-state-123');
  return { code: back.searchParams.get('code'), error: back.searchParams.get('error') };
}

// ---------- metadata ----------
test('protected resource metadata (RFC 9728) points at the bridge', async () => {
  for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const doc = await (await get(p)).json();
    assert.equal(doc.resource, `${base}/mcp`);
    assert.deepEqual(doc.authorization_servers, [base]);
  }
});

test('authorization server metadata (RFC 8414) advertises registration and secret auth', async () => {
  const doc = await (await get('/.well-known/oauth-authorization-server')).json();
  assert.equal(doc.issuer, base);
  assert.equal(doc.registration_endpoint, `${base}/register`);
  assert.equal(doc.token_endpoint, `${base}/token`);
  assert.deepEqual(doc.code_challenge_methods_supported, ['S256']);
  assert.ok(doc.token_endpoint_auth_methods_supported.includes('client_secret_post'));
  assert.ok(!doc.token_endpoint_auth_methods_supported.includes('none'));
});

// ---------- registration ----------
test('register issues a confidential client (Microsoft DCR requires a secret)', async () => {
  const c = await registerClient();
  assert.match(c.client_id, /^ddb_/);
  assert.ok(c.client_secret.length >= 40);
  assert.equal(c.client_secret_expires_at, 0);
  assert.deepEqual(c.redirect_uris, [MICROSOFT_REDIRECT]);
  assert.equal(c.token_endpoint_auth_method, 'client_secret_post');
  const basic = await registerClient({ token_endpoint_auth_method: 'client_secret_basic' });
  assert.equal(basic.token_endpoint_auth_method, 'client_secret_basic');
  const none = await registerClient({ token_endpoint_auth_method: 'none' });
  assert.ok(none.client_secret, 'a secret is issued even when none is requested');
});

test('register rejects redirect URIs outside the allowlist and drops extras', async () => {
  const bad = await postJson('/register', { redirect_uris: ['https://evil.example.com/cb'] });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'invalid_redirect_uri');
  const mixed = await registerClient({ redirect_uris: ['https://evil.example.com/cb', MICROSOFT_REDIRECT] });
  assert.deepEqual(mixed.redirect_uris, [MICROSOFT_REDIRECT]);
  const notJson = await fetch(base + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(notJson.status, 400);
});

// ---------- authorize ----------
test('authorize never redirects for an unknown client or disallowed redirect_uri', async () => {
  const c = await registerClient();
  const forged = 'ddb_AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA';
  const r1 = await get(`/authorize?response_type=code&client_id=${forged}&redirect_uri=${encodeURIComponent(MICROSOFT_REDIRECT)}`);
  assert.equal(r1.status, 400);
  assert.equal(r1.headers.get('location'), null);
  const r2 = await get(`/authorize?response_type=code&client_id=${c.client_id}&redirect_uri=${encodeURIComponent('https://evil.example.com/cb')}`);
  assert.equal(r2.status, 400);
  assert.equal(r2.headers.get('location'), null);
  const r3 = await get(`/authorize?response_type=code&client_id=${c.client_id}&redirect_uri=${encodeURIComponent(MICROSOFT_REDIRECT + '/x')}`);
  assert.equal(r3.status, 400);
});

test('authorize shows the bridge consent page, then redirects to Datadog with the bridge PKCE challenge', async () => {
  const c = await registerClient();
  const page = await consentPage(c, { state: 's1' });
  assert.match(page.html, /Continue to Datadog/);
  assert.match(page.html, /teams\.microsoft\.com/);
  assert.match(page.cookie, /^ddb_csrf=/);
  const { location } = await toDatadog(c, { state: 's1' });
  const s = datadogSignIn(location);
  assert.equal(s.scope, 'mcp_read');
  assert.ok(dd.registered.some(m => m.redirect_uris[0] === `${base}/callback` && m.token_endpoint_auth_method === 'none'));
  const bad = await get(`/authorize?response_type=token&client_id=${c.client_id}&redirect_uri=${encodeURIComponent(MICROSOFT_REDIRECT)}&state=s2`);
  assert.equal(bad.status, 302);
  assert.equal(new URL(bad.headers.get('location')).searchParams.get('error'), 'unsupported_response_type');
  const plain = await get(`/authorize?response_type=code&client_id=${c.client_id}&redirect_uri=${encodeURIComponent(MICROSOFT_REDIRECT)}&state=s3&code_challenge=${'a'.repeat(43)}&code_challenge_method=plain`);
  assert.equal(new URL(plain.headers.get('location')).searchParams.get('error'), 'invalid_request', 'PKCE plain is rejected');
  const long = await get(`/authorize?response_type=code&client_id=${c.client_id}&redirect_uri=${encodeURIComponent(MICROSOFT_REDIRECT)}&state=${'x'.repeat(9000)}`);
  assert.equal(new URL(long.headers.get('location')).searchParams.get('error'), 'invalid_request', 'over-long state is rejected, not cut');
});

test('consent is CSRF-protected, can be cancelled, and the callback is bound to the confirming browser', async () => {
  const c = await registerClient();
  const { consent, cookie } = await consentPage(c, { state: 'cs' });
  const post = (form, headers = {}) => fetch(base + '/authorize', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(form) });
  let r = await post({ consent, decision: 'allow' });
  assert.equal(r.status, 400, 'no CSRF cookie: an attacker cannot auto-submit the consent');
  r = await post({ consent, decision: 'allow' }, { cookie: 'ddb_csrf=' + b64u(randomBytes(18)) });
  assert.equal(r.status, 400, 'CSRF cookie from another page view');
  r = await post({ consent, decision: 'deny' }, { cookie });
  assert.equal(new URL(r.headers.get('location')).searchParams.get('error'), 'access_denied');
  // A victim who never confirmed cannot complete an attacker's Datadog sign-in.
  const attacker = await toDatadog(c, { state: 'attacker' });
  const s = datadogSignIn(attacker.location);
  r = await get(`/callback?code=${s.code}&state=${encodeURIComponent(s.state)}`);
  assert.equal(r.status, 400);
  assert.equal(r.headers.get('location'), null);
});

// ---------- full flow ----------
test('Microsoft token store flow: PKCE challenge sent, verifier omitted, client_secret_post', async () => {
  const c = await registerClient();
  const verifier = b64u(randomBytes(32));
  const { code } = await signIn(c, { challenge: s256(verifier) });
  // The bridge sent Datadog the verifier matching its own challenge.
  const upstreamCall = dd.tokenCalls.at(-1);
  assert.equal(upstreamCall.grant_type, 'authorization_code');
  assert.ok(upstreamCall.code_verifier);
  // Microsoft omits code_verifier but authenticates with the secret.
  const t = await postForm('/token', { grant_type: 'authorization_code', code, redirect_uri: MICROSOFT_REDIRECT, client_id: c.client_id, client_secret: c.client_secret });
  assert.equal(t.status, 200);
  assert.equal(t.headers.get('cache-control'), 'no-store');
  const tok = await t.json();
  assert.equal(tok.access_token, 'dd-access-1');
  assert.equal(tok.token_type, 'Bearer');
  assert.equal(tok.expires_in, 3600);
  assert.ok(tok.refresh_token.startsWith('v1.'));
  assert.ok(!JSON.stringify(tok).includes('dd-refresh-1'), 'Datadog refresh token is sealed');
  assert.ok(logs.some(l => l.evt === 'token_pkce_verifier_omitted_by_confidential_client'));
});

test('client_secret_basic with URL-encoded credentials and a correct verifier', async () => {
  const c = await registerClient({ token_endpoint_auth_method: 'client_secret_basic' });
  const verifier = b64u(randomBytes(32));
  const { code } = await signIn(c, { challenge: s256(verifier) });
  const basic = Buffer.from(`${encodeURIComponent(c.client_id)}:${encodeURIComponent(c.client_secret)}`).toString('base64');
  const t = await postForm('/token', { grant_type: 'authorization_code', code, redirect_uri: MICROSOFT_REDIRECT, code_verifier: verifier }, { authorization: `Basic ${basic}` });
  assert.equal(t.status, 200);
  assert.equal((await t.json()).access_token, 'dd-access-1');
});

test('wrong verifier, wrong secret, reused code, other client, tampered code all fail', async () => {
  const c = await registerClient();
  const other = await registerClient();
  const verifier = b64u(randomBytes(32));
  const { code } = await signIn(c, { challenge: s256(verifier) });
  const base1 = { grant_type: 'authorization_code', code, redirect_uri: MICROSOFT_REDIRECT, client_id: c.client_id };
  let r = await postForm('/token', { ...base1, client_secret: c.client_secret, code_verifier: b64u(randomBytes(32)) });
  assert.equal((await r.json()).error, 'invalid_grant');
  r = await postForm('/token', { ...base1, client_secret: 'x'.repeat(43) });
  assert.equal(r.status, 401);
  r = await postForm('/token', { ...base1, client_id: other.client_id, client_secret: other.client_secret });
  assert.equal((await r.json()).error, 'invalid_grant');
  const tampered = code.slice(0, -4) + (code.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  r = await postForm('/token', { ...base1, code: tampered, client_secret: c.client_secret });
  assert.equal((await r.json()).error, 'invalid_grant');
  r = await postForm('/token', { ...base1, client_secret: c.client_secret, code_verifier: verifier });
  assert.equal(r.status, 200);
  r = await postForm('/token', { ...base1, client_secret: c.client_secret, code_verifier: verifier });
  assert.equal((await r.json()).error, 'invalid_grant', 'codes are single use');
});

test('public client (no secret) must present a valid verifier', async () => {
  const c = await registerClient();
  const verifier = b64u(randomBytes(32));
  const { code } = await signIn(c, { challenge: s256(verifier) });
  let r = await postForm('/token', { grant_type: 'authorization_code', code, redirect_uri: MICROSOFT_REDIRECT, client_id: c.client_id });
  assert.equal((await r.json()).error, 'invalid_grant');
  r = await postForm('/token', { grant_type: 'authorization_code', code, redirect_uri: MICROSOFT_REDIRECT, client_id: c.client_id, code_verifier: verifier });
  assert.equal(r.status, 200);
});

test('state and code are purpose-bound: a sealed state is not a code', async () => {
  const c = await registerClient();
  const { location, cookie } = await toDatadog(c, { state: 's' });
  const state = new URL(location).searchParams.get('state');
  const t = await postForm('/token', { grant_type: 'authorization_code', code: state, client_id: c.client_id, client_secret: c.client_secret });
  assert.equal((await t.json()).error, 'invalid_grant');
  const cb = await get(`/callback?code=x&state=${encodeURIComponent(state.slice(0, -3) + 'AAA')}`, { headers: { cookie } });
  assert.equal(cb.status, 400);
  assert.equal(cb.headers.get('location'), null);
});

test('Datadog errors and failed exchanges return to Microsoft as OAuth errors', async () => {
  const c = await registerClient();
  const { location, cookie } = await toDatadog(c, { state: 's9' });
  const s = datadogSignIn(location);
  const denied = await get(`/callback?error=access_denied&error_description=User%20denied&state=${encodeURIComponent(s.state)}`, { headers: { cookie } });
  const u = new URL(denied.headers.get('location'));
  assert.equal(u.searchParams.get('error'), 'access_denied');
  assert.equal(u.searchParams.get('state'), 's9');
  const again = await toDatadog(c, { state: 's9' });
  const s2 = datadogSignIn(again.location);
  const failed = await get(`/callback?code=not-a-real-code&state=${encodeURIComponent(s2.state)}`, { headers: { cookie: again.cookie } });
  assert.equal(new URL(failed.headers.get('location')).searchParams.get('error'), 'server_error');
});

test('refresh_token grant refreshes at Datadog and rotates the sealed refresh token', async () => {
  const c = await registerClient();
  const { code } = await signIn(c, {});
  const tok = await (await postForm('/token', { grant_type: 'authorization_code', code, redirect_uri: MICROSOFT_REDIRECT, client_id: c.client_id, client_secret: c.client_secret })).json();
  const r = await postForm('/token', { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: c.client_id, client_secret: c.client_secret });
  assert.equal(r.status, 200);
  const t2 = await r.json();
  assert.equal(t2.access_token, 'dd-access-2');
  assert.notEqual(t2.refresh_token, tok.refresh_token);
  assert.equal(dd.tokenCalls.at(-1).refresh_token, 'dd-refresh-1');
  const other = await registerClient();
  const stolen = await postForm('/token', { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: other.client_id, client_secret: other.client_secret });
  assert.equal((await stolen.json()).error, 'invalid_grant');
  const noSecret = await postForm('/token', { grant_type: 'refresh_token', refresh_token: t2.refresh_token, client_id: c.client_id });
  assert.equal(noSecret.status, 401, 'refresh requires the client secret');
});

test('token endpoint request rules: redirect_uri binding, one auth method, grant_type required', async () => {
  const c = await registerClient();
  const { code } = await signIn(c, {});
  let r = await postForm('/token', { grant_type: 'authorization_code', code, client_id: c.client_id, client_secret: c.client_secret });
  assert.equal((await r.json()).error, 'invalid_grant', 'redirect_uri was sent to /authorize, so it is required');
  const basic = Buffer.from(`${c.client_id}:${c.client_secret}`).toString('base64');
  r = await postForm('/token', { grant_type: 'authorization_code', code, redirect_uri: MICROSOFT_REDIRECT, client_secret: c.client_secret }, { authorization: `Basic ${basic}` });
  assert.equal((await r.json()).error, 'invalid_request');
  r = await postForm('/token', { code, client_id: c.client_id, client_secret: c.client_secret });
  assert.equal((await r.json()).error, 'invalid_request');
  r = await postForm('/token', { grant_type: 'authorization_code', code, redirect_uri: MICROSOFT_REDIRECT, client_id: c.client_id, client_secret: c.client_secret });
  const tok = await r.json();
  assert.ok(tok.expires_in <= 3600 && tok.expires_in >= 3590);
});

test('strict mode requires the downstream verifier', async () => {
  const strict = await startBridge({ REQUIRE_DOWNSTREAM_PKCE: 'true' });
  try {
    const c = await registerClient({}, strict.base);
    const verifier = b64u(randomBytes(32));
    const { code } = await signIn(c, { challenge: s256(verifier), b: strict.base });
    const r = await postForm('/token', { grant_type: 'authorization_code', code, redirect_uri: MICROSOFT_REDIRECT, client_id: c.client_id, client_secret: c.client_secret }, {}, strict.base);
    assert.equal((await r.json()).error, 'invalid_grant');
  } finally { strict.server.close(); }
});

// ---------- MCP proxy ----------
test('/mcp without a bearer token returns 401 with the resource_metadata challenge', async () => {
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('connection'), 'close');
  assert.equal(r.headers.get('www-authenticate'), `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="mcp_read"`);
});

test('/mcp forwards JSON-RPC with the user token, query, and session headers', async () => {
  const r = await fetch(base + '/mcp?toolsets=core', {
    method: 'POST',
    headers: { authorization: 'Bearer dd-access-1', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', cookie: 'secret=1' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('mcp-session-id'), 'sess-1');
  assert.equal((await r.json()).result.tools[0].name, 'search_datadog_hosts');
  const call = dd.mcpCalls.at(-1);
  const q = new URLSearchParams(call.search);
  assert.equal(q.get('omit_tools'), 'upsert_datadog_dashboard');
  assert.equal(q.get('toolsets'), 'core');
  assert.equal(call.headers['mcp-protocol-version'], '2025-06-18');
  assert.equal(call.headers.cookie, undefined, 'cookies are not forwarded');
  assert.equal(JSON.parse(call.body).method, 'tools/list');
});

test('/mcp streams SSE without buffering', async () => {
  const r = await fetch(base + '/mcp', { headers: { authorization: 'Bearer dd-access-1', accept: 'text/event-stream' } });
  assert.equal(r.headers.get('content-type'), 'text/event-stream');
  const reader = r.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /"n":1/);
  let rest = '';
  for (;;) { const { value, done } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
  assert.match(rest, /"n":2/);
});

test('/mcp maps an upstream 401 to invalid_token with the challenge', async () => {
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { authorization: 'Bearer expired-token', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /^Bearer error="invalid_token", resource_metadata="/);
});

test('oversized bodies are rejected; no secrets or tokens in logs', async () => {
  const r = await fetch(base + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a='.padEnd(70 * 1024, 'x') });
  assert.equal(r.status, 413);
  const text = JSON.stringify(logs);
  for (const s of ['dd-access-1', 'dd-refresh-1', 'dd-code-', 'client_secret"']) assert.ok(!text.includes(s), `log leaked ${s}`);
});

test('config rejects weak or unsafe settings', () => {
  const ok = { PUBLIC_BASE_URL: 'https://bridge.example.com', BRIDGE_SECRET: b64u(randomBytes(32)) };
  assert.doesNotThrow(() => loadConfig(ok));
  assert.throws(() => loadConfig({ ...ok, BRIDGE_SECRET: b64u(randomBytes(16)) }), /32 bytes/);
  assert.throws(() => loadConfig({ ...ok, PUBLIC_BASE_URL: 'http://bridge.example.com' }), /https/);
  assert.throws(() => loadConfig({ ...ok, PUBLIC_BASE_URL: 'https://bridge.example.com/x' }), /origin/);
  assert.throws(() => loadConfig({ ...ok, ALLOWED_REDIRECT_URIS: 'http://evil.example.com/cb' }), /https/);
});
