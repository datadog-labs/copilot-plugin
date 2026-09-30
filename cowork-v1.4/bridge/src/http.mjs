// Small HTTP helpers shared by the OAuth and MCP handlers.

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

export function baseHeaders(https) {
  return https ? { ...BASE_HEADERS, 'strict-transport-security': 'max-age=31536000' } : { ...BASE_HEADERS };
}

export function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

/** RFC 6749 error response: JSON, no-store. */
export function sendOAuthError(res, status, error, description, headers = {}) {
  const body = { error };
  if (description) body.error_description = description;
  sendJson(res, status, body, { 'cache-control': 'no-store', pragma: 'no-cache', ...headers });
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Plain error page for requests that must not be redirected (unknown client or redirect_uri). */
export function sendPage(res, status, title, message) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>`
    + '<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#1f1f1f}h1{font-size:1.25rem}</style></head>'
    + `<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
  res.end(html);
}

/** The bridge's own consent step: the user confirms before the browser is sent to Datadog. */
export function sendConsentPage(res, { consent, redirectHost, site }) {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Connect Datadog</title><style>'
    + 'body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#1f1f1f}'
    + 'h1{font-size:1.25rem}dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem}dt{color:#555}dd{margin:0;word-break:break-all}'
    + 'form{display:flex;gap:.75rem;margin-top:1.5rem}button{font:inherit;padding:.5rem 1rem;border-radius:.375rem;border:1px solid #632ca6;cursor:pointer}'
    + '.allow{background:#632ca6;color:#fff}.deny{background:#fff;color:#632ca6}</style></head><body>'
    + '<h1>Connect your Datadog account</h1>'
    + '<p>An app is asking to use Datadog MCP with your Datadog account. You will sign in at Datadog next; tools act with your Datadog permissions.</p>'
    + `<dl><dt>Returns to</dt><dd>${escapeHtml(redirectHost)}</dd><dt>Datadog site</dt><dd>${escapeHtml(site)}</dd></dl>`
    + '<p>Continue only if you just clicked <strong>Connect</strong> for the Datadog plugin in Microsoft 365 Copilot.</p>'
    + `<form method="post" action="/authorize"><input type="hidden" name="consent" value="${escapeHtml(consent)}">`
    + '<button class="allow" type="submit" name="decision" value="allow">Continue to Datadog</button>'
    + '<button class="deny" type="submit" name="decision" value="deny">Cancel</button></form></body></html>';
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
  res.end(html);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export function serializeCookie(name, value, { secure, maxAge }) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

/** Read a request body up to limit bytes; throws HttpError(413) beyond it. */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) { req.resume(); reject(new HttpError(413, 'request body too large')); return; }
    const chunks = [];
    let size = 0, done = false;
    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > limit) { done = true; req.resume(); reject(new HttpError(413, 'request body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', err => { if (!done) { done = true; reject(err); } });
  });
}

/** application/x-www-form-urlencoded body -> object (first value wins). */
export function parseForm(buf) {
  const out = {};
  for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) if (!(k in out)) out[k] = v;
  return out;
}

/** Query string -> object (first value wins). */
export function parseQuery(url) {
  const out = {};
  for (const [k, v] of url.searchParams) if (!(k in out)) out[k] = v;
  return out;
}
