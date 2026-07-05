#!/usr/bin/env node
// @ts-check
/**
 * generate-registry.mjs — DETERMINISTIC system-registry generator (anti-drift tool).
 *
 * This is NOT an LLM-judgment tool. It is pure extraction + set-math. Accuracy over cleverness.
 * Read-only against the DB. No DDL. No prod mutation.
 *
 * WHAT IT DOES
 *   1. SUPABASE (read-only): pull every public table + columns, every function, every view
 *      via the repo's existing raw-SQL RPC (exec_sql / run_sql). information_schema is NOT
 *      exposed over PostgREST directly, so we go through the RPC the repo already uses.
 *   2. CODE (fs + regex over BOTH repos): extract every process.env.X read and every
 *      supabase .from('table') reference, each with a file:line list.
 *   3. RECONCILE + FLAG: env read-but-not-declared (Railway placeholder), tables
 *      used-in-code-but-absent-in-db, db-tables-never-referenced-in-code (candidate cruft),
 *      and name-variant clusters (likely-same-thing under different names).
 *   4. OUTPUT:
 *      - E:\dev\living-docs\SYSTEM_REGISTRY.md         (the reconciled registry)
 *      - E:\dev\reports\<DATE>\REGISTRY_DRIFT_REPORT.md (the actionable flags)
 *
 * USAGE
 *   node scripts/registry/generate-registry.mjs [optional-railway-env-names.txt]
 *   The optional file is a newline-separated list of env-var NAMES declared on Railway
 *   (names only — never values). When provided, the "env read-but-not-declared" flag
 *   becomes real instead of a placeholder.
 *
 * IDEMPOTENT: re-run any time. Overwrites the two output files. Never hand-edit the outputs.
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const REPOS = [
  'C:/Users/Cash4/repos/repid-engine',
  'C:/Users/Cash4/repos/trinity-symphony-shared',
];
const ENV_MASTER = 'C:/Users/Cash4/repos/.env.master';
const OUT_REGISTRY = 'E:/dev/living-docs/SYSTEM_REGISTRY.md';
const REPORT_DATE = '2026-07-05';
const OUT_DRIFT = `E:/dev/reports/${REPORT_DATE}/REGISTRY_DRIFT_REPORT.md`;

// Directories that are NOT project source — excluded from code extraction.
const EXCLUDE_DIR = new Set([
  'node_modules', 'dist', '.git', '.claude', 'mcps', 'coverage',
  '.next', 'build', '.turbo', '.cache', 'vendor',
]);
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

// Seeded name-variant clusters — KNOWN aliases we assert the tool must catch.
// Each cluster is a set of names that (very likely) mean the same thing.
const SEED_ENV_CLUSTERS = [
  ['ZKP_SERVICE_URL', 'PLONKY3_PROVER_URL'],
  ['HYPERDAG_ATTESTOR_PRIVATE_KEY', 'EAS_ATTESTER_PRIVATE_KEY'],
];
const SEED_TABLE_CLUSTERS = [
  ['task_artifacts', 'trinity_artifacts', 'agent_artifacts'],
];

const args = process.argv.slice(2);
const railwayEnvFile = args[0] || null;

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------
function parseEnvFile(file) {
  // Minimal .env parser: KEY=VALUE, last-wins (matches dotenv). Returns Map(name->hasValue).
  const out = new Map();
  if (!fs.existsSync(file)) return out;
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    // strip surrounding quotes
    val = val.replace(/^["']|["']$/g, '');
    out.set(key, val.length > 0);
  }
  return out;
}

function loadEnvForRuntime(file) {
  // Load SUPABASE_URL / key into process.env WITHOUT printing values.
  const m = new Map();
  if (!fs.existsSync(file)) return m;
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    m.set(key, val); // last wins
  }
  for (const [k, v] of m) process.env[k] = v;
  return m;
}

function walkSourceFiles(root) {
  /** @type {string[]} */
  const files = [];
  if (!fs.existsSync(root)) return files;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (EXCLUDE_DIR.has(e.name)) continue;
        // Skip this tool's own directory — its doc-comments contain example
        // `.from('table')` / `.from('X')` snippets that would self-pollute the scan.
        if (full.replace(/\\/g, '/').endsWith('/scripts/registry')) continue;
        stack.push(full);
      } else if (e.isFile()) {
        if (SOURCE_EXT.has(path.extname(e.name))) files.push(full);
      }
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// SUPABASE LEG — read-only schema pull via the repo's raw-SQL RPC
// ---------------------------------------------------------------------------
async function runSql(supUrl, supKey, rawSql) {
  // The exec_sql/run_sql RPCs inspect the leading token to decide SELECT-vs-exec, so a
  // query with leading whitespace/newlines returns {success:true} instead of rows.
  // Normalize to a single trimmed line before sending. (Verified: leading-newline SQL
  // returns {"success":true}; trimmed single-line SQL returns the row array.)
  const sql = rawSql.replace(/\s+/g, ' ').trim();
  // Try exec_sql({query}) first (verified working), fall back to run_sql({sql}).
  const attempts = [
    { name: 'exec_sql', body: { query: sql } },
    { name: 'run_sql', body: { sql } },
  ];
  let lastErr = null;
  for (const a of attempts) {
    try {
      const r = await fetch(`${supUrl}/rest/v1/rpc/${a.name}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${supKey}`,
          apikey: supKey,
        },
        body: JSON.stringify(a.body),
      });
      const text = await r.text();
      if (r.status === 200) {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          lastErr = `${a.name} returned non-JSON 200: ${text.slice(0, 120)}`;
          continue;
        }
        if (Array.isArray(parsed)) {
          return { ok: true, rows: parsed, rpc: a.name };
        }
        // A SELECT that yielded rows must be an array; {success:true} etc. means the
        // RPC did not run it as a query — try the next RPC shape rather than lie.
        lastErr = `${a.name} did not return rows (got ${JSON.stringify(parsed).slice(0, 80)})`;
        continue;
      }
      lastErr = `HTTP ${r.status} ${text.slice(0, 200)}`;
    } catch (e) {
      lastErr = e && e.message ? e.message : String(e);
    }
  }
  return { ok: false, error: lastErr };
}

async function pullSchema() {
  const supUrl = process.env.SUPABASE_URL;
  const supKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  const result = {
    reachable: false,
    error: null,
    rpc: null,
    tables: new Map(), // name -> columnCount
    tableColumns: new Map(), // name -> [{column, type}]
    functions: [], // names
    views: [], // names
  };
  if (!supUrl || !supKey) {
    result.error = 'SUPABASE_URL / SUPABASE_SERVICE_KEY not found in env — Supabase leg skipped.';
    return result;
  }

  // 1. tables + columns (public schema, base tables only)
  const colSql = `
    SELECT c.table_name, c.column_name, c.data_type
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name, c.ordinal_position`;
  const colRes = await runSql(supUrl, supKey, colSql);
  if (!colRes.ok) {
    result.error = colRes.error;
    return result;
  }
  result.reachable = true;
  result.rpc = colRes.rpc;
  for (const row of colRes.rows) {
    const t = row.table_name;
    if (!result.tableColumns.has(t)) result.tableColumns.set(t, []);
    result.tableColumns.get(t).push({ column: row.column_name, type: row.data_type });
  }
  for (const [t, cols] of result.tableColumns) result.tables.set(t, cols.length);

  // 2. views
  const viewRes = await runSql(
    supUrl, supKey,
    `SELECT table_name FROM information_schema.views WHERE table_schema='public' ORDER BY table_name`,
  );
  if (viewRes.ok) result.views = viewRes.rows.map((r) => r.table_name);

  // 3. functions / routines
  const fnRes = await runSql(
    supUrl, supKey,
    `SELECT routine_name FROM information_schema.routines WHERE routine_schema='public' ORDER BY routine_name`,
  );
  if (fnRes.ok) result.functions = fnRes.rows.map((r) => r.routine_name);

  return result;
}

// ---------------------------------------------------------------------------
// CODE LEG — extract env reads + supabase table references
// ---------------------------------------------------------------------------
// process.env.X  and  process.env['X'] / process.env["X"]
const RE_ENV_DOT = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
const RE_ENV_BRACKET = /process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g;
// DYNAMIC env read: process.env[<anything that is NOT a plain string literal>] — e.g.
//   process.env[`${provider.toUpperCase()}_API_KEY`]   (router.ts)
//   process.env[wire.apiKeyEnv]                          (resilient-llm.ts)
//   process.env[p.env]                                   (providers.ts)
//   process.env[PROVIDERS[k].envKey]                     (ConstitutionalAgent*.js)
// We can't resolve the exact name from the index expression alone, so we (a) record that a
// dynamic read exists at this location, and (b) try to resolve the two RESOLVABLE shapes:
//   - a template literal ending in `_API_KEY`  → mark "any *_API_KEY may be read dynamically"
//   - a `.envKey` / `.env` object-property access → resolve via the object-literal parser below
const RE_ENV_DYNAMIC = /process\.env\[\s*([^'"\]][^\]]*)\]/g;
// A template ending in _API_KEY (case-insensitive) inside a dynamic index — the router pattern.
const RE_APIKEY_TEMPLATE = /_API_KEY\s*`/i;
// Object-literal config maps: capture the string-literal values assigned to `envKey:` or `env:`
// (the PROVIDERS-style provider→{envKey,...} maps in both repos, plus providers.ts `env:`).
const RE_ENVKEY_LITERAL = /\b(?:envKey|env)\s*:\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;
// .from('X') / .from("X")  and  .from(`X`) with no interpolation
const RE_FROM = /\.from\(\s*(['"`])([A-Za-z_][A-Za-z0-9_]*)\1\s*\)/g;

function extractFromCode(repos) {
  /** @type {Map<string, string[]>} */ const envRefs = new Map(); // name -> ["repo/rel:line", ...] (LITERAL reads)
  /** @type {Map<string, string[]>} */ const tableRefs = new Map();
  // DYNAMIC-read handling (CHANGE 1):
  /** @type {string[]} */ const dynamicEnvLocs = [];   // every process.env[<expr>] site
  let sawApiKeyTemplateDynamic = false;                // did we see the `${...}_API_KEY` template shape?
  /** @type {Map<string, string[]>} */ const configEnvRefs = new Map(); // name -> locs (from envKey:/env: literals)
  let fileCount = 0;

  for (const repo of repos) {
    const repoName = path.basename(repo);
    const files = walkSourceFiles(repo);
    for (const file of files) {
      fileCount += 1;
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const rel = `${repoName}/${path.relative(repo, file).replace(/\\/g, '/')}`;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const loc = `${rel}:${i + 1}`;
        let m;
        RE_ENV_DOT.lastIndex = 0;
        while ((m = RE_ENV_DOT.exec(line))) addRef(envRefs, m[1], loc);
        RE_ENV_BRACKET.lastIndex = 0;
        while ((m = RE_ENV_BRACKET.exec(line))) addRef(envRefs, m[1], loc);
        // dynamic process.env[<expr>] — record the site; probe for the resolvable template shape
        RE_ENV_DYNAMIC.lastIndex = 0;
        while ((m = RE_ENV_DYNAMIC.exec(line))) {
          dynamicEnvLocs.push(loc);
          if (RE_APIKEY_TEMPLATE.test(m[0])) sawApiKeyTemplateDynamic = true;
        }
        // object-literal config maps: envKey: 'X' / env: 'X' → X is dynamically read elsewhere
        RE_ENVKEY_LITERAL.lastIndex = 0;
        while ((m = RE_ENVKEY_LITERAL.exec(line))) addRef(configEnvRefs, m[1], loc);
        RE_FROM.lastIndex = 0;
        while ((m = RE_FROM.exec(line))) addRef(tableRefs, m[2], loc);
      }
    }
  }
  return { envRefs, tableRefs, fileCount, dynamicEnvLocs, sawApiKeyTemplateDynamic, configEnvRefs };
}

// A var is potentially DYNAMICALLY read if it is resolved from a config object literal (envKey:/env:)
// OR it matches the `*_API_KEY` template shape the code uses to build provider-key names at runtime.
// Such vars must NOT be reported as SET-BUT-UNREAD cruft (they are downgraded to "review").
function isDynamicApiKey(name) {
  return /_API_KEY$/.test(name);
}

function addRef(map, key, loc) {
  if (!map.has(key)) map.set(key, []);
  const arr = map.get(key);
  // de-dupe identical locations, cap list length for readability
  if (!arr.includes(loc)) arr.push(loc);
}

// ---------------------------------------------------------------------------
// NAME-VARIANT CLUSTERING (deterministic set-math)
// ---------------------------------------------------------------------------
function normalizeEnvName(name) {
  return name
    .toLowerCase()
    .replace(/_(private_key|service_role_key|service_key|api_key|api_token|secret_key|secret|token|url|uri|key|address|addr|id)$/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function normalizeTableName(name) {
  return name.toLowerCase().replace(/^(trinity|repid|agent|hal)_/, '').replace(/s$/, '');
}

function tokenSet(name) {
  return new Set(name.toLowerCase().split(/[_\W]+/).filter(Boolean));
}

function jaccard(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const uni = new Set([...A, ...B]).size;
  return inter / uni;
}

/**
 * Cluster names that likely mean the same thing.
 *   - primary signal: identical normalized form (suffix-stripped)
 *   - secondary signal: token-overlap (Jaccard >= threshold) AND same normalized stem
 * Deterministic: sorted input, union-find merge. Only clusters with >1 distinct name returned.
 * seeds: array of arrays — forced clusters (proves the tool works on known aliases).
 */
function clusterNames(names, normalizeFn, seeds, jThreshold = 0.5) {
  const sorted = [...new Set(names)].sort();
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const n of sorted) parent.set(n, n);

  // Seeds first — force known aliases together (add seed members even if not in `names`).
  for (const seed of seeds) {
    for (const n of seed) if (!parent.has(n)) parent.set(n, n);
    for (let i = 1; i < seed.length; i += 1) union(seed[0], seed[i]);
  }

  const allNames = [...parent.keys()].sort();
  for (let i = 0; i < allNames.length; i += 1) {
    for (let j = i + 1; j < allNames.length; j += 1) {
      const a = allNames[i];
      const b = allNames[j];
      const na = normalizeFn(a);
      const nb = normalizeFn(b);
      if (!na || !nb) continue;
      if (na === nb) {
        union(a, b);
      } else if (jaccard(a, b) >= jThreshold && (na.includes(nb) || nb.includes(na))) {
        union(a, b);
      }
    }
  }

  const groups = new Map();
  for (const n of allNames) {
    const r = find(n);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(n);
  }
  return [...groups.values()]
    .map((g) => [...new Set(g)].sort())
    .filter((g) => g.length > 1)
    .sort((a, b) => a[0].localeCompare(b[0]));
}

// ---------------------------------------------------------------------------
// FORMATTING HELPERS
// ---------------------------------------------------------------------------
function refSummary(locs, cap = 6) {
  const shown = locs.slice(0, cap).join(', ');
  const more = locs.length > cap ? ` … (+${locs.length - cap} more)` : '';
  return `${shown}${more}`;
}

function mdEscape(s) {
  return String(s).replace(/\|/g, '\\|');
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  const startedAt = new Date().toISOString();
  loadEnvForRuntime(ENV_MASTER);

  // ---- declared env (from .env.master) ----
  const declaredEnv = parseEnvFile(ENV_MASTER); // Map name->hasValue

  // ---- railway env names (optional argv[2]) ----
  let railwayNames = null;
  if (railwayEnvFile) {
    if (fs.existsSync(railwayEnvFile)) {
      railwayNames = new Set(
        fs.readFileSync(railwayEnvFile, 'utf8')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'))
          .map((l) => (l.includes('=') ? l.slice(0, l.indexOf('=')).trim() : l)),
      );
    } else {
      console.error(`[warn] railway env-names file not found: ${railwayEnvFile} — treating as absent`);
    }
  }

  // ---- CODE leg ----
  const { envRefs, tableRefs, fileCount, dynamicEnvLocs, sawApiKeyTemplateDynamic, configEnvRefs } =
    extractFromCode(REPOS);
  // CHANGE 1: a var counts as READ if it is a literal process.env.X read, OR it is resolved from a
  // config object literal (envKey:/env: — statically resolvable dynamic reads).
  const resolvedDynamicNames = new Set(configEnvRefs.keys());
  const isRead = (n) => envRefs.has(n) || resolvedDynamicNames.has(n);
  // Potentially-dynamic-but-unresolvable: any *_API_KEY (provider keys are built via the
  // `${...}_API_KEY` template — VERIFIED present, `sawApiKeyTemplateDynamic`), or a config-literal name.
  // `*_API_KEY` is treated as dynamic unconditionally: a truly-unused key is indistinguishable from a
  // dynamically-read one, so it is downgraded to review, never delete.
  const isPotentiallyDynamic = (n) => resolvedDynamicNames.has(n) || isDynamicApiKey(n);

  // ---- SUPABASE leg ----
  const schema = await pullSchema();

  // ---- RECONCILE ----
  // codeEnvNames = names KNOWN to be read: literal process.env.X reads + config-literal (envKey:/env:)
  // resolved dynamic reads. This is the set used for all read/unread reconciliation below.
  const codeEnvNames = [...new Set([...envRefs.keys(), ...resolvedDynamicNames])].sort();
  const codeTableNames = [...tableRefs.keys()].sort();
  const dbTableNames = [...schema.tables.keys()].sort();

  // env read-but-not-declared (against .env.master, and against Railway if provided)
  const envNotInMaster = codeEnvNames.filter((n) => !declaredEnv.has(n));
  const envNotInRailway = railwayNames
    ? codeEnvNames.filter((n) => !railwayNames.has(n))
    : null;

  // tables used-in-code-but-absent-in-db (only meaningful if schema reachable)
  const tablesMissingInDb = schema.reachable
    ? codeTableNames.filter((n) => !schema.tables.has(n))
    : [];
  // db-tables-never-referenced-in-code (candidate cruft)
  const dbTablesUnreferenced = schema.reachable
    ? dbTableNames.filter((n) => !tableRefs.has(n))
    : [];

  // name-variant clusters
  const envClusters = clusterNames(
    [...codeEnvNames, ...declaredEnv.keys()],
    normalizeEnvName,
    SEED_ENV_CLUSTERS,
  );
  const tableUniverse = [...new Set([...codeTableNames, ...dbTableNames])];
  const tableClusters = clusterNames(tableUniverse, normalizeTableName, SEED_TABLE_CLUSTERS, 0.6);

  // confirm seeds landed
  const seedConfirm = [];
  for (const seed of [...SEED_ENV_CLUSTERS, ...SEED_TABLE_CLUSTERS]) {
    const isEnv = SEED_ENV_CLUSTERS.includes(seed);
    const clusters = isEnv ? envClusters : tableClusters;
    const hit = clusters.find((c) => seed.every((s) => c.includes(s)));
    seedConfirm.push({ seed, confirmed: !!hit, cluster: hit || null });
  }

  // -------------------------------------------------------------------------
  // WRITE: SYSTEM_REGISTRY.md
  // -------------------------------------------------------------------------
  const reg = [];
  reg.push('# SYSTEM_REGISTRY — reconciled names across Supabase + code');
  reg.push('');
  reg.push('> **GENERATED FILE — do NOT hand-edit.** Re-run to refresh:');
  reg.push('> `node scripts/registry/generate-registry.mjs [optional-railway-env-names.txt]`');
  reg.push('> Deterministic extraction + set-math (no LLM judgment). Read-only against the DB.');
  reg.push('');
  reg.push(`- Generated: ${startedAt}`);
  reg.push(`- Repos scanned: ${REPOS.map((r) => path.basename(r)).join(', ')} (${fileCount} source files)`);
  reg.push(`- Supabase leg: ${schema.reachable ? `REACHED via RPC \`${schema.rpc}\`` : `UNREACHED — ${schema.error}`}`);
  reg.push(`- Railway env leg: ${railwayNames ? `loaded ${railwayNames.size} names from ${path.basename(railwayEnvFile)}` : 'NOT PROVIDED (placeholder — pass a railway-env-names file as argv[2])'}`);
  reg.push('');
  reg.push('## Counts');
  reg.push('');
  reg.push('| Surface | Count |');
  reg.push('|---|---|');
  reg.push(`| env vars read in code | ${codeEnvNames.length} |`);
  reg.push(`| env vars declared in .env.master | ${declaredEnv.size} |`);
  reg.push(`| supabase tables referenced in code (.from) | ${codeTableNames.length} |`);
  reg.push(`| public base tables in DB | ${schema.reachable ? schema.tables.size : 'n/a'} |`);
  reg.push(`| public views in DB | ${schema.reachable ? schema.views.length : 'n/a'} |`);
  reg.push(`| public functions/routines in DB | ${schema.reachable ? schema.functions.length : 'n/a'} |`);
  reg.push('');

  reg.push('## ENV VARS — read in code (with locations)');
  reg.push('');
  reg.push('_Read = literal `process.env.X` OR resolved from an `envKey:`/`env:` config literal (dynamic)._');
  reg.push('');
  reg.push('| Env var | In .env.master? | Read via | Refs (file:line) |');
  reg.push('|---|---|---|---|');
  for (const n of codeEnvNames) {
    const inMaster = declaredEnv.has(n) ? '✅' : '❌';
    const litLocs = envRefs.get(n) || [];
    const cfgLocs = configEnvRefs.get(n) || [];
    const via = litLocs.length && cfgLocs.length ? 'literal + config' : litLocs.length ? 'literal' : 'config (dynamic)';
    const locs = litLocs.length ? litLocs : cfgLocs;
    reg.push(`| \`${n}\` | ${inMaster} | ${via} | ${mdEscape(refSummary(locs))} |`);
  }
  reg.push('');

  reg.push('## SUPABASE TABLES');
  reg.push('');
  if (schema.reachable) {
    reg.push('| Table | Cols (DB) | Referenced in code? |');
    reg.push('|---|---|---|');
    const allTables = [...new Set([...dbTableNames, ...codeTableNames])].sort();
    for (const t of allTables) {
      const cols = schema.tables.has(t) ? String(schema.tables.get(t)) : '—(not in DB)';
      const inCode = tableRefs.has(t) ? '✅' : '';
      reg.push(`| \`${t}\` | ${cols} | ${inCode} |`);
    }
  } else {
    reg.push('> Supabase leg UNREACHED — showing code-referenced tables only.');
    reg.push('');
    reg.push('| Table (referenced in code) | Refs (file:line) |');
    reg.push('|---|---|');
    for (const t of codeTableNames) {
      reg.push(`| \`${t}\` | ${mdEscape(refSummary(tableRefs.get(t)))} |`);
    }
  }
  reg.push('');

  if (schema.reachable) {
    reg.push('## SUPABASE VIEWS');
    reg.push('');
    reg.push(schema.views.length ? schema.views.map((v) => `- \`${v}\``).join('\n') : '_none_');
    reg.push('');
    reg.push(`## SUPABASE FUNCTIONS / ROUTINES (${schema.functions.length})`);
    reg.push('');
    reg.push(schema.functions.length ? schema.functions.map((f) => `- \`${f}\``).join('\n') : '_none_');
    reg.push('');
  }

  reg.push('---');
  reg.push('*Generated by scripts/registry/generate-registry.mjs — anti-drift tool. Trust but verify.*');
  fs.mkdirSync(path.dirname(OUT_REGISTRY), { recursive: true });
  fs.writeFileSync(OUT_REGISTRY, reg.join('\n'), 'utf8');

  // -------------------------------------------------------------------------
  // WRITE: REGISTRY_DRIFT_REPORT.md
  // -------------------------------------------------------------------------
  const dr = [];
  dr.push('# REGISTRY DRIFT REPORT — actionable flags');
  dr.push('');
  dr.push('> **GENERATED FILE — do NOT hand-edit.** Companion to `E:\\dev\\living-docs\\SYSTEM_REGISTRY.md`.');
  dr.push(`> Generated: ${startedAt}`);
  dr.push('');
  dr.push('Each section below is a drift class. Items are candidates for action, not verdicts —');
  dr.push('the tool reports set-math; a human confirms intent (e.g. a table read only by a worker');
  dr.push('outside these two repos is not truly "cruft").');
  dr.push('');

  // 1. env read-but-not-declared
  dr.push('## 1. ENV read-in-code but NOT declared in .env.master');
  dr.push('');
  if (envNotInMaster.length === 0) {
    dr.push('_none — every env var read in code is present in .env.master._');
  } else {
    dr.push('These are read by code but absent from `.env.master`. Either add them, or confirm they');
    dr.push('are injected only at the Railway/deploy layer (many will be — see §1b).');
    dr.push('');
    dr.push('| Env var | Refs (file:line) |');
    dr.push('|---|---|');
    for (const n of envNotInMaster) {
      dr.push(`| \`${n}\` | ${mdEscape(refSummary(envRefs.get(n) || configEnvRefs.get(n) || []))} |`);
    }
  }
  dr.push('');

  // 1b. Railway placeholder / reconciliation
  dr.push('## 1b. RAILWAY env reconciliation');
  dr.push('');
  if (!railwayNames) {
    dr.push('> **PLACEHOLDER — Railway env-names not yet provided.**');
    dr.push('> We cannot see Railway env from here. To fill this section, export the env-var NAMES');
    dr.push('> (names only, never values) to a file and re-run:');
    dr.push('>');
    dr.push('> `node scripts/registry/generate-registry.mjs railway-env-names.txt`');
    dr.push('>');
    dr.push('> Then this section will list: (a) env read-in-code but missing on Railway = a real deploy');
    dr.push('> break risk, and (b) env on Railway but never read in code = candidate stale config.');
  } else {
    const readNotOnRailway = envNotInRailway;
    // CHANGE 1 — dynamic-read handling. A Railway var is only "stale config (delete candidate)" if it
    // is NOT read literally AND NOT resolvable as a dynamic read. Vars matching a dynamic pattern
    // (config-literal envKey:/env:, or any *_API_KEY under the `${...}_API_KEY` template) are
    // DOWNGRADED to a review list — they may be read at runtime by a name the extractor can't see.
    const railwayNotReadRaw = [...railwayNames].filter((n) => !isRead(n)).sort();
    const railwayDynamicReview = railwayNotReadRaw.filter((n) => isPotentiallyDynamic(n));
    const railwayTrulyStale = railwayNotReadRaw.filter((n) => !isPotentiallyDynamic(n));
    dr.push(`Loaded ${railwayNames.size} Railway env names.`);
    dr.push('');
    dr.push('> **Dynamic-read handling (CHANGE 1).** Both repos read provider keys DYNAMICALLY —');
    dr.push('> `process.env[`${provider.toUpperCase()}_API_KEY`]`, `process.env[wire.apiKeyEnv]`,');
    dr.push('> `process.env[p.env]`, `process.env[PROVIDERS[k].envKey]` — so a literal `process.env.X`');
    dr.push('> scan can\'t see them and would false-flag them as cruft. We now resolve reads two ways:');
    dr.push('> (a) parse `envKey:`/`env:` string literals in config object maps (statically resolvable →');
    dr.push('> counted as READ), and (b) treat ANY `*_API_KEY` var as potentially dynamically read (the');
    dr.push('> `${...}_API_KEY` template shape) → NOT cruft, downgraded to "review". **Residual limit:** a');
    dr.push('> `*_API_KEY` that is truly unused is indistinguishable from one read dynamically, so those are');
    dr.push('> "review", never "delete". Non-key vars and exact mismatches are still flagged normally.');
    dr.push('');
    dr.push('### 1b.i — read in code but MISSING on Railway (deploy-break risk)');
    dr.push('');
    dr.push(readNotOnRailway.length ? readNotOnRailway.map((n) => `- \`${n}\` — ${refSummary(envRefs.get(n) || configEnvRefs.get(n) || [], 3)}`).join('\n') : '_none_');
    dr.push('');
    dr.push('### 1b.ii — on Railway but NEVER read in code (candidate STALE config — SAFE to review for delete)');
    dr.push('');
    dr.push('Not read literally and not a dynamic-read pattern. Provider `*_API_KEY` vars are NOT here.');
    dr.push('');
    dr.push(railwayTrulyStale.length ? railwayTrulyStale.map((n) => `- \`${n}\``).join('\n') : '_none_');
    dr.push('');
    dr.push('### 1b.iii — dynamic-read candidates (DOWNGRADED to review, NOT delete)');
    dr.push('');
    dr.push('On Railway, not literally read, but matches a dynamic-read pattern (`*_API_KEY` template or');
    dr.push('resolved from an `envKey:`/`env:` config literal). Likely read at runtime — do NOT delete');
    dr.push('without confirming the provider is truly unused.');
    dr.push('');
    dr.push(railwayDynamicReview.length ? railwayDynamicReview.map((n) => `- \`${n}\` — dynamic-read (unconfirmed literal)`).join('\n') : '_none_');
  }
  dr.push('');

  // 2. tables used-in-code-but-absent-in-db
  dr.push('## 2. TABLES referenced in code but ABSENT in DB');
  dr.push('');
  if (!schema.reachable) {
    dr.push(`> Supabase leg UNREACHED (${schema.error}) — cannot compute. Run the schema leg and re-run.`);
  } else if (tablesMissingInDb.length === 0) {
    dr.push('_none — every `.from(\'table\')` in code resolves to a real public table._');
  } else {
    dr.push('Code reads/writes these table names, but they are not public base tables in the DB.');
    dr.push('Likely: typo, renamed table, a view (see registry views list), or a not-yet-created table.');
    dr.push('');
    dr.push('| Table | Refs (file:line) |');
    dr.push('|---|---|');
    for (const t of tablesMissingInDb) {
      const noteView = schema.views.includes(t) ? ' _(exists as VIEW)_' : '';
      dr.push(`| \`${t}\`${noteView} | ${mdEscape(refSummary(tableRefs.get(t)))} |`);
    }
  }
  dr.push('');

  // 3. db-tables-never-referenced-in-code
  dr.push('## 3. DB tables NEVER referenced in code (candidate cruft)');
  dr.push('');
  if (!schema.reachable) {
    dr.push('> Supabase leg UNREACHED — cannot compute.');
  } else {
    dr.push(`${dbTablesUnreferenced.length} of ${schema.tables.size} public tables are never touched by a`);
    dr.push('`.from()` in these two repos. NOTE: many are legitimately owned by OTHER services');
    dr.push('(Trinity agents, edge functions, workers not in these repos) — this is a *candidate* list,');
    dr.push('not a delete list. Cross-check against the full service inventory before dropping anything.');
    dr.push('');
    dr.push('<details><summary>Show all ' + dbTablesUnreferenced.length + ' unreferenced tables</summary>');
    dr.push('');
    dr.push(dbTablesUnreferenced.map((t) => `- \`${t}\``).join('\n'));
    dr.push('');
    dr.push('</details>');
  }
  dr.push('');

  // 4. name-variant clusters
  dr.push('## 4. NAME-VARIANT CLUSTERS (likely-same-thing under different names)');
  dr.push('');
  dr.push('Deterministic clustering: normalized-form match (suffix-stripped) OR token-overlap');
  dr.push('(Jaccard) with a shared stem. Seeded known aliases are force-included to prove the method.');
  dr.push('');
  dr.push('### 4a — ENV var clusters');
  dr.push('');
  if (envClusters.length === 0) {
    dr.push('_no multi-name env clusters found_');
  } else {
    for (const c of envClusters) {
      const seeded = SEED_ENV_CLUSTERS.some((s) => s.every((x) => c.includes(x)));
      dr.push(`- ${c.map((n) => `\`${n}\``).join(' ≈ ')}${seeded ? '  **[seeded — confirmed]**' : ''}`);
    }
  }
  dr.push('');
  dr.push('### 4b — TABLE clusters');
  dr.push('');
  if (tableClusters.length === 0) {
    dr.push('_no multi-name table clusters found_');
  } else {
    for (const c of tableClusters) {
      const seeded = SEED_TABLE_CLUSTERS.some((s) => s.every((x) => c.includes(x)));
      const dbMark = (n) => (schema.tables.has(n) ? '' : '†');
      dr.push(`- ${c.map((n) => `\`${n}\`${dbMark(n)}`).join(' ≈ ')}${seeded ? '  **[seeded — confirmed]**' : ''}`);
    }
    dr.push('');
    dr.push('_† = name not present as a public base table in the DB (code-only or view)._');
  }
  dr.push('');

  // 5. seed confirmation
  dr.push('## 5. SEED CONFIRMATION (proves the tool works)');
  dr.push('');
  dr.push('| Seeded alias set | Confirmed clustered? |');
  dr.push('|---|---|');
  for (const s of seedConfirm) {
    dr.push(`| ${s.seed.map((x) => `\`${x}\``).join(', ')} | ${s.confirmed ? '✅ yes' : '❌ NO'} |`);
  }
  dr.push('');
  dr.push('---');
  dr.push('*Generated by scripts/registry/generate-registry.mjs — re-run to refresh. Trust but verify.*');

  fs.mkdirSync(path.dirname(OUT_DRIFT), { recursive: true });
  fs.writeFileSync(OUT_DRIFT, dr.join('\n'), 'utf8');

  // -------------------------------------------------------------------------
  // STDOUT SUMMARY
  // -------------------------------------------------------------------------
  console.log('\n=== SYSTEM REGISTRY GENERATOR — SUMMARY ===');
  console.log(`repos scanned         : ${REPOS.map((r) => path.basename(r)).join(', ')} (${fileCount} files)`);
  console.log(`env vars read in code : ${codeEnvNames.length} (literal + config-resolved dynamic)`);
  console.log(`  literal reads       : ${envRefs.size}`);
  console.log(`  config-resolved     : ${resolvedDynamicNames.size} (envKey:/env: literals)`);
  console.log(`  dynamic env[] sites : ${dynamicEnvLocs.length}  | *_API_KEY template seen: ${sawApiKeyTemplateDynamic ? 'yes' : 'no'}`);
  console.log(`  not in .env.master  : ${envNotInMaster.length}`);
  console.log(`tables ref'd in code  : ${codeTableNames.length}`);
  if (schema.reachable) {
    console.log(`DB tables (public)    : ${schema.tables.size}  | views: ${schema.views.length} | functions: ${schema.functions.length}  [via ${schema.rpc}]`);
    console.log(`  code-ref'd, not in DB: ${tablesMissingInDb.length}${tablesMissingInDb.length ? '  -> ' + tablesMissingInDb.join(', ') : ''}`);
    console.log(`  in DB, never ref'd  : ${dbTablesUnreferenced.length} (candidate cruft)`);
  } else {
    console.log(`DB schema             : UNREACHED — ${schema.error}`);
  }
  console.log(`env-name clusters     : ${envClusters.length}`);
  console.log(`table-name clusters   : ${tableClusters.length}`);
  console.log('seed confirmation     :');
  for (const s of seedConfirm) {
    console.log(`  [${s.confirmed ? 'OK' : 'MISS'}] ${s.seed.join(' + ')}`);
  }
  console.log(`railway env leg       : ${railwayNames ? `loaded ${railwayNames.size} names` : 'PLACEHOLDER (not provided)'}`);
  console.log('\nwrote:');
  console.log(`  ${OUT_REGISTRY}`);
  console.log(`  ${OUT_DRIFT}`);
}

main().catch((e) => {
  console.error('FATAL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
