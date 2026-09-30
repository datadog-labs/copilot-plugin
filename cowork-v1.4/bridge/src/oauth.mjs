// Microsoft side of the bridge: a standard MCP authorization server.
//   RFC 9728 protected resource metadata -> RFC 8414 server metadata -> RFC 7591 registration (issues a
//   client secret, which Microsoft DCR requires) -> authorization code grant -> refresh grant.
// Sign-in itself is delegated to Datadog with the bridge's own PKCE pair (upstream.mjs).
import { randomBytes } from 'node:crypto';
import { b64u, newVerifier, now, s256, safeEqual } from './seal.mjs';
import { parseForm, redirect, sendJson, sendOAuthError, sendPage } from './http.mjs';

const STATE_TTL = 600; // Datadog sign-in window, seconds
const CODE_TTL = 300; // downstream authorization code lifetime, seconds
const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;
const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

export function createOAuth(config, { sealer, upstream, log }) {
  const usedCodes = new Map(); // jti -> exp (single replica; see README "Limitations")

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
    if (dropped.length) log('warn', 'register_redirect_uri_not_allowed', { redirect_uris: dropped });
    if (!allowed.length) {
      return sendOAuthError(res, 400, 'invalid_redirect_uri', `redirect_uris must include one of: ${config.allowedRedirectUris.join(', ')}`);
    }
    const method = meta.token_endpoint_auth_method === 'client_secret_basic' ? 'client_secret_basic' : 'client_secret_post';
    const grantTypes = (Array.isArray(meta.grant_types) ? meta.grant_types : ['authorization_code', 'refresh_token'])
      .filter(g => g === 'authorization_code' || g === 'refresh_token');
    const clientId = sealer.newClientId();
    const issuedAt = now();
    log('info', 'client_registered', { client_id: clientId, client_name: String(meta.client_name || '').slice(0, 100), auth_method: method, requested_auth_method: meta.token_endpoint_auth_method });
    const out = {
      client_id: clientId,
      client_secret: sealer.clientSecret(clientId),
      client_id_issued_at: issuedAt,
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

  async function authorize(req, res, q) {
    if (!sealer.isClientId(q.client_id)) {
      log('warn', 'authorize_unknown_client', {});
      return sendPage(res, 400, 'Unknown client', 'This sign-in link was not issued for a client registered with this Datadog bridge. Start the connection again from Copilot.');
    }
    let redirectUri = q.redirect_uri;
    const redirectProvided = typeof redirectUri === 'string';
    if (!redirectProvided && config.allowedRedirectUris.length === 1) redirectUri = config.allowedRedirectUris[0];
    if (!redirectUri || !config.allowedRedirectUris.includes(redirectUri)) {
      log('warn', 'authorize_redirect_uri_not_allowed', { redirect_uri: String(redirectUri || '').slice(0, 300) });
      return sendPage(res, 400, 'Invalid redirect_uri', 'The redirect_uri in this sign-in link is not allowed by this Datadog bridge.');
    }
    const state = typeof q.state === 'string' ? q.state.slice(0, 4096) : undefined;
    if (q.response_type !== 'code') return errorRedirect(res, redirectUri, 'unsupported_response_type', 'response_type must be code', state);

    let challenge, method;
    if (q.code_challenge !== undefined) {
      challenge = q.code_challenge;
      method = q.code_challenge_method || 'plain';
      if (!PKCE_VALUE.test(challenge)) return errorRedirect(res, redirectUri, 'invalid_request', 'code_challenge is malformed', state);
      if (method !== 'S256' && method !== 'plain') return errorRedirect(res, redirectUri, 'invalid_request', 'code_challenge_method must be S256', state);
    } else if (config.requireDownstreamPkce) {
      return errorRedirect(res, redirectUri, 'invalid_request', 'code_challenge is required', state);
    }

    const verifier = newVerifier();
    const upstreamState = sealer.seal('state', {
      s: state, cid: q.client_id, ru: redirectUri, rp: redirectProvided, cc: challenge, ccm: method, v: verifier, exp: now() + STATE_TTL,
    });
    let location;
    try {
      location = await upstream.authorizeUrl({ state: upstreamState, challenge: s256(verifier) });
    } catch (err) {
      log('error', 'upstream_unavailable', { reason: err.message });
      return errorRedirect(res, redirectUri, 'temporarily_unavailable', 'Datadog sign-in is unavailable; try again shortly', state);
    }
    log('info', 'authorize_redirect_to_datadog', { client_id: q.client_id, pkce: Boolean(challenge) });
    redirect(res, location);
  }

  async function callback(req, res, q) {
    const st = sealer.open('state', q.state);
    if (!st) {
      log('warn', 'callback_state_invalid', {});
      return sendPage(res, 400, 'Sign-in expired', 'This Datadog sign-in could not be matched to a Copilot request, or it took longer than 10 minutes. Start the connection again from Copilot.');
    }
    if (q.error) {
      const error = ERROR_CODE.test(q.error) ? q.error : 'access_denied';
      log('warn', 'callback_datadog_error', { error });
      return errorRedirect(res, st.ru, error, typeof q.error_description === 'string' ? q.error_description.slice(0, 200) : undefined, st.s);
    }
    if (typeof q.code !== 'string' || !q.code) return errorRedirect(res, st.ru, 'invalid_request', 'Datadog returned no authorization code', st.s);

    let tokens;
    try {
      tokens = await upstream.exchangeCode({ code: q.code, verifier: st.v });
    } catch (err) {
      log('error', 'upstream_code_exchange_failed', { status: err.status, error: err.upstreamError, description: err.upstreamDescription });
      return errorRedirect(res, st.ru, 'server_error', `Datadog token exchange failed${err.upstreamError ? ` (${err.upstreamError})` : ''}`, st.s);
    }
    const code = sealer.seal('code', {
      t: tokens, cid: st.cid, ru: st.ru, rp: st.rp, cc: st.cc, ccm: st.ccm, jti: b64u(randomBytes(16)), exp: now() + CODE_TTL,
    });
    log('info', 'callback_code_issued', { client_id: st.cid });
    const url = new URL(st.ru);
    url.searchParams.set('code', code);
    if (st.s !== undefined) url.searchParams.set('state', st.s);
    redirect(res, url.toString());
  }

  // RFC 6749 section 2.3.1: Basic credentials are form-urlencoded before base64.
  function clientCredentials(headers, form) {
    const h = headers.authorization || '';
    if (/^basic\s+/i.test(h)) {
      const decoded = Buffer.from(h.replace(/^basic\s+/i, '').trim(), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i < 0) return { invalid: true, basic: true };
      const id = formDecode(decoded.slice(0, i)), secret = formDecode(decoded.slice(i + 1));
      if (id === null || secret === null) return { invalid: true, basic: true };
      if (form.client_id !== undefined && form.client_id !== id) return { invalid: true, basic: true };
      return { id, secret, basic: true };
    }
    return { id: form.client_id, secret: form.client_secret };
  }

  function tokenResponse(res, tokens, clientId) {
    const body = { access_token: tokens.access_token, token_type: 'Bearer' };
    if (tokens.expires_in !== undefined) body.expires_in = tokens.expires_in;
    if (tokens.refresh_token) body.refresh_token = sealer.seal('refresh', { rt: tokens.refresh_token, cid: clientId });
    if (tokens.scope) body.scope = tokens.scope;
    sendJson(res, 200, body, { 'cache-control': 'no-store', pragma: 'no-cache' });
  }

  async function token(req, res, body) {
    const form = parseForm(body);
    const cred = clientCredentials(req.headers, form);
    const basicChallenge = cred.basic ? { 'www-authenticate': 'Basic realm="datadog-cowork-bridge"' } : {};
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
      if (form.redirect_uri !== undefined && form.redirect_uri !== c.ru) return sendOAuthError(res, 400, 'invalid_grant', 'redirect_uri does not match the authorization request');
      if (form.code_verifier !== undefined) {
        if (!c.cc) return sendOAuthError(res, 400, 'invalid_grant', 'code_verifier sent but no code_challenge was used');
        const expected = c.ccm === 'S256' ? s256(form.code_verifier) : form.code_verifier;
        if (!PKCE_VALUE.test(form.code_verifier) || !safeEqual(expected, c.cc)) return sendOAuthError(res, 400, 'invalid_grant', 'code_verifier does not match code_challenge');
      } else if (c.cc || !authenticated || config.requireDownstreamPkce) {
        // Microsoft's token store sends the client secret but omits code_verifier (RELEASES.md 1.4.3).
        // A secret-authenticated confidential client is accepted without it unless strict mode is on.
        if (!authenticated || config.requireDownstreamPkce) return sendOAuthError(res, 400, 'invalid_grant', 'code_verifier is required');
        log('warn', 'token_pkce_verifier_omitted_by_confidential_client', { client_id: clientId });
      }
      if (!consumeCode(c.jti, c.exp)) {
        log('warn', 'token_code_replay', { client_id: clientId });
        return sendOAuthError(res, 400, 'invalid_grant', 'authorization code was already used');
      }
      log('info', 'token_issued', { client_id: clientId, grant: 'authorization_code', authenticated });
      return tokenResponse(res, c.t, clientId);
    }

    if (form.grant_type === 'refresh_token') {
      const r = sealer.open('refresh', form.refresh_token);
      if (!r || !safeEqual(r.cid, clientId)) return sendOAuthError(res, 400, 'invalid_grant', 'refresh token is invalid');
      let tokens;
      try {
        tokens = await upstream.refresh(r.rt);
      } catch (err) {
        log('warn', 'upstream_refresh_failed', { status: err.status, error: err.upstreamError });
        if (err.status >= 400 && err.status < 500) return sendOAuthError(res, 400, 'invalid_grant', 'Datadog refused the refresh token; sign in again');
        return sendOAuthError(res, 503, 'temporarily_unavailable', 'Datadog token endpoint is unavailable');
      }
      if (!tokens.refresh_token) tokens.refresh_token = r.rt;
      log('info', 'token_issued', { client_id: clientId, grant: 'refresh_token', authenticated });
      return tokenResponse(res, tokens, clientId);
    }

    return sendOAuthError(res, 400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  }

  return { protectedResourceMetadata, authorizationServerMetadata, register, authorize, callback, token };
}

function formDecode(s) {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return null; }
}
