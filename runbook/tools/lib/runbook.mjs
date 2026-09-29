// Shared runbook library: .env loading, parameter resolution, placeholder rendering and module loading.
// Every tool (render, validate, apply, export, fill-env, docs, bridges) goes through these functions so
// placeholder semantics are identical everywhere.
//
// Placeholders inside module files:
//   ${param}          -> parameter value (runbook.json parameters; .env / process env / default)
//   ${id.resource-id} -> Datadog object id from env DD_ID_<RESOURCE_ID> (written by apply/export/fill-env)
// Datadog's own template syntax ({{#is_alert}}, {{value}}, $template_var) is never touched.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNBOOK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PLACEHOLDER = /\$\{(id\.)?([a-z0-9_.-]+)\}/gi;

/** Parse dotenv text: KEY=value, optional quotes, # comments, blank lines. No interpolation. */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/** Resolve which .env file to use: --env <path>, RUNBOOK_ENV, then <runbook>/.env. */
export function envFilePath(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--env');
  if (i >= 0 && argv[i + 1]) return resolve(argv[i + 1]);
  if (process.env.RUNBOOK_ENV) return resolve(process.env.RUNBOOK_ENV);
  return join(RUNBOOK_ROOT, '.env');
}

/** .env values overlaid by the process environment (process env wins, so CI can override). */
export function loadEnv(file = envFilePath()) {
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  const merged = { ...fromFile };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && v !== '') merged[k] = v;
  return { file, exists: existsSync(file), values: merged, fromFile };
}

/** Update or append KEY=value lines in a .env file, preserving comments and order. */
export function writeEnvValues(file, updates) {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const pending = new Map(Object.entries(updates));
  const out = lines.map(line => {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && pending.has(m[1])) {
      const v = pending.get(m[1]); pending.delete(m[1]);
      return `${m[1]}=${quote(v)}`;
    }
    return line;
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of pending) out.push(`${k}=${quote(v)}`);
  writeFileSync(file, out.join('\n') + '\n');
}
const quote = v => (/[\s#"'|]/.test(String(v)) ? `"${String(v).replace(/"/g, '\\"')}"` : String(v));

export function loadManifest(root = RUNBOOK_ROOT) {
  return JSON.parse(readFileSync(join(root, 'runbook.json'), 'utf8'));
}

/** Env key that stores the Datadog id of a resource. */
export function idEnvKey(resourceId) {
  return 'DD_ID_' + resourceId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/**
 * Resolve parameters. Secrets are only included when includeSecrets is true (API tools), and are
 * never rendered by renderText (they are filtered out of the render map).
 */
export function resolveParams(manifest, env, { includeSecrets = false } = {}) {
  const params = {}, missingRequired = [], secrets = {};
  for (const [name, p] of Object.entries(manifest.parameters)) {
    const raw = env[p.env] ?? p.default;
    if (p.secret) { if (includeSecrets && raw) secrets[name] = raw; continue; }
    if ((raw === undefined || raw === '') && p.required) missingRequired.push(`${name} (${p.env})`);
    params[name] = p.type === 'list' ? String(raw ?? '').split(',').map(s => s.trim()).filter(Boolean) : raw;
  }
  return { params, missingRequired, secrets };
}

/**
 * Render ${...} placeholders. Lists render as JSON arrays when the placeholder is the whole JSON string
 * value ("${github_orgs}" -> ["a","b"]) and as comma-joined text inside longer strings.
 * Returns { text, missing, unresolvedIds }.
 */
export function renderText(text, params, env, { unresolved = '(not applied yet)' } = {}) {
  const missing = new Set(), unresolvedIds = new Set();
  // Whole-value list placeholders first: "${list}" -> JSON array.
  let out = text.replace(/"\$\{([a-z0-9_]+)\}"/gi, (m, name) =>
    Array.isArray(params[name]) ? JSON.stringify(params[name]) : m);
  out = out.replace(PLACEHOLDER, (m, isId, name) => {
    if (isId) {
      const v = env[idEnvKey(name)];
      if (!v) { unresolvedIds.add(name); return unresolved; }
      return v;
    }
    if (!(name in params) || params[name] === undefined || params[name] === '') { missing.add(name); return m; }
    const v = params[name];
    return jsonEscape(Array.isArray(v) ? v.join(',') : String(v));
  });
  return { text: out, missing: [...missing], unresolvedIds: [...unresolvedIds] };
}
// Values land inside JSON strings, so escape quotes/backslashes/control characters.
const jsonEscape = s => JSON.stringify(s).slice(1, -1);

/** Load enabled modules (optionally filtered by id) with their parsed module.json. */
export function loadModules(manifest, { only = [], root = RUNBOOK_ROOT, includeDisabled = false } = {}) {
  const mods = [];
  for (const entry of [...manifest.modules].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    if (!includeDisabled && !entry.enabled) continue;
    if (only.length && !only.includes(entry.id)) continue;
    const path = join(root, entry.path);
    if (!existsSync(path)) { mods.push({ entry, path, dir: dirname(path), module: null }); continue; }
    mods.push({ entry, path, dir: dirname(path), module: JSON.parse(readFileSync(path, 'utf8')) });
  }
  return mods;
}

/**
 * Apply targets of a module, in apply order (dashboards/SLO sources before monitors, so monitor messages
 * can link to freshly created dashboards). Superseded resources are always skipped; adopted resources are
 * skipped when skipAdopted is set (re-applying to the org they were exported from).
 */
const KIND_ORDER = ['log_index', 'log_pipeline', 'log_metric', 'team', 'dashboard', 'notebook', 'synthetics_test', 'monitor', 'slo', 'workflow'];
export function applyTargets(module, { skipAdopted = false } = {}) {
  const resources = module?.resources ?? [];
  const superseded = new Set(resources.map(r => r.supersedes).filter(Boolean));
  return resources
    .filter(r => !superseded.has(r.id))
    .filter(r => !(skipAdopted && r.origin === 'adopted'))
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

/** Common CLI flag parsing: positional module ids + --flags. */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = new Set(), values = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env' || a === '--out' || a === '--site' || a === '--since') { values[a.slice(2)] = argv[++i]; continue; }
    if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); v === undefined ? flags.add(k) : (values[k] = v); continue; }
    positional.push(a);
  }
  return { flags, values, positional };
}
