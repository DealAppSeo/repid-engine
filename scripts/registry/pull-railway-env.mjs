#!/usr/bin/env node
// @ts-check
/**
 * pull-railway-env.mjs — third leg of the anti-drift registry.
 *
 * Pulls env-var NAMES (NEVER values) from every Railway service across all projects,
 * and writes a names-only file that generate-registry.mjs consumes as argv[2].
 *
 * SAFETY (hard invariants):
 *   - RAILWAY_API_TOKEN is read from C:/Users/Cash4/repos/.env.master ONLY.
 *     It is never printed, never placed on a command line, never written to any file.
 *   - Railway's GraphQL `variables(projectId, environmentId, serviceId)` returns a
 *     name->value MAP. We call Object.keys() on it and DISCARD the object immediately.
 *     No value is ever printed, logged, or written.
 *
 * OUTPUT FILE FORMAT (matches generate-registry.mjs's parser, which skips '#' lines and
 * takes the text before '=' on any remaining line — so per-service headers are '#' comments
 * and each var name is on its own line):
 *
 *   # === <project> / <service> (env=production) — <N> names ===
 *   VAR_NAME_1
 *   VAR_NAME_2
 *   ...
 *
 * The generator dedupes into a flat Set of names; this file additionally preserves the
 * per-service grouping (as comments) for the human drift report.
 *
 * USAGE: node scripts/registry/pull-railway-env.mjs
 * Then:  node scripts/registry/generate-registry.mjs <the-output-file>
 */

import fs from 'node:fs';
import path from 'node:path';

const ENV_MASTER = 'C:/Users/Cash4/repos/.env.master';
const OUT_FILE =
  'C:/Users/Cash4/AppData/Local/Temp/claude/C--Users-Cash4-repos-repid-engine/' +
  'b726c7a9-ca73-4909-bc18-18d7d10995be/scratchpad/railway-env-names.txt';
const GRAPHQL = 'https://backboard.railway.app/graphql/v2';

// ---- token (read-only, never printed) ----
function readToken() {
  const raw = fs.readFileSync(ENV_MASTER, 'utf8');
  const line = raw.split(/\r?\n/).find((l) => /^RAILWAY_API_TOKEN=/.test(l));
  if (!line) return null;
  return line.replace(/^RAILWAY_API_TOKEN=/, '').trim().replace(/^["']|["']$/g, '');
}
const TOKEN = readToken();
if (!TOKEN) {
  console.error('RAILWAY_API_TOKEN not found in .env.master');
  process.exit(1);
}

async function gql(query, variables) {
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  return { status: res.status, json: j };
}

// ---- 1. enumerate projects -> environments -> services ----
async function enumerate() {
  const q = `query {
    projects {
      edges { node {
        id name
        environments { edges { node { id name } } }
        services { edges { node { id name } } }
      } }
    }
  }`;
  const { status, json } = await gql(q, {});
  if (json.errors) {
    throw new Error(`enumerate failed (HTTP ${status}): ${JSON.stringify(json.errors).slice(0, 300)}`);
  }
  const projects = [];
  for (const pe of json.data.projects.edges) {
    const p = pe.node;
    const envs = p.environments.edges.map((e) => e.node);
    // prefer an environment literally named 'production'; else first.
    const prod = envs.find((e) => /^production$/i.test(e.name)) || envs[0] || null;
    const services = p.services.edges.map((s) => s.node);
    projects.push({ id: p.id, name: p.name, env: prod, services });
  }
  return projects;
}

// ---- 2. per-service variable NAMES (keys only) ----
async function varNames(projectId, environmentId, serviceId) {
  const q = `query vars($projectId: String!, $environmentId: String!, $serviceId: String!) {
    variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
  }`;
  const { status, json } = await gql(q, { projectId, environmentId, serviceId });
  if (json.errors) {
    return { ok: false, error: `HTTP ${status}: ${JSON.stringify(json.errors).slice(0, 200)}` };
  }
  const map = json.data && json.data.variables;
  if (!map || typeof map !== 'object') {
    return { ok: false, error: 'no variables object returned' };
  }
  // KEYS ONLY. Discard the map (which contains values) immediately.
  const names = Object.keys(map).sort();
  return { ok: true, names };
}

async function main() {
  const projects = await enumerate();
  const lines = [];
  lines.push('# Railway env-var NAMES (names only — NO values). Third leg of the anti-drift registry.');
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push('# One name per line; per-service headers are "#" comments (skipped by the generator parser).');
  lines.push('');

  const summary = []; // {project, service, env, count|error}
  for (const proj of projects) {
    if (!proj.env) {
      summary.push({ project: proj.name, service: '(all)', env: '(none)', error: 'no environment' });
      lines.push(`# === ${proj.name} — SKIPPED (no environment) ===`);
      lines.push('');
      continue;
    }
    for (const svc of proj.services) {
      const r = await varNames(proj.id, proj.env.id, svc.id);
      if (!r.ok) {
        summary.push({ project: proj.name, service: svc.name, env: proj.env.name, error: r.error });
        lines.push(`# === ${proj.name} / ${svc.name} (env=${proj.env.name}) — UNREADABLE: ${r.error} ===`);
        lines.push('');
        continue;
      }
      summary.push({ project: proj.name, service: svc.name, env: proj.env.name, count: r.names.length });
      lines.push(`# === ${proj.name} / ${svc.name} (env=${proj.env.name}) — ${r.names.length} names ===`);
      for (const n of r.names) lines.push(n);
      lines.push('');
    }
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, lines.join('\n'), 'utf8');

  // ---- stdout summary: COUNTS ONLY, never names/values ----
  console.log('=== RAILWAY ENV PULL — per-service NAME COUNTS (names/values never printed) ===');
  let totalNames = 0;
  let curProj = null;
  for (const s of summary) {
    if (s.project !== curProj) { console.log(`\n[${s.project}]`); curProj = s.project; }
    if (s.error) {
      console.log(`  ${s.service.padEnd(38)}  ERROR: ${s.error}`);
    } else {
      console.log(`  ${s.service.padEnd(38)}  ${s.count} names`);
      totalNames += s.count;
    }
  }
  const readable = summary.filter((s) => !s.error).length;
  const unreadable = summary.filter((s) => s.error).length;
  console.log(`\nservices readable: ${readable} | unreadable: ${unreadable} | total name-slots: ${totalNames}`);
  console.log(`wrote: ${OUT_FILE}`);
}

main().catch((e) => {
  console.error('FATAL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
