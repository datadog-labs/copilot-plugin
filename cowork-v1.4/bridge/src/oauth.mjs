// Microsoft side of the bridge: a standard MCP authorization server.
//   RFC 9728 protected resource metadata -> RFC 8414 server metadata -> RFC 7591 registration (issues a
//   client secret, which Microsoft DCR requires) -> consent -> authorization code grant -> refresh grant.
// Sign-in itself is delegated to Datadog with the bridge's own PKCE pair (upstream.mjs).
//
// Every client shares one Datadog client, so the bridge asks the user to confirm each connection on its
// own consent page (CSRF-protected POST) and binds the Datadog callback to the browser that confirmed it
// (MCP security best practices, "Confused deputy").
import { randomBytes } from 'node:crypto';
import { b64u, newVerifier, now, s256, safeEqual } from './seal.mjs';
import { parseCookies, parseForm, redirect, sendConsentPage, sendJson, sendOAuthError, sendPage, serializeCookie } from './http.mjs';

const CONSENT_TTL = 600; // consent page to Datadog sign-in, seconds
const STATE_TTL = 600; // Datadog sign-in window, seconds
const CODE_TTL = 300; // downstream authorization code lifetime, seconds
const REFRESH_TTL = 90 * 24 * 3600; // sealed refresh token lifetime, seconds
const MAX_STATE = 8192;
const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;
const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const clip = (s, n = 200) => String(s ?? '').slice(0, n);

export function createOAuth(config, { sealer, upstream, log }) {
  const usedCodes = new Map(); // jti -> exp (single replica; see README "Limitations")
  const secure = config.baseUrl.startsWith('https://');
  const cookieName = name => (secure ? `__Host-${name}` : name);

  function consumeCode(jti, exp) {
    const t = now();
    for (const [k, e] of usedCodes) if (e < t) usedCodes.delete(k);
    if (usedCodes.has(jti)) return false;
    usedCodes.set(jti, exp);
    return true;
  }

  const scopes = () => (config.upstreamScope ? config.upstreamScope.split(/\s+/) : []);

  function protectedResourceMetadata() {
    return {
      resource: config.resource,
      authorization_servers: [config.baseUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: scopes(),
      resource_name: 'Datadog MCP (Copilot Cowork bridge)',
    };
  }

  function authorizationServerMetadata() {
    return {
      issuer: config.baseUrl,
      authorization_endpoint: `${config.baseUrl}/authorize`,
      token_endpoint: `${config.baseUrl}/token`,
      registration_endpoint: `${config.baseUrl}/register`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      scopes_supported: scopes(),
    };
  }

  // RFC 7591. Redirect URIs outside the allowlist are dropped; registration fails if none remain.
  function register(req, res, body) {
    let meta;
    try { meta = JSON.parse(body.toString('utf8') || '{}'); } catch { return sendOAuthError(res, 400, 'invalid_client_metadata', 'body must be JSON'); }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return sendOAuthError(res, 400, 'invalid_client_metadata', 'body must be a JSON object');
    const requested = Array.isArray(meta.redirect_uris) ? meta.redirect_uris.filter(u => typeof u === 'string') : [];
    const allowed = requested.filter(u => config.allowedRedirectUris.includes(u));
    const dropped = requested.filter(u => !config.allowedRedirectUris.includes(u));
    if (dropped.length) log('warn', 'register_redirect_uri_not_allowed', { redirect_uris: dropped.slice(0, 5).map(u => clip(u, 300)) });
    if (!allowed.length) {
      return sendOAuthError(res, 400, 'invalid_redirect_uri', `redirect_uris must include one of: ${config.allowedRedirectUris.join(', ')}`);
    }
    const method = meta.token_endpoint_auth_method === 'client_secret_basic' ? 'client_secret_basic' : 'client_secret_post';
    const grantTypes = (Array.isArray(meta.grant_types) ? meta.grant_types : ['authorization_code', 'refresh_token'])
      .filter(g => g === 'authorization_code' || g === 'refresh_token');
    const clientId = sealer.newClientId();
    log('info', 'client_registered', { client_id: clientId, client_name: clip(meta.client_name, 100), auth_method: method, requested_auth_method: clip(meta.token_endpoint_auth_method, 40) });
    const out = {
      client_id: clientId,
      client_secret: sealer.clientSecret(clientId),
      client_id_issued_at: now(),
      client_secret_expires_at: 0,
      redirect_uris: allowed,
      token_endpoint_auth_method: method,
      grant_types: grantTypes.length ? grantTypes : ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
    if (typeof meta.client_name === 'string') out.client_name = meta.client_name.slice(0, 200);
    if (config.upstreamScope) out.scope = config.upstreamScope;
    sendJson(res, 201, out, { 'cache-control': 'no-store', pragma: 'no-cache' });
  }

  function errorRedirect(res, redirectUri, error, description, state) {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error);
    if (description) url.searchParams.set('error_description', description);
    if (state !== undefined) url.searchParams.set('state', state);
    redirect(res, url.toString());
  }

  /** Validate an authorization request. Returns { request } or { page } / { redirectError } to send. */
  function validateAuthorize(q) {
    if (!sealer.isClientId(q.client_id)) {
      log('warn', 'authorize_unknown_client', {});
      return { page: ['Unknown client', 'This sign-in link was not issued for a client registered with this Datadog bridge. Start the connection again from Copilot.'] };
    }
    let redirectUri = q.redirect_uri;
    const redirectProvided = typeof redirectUri === 'string';
    if (!redirectProvided && config.allowedRedirectUris.length === 1) redirectUri = config.allowedRedirectUris[0];
    if (!redirectUri || !config.allowedRedirectUris.includes(redirectUri)) {
      log('warn', 'authorize_redirect_uri_not_allowed', { redirect_uri: clip(redirectUri, 300) });
      return { page: ['Invalid redirect_uri', 'The redirect_uri in this sign-in link is not allowed by this Datadog bridge.'] };
    }
    if (typeof q.state === 'string' && q.state.length > MAX_STATE) {
      return { redirectError: [redirectUri, 'invalid_request', 'state is too long', undefined] };
    }
    const state = typeof q.state === 'string' ? q.state : undefined;
    if (q.response_type !== 'code') return { redirectError: [redirectUri, 'unsupported_response_type', 'response_type must be code', state] };
    let challenge;
    if (q.code_challenge !== undefined) {
      if (q.code_challenge_method !== 'S256') return { redirectError: [redirectUri, 'invalid_request', 'code_challenge_method must be S256', state] };
      if (!PKCE_VALUE.test(q.code_challenge)) return { redirectError: [redirectUri, 'invalid_request', 'code_challenge is malformed', state] };
      challenge = q.code_challenge;
    } else if (config.requireDownstreamPkce) {
      return { redirectError: [redirectUri, 'invalid_request', 'code_challenge is required', state] };
    }
    return { request: { cid: q.client_id, ru: redirectUri, rp: redirectProvided, s: state, cc: challenge } };
  }

  // GET /authorize: validate, then ask the user to confirm on the bridge's own page.
  function authorize(req, res, q) {
    const v = validateAuthorize(q);
    if (v.page) return sendPage(res, 400, ...v.page);
    if (v.redirectError) return errorRedirect(res, ...v.redirectError);
    const csrf = b64u(randomBytes(18));
    const consent = sealer.seal('consent', { r: v.request, x: s256(csrf), exp: now() + CONSENT_TTL });
    res.setHeader('set-cookie', serializeCookie(cookieName('ddb_csrf'), csrf, { secure, maxAge: CONSENT_TTL }));
    log('info', 'authorize_consent_shown', { client_id: v.request.cid });
    sendConsentPage(res, { consent, redirectHost: new URL(v.request.ru).host, site: config.site });
  }

  // POST /authorize: the user confirmed (or cancelled) on the consent page.
  async function authorizeConfirm(req, res, body) {
    const form = parseForm(body);
    const c = sealer.open('consent', form.consent);
    const cookies = parseCookies(req.headers.cookie);
    const csrf = cookies[cookieName('ddb_csrf')];
    if (!c || !csrf || !safeEqual(s256(csrf), c.x)) {
      log('warn', 'authorize_consent_invalid', { has_cookie: Boolean(csrf) });
      return sendPage(res, 400, 'Sign-in expired', 'This confirmation expired or was not opened in this browser. Start the connection again from Copilot.');
    }
    const r = c.r;
    const clearCsrf = serializeCookie(cookieName('ddb_csrf'), '', { secure, maxAge: 0 });
    if (form.decision !== 'allow') {
      res.setHeader('set-cookie', clearCsrf);
      log('info', 'authorize_consent_denied', { client_id: r.cid });
      return errorRedirect(res, r.ru, 'access_denied', 'The user cancelled the Datadog connection', r.s);
    }
    let clientId;
    try {
      ({ clientId } = await upstream.ready());
    } catch (err) {
      log('error', 'upstream_unavailable', { reason: err.message });
      return errorRedirect(res, r.ru, 'temporarily_unavailable', 'Datadog sign-in is unavailable; try again shortly', r.s);
    }
    const verifier = newVerifier();
    const flow = b64u(randomBytes(18));
    const flowId = b64u(randomBytes(6));
    const upstreamState = sealer.seal('state', { ...r, v: verifier, uc: clientId, f: flowId, b: s256(flow), exp: now() + STATE_TTL });
    const location = upstream.authorizeUrl({ state: upstreamState, challenge: s256(verifier), clientId });
    res.setHeader('set-cookie', [clearCsrf, serializeCookie(cookieName(`ddb_flow_${flowId}`), flow, { secure, maxAge: STATE_TTL })]);
    log('info', 'authorize_redirect_to_datadog', { client_id: r.cid, pkce: Boolean(r.cc) });
    redirect(res, location);
  }

  async function callback(req, res, q) {
    const st = sealer.open('state', q.state);
    if (!st) {
      log('warn', 'callback_state_invalid', {});
      return sendPage(res, 400, 'Sign-in expired', 'This Datadog sign-in could not be matched to a Copilot request, or it took longer than 10 minutes. Start the connection again from Copilot.');
    }
    const flowCookie = cookieName(`ddb_flow_${st.f}`);
    const flow = parseCookies(req.headers.cookie)[flowCookie];
    if (!flow || !safeEqual(s256(flow), st.b)) {
      log('warn', 'callback_browser_mismatch', { client_id: st.cid, has_cookie: Boolean(flow) });
      return sendPage(res, 400, 'Sign-in not started here', 'This Datadog sign-in was not started in this browser. Start the connection again from Copilot.');
    }
    res.setHeader('set-cookie', serializeCookie(flowCookie, '', { secure, maxAge: 0 }));
    if (q.error) {
      const error = ERROR_CODE.test(q.error) ? q.error : 'access_denied';
      log('warn', 'callback_datadog_error', { error });
      return errorRedirect(res, st.ru, error, typeof q.error_description === 'string' ? clip(q.error_description) : undefined, st.s);
    }
    if (typeof q.code !== 'string' || !q.code) return errorRedirect(res, st.ru, 'invalid_request', 'Datadog returned no authorization code', st.s);

    let tokens;
    try {
      tokens = await upstream.exchangeCode({ code: q.code, verifier: st.v, clientId: st.uc });
    } catch (err) {
      log('error', 'upstream_code_exchange_failed', { status: err.status, error: err.upstreamError, description: err.upstreamDescription });
      return errorRedirect(res, st.ru, 'server_error', `Datadog token exchange failed${err.upstreamError ? ` (${err.upstreamError})` : ''}`, st.s);
    }
    const code = sealer.seal('code', {
      t: tokens, iat: now(), uc: st.uc, cid: st.cid, ru: st.ru, rp: st.rp, cc: st.cc, jti: b64u(randomBytes(16)), exp: now() + CODE_TTL,
    });
    log('info', 'callback_code_issued', { client_id: st.cid });
    const url = new URL(st.ru);
    url.searchParams.set('code', code);
    if (st.s !== undefined) url.searchParams.set('state', st.s);
    redirect(res, url.toString());
  }

  // RFC 6749 section 2.3.1: Basic credentials are form-urlencoded before base64; one method per request.
  function clientCredentials(headers, form) {
    const h = headers.authorization || '';
    if (/^basic\s+/i.test(h)) {
      if (form.client_secret !== undefined) return { invalid: 'invalid_request', basic: true };
      const decoded = Buffer.from(h.replace(/^basic\s+/i, '').trim(), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i < 0) return { invalid: 'invalid_client', basic: true };
      const id = formDecode(decoded.slice(0, i)), secret = formDecode(decoded.slice(i + 1));
      if (id === null || secret === null) return { invalid: 'invalid_client', basic: true };
      if (form.client_id !== undefined && form.client_id !== id) return { invalid: 'invalid_client', basic: true };
      return { id, secret, basic: true };
    }
    return { id: form.client_id, secret: form.client_secret };
  }

  function tokenResponse(res, tokens, clientId, upstreamClientId, elapsed = 0) {
    const body = { access_token: tokens.access_token, token_type: 'Bearer' };
    if (tokens.expires_in !== undefined) body.expires_in = Math.max(0, tokens.expires_in - elapsed);
    if (tokens.refresh_token) body.refresh_token = sealer.seal('refresh', { rt: tokens.refresh_token, cid: clientId, uc: upstreamClientId, exp: now() + REFRESH_TTL });
    if (tokens.scope) body.scope = tokens.scope;
    sendJson(res, 200, body, { 'cache-control': 'no-store', pragma: 'no-cache' });
  }

  async function token(req, res, body) {
    const form = parseForm(body);
    const cred = clientCredentials(req.headers, form);
    const basicChallenge = cred.basic ? { 'www-authenticate': 'Basic realm="datadog-cowork-bridge"' } : {};
    if (cred.invalid === 'invalid_request') return sendOAuthError(res, 400, 'invalid_request', 'use one client authentication method');
    if (cred.invalid) return sendOAuthError(res, 401, 'invalid_client', 'client authentication failed', basicChallenge);
    let authenticated = false;
    if (cred.secret !== undefined) {
      if (!sealer.checkClientSecret(cred.id, cred.secret)) {
        log('warn', 'token_client_auth_failed', { basic: Boolean(cred.basic) });
        return sendOAuthError(res, 401, 'invalid_client', 'client authentication failed', basicChallenge);
      }
      authenticated = true;
    } else if (!sealer.isClientId(cred.id)) {
      return sendOAuthError(res, 401, 'invalid_client', 'unknown client_id');
    }
    const clientId = cred.id;

    if (form.grant_type === 'authorization_code') {
      const c = sealer.open('code', form.code);
      if (!c || !safeEqual(c.cid, clientId)) return sendOAuthError(res, 400, 'invalid_grant', 'authorization code is invalid or expired');
      if (form.redirect_uri === undefined ? c.rp : form.redirect_uri !== c.ru) {
        return sendOAuthError(res, 400, 'invalid_grant', 'redirect_uri does not match the authorization request');
      }
      if (form.code_verifier !== undefined) {
        if (!c.cc) return sendOAuthError(res, 400, 'invalid_grant', 'code_verifier sent but no code_challenge was used');
        if (!PKCE_VALUE.test(form.code_verifier) || !safeEqual(s256(form.code_verifier), c.cc)) return sendOAuthError(res, 400, 'invalid_grant', 'code_verifier does not match code_challenge');
      } else if (!authenticated || config.requireDownstreamPkce) {
        return sendOAuthError(res, 400, 'invalid_grant', 'code_verifier is required');
      } else if (c.cc) {
        // Microsoft's token store sends the client secret but omits code_verifier (RELEASES.md 1.4.3).
        // A secret-authenticated confidential client is accepted without it unless strict mode is on.
        log('warn', 'token_pkce_verifier_omitted_by_confidential_client', { client_id: clientId });
      }
      if (!consumeCode(c.jti, c.exp)) {
        log('warn', 'token_code_replay', { client_id: clientId });
        return sendOAuthError(res, 400, 'invalid_grant', 'authorization code was already used');
      }
      log('info', 'token_issued', { client_id: clientId, grant: 'authorization_code', authenticated });
      return tokenResponse(res, c.t, clientId, c.uc, now() - (c.iat ?? now()));
    }

    if (form.grant_type === 'refresh_token') {
      // Every client is issued a secret, so refresh requires it (RFC 6749 section 6).
      if (!authenticated) return sendOAuthError(res, 401, 'invalid_client', 'client authentication is required to refresh');
      const r = sealer.open('refresh', form.refresh_token);
      if (!r || !safeEqual(r.cid, clientId)) return sendOAuthError(res, 400, 'invalid_grant', 'refresh token is invalid or expired');
      let tokens;
      try {
        tokens = await upstream.refresh(r.rt, r.uc);
      } catch (err) {
        log('warn', 'upstream_refresh_failed', { status: err.status, error: err.upstreamError });
        if (err.status >= 400 && err.status < 500) return sendOAuthError(res, 400, 'invalid_grant', 'Datadog refused the refresh token; sign in again');
        return sendOAuthError(res, 503, 'temporarily_unavailable', 'Datadog token endpoint is unavailable');
      }
      if (!tokens.refresh_token) tokens.refresh_token = r.rt;
      log('info', 'token_issued', { client_id: clientId, grant: 'refresh_token', authenticated });
      return tokenResponse(res, tokens, clientId, r.uc);
    }

    if (form.grant_type === undefined) return sendOAuthError(res, 400, 'invalid_request', 'grant_type is required');
    return sendOAuthError(res, 400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  }

  return { protectedResourceMetadata, authorizationServerMetadata, register, authorize, authorizeConfirm, callback, token };
}

function formDecode(s) {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return null; }
}
