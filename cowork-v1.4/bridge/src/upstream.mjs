// Datadog side of the bridge: authorization server discovery, public client registration, and the two
// token calls. This is the part of the Datadog VS Code extension's sign-in that Microsoft's token store
// cannot do: it always sends the PKCE code_verifier that matches the challenge used at sign-in.

const REDISCOVER_AFTER = 60; // seconds before retrying discovery after a fallback

export function createUpstream(config, { fetch: fetchImpl = globalThis.fetch, log } = {}) {
  let metadata = null;
  let discovered = false;
  let nextDiscovery = 0;
  let clientId = config.upstreamClientId || null;
  let pending = null;

  const allowedEndpoint = value => {
    if (typeof value !== 'string') return false;
    try {
      const u = new URL(value);
      return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
    } catch { return false; }
  };

  async function discover() {
    try {
      const res = await fetchImpl(config.upstreamMetadataUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const doc = await res.json();
      for (const key of ['authorization_endpoint', 'token_endpoint']) {
        if (!allowedEndpoint(doc[key])) throw new Error(`metadata ${key} missing or not https`);
      }
      if (doc.registration_endpoint !== undefined && !allowedEndpoint(doc.registration_endpoint)) throw new Error('metadata registration_endpoint not https');
      discovered = true;
      return doc;
    } catch (err) {
      log?.('warn', 'upstream_discovery_fallback', { reason: err.message });
      discovered = false;
      nextDiscovery = Math.floor(Date.now() / 1000) + REDISCOVER_AFTER;
      return { ...config.upstreamFallback };
    }
  }

  async function register(doc) {
    const endpoint = doc.registration_endpoint || config.upstreamFallback.registration_endpoint;
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Datadog for Copilot Cowork (bridge)',
        redirect_uris: [config.callbackUrl],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || typeof body.client_id !== 'string') throw new Error(`Datadog client registration failed (status ${res.status})`);
    log?.('info', 'upstream_client_registered', { client_id: body.client_id, redirect_uri: config.callbackUrl });
    return body.client_id;
  }

  /** Discovery + registration once; retried on the next request if Datadog was unreachable. */
  function ready() {
    const stale = !discovered && Math.floor(Date.now() / 1000) >= nextDiscovery;
    if (metadata && clientId && !stale) return Promise.resolve({ metadata, clientId });
    if (!pending) {
      pending = (async () => {
        if (!metadata || stale) metadata = await discover();
        clientId = clientId || await register(metadata);
        return { metadata, clientId };
      })().finally(() => { pending = null; });
    }
    return pending;
  }

  /** Datadog sign-in URL; call after ready() so the client_id sealed into state is the one used here. */
  function authorizeUrl({ state, challenge, clientId: id }) {
    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', id || clientId);
    url.searchParams.set('redirect_uri', config.callbackUrl);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (config.upstreamScope) url.searchParams.set('scope', config.upstreamScope);
    return url.toString();
  }

  async function tokenCall(params, id) {
    const { metadata: m, clientId: current } = await ready();
    const body = new URLSearchParams({ ...params, client_id: id || current });
    const res = await fetchImpl(m.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || typeof json.access_token !== 'string') {
      // Datadog error codes are not secret; tokens never reach the log.
      const err = new Error('Datadog token endpoint rejected the request');
      err.status = res.status;
      err.upstreamError = typeof json.error === 'string' ? json.error.slice(0, 64) : undefined;
      err.upstreamDescription = typeof json.error_description === 'string' ? json.error_description.slice(0, 200) : undefined;
      throw err;
    }
    return {
      access_token: json.access_token,
      refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
      expires_in: Number.isFinite(json.expires_in) ? json.expires_in : undefined,
      scope: typeof json.scope === 'string' ? json.scope : undefined,
    };
  }

  return {
    ready,
    authorizeUrl,
    exchangeCode: ({ code, verifier, clientId: id }) => tokenCall({ grant_type: 'authorization_code', code, redirect_uri: config.callbackUrl, code_verifier: verifier }, id),
    refresh: (refreshToken, id) => tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken }, id),
    get clientId() { return clientId; },
  };
}
