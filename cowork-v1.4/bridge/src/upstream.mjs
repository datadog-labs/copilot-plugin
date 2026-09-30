// Datadog side of the bridge: authorization server discovery, public client registration, and the two
// token calls. This is the part of the Datadog VS Code extension's sign-in that Microsoft's token store
// cannot do: it always sends the PKCE code_verifier that matches the challenge used at sign-in.

export function createUpstream(config, { fetch: fetchImpl = globalThis.fetch, log } = {}) {
  let metadata = null;
  let clientId = config.upstreamClientId || null;
  let pending = null;

  async function discover() {
    try {
      const res = await fetchImpl(config.upstreamMetadataUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const doc = await res.json();
      for (const key of ['authorization_endpoint', 'token_endpoint']) {
        if (typeof doc[key] !== 'string' || !/^https?:\/\//.test(doc[key])) throw new Error(`metadata missing ${key}`);
      }
      return doc;
    } catch (err) {
      log?.('warn', 'upstream_discovery_fallback', { reason: err.message });
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
    if (metadata && clientId) return Promise.resolve({ metadata, clientId });
    if (!pending) {
      pending = (async () => {
        metadata = metadata || await discover();
        clientId = clientId || await register(metadata);
        return { metadata, clientId };
      })().finally(() => { pending = null; });
    }
    return pending;
  }

  async function authorizeUrl({ state, challenge }) {
    const { metadata: m, clientId: id } = await ready();
    const url = new URL(m.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', id);
    url.searchParams.set('redirect_uri', config.callbackUrl);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (config.upstreamScope) url.searchParams.set('scope', config.upstreamScope);
    return url.toString();
  }

  async function tokenCall(params) {
    const { metadata: m, clientId: id } = await ready();
    const body = new URLSearchParams({ ...params, client_id: id });
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
      err.upstreamError = typeof json.error === 'string' ? json.error : undefined;
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
    exchangeCode: ({ code, verifier }) => tokenCall({ grant_type: 'authorization_code', code, redirect_uri: config.callbackUrl, code_verifier: verifier }),
    refresh: refreshToken => tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    get clientId() { return clientId; },
  };
}
