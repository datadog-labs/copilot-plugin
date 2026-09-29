#!/usr/bin/env node
// Render module resources into apply-ready Datadog API payloads under build/<module>/<resource>.json.
//
//   node tools/render.mjs                      # all enabled modules, fresh-org replay (includes adopted)
//   node tools/render.mjs github entra-id      # selected modules
//   node tools/render.mjs --skip-adopted       # re-apply to the org the adopted resources came from
//   node tools/render.mjs --check              # render in memory only; exit 1 on missing parameters
//   node tools/render.mjs --env ../my-org.env  # use a specific .env (default: runbook/.env, or $RUNBOOK_ENV)
//
// ${id.<resource>} references to resources that have not been applied yet render as "(not applied yet)"
// and are reported as warnings; tools/apply.mjs resolves them as it creates dashboards first.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  RUNBOOK_ROOT, applyTargets, loadEnv, loadManifest, loadModules, parseArgs, renderText, resolveParams,
} from './lib/runbook.mjs';

const { flags, positional } = parseArgs();
const manifest = loadManifest();
const env = loadEnv();
const { params, missingRequired } = resolveParams(manifest, env.values);
const checkOnly = flags.has('check');

if (!env.exists) console.warn(`note: ${env.file} not found - using process environment and defaults (copy .env.example to .env)`);
if (missingRequired.length) console.warn(`warning: required parameters without a value: ${missingRequired.join(', ')}`);

let count = 0, errors = 0, warnings = 0;
for (const { entry, dir, module } of loadModules(manifest, { only: positional })) {
  if (!module) { console.warn(`skip ${entry.id}: ${entry.path} missing`); warnings++; continue; }
  for (const res of applyTargets(module, { skipAdopted: flags.has('skip-adopted') })) {
    const src = join(dir, res.file);
    const { text, missing, unresolvedIds } = renderText(readFileSync(src, 'utf8'), params, env.values,
      { unresolved: manifest.idReferences?.unresolved });
    const title = renderText(res.title, params, env.values).text;
    if (missing.length) { console.error(`error ${entry.id}/${res.id}: missing parameters ${missing.join(', ')}`); errors++; continue; }
    try { JSON.parse(text); } catch (e) { console.error(`error ${entry.id}/${res.id}: rendered JSON invalid: ${e.message}`); errors++; continue; }
    if (unresolvedIds.length) { console.warn(`warn  ${entry.id}/${res.id}: links to not-yet-applied ${unresolvedIds.join(', ')}`); warnings++; }
    if (!checkOnly) {
      const dest = join(RUNBOOK_ROOT, 'build', entry.id, `${res.id}.json`);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, text);
    }
    count++;
    console.log(`${checkOnly ? 'ok      ' : 'rendered'} ${entry.id}/${res.id} (${res.kind}${res.origin === 'adopted' ? ', adopted' : ''}) -> ${title}`);
  }
}
console.log(`${count} resource(s) ${checkOnly ? 'checked' : 'rendered to build/'}; ${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);
