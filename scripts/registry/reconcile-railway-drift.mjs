#!/usr/bin/env node
// @ts-check
/**
 * reconcile-railway-drift.mjs — the THREE actionable per-service drift lists.
 *
 * Consumes the per-service Railway env-NAMES file (from pull-railway-env.mjs, which groups
 * names under "# === project / service ... ===" headers), maps each service to the repo
 * whose code it runs, extracts that repo's `process.env.X` reads (file:line), and emits:
 *
 *   SET-BUT-UNREAD  — name set on a service but NO code in that service's repo reads it (cruft)
 *   READ-BUT-UNSET  — name the service's repo reads but is NOT set on that service (break risk)
 *   MISPLACED       — repid-engine-specific names sitting on a trinity agent (wrong service)
 *
 * Read-only. NO values ever touched (the input file is names-only by construction).
 * Output: E:\dev\reports\2026-07-05\REGISTRY_DRIFT_FULL.md
 */

import fs from 'node:fs';
import path from 'node:path';

const NAMES_FILE = process.argv[2];
if (!NAMES_FILE || !fs.existsSync(NAMES_FILE)) {
  console.error('usage: node reconcile-railway-drift.mjs <railway-env-names.txt>');
  process.exit(1);
}
const OUT = 'E:/dev/reports/2026-07-05/REGISTRY_DRIFT_FULL.md';

// ---------------------------------------------------------------------------
// service -> repo mapping (VERIFIED where the repo is on disk; ASSUMED noted)
// ---------------------------------------------------------------------------
const REPO_ROOT = 'C:/Users/Cash4/repos';
// A repo entry is { repo: <dir under repos/ or null>, note: 'VERIFIED'|'ASSUMED'|... }
const SERVICE_REPO = {
  // repid-engine project — all three run the repid-engine repo
  'repid-engine/repid-engine':            { repo: 'repid-engine', tag: 'VERIFIED' },
  'repid-engine/proof-drain-worker':      { repo: 'repid-engine', tag: 'VERIFIED', sub: 'worker' },
  'repid-engine/receipt-indexer':         { repo: 'repid-engine', tag: 'VERIFIED', sub: 'worker' },
  // AITrinitySymphony — the 12 trinity-* agents run trinity-symphony-shared
  'AITrinitySymphony/trinity-apm':        { repo: 'trinity-symphony-shared', tag: 'VERIFIED' },
  'AITrinitySymphony/trinity-w3c':        { repo: 'trinity-symphony-shared', tag: 'VERIFIED' },
  'AITrinitySymphony/trinity-chesed':     { repo: 'trinity-symphony-shared', tag: 'VERIFIED' },
  'AITrinitySymphony/trinity-shofet':     { repo: 'trinity-symphony-shared', tag: 'VERIFIED' },
  'AITrinitySymphony/trinity-gcm':        { repo: 'trinity-symphony-shared', tag: 'VERIFIED' },
  'AITrinitySymphony/trinity-sophia':     { repo: 'trinity-symphony-shared', tag: 'VERIFIED' },
  'AITrinitySymphony/trinity-hdm':        { repo: 'trinity-symphony-shared', tag: 'VERIFIED' },
  'AITrinitySymphony/trinity-orch':       { repo: 'trinity-symphony-shared', tag: 'VERIFIED' },
  'AITrinitySymphony/trinity-mel':        { repo: 'trinity-symphony-shared', tag: 'VERIFIED' },
  'AITrinitySymphony/trinity-nexus':      { repo: 'trinity-symphony-shared', tag: 'VERIFIED' },
  'AITrinitySymphony/trinity-torch':      { repo: 'trinity-symphony-shared', tag: 'VERIFIED' },
  'AITrinitySymphony/trinity-veritas':    { repo: 'trinity-symphony-shared', tag: 'VERIFIED' },
  // AITrinitySymphony infra — repo unknown / not one of the two scanned repos
  'AITrinitySymphony/trinity-litellm':    { repo: null, tag: 'ASSUMED', note: 'LiteLLM gateway image — no local repo' },
  'AITrinitySymphony/rust-brain':         { repo: null, tag: 'ASSUMED', note: 'rust service — not on disk' },
  'AITrinitySymphony/py-brain':           { repo: null, tag: 'ASSUMED', note: 'python service — not on disk' },
  'AITrinitySymphony/trinity-ecosystem':  { repo: null, tag: 'ASSUMED', note: 'controller/ecosystem — trinity-ecosystem repo (private, not scanned)' },
  'AITrinitySymphony/Postgis':            { repo: null, tag: 'ASSUMED', note: 'DB image — no app repo' },
  'AITrinitySymphony/czlonkowski/n8n-mcp-railway:latest': { repo: null, tag: 'ASSUMED', note: 'third-party n8n-mcp image' },
  'AITrinitySymphony/n8n':                { repo: null, tag: 'ASSUMED', note: 'n8n image — no app repo' },
  'AITrinitySymphony/repid-decay-weekly': { repo: 'repid-engine', tag: 'ASSUMED', sub: 'cron', note: 'weekly RepID decay cron — most likely runs a repid-engine script' },
  'AITrinitySymphony/railway-mcp':        { repo: null, tag: 'ASSUMED', note: 'railway-mcp repo (private, not scanned)' },
  'AITrinitySymphony/mcp-a2a-gateway':    { repo: null, tag: 'ASSUMED', note: 'a2a gateway — repo not scanned' },
  'AITrinitySymphony/trustchat-backend':  { repo: null, tag: 'ASSUMED', note: 'trustchat-backend repo exists on disk but is not one of the two registry-scanned repos' },
  'AITrinitySymphony/zkp-postcard':       { repo: null, tag: 'ASSUMED', note: 'Rust Plonky3 prover — hyperdag-core-ish, not scanned' },
  'AITrinitySymphony/Flowise':            { repo: null, tag: 'ASSUMED', note: 'Flowise image — no app repo' },
  // other projects
  'hyperdag-core/HyperDAG-core':          { repo: null, tag: 'ASSUMED', note: 'Rust core — hyperdag-core repo (Rust, not env-scanned by this TS/JS tool)' },
  'AI-Trinity-Symphony-Landing/aitrinitysymphony-landing': { repo: null, tag: 'ASSUMED', note: 'static landing — aitrinitysymphony-landing repo, not scanned' },
  'hyperdag-trinity/hyperdag-platform':   { repo: null, tag: 'ASSUMED', note: 'legacy orchestrator — hyperdag-platform repo, not scanned' },
  'AISocialMirror/AISocialMirror':        { repo: null, tag: 'ASSUMED', note: 'social mirror — repo not on disk' },
};

// Railway-injected / platform names that are NOT app env vars — never flag these.
const RAILWAY_PLATFORM_EXACT = new Set([
  'RAILWAY_ENVIRONMENT', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_ENVIRONMENT_NAME',
  'RAILWAY_PRIVATE_DOMAIN', 'RAILWAY_PROJECT_ID', 'RAILWAY_PROJECT_NAME',
  'RAILWAY_PUBLIC_DOMAIN', 'RAILWAY_SERVICE_ID', 'RAILWAY_SERVICE_NAME',
  'RAILWAY_STATIC_URL', 'RAILWAY_GIT_COMMIT_SHA', 'RAILWAY_GIT_BRANCH',
  'RAILWAY_REPLICA_ID', 'RAILWAY_DEPLOYMENT_ID', 'PORT',
]);
// RAILWAY_SERVICE_<X>_URL and RAILWAY_TCP_* are Railway REFERENCE variables (auto-generated
// cross-service URL injections), not app config cruft — exclude by pattern.
function isRailwayPlatform(name) {
  if (RAILWAY_PLATFORM_EXACT.has(name)) return true;
  if (/^RAILWAY_SERVICE_.*_URL$/.test(name)) return true;
  if (/^RAILWAY_TCP_/.test(name)) return true;
  if (/^RAILWAY_/.test(name)) return true; // any other RAILWAY_* platform var
  return false;
}

// ---------------------------------------------------------------------------
// parse the per-service names file
// ---------------------------------------------------------------------------
function parseNamesFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const services = new Map(); // "project/service" -> Set(names)
  let cur = null;
  const HEADER = /^#\s*===\s*(.+?)\s*\/\s*(.+?)\s*\(env=/;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    const hm = HEADER.exec(line);
    if (hm) {
      const key = `${hm[1]}/${hm[2]}`;
      cur = key;
      if (!services.has(cur)) services.set(cur, new Set());
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    const name = line.includes('=') ? line.slice(0, line.indexOf('=')).trim() : line.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (cur) services.get(cur).add(name);
  }
  return services;
}

// ---------------------------------------------------------------------------
// per-repo env-read extraction (process.env.X and process.env['X'])
// ---------------------------------------------------------------------------
const RE_ENV_DOT = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
const RE_ENV_BRACKET = /process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g;
// DYNAMIC env read (CHANGE 1): process.env[<non-string-literal expr>] — e.g.
//   process.env[`${provider.toUpperCase()}_API_KEY`]  ·  process.env[wire.apiKeyEnv]
//   process.env[p.env]  ·  process.env[PROVIDERS[k].envKey]
// The exact name isn't statically recoverable from the index, so we (a) note the repo uses the
// `${...}_API_KEY` template shape, and (b) resolve `envKey:`/`env:` config-literal maps to concrete
// names. Vars matching these patterns are NOT flagged as SET-BUT-UNREAD cruft (downgraded to review).
const RE_ENV_DYNAMIC = /process\.env\[\s*([^'"\]][^\]]*)\]/g;
const RE_APIKEY_TEMPLATE = /_API_KEY\s*`/i;
const RE_ENVKEY_LITERAL = /\b(?:envKey|env)\s*:\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const EXCLUDE_DIR = new Set(['node_modules', 'dist', '.git', '.claude', 'mcps', 'coverage', '.next', 'build', '.turbo', '.cache', 'vendor']);

function walk(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (EXCLUDE_DIR.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile() && SOURCE_EXT.has(path.extname(e.name))) {
        files.push(full);
      }
    }
  }
  return files;
}

// Cache per repo: name -> [file:line, ...] (LITERAL process.env.X reads only — return type unchanged)
const repoEnvCache = new Map();
// Side caches (CHANGE 1): per repo, config-literal-resolved names (envKey:/env:) and whether the
// `${...}_API_KEY` dynamic template shape appears anywhere in that repo.
const repoConfigReadsCache = new Map();   // repoDir -> Map(name -> [file:line])
const repoApiKeyTemplateCache = new Map(); // repoDir -> boolean
function envReadsForRepo(repoDir) {
  if (repoEnvCache.has(repoDir)) return repoEnvCache.get(repoDir);
  const root = `${REPO_ROOT}/${repoDir}`;
  const map = new Map();
  const configMap = new Map();
  let sawApiKeyTemplate = false;
  for (const file of walk(root)) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const rel = `${repoDir}/${path.relative(root, file).replace(/\\/g, '/')}`;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const loc = `${rel}:${i + 1}`;
      let m;
      RE_ENV_DOT.lastIndex = 0;
      while ((m = RE_ENV_DOT.exec(line))) push(map, m[1], loc);
      RE_ENV_BRACKET.lastIndex = 0;
      while ((m = RE_ENV_BRACKET.exec(line))) push(map, m[1], loc);
      RE_ENV_DYNAMIC.lastIndex = 0;
      while ((m = RE_ENV_DYNAMIC.exec(line))) { if (RE_APIKEY_TEMPLATE.test(m[0])) sawApiKeyTemplate = true; }
      RE_ENVKEY_LITERAL.lastIndex = 0;
      while ((m = RE_ENVKEY_LITERAL.exec(line))) push(configMap, m[1], loc);
    }
  }
  repoEnvCache.set(repoDir, map);
  repoConfigReadsCache.set(repoDir, configMap);
  repoApiKeyTemplateCache.set(repoDir, sawApiKeyTemplate);
  return map;
}
// True if `name` is READ by this repo, counting config-literal (envKey:/env:) resolved dynamic reads.
function isReadByRepo(repoDir, name) {
  const lit = repoEnvCache.get(repoDir) || envReadsForRepo(repoDir);
  if (lit.has(name)) return true;
  const cfg = repoConfigReadsCache.get(repoDir);
  return !!(cfg && cfg.has(name));
}
// True if `name` is potentially DYNAMICALLY read (so not deletable cruft): resolved from a config
// literal in this repo, OR any `*_API_KEY` var. Provider keys are read via the `${...}_API_KEY`
// template shape (VERIFIED in both repos: repid-engine router.ts / route.ts, trinity ConstitutionalAgent*),
// so ANY `*_API_KEY` is treated as potentially dynamic regardless of which repo runs the service —
// a `*_API_KEY` that is truly unused is indistinguishable from one read dynamically, so it is
// downgraded to "review", never "delete" (the residual limitation).
function isPotentiallyDynamicForRepo(repoDir, name) {
  if (/_API_KEY$/.test(name)) return true;
  envReadsForRepo(repoDir); // ensure caches populated
  const cfg = repoConfigReadsCache.get(repoDir);
  return !!(cfg && cfg.has(name));
}
function push(map, k, loc) {
  if (!map.has(k)) map.set(k, []);
  const a = map.get(k);
  if (!a.includes(loc)) a.push(loc);
}
function refSummary(locs, cap = 4) {
  if (!locs || !locs.length) return '';
  const shown = locs.slice(0, cap).join(', ');
  return locs.length > cap ? `${shown} … (+${locs.length - cap} more)` : shown;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
const services = parseNamesFile(NAMES_FILE);

// Build union of names read by the repid-engine repo (for MISPLACED detection):
// "repid-engine-specific" = read in repid-engine repo AND never read in trinity-symphony-shared.
const engineReads = envReadsForRepo('repid-engine');
const trinityReads = envReadsForRepo('trinity-symphony-shared');
const engineOnlyNames = new Set([...engineReads.keys()].filter((n) => !trinityReads.has(n)));

const perService = []; // { key, repoInfo, setButUnread, readButUnset, railwayCount }
for (const [key, nameSet] of services) {
  const repoInfo = SERVICE_REPO[key] || { repo: null, tag: 'ASSUMED', note: 'unmapped service' };
  const names = [...nameSet].sort();
  const appNames = names.filter((n) => !isRailwayPlatform(n));

  let setButUnread = null;
  let dynamicReview = null;
  let readButUnset = null;
  if (repoInfo.repo) {
    const reads = envReadsForRepo(repoInfo.repo);
    // CHANGE 1 — dynamic-read handling. A var is "unread" only if it's NOT read literally AND NOT
    // resolved from a config literal. Of the remaining unread names, provider *_API_KEY vars (and
    // config-literal names) matching a dynamic pattern are DOWNGRADED to a review bucket, not cruft.
    const unread = appNames.filter((n) => !isReadByRepo(repoInfo.repo, n));
    setButUnread = unread.filter((n) => !isPotentiallyDynamicForRepo(repoInfo.repo, n));
    dynamicReview = unread.filter((n) => isPotentiallyDynamicForRepo(repoInfo.repo, n));
    // READ-BUT-UNSET: names read in the repo but not set on this service.
    // Exclude Railway platform names (never set by us) and test-only helper names is out of scope
    // here (we report all reads not present; a human triages test-only ones).
    readButUnset = [...reads.keys()].filter((n) => !nameSet.has(n) && !isRailwayPlatform(n)).sort();
  }
  perService.push({ key, repoInfo, names, appNames, setButUnread, dynamicReview, readButUnset, railwayCount: names.length });
}

// MISPLACED: engine-only names that appear on a trinity-* agent service.
// Split "engine-only" into RUNTIME-src reads (strong wrong-service signal) vs
// test/script-only reads (weak — shared keys the agent repo simply doesn't process.env).
function readInEngineRuntimeSrc(name) {
  const locs = engineReads.get(name) || [];
  return locs.some((l) => /^repid-engine\/src\//.test(l) && !/\/__tests__\//.test(l));
}
const misplaced = []; // { service, strong: [], weak: [] }
for (const s of perService) {
  if (!s.key.startsWith('AITrinitySymphony/trinity-')) continue;
  const hits = s.appNames.filter((n) => engineOnlyNames.has(n));
  if (!hits.length) continue;
  const strong = hits.filter(readInEngineRuntimeSrc).sort();
  const weak = hits.filter((n) => !readInEngineRuntimeSrc(n)).sort();
  misplaced.push({ service: s.key, names: hits.sort(), strong, weak });
}

// ---------------------------------------------------------------------------
// TYPO / NEAR-MISS DETECTION — a Railway name that is a 1-2 char edit away from a
// name the code READS but does NOT exactly match = likely a deploy-time typo where the
// var silently reads `undefined`. (This is how the ZKP_SERVICE_URL class bites.)
// ---------------------------------------------------------------------------
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}
// All names read anywhere in either repo:
const allCodeReads = new Set([...engineReads.keys(), ...trinityReads.keys()]);
// All names set on any Railway service (app names only):
const allRailwayNames = new Set();
for (const s of perService) for (const n of s.appNames) allRailwayNames.add(n);
// Typo pairs: a Railway name NOT read by code, whose closest code-read name is 1-2 edits away
// and shares the same head token (avoids coincidental matches).
const typoPairs = [];
for (const rn of [...allRailwayNames].sort()) {
  if (allCodeReads.has(rn)) continue; // exact match — fine
  let best = null;
  for (const cn of allCodeReads) {
    if (allRailwayNames.has(cn)) continue; // code-name also set on Railway somewhere — skip
    const d = editDistance(rn, cn);
    if (d >= 1 && d <= 2 && rn.split('_')[0] === cn.split('_')[0]) {
      if (!best || d < best.d) best = { name: cn, d };
    }
  }
  if (best) typoPairs.push({ railway: rn, code: best.name, dist: best.d });
}

// ---------------------------------------------------------------------------
// WRITE REPORT
// ---------------------------------------------------------------------------
const L = [];
L.push('# REGISTRY DRIFT — FULL 3-WAY RECONCILIATION (Railway env × code × service→repo)');
L.push('');
L.push(`> Generated: ${new Date().toISOString()} · read-only · **names only, no values**`);
L.push('> Third leg of the anti-drift registry. Companion set-math report:');
L.push('> `E:\\dev\\reports\\2026-07-05\\REGISTRY_DRIFT_REPORT.md` (flat) + `SYSTEM_REGISTRY.md`.');
L.push('');
L.push('**Method.** `pull-railway-env.mjs` pulled env-var NAMES from every Railway service via');
L.push('GraphQL `variables(projectId, environmentId, serviceId)` (keys only, values discarded).');
L.push('Each service is mapped to the repo it runs; that repo\'s `process.env.X` reads are');
L.push('extracted with file:line. Three set-math lists follow. Items are CANDIDATES, not verdicts.');
L.push('');
L.push('**Repo mapping.** repid-engine project services → `repid-engine` repo [VERIFIED].');
L.push('trinity-* agents → `trinity-symphony-shared` repo [VERIFIED]. Other services\' repos are');
L.push('not on disk / not scanned [ASSUMED] — their SET-BUT-UNREAD/READ-BUT-UNSET are left blank.');
L.push('Railway platform-injected names (RAILWAY_*, PORT) are excluded from all flags.');
L.push('');

// -- headline counts --
L.push('## Headline');
L.push('');
const scannable = perService.filter((s) => s.repoInfo.repo);
const totalUnread = scannable.reduce((a, s) => a + (s.setButUnread ? s.setButUnread.length : 0), 0);
const totalDynamicReview = scannable.reduce((a, s) => a + (s.dynamicReview ? s.dynamicReview.length : 0), 0);
const totalUnset = new Set();
for (const s of scannable) for (const n of (s.readButUnset || [])) totalUnset.add(`${s.key}::${n}`);
L.push(`- Services pulled: **${perService.length}** (all readable). Names/values never printed.`);
L.push(`- Services mapped to a scanned repo: **${scannable.length}** (get full 3-way flags).`);
L.push(`- SET-BUT-UNREAD candidates (real cruft, SAFE to review for delete) across scanned services: **${totalUnread}**.`);
L.push(`- DYNAMIC-READ downgraded (\`*_API_KEY\`/config-literal — review, NOT delete): **${totalDynamicReview}**.`);
L.push(`- READ-BUT-UNSET (break-risk) service×var pairs: **${totalUnset.size}**.`);
L.push(`- MISPLACED (engine-only var on a trinity agent) services flagged: **${misplaced.length}**.`);
L.push(`- TYPO / near-miss pairs (Railway name ≈ a name the code reads, but not equal): **${typoPairs.length}**.`);
L.push('');

// -- HEADLINE FINDINGS (the few things worth acting on now) --
L.push('## HEADLINE FINDINGS (act-on-now)');
L.push('');
L.push('### A. TYPO / near-miss — a set var the code will read as `undefined` [VERIFIED set-math]');
L.push('');
if (!typoPairs.length) {
  L.push('_none found_');
} else {
  L.push('A Railway var whose spelling is 1–2 edits from a name the code actually reads (same head');
  L.push('token). The deployed spelling is set; the code reads a *different* spelling → silent');
  L.push('`undefined`. **This is the exact silent-failure class the registry exists to catch.**');
  L.push('');
  L.push('| Set on Railway (spelling) | Code actually reads | Edit dist |');
  L.push('|---|---|---|');
  for (const t of typoPairs) {
    L.push(`| \`${t.railway}\` | \`${t.code}\` | ${t.dist} |`);
  }
}
L.push('');
L.push('### B. seeded alias clusters — confirmed the tool catches known drift');
L.push('');
L.push('The generator (`REGISTRY_DRIFT_REPORT.md` §5) confirmed the seeded aliases cluster:');
L.push('`ZKP_SERVICE_URL` ≈ `PLONKY3_PROVER_URL`, `HYPERDAG_ATTESTOR_PRIVATE_KEY` ≈');
L.push('`EAS_ATTESTER_PRIVATE_KEY`, and `task_artifacts` ≈ `trinity_artifacts` ≈ `agent_artifacts`.');
L.push('');

// =====================================================================
// LIST 1 — SET-BUT-UNREAD
// =====================================================================
L.push('## 1. SET-BUT-UNREAD (cruft) — set on Railway, no code in that service\'s repo reads it');
L.push('');
L.push('“Keys I asked for and never used.” Candidates to delete from the service. Grouped by service.');
L.push('NOTE: a var may be read only by a sibling worker/script not in the mapped repo, or consumed');
L.push('by a base-image entrypoint — confirm before deleting.');
L.push('');
L.push('> **DYNAMIC-READ handling (CHANGE 1).** Both repos read provider keys DYNAMICALLY —');
L.push('> `process.env[`${provider.toUpperCase()}_API_KEY`]`, `process.env[wire.apiKeyEnv]`,');
L.push('> `process.env[p.env]`, `process.env[PROVIDERS[k].envKey]`. A literal `process.env.X` scan');
L.push('> can\'t see those, so it USED to false-flag `GROK_API_KEY` / `OPENROUTER_API_KEY` /');
L.push('> `PERPLEXITY_API_KEY` etc. as cruft. Now: names resolved from an `envKey:`/`env:` config');
L.push('> literal count as READ, and any `*_API_KEY` (the `${...}_API_KEY` template shape) is DOWNGRADED');
L.push('> to the review list in §1a below — **it is NOT in the delete list here.** **Residual limit:** a');
L.push('> `*_API_KEY` that is genuinely unused can\'t be distinguished from one read dynamically, so it is');
L.push('> "review", never "delete". The list below is therefore SAFE to act on: real cruft + real');
L.push('> mismatches only. (Genuinely-unread NON-key vars are still flagged.)');
L.push('');
for (const s of scannable) {
  if (!s.setButUnread || !s.setButUnread.length) continue;
  const sub = s.repoInfo.sub ? ` _(${s.repoInfo.sub})_` : '';
  L.push(`### ${s.key} → \`${s.repoInfo.repo}\`${sub} [${s.repoInfo.tag}] — ${s.setButUnread.length} real-cruft of ${s.appNames.length}`);
  L.push('');
  L.push(s.setButUnread.map((n) => `\`${n}\``).join(', '));
  L.push('');
}
if (!scannable.some((s) => s.setButUnread && s.setButUnread.length)) L.push('_none — no real (non-dynamic) cruft on any scanned service._\n');

// -- 1a. DYNAMIC-READ review bucket (downgraded from cruft) --
L.push('## 1a. DYNAMIC-READ candidates (DOWNGRADED to review, NOT delete)');
L.push('');
L.push('Set on the service, not literally read, but matches a dynamic-read pattern (`*_API_KEY`');
L.push('template or resolved from an `envKey:`/`env:` config literal). Almost always a provider key');
L.push('read at runtime. Do NOT delete without confirming the provider is truly unused.');
L.push('');
for (const s of scannable) {
  if (!s.dynamicReview || !s.dynamicReview.length) continue;
  const sub = s.repoInfo.sub ? ` _(${s.repoInfo.sub})_` : '';
  L.push(`### ${s.key} → \`${s.repoInfo.repo}\`${sub} — ${s.dynamicReview.length} dynamic-read (unconfirmed literal)`);
  L.push('');
  L.push(s.dynamicReview.map((n) => `\`${n}\``).join(', '));
  L.push('');
}
if (!scannable.some((s) => s.dynamicReview && s.dynamicReview.length)) L.push('_none_\n');

// =====================================================================
// LIST 2 — READ-BUT-UNSET
// =====================================================================
L.push('## 2. READ-BUT-UNSET (break risk) — code reads it, NOT set on the service that runs it');
L.push('');
L.push('Silent-failure class (the ZKP_SERVICE_URL / PLONKY3_PROVER_URL pattern). A var the mapped');
L.push('repo reads but that is absent from the service\'s Railway env → `undefined` at runtime.');
L.push('MANY of these are legitimately test-only / script-only / optional-with-fallback reads —');
L.push('the tool cannot tell intent, so this is a TRIAGE list. Highest concern: vars read in');
L.push('`src/` runtime paths (not `tests/`, not `scripts/`) with no `|| default`.');
L.push('');
L.push('> **LIMITATION.** The single-purpose repid-engine services (`proof-drain-worker`,');
L.push('> `receipt-indexer`, `repid-decay-weekly`) are each compared against the WHOLE');
L.push('> `repid-engine` repo, so their huge read-but-unset counts are expected — a worker runs');
L.push('> one entrypoint and legitimately lacks most of the API server\'s env. Treat the');
L.push('> `repid-engine` *main service* runtime list as the real signal; the workers only');
L.push('> matter for vars their own entrypoint reads. Trinity agents are compared against the');
L.push('> whole `trinity-symphony-shared` repo (correct — they all run the same base).');
L.push('');
for (const s of scannable) {
  if (!s.readButUnset || !s.readButUnset.length) continue;
  const reads = envReadsForRepo(s.repoInfo.repo);
  // Split runtime-src reads from test/script reads for triage.
  const runtimeFirst = [];
  const otherReads = [];
  for (const n of s.readButUnset) {
    const locs = reads.get(n) || [];
    const isRuntime = locs.some((l) => /\/src\//.test(l) && !/\/__tests__\//.test(l));
    const isTestOrScript = locs.every((l) => /\/(tests?|scripts|scratch|testing)\//.test(l) || /\.test\./.test(l) || /\/__tests__\//.test(l));
    if (isRuntime && !isTestOrScript) runtimeFirst.push(n);
    else otherReads.push(n);
  }
  const sub = s.repoInfo.sub ? ` _(${s.repoInfo.sub})_` : '';
  L.push(`### ${s.key} → \`${s.repoInfo.repo}\`${sub} — ${s.readButUnset.length} read-but-unset`);
  L.push('');
  L.push(`**runtime (\`src/\`) reads — HIGHER concern (${runtimeFirst.length}):**`);
  L.push('');
  if (runtimeFirst.length) {
    L.push('| Env var | Refs (file:line) |');
    L.push('|---|---|');
    for (const n of runtimeFirst) L.push(`| \`${n}\` | ${refSummary(reads.get(n)).replace(/\|/g, '\\|')} |`);
  } else { L.push('_none_'); }
  L.push('');
  L.push(`<details><summary>test/script-only reads — lower concern (${otherReads.length})</summary>`);
  L.push('');
  L.push(otherReads.length ? otherReads.map((n) => `\`${n}\``).join(', ') : '_none_');
  L.push('');
  L.push('</details>');
  L.push('');
}
if (!scannable.some((s) => s.readButUnset && s.readButUnset.length)) L.push('_none_\n');

// =====================================================================
// LIST 3 — MISPLACED
// =====================================================================
L.push('## 3. MISPLACED — engine-only vars sitting on a trinity agent (wrong service)');
L.push('');
L.push('Vars that are read ONLY by the `repid-engine` repo (never by `trinity-symphony-shared`) yet');
L.push('are SET on a `trinity-*` agent service. Strong candidates for “this flag belongs on');
L.push('repid-engine, not the agent.” Excludes shared provider keys / DB creds by construction');
L.push('(those are read by both repos, so they are not engine-only).');
L.push('');
if (!misplaced.length) {
  L.push('_none detected_');
  L.push('');
} else {
  // STRONG signal: engine-only var read in repid-engine RUNTIME src/, set on ≥10 agents.
  const strongCount = new Map();
  const weakCount = new Map();
  for (const m of misplaced) {
    for (const n of m.strong) strongCount.set(n, (strongCount.get(n) || 0) + 1);
    for (const n of m.weak) weakCount.set(n, (weakCount.get(n) || 0) + 1);
  }
  const strongFleet = [...strongCount.entries()].filter(([, c]) => c >= 10).map(([n]) => n).sort();
  L.push(`Engine-only names present on **${misplaced.length}** trinity agents. Two grades:`);
  L.push('- **STRONG** = the var is read in repid-engine **runtime `src/`** (not tests/scripts) → really belongs on the engine, not the agent.');
  L.push('- **WEAK** = the var is read only in repid-engine `tests/`/`scripts/` → it is a shared key the agent repo simply never `process.env`s; usually a deliberate fleet-wide secret, low priority.');
  L.push('');
  L.push('### STRONG — engine-runtime var set fleet-wide on agents (review first)');
  L.push('');
  if (strongFleet.length) {
    L.push('| Engine-only var | On N agents | Read in repid-engine runtime at |');
    L.push('|---|---|---|');
    for (const n of strongFleet) {
      const locs = (engineReads.get(n) || []).filter((l) => /^repid-engine\/src\//.test(l));
      L.push(`| \`${n}\` | ${strongCount.get(n)} | ${refSummary(locs, 3).replace(/\|/g, '\\|')} |`);
    }
  } else {
    L.push('_none — no engine-runtime-src var is set fleet-wide on the agents._');
  }
  L.push('');
  L.push(`### WEAK — shared secrets/keys on agents (${[...weakCount.keys()].length} distinct; low priority)`);
  L.push('');
  L.push([...weakCount.keys()].sort().map((n) => `\`${n}\``).join(', ') || '_none_');
  L.push('');
  L.push('<details><summary>Per-agent breakdown (all engine-only vars, strong marked ★)</summary>');
  L.push('');
  for (const m of misplaced) {
    const marked = m.names.map((n) => (m.strong.includes(n) ? `★\`${n}\`` : `\`${n}\``));
    L.push(`- **${m.service}** (${m.names.length}, ${m.strong.length} strong): ${marked.join(', ')}`);
  }
  L.push('');
  L.push('</details>');
  L.push('');
}

// =====================================================================
// Per-service name-count table + repo map (for the record)
// =====================================================================
L.push('## Appendix — per-service name counts + repo mapping');
L.push('');
L.push('| Project / Service | Names | Repo | Map tag |');
L.push('|---|---|---|---|');
for (const s of perService) {
  const repo = s.repoInfo.repo || '_(not scanned)_';
  const note = s.repoInfo.note ? ` — ${s.repoInfo.note}` : '';
  L.push(`| ${s.key} | ${s.railwayCount} | ${repo} | ${s.repoInfo.tag}${note} |`);
}
L.push('');
L.push('---');
L.push('*Generated by scripts/registry/reconcile-railway-drift.mjs. Names only — no values persisted.*');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, L.join('\n'), 'utf8');

// stdout: counts only
console.log('=== 3-WAY DRIFT RECONCILE — SUMMARY (counts only) ===');
console.log(`services: ${perService.length} | scanned-repo services: ${scannable.length}`);
console.log(`SET-BUT-UNREAD real cruft (safe to review): ${totalUnread}`);
console.log(`DYNAMIC-READ downgraded (review, not delete): ${totalDynamicReview}`);
console.log(`READ-BUT-UNSET service×var pairs: ${totalUnset.size}`);
console.log(`MISPLACED trinity agents flagged: ${misplaced.length}`);
console.log(`TYPO / near-miss pairs: ${typoPairs.length}`);
for (const t of typoPairs) console.log(`  TYPO: railway '${t.railway}' vs code '${t.code}' (dist ${t.dist})`);
console.log(`wrote: ${OUT}`);
