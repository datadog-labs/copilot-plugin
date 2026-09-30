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
