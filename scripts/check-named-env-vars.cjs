#!/usr/bin/env node
/**
 * check-named-env-vars.cjs — docs/comments must not name an env var that does not exist.
 *
 * LESSONS.md rule 4: evidence outranks the label. A SCREAMING_SNAKE token in a
 * comment reads as a real control. On 2026-09-08 a reviewer reported "no findings"
 * on the file whose comment invented a money-path gate environment variable —
 * a name that appears nowhere in code and nowhere in the generated registry.
 * Human attention missed it. A grep would not have.
 *
 * Authority: src/config/known-env-vars.generated.ts (literal process.env.NAME
 * reads under src/). This check scans *.md and TypeScript comments, subtracts
 * that registry, subtracts an explicit allowlist (each entry has a reason),
 * and fails on the remainder.
 *
 * Discovery, not a file list. A hand list fails silently in the safe-looking
 * direction: the next file added is simply never scanned.
 *
 * Outcomes (exit 3 is never 0):
 *   VERIFIED     exit 0  — walked the tree, registry loaded, no unknown names
 *   FAILED       exit 1  — at least one named-but-missing env var
 *   NOT CHECKED  exit 3  — could not load the registry, walk found nothing, etc.
 *
 * CommonJS on purpose: tests/named-env-vars.test.ts require()s this file, matching
 * tests/prod-fixture-guard.test.ts. ts-jest cannot dynamic-import ESM without
 * --experimental-vm-modules.
 */
'use strict';

const { readFileSync, readdirSync, statSync, existsSync } = require('node:fs');
const { dirname, extname, join, relative } = require('node:path');

const EXIT_VERIFIED = 0;
const EXIT_FAILED = 1;
const EXIT_NOT_CHECKED = 3;

const SCRIPT_DIR = __dirname;
const REPO_ROOT = join(SCRIPT_DIR, '..');
const REGISTRY_REL = join('src', 'config', 'known-env-vars.generated.ts');

/** SCREAMING_SNAKE with at least one underscore. HTTP, SQL, GET do not match. */
const TOKEN_RE = /\b([A-Z][A-Z0-9]*(_[A-Z0-9]+)+)\b/g;

const FILE_EXT_AFTER_TOKEN = /^(md|ts|tsx|js|mjs|cjs|json|yml|yaml|sql|txt|toml|html)$/i;

/**
 * Suffixes that make a backticked or env-context token look like a control.
 * Kept as a positive list of env-shaped endings, not as a silent "match less"
 * filter: tokens without these still match when the line is an explicit
 * process.env / $VAR / VAR= / export form.
 */
const ENV_SUFFIX_RE =
  /(KEY|KEYS|URL|URI|DSN|MODE|ENABLED|SECRET|TOKEN|PATH|TIMEOUT|ENDPOINT|ADDRESS|PORT|HOST|PASSWORD|ORIGIN|LIMIT|FLAG|DEBUG|HMAC|SALT|RPC|TTL|GATE|WORKER|NETWORK|CHAIN|SHADOW|MS|HOURS|DAYS)$/;

const ENV_WORDS_RE =
  /\b(env(?:ironment)?|env[ -]?var(?:iable)?s?|process\.env|dotenv|\bexport\b|\bunset\b)\b/i;

/**
 * Directories skipped by the walk. These are kinds of tree, not a file list.
 * reports/ is append-only historical; living docs and source comments are the
 * current-tense surface a reviewer treats as true. Skipping it is a discovery
 * rule with a reason, not a silent hole: a new reports/YYYY-MM-DD file is
 * historical by construction.
 */
const SKIP_DIRS = {
  node_modules: 'dependency tree, not our docs',
  dist: 'build output',
  '.git': 'vcs internals',
  coverage: 'test artifacts',
  '.next': 'build output',
  reports: 'append-only historical snapshots; living docs + src comments are current tense',
};

const SKIP_DIR_NAMES = new Set(Object.keys(SKIP_DIRS));

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Named-but-not-in-the-generated-registry tokens we are leaving, each with a
 * reason. Prefer adding a reason here over quietly narrowing the matcher.
 * An unused entry fails the check so the list cannot rot into a silent dump.
 *
 * @type {Record<string, string>}
 */
const ALLOWLIST = {
  // ── composed / indirect src/ reads the generator cannot see ──────────────
  GROK_API_KEY:
    'Composed at runtime via XAI_KEY_VARS; generator only captures literal process.env.NAME under src/.',
  XAI_API_KEY:
    'Composed at runtime via XAI_KEY_VARS; generator only captures literal process.env.NAME under src/.',
  CONTRACT_PARTY_ENFORCEMENT:
    'Read as process.env[PARTY_ENFORCEMENT_ENV]; generator misses indirection.',
  ZKREPID_DISCLOSURE_MODE:
    'Read as process.env[MODE_ENV]; generator misses indirection.',
  TASK_CRITERIA_GATE:
    'Read as process.env[CRITERIA_GATE_ENV]; generator misses indirection.',
  HYPERDAG_LANE:
    'Read as process.env[LANE_ENV]; generator misses indirection.',
  T3_OUTCOME_NUDGE_ENABLED:
    'Read as process.env[NUDGE_FLAG]; generator misses indirection.',
  HAL_ISSUER_IDENTITY_ENABLED:
    'Read as env.HAL_ISSUER_IDENTITY_ENABLED on an injected ProcessEnv; generator only sees process.env.NAME.',
  RRL_SHADOW_ENABLED:
    'Read as env.RRL_SHADOW_ENABLED on an injected ProcessEnv; generator only sees process.env.NAME.',
  REPID_FORMULA_COMMITMENT_SALT:
    'Read as process.env[FORMULA_SALT_ENV]; generator misses indirection.',
  REPID_IDENTITY_MASTER_SECRET:
    'Read as process.env[IDENTITY_MASTER_ENV]; generator misses indirection.',
  COHERE_API_KEY:
    'Provider-probe table name; resolved via process.env[name] from PROVIDER_PROBES, not a literal process.env.COHERE_API_KEY.',
  MODE_ENV:
    'Constant holding an env-var *name* (ZKREPID_DISCLOSURE_MODE), not an env var itself.',

  // ── real reads outside src/ (generator scans src/ only) ──────────────────
  REPID_API_KEY:
    'Client/caller env name (scripts, demos, agent runtime). Engine src reads REPID_API_KEYS (plural).',
  RUN_INTEGRATION: 'Test harness opt-in; consumed under tests/, not src/.',
  RUN_ZKP_SMOKE: 'Test harness opt-in; consumed under tests/, not src/.',
  RUN_AUDIT_CHAIN_INTEGRATION: 'Test harness opt-in; consumed under tests/, not src/.',
  INTEGRATION_SCHEMA_PRESENT: 'Test harness signal; consumed under tests/, not src/.',
  E2E_API_KEY: 'E2E harness; consumed under tests/e2e/, not src/.',
  E2E_BASE_URL: 'E2E harness; consumed under tests/e2e/, not src/.',
  E2E_STRICT: 'E2E harness; consumed under tests/e2e/, not src/.',
  SUPABASE_TEST_URL: 'Test harness; consumed under tests/, not src/.',
  SUPABASE_TEST_PUBLISHABLE_KEY: 'Test harness; consumed under tests/, not src/.',
  SIM_JSON: 'scripts/repid-sim only; generator scans src/.',
  SIM_ROUNDS: 'scripts/repid-sim only; generator scans src/.',
  SIM_SEED: 'scripts/repid-sim only; generator scans src/.',
  CANARY_CONCURRENCY: 'scripts/eval/canary-f1.ts only; generator scans src/.',
  CANARY_DELAY_MS: 'scripts/eval/canary-f1.ts only; generator scans src/.',
  CANARY_LIMIT: 'scripts/eval/canary-f1.ts only; generator scans src/.',
  CANARY_RAW: 'scripts/eval/canary-f1.ts only; generator scans src/.',
  RIG_CORPUS: 'scripts/eval/rigorous-hal-eval.ts only; generator scans src/.',
  RIG_DELAY_MS: 'scripts/eval/rigorous-hal-eval.ts only; generator scans src/.',
  RIG_LIMIT: 'scripts/eval/rigorous-hal-eval.ts only; generator scans src/.',
  RIG_OUT: 'scripts/eval/rigorous-hal-eval.ts only; generator scans src/.',
  RESKIN_CERTAINTY: 'scripts/hal-eval/reskin-invariance.ts only; generator scans src/.',
  RESKIN_CORPUS: 'scripts/hal-eval/reskin-invariance.ts only; generator scans src/.',
  RESKIN_JSON: 'scripts/hal-eval/reskin-invariance.ts only; generator scans src/.',
  CLASSIFIER_PACE_MS: 'scripts/test-classifier.ts only; generator scans src/.',
  CROSS_LLM_PACE_MS: 'scripts/test-classifier.ts only; generator scans src/.',
  CC_DRAIN_BATCH: 'scripts/cc-drain-once.ts only; generator scans src/.',
  DISPATCH_RUNNER:
    'Real read in scripts/dispatch/read-inbox.mjs (claim provenance); the generator scans src/ only, and the walk above scans .md/.ts/.tsx only, so an .mjs read can never reach the registry.',
  FIRECRAWL_SMOKE_AGENT_ID: 'scripts/firecrawl-smoke.ts only; generator scans src/.',
  WINDOW_HOURS: 'scripts/cost/spend-readout.ts only; generator scans src/.',
  WALLET_ADDRESS: 'scripts/check-testnet-balance.ts only; generator scans src/.',
  DOTENV_CONFIG_PATH: 'dotenv CLI convention, not an engine src/ read.',
  HEALTH_URL: 'scripts/verify deployed-sha check; generator scans src/.',
  EXPECTED_SHA: 'scripts/verify deployed-sha check; generator scans src/.',
  EXPECTED_REF: 'scripts/verify deployed-sha check; generator scans src/.',
  SWARM_FAIL_ON_BACKLOG_GROWTH: 'scripts/verify swarm check; generator scans src/.',
  WARN_ONLY: 'scripts/verify suite demotion list; generator scans src/.',
  FLOOR_PEAK_RATIO: 'scripts/verify/checks/repid-floor.ts only; generator scans src/.',
  ENGINE_BASE_URL: 'scripts/cron + demos; generator scans src/.',
  BASE_SEPOLIA_PRIVATE_KEY: 'scripts/ on-chain operators; generator scans src/.',
  ERC8004_REPUTATION_CHAIN_ID: 'scripts/erc8004-reputation-*; generator scans src/.',
  ERC8004_REPUTATION_WRITER_KEY: 'scripts/erc8004-reputation-*; generator scans src/.',
  HAL_SHADOW_AUTOTUNE_WRITE: 'scripts/hal/shadow-threshold-autotune.ts only; generator scans src/.',
  X402_FACILITATOR_URL: 'scripts/x402/* local facilitator; engine src uses X402_MAINNET_FACILITATOR_URL.',
  TWITTER_AUTH_TOKEN: 'agent-reach skill credential; not an engine src/ read.',
  TWITTER_CT0: 'agent-reach skill credential; not an engine src/ read.',
  DOCKER_BUILDKIT: 'Docker CLI convention, not an engine src/ read.',
  RAILWAY_SERVICE_ID: 'Railway platform env, not an engine src/ read.',
  DEPLOY_TARGET: 'deploy/ Dockerfile selector; not an engine src/ read.',
  ACTIVE_ENGINE_URL: 'deploy/FAILOVER_RUNBOOK operator pin; not an engine src/ read.',
  CLEAN_CORPUS: 'README canary command; scripts/eval input path, not src/.',
  TOGETHER_API_KEY: 'scripts/agent-testing free-LLM router; generator scans src/.',
  PERPLEXITY_API_KEY: 'deploy/ENV_MANIFEST Railway-superset list; not a src/ literal.',
  PORTKEY_API_KEY: 'deploy/ENV_MANIFEST Railway-superset list; not a src/ literal.',
  ASI1_API_KEY: 'deploy/ENV_MANIFEST Railway-superset list; not a src/ literal.',
  VERITAS_PRIVATE_KEY: 'Test-only process.env mutation under tests/; generator scans src/.',
  HEARTBEAT_ENABLED: 'launch-monitoring runbook; not a src/ literal (heartbeat script is scripts/).',
  AUDIT_PROBE_ENABLED: 'launch-monitoring runbook; not a src/ literal (audit-probe script is scripts/).',
  SMOKE_BASE_URL: 'docs/PRODUCTION_DEPLOY_GATE smoke input; not a src/ literal.',
  FLY_API_TOKEN: 'GitHub Actions / Fly deploy secret; not an engine src/ read.',
  GH_DEP_TOKEN: 'GitHub Actions Docker-build PAT; not an engine src/ read.',
  GH_TOKEN: 'Docker BuildKit secret id for GH packages; not an engine src/ read.',
  GITHUB_TOKEN: 'GitHub Actions default token, documented as insufficient for LOOP_GH_PAT; not an engine src/ read.',
  RAILWAY_API_TOKEN: 'Railway platform token named in a recon doc; not an engine src/ read.',

  // ── other-repo / agent-runtime flags this engine does not read ───────────
  CAPABILITY_FILTER:
    'Read by trinity-symphony-shared getNextTask, not by a src/ literal in this repo.',
  ESCALATION_CONTRACT:
    'Gates ConstitutionalAgentV4.runLoop in the agent runtime, not a src/ literal in this repo.',
  ENGINE_LLM_PROXY:
    'Agent-service enablement flip (Railway per-agent), not a src/ literal in this repo.',
  HAL_SCORE_V2:
    'Documented opt-in flag in CONTRIBUTING/TESTING; not a src/ literal in this repo.',

  // ── proposed / unbuilt flags named in specs (not asserted as live) ───────
  ANFIS_POA_ROUTING:
    'Comment proposes a new flag ("e.g. ANFIS_POA_ROUTING=true"); not implemented, not a live control.',
  DELEGATION_INHERITANCE:
    'Unbuilt S-SDK1 spec names a feature gate; not a src/ read.',
  HAL_QUORUM_ROUTING:
    'GAP_SWEEP_R3 proposal; not a src/ read.',
  TASK_TYPES_ENABLED:
    'OPTIMIZATION_PLAN proposal; not a src/ read.',
  ROUTER_FIRST_TIME_FRONTIER_N:
    'scripts/sim comment names a tunable; not a src/ read.',
  REPID_DECAY_APPLY:
    'scripts/run-repid-decay.ts documents a non-flag; --apply is the operator switch.',
  AGENT_KEY_MASTER_V1:
    'Rotation-runbook example of a *renamed* key (AGENT_KEY_MASTER_V1=<old>), not a live var.',
  GROQ_MODEL:
    'Comment in src/providers/groq.ts; model override is not a src/ process.env.GROQ_MODEL read.',
  HAL_SCORER:
    'DEPLOY_READINESS_R3 retraction: the sprint name is not the flag; real flag is HAL_STRICTNESS.',

  // ── constants / event types / CHECK values / verdict labels ──────────────
  BABYBEAR_S_BOX_DEGREE: 'Poseidon2 constant, not an env var.',
  BFT_THRESHOLD: 'Published scoring constant, not an env var.',
  CACHE_ONLY: 'Ablation skip-mode label, not an env var.',
  CODE_CONTRIBUTION: 'FIXED_DELTAS table key, not an env var.',
  COMMA_BAND_LOOSE_THRESHOLD: 'HAL band constant, not an env var.',
  COMMA_BAND_TIGHT_THRESHOLD: 'HAL band constant, not an env var.',
  COMMA_RATIO: 'HAL constant alias, not an env var.',
  CONFIDENCE_GATE: 'Published scoring constant, not an env var.',
  DELTA_ENCODING_SCALE: 'Encoding constant, not an env var.',
  FIXED_DELTAS: 'Scoring table name, not an env var.',
  HAL_PYTHAGOREAN_COMMA: 'Exported HAL constant, not an env var.',
  HAL_RISK_THRESHOLD: 'Mock-harness constant, not an env var.',
  HAL_S2: 'HAL strictness shorthand in CONTRIBUTING, not an env var.',
  HAL_SCORE_EVENT: 'event_type CHECK value, not an env var.',
  HAS_DB: 'Local test binding, not an env var.',
  HEARTBEAT_MODE: 'ConstitutionalAgentV4 constructor option documented in a comment, not this repo\'s env.',
  ISO_TIMESTAMP: 'Markdown template placeholder, not an env var.',
  K_MIN: 'Quorum constant, not an env var.',
  MAX_SUBJECT_LEN: 'Input-cap constant, not an env var.',
  MIN_QUORUM_FOR_VETO: 'HAL quorum constant, not an env var.',
  MIN_STAKE: 'On-chain contract constant, not an env var.',
  NOT_CHECKED: 'Verify-suite verdict label, not an env var.',
  PATH_TO_CAPTURE: 'Markdown template placeholder, not an env var.',
  PCP_MODEL: 'Local binding of PCP_VALIDATOR_MODEL in CLAUDE.md, not its own env var.',
  PHI_FALLBACK: 'phi default constant, not an env var.',
  POOL_MAX: 'pg pool size in a stress report, not an env var.',
  PUBLIC_FLAGS: 'flag-readiness.ts exported list, not an env var.',
  PYTHAGOREAN_COMMA: 'HAL constant, not an env var.',
  PYTHAGOREAN_COMMA_RATIO: 'HAL constant, not an env var.',
  REPID_HITL_GATE: 'Published scoring constant, not an env var.',
  REPID_MIN: 'Published tier bound, not an env var.',
  RESERVED_ARITY_A1: 'ZKP statement-registry constant, not an env var.',
  RUN_ID: 'Markdown template placeholder, not an env var.',
  SELF_REPORT_DISCOUNT: 'Scoring constant, not an env var.',
  SINGLE_IMPLEMENTATION: 'module-space.ts flag constant, not an env var.',
  STARTING_WISDOM: 'Wisdom-score constant, not an env var.',
  UNSUPPORTED_CLAIM: 'Scoring-delta constant, not an env var.',
  VALID_TIERS: 'Provider-routing set, not an env var.',
  VALIDATOR_PENALTY: 'Scoring-delta constant, not an env var.',
  W_CEILING: 'Wisdom-score bound, not an env var.',
  W_FLOOR: 'Wisdom-score bound, not an env var.',
  AGENT_TASK_TYPES: 'Task-type enum/list, not an env var.',
  AMBIGUOUS_SEED: 'Eval seed list, not an env var.',
  BUILDER_ID: 'curl path placeholder, not an env var.',
  EDGE_ID: 'Markdown template placeholder, not an env var.',
  SEAN_SIG: 'shell local in a docs snippet, not an env var.',
  SERVICE_ROLE: 'curl Bearer placeholder (not SUPABASE_SERVICE_ROLE_KEY), not an engine env var.',
  BASE_ENGINE_URL: 'Comment interpolates a URL template, not a process.env read.',
  HAL_PBLIC_RATE_LIMIT:
    'Intentional misspelling used as the env-typo-guard example; canonical is HAL_PUBLIC_RATE_LIMIT.',
  CURRENT_FORMULA_PARAMS: 'Scoring-params export, not an env var.',
  ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG: 'Node error code, not an env var.',
  NOT_PROVEN_WITHOUT_SECRET: 'Thrown error name, not an env var.',
  OFF_CHAIN: 'risk_tier CHECK/band value, not an env var.',
  PRIVATE_KEY: 'Secret-scan pattern in a report, not an env var name this engine reads.',
  REQUIRED_STATEMENT_KEYS: 'Proof-verifier key-set constant, not an env var.',
  SERVICE_KEY: 'Comment shorthand for SUPABASE_SERVICE_ROLE_KEY, not its own env var.',
  SERVICE_ROLE_KEY: 'Fragment of SUPABASE_SERVICE_ROLE_KEY in a Select-String pattern, not its own env var.',
  THRESHOLD_PUBLIC_KEYS: 'zkRepID disclosure key-set constant, not an env var.',
  TOKEN_BOUND_STATEMENT_KEYS: 'Proof-verifier key-set constant, not an env var.',
};

function looksLikeEnvVar(token, line) {
  const idx = line.indexOf(token);
  if (idx === -1) return false;
  const after = line.slice(idx + token.length);
  if (after.startsWith('.')) {
    const ext = after.slice(1).split(/[^\w]/)[0] || '';
    if (FILE_EXT_AFTER_TOKEN.test(ext)) return false;
  }

  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(String.raw`process\.env(?:\.|\[[\s'"]+)${escaped}`).test(line)) return true;
  if (new RegExp(String.raw`\b(?:export|unset)\s+${escaped}\b`).test(line)) return true;
  // TOKEN=value (no space before =) is env-assignment style. TOKEN = 1 is a constant.
  if (new RegExp(String.raw`\b${escaped}=`).test(line)) return true;
  if (new RegExp(String.raw`\$\{?${escaped}\b\}?`).test(line)) return true;

  const tick = new RegExp(String.raw`\`${escaped}\``).test(line);
  const envWords = ENV_WORDS_RE.test(line);
  const envSuffix = ENV_SUFFIX_RE.test(token);
  if (tick && (envWords || envSuffix)) return true;
  if (envWords && envSuffix) return true;
  return false;
}

/** Pull line comments and block comments; skip strings and template literals. */
function extractComments(src) {
  let i = 0;
  const n = src.length;
  let out = '';
  while (i < n) {
    const c = src[i];
    const n1 = src[i + 1];
    if (c === '/' && n1 === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += src.slice(i, stop) + '\n';
      i = stop;
      continue;
    }
    if (c === '/' && n1 === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += src.slice(i, stop) + '\n';
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      i += 1;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === q) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === '`') {
      i += 1;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === '`') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out;
}

function loadRegistry(root = REPO_ROOT) {
  const path = join(root, REGISTRY_REL);
  if (!existsSync(path)) {
    return { ok: false, reason: `registry missing: ${REGISTRY_REL}`, names: new Set() };
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { ok: false, reason: `registry unreadable: ${err.message}`, names: new Set() };
  }
  const m = text.match(/export const KNOWN_ENV_VARS[\s\S]*?`([\s\S]*?)`/);
  if (!m) {
    return { ok: false, reason: 'registry did not match KNOWN_ENV_VARS template string', names: new Set() };
  }
  const names = new Set(
    m[1]
      .trim()
      .split(/\n/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (names.size === 0) {
    return { ok: false, reason: 'registry parsed but contained zero names', names };
  }
  return { ok: true, reason: null, names };
}

function walkScanTargets(root = REPO_ROOT) {
  const md = [];
  const ts = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (SKIP_DIR_NAMES.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (st.size > MAX_FILE_BYTES) continue;
      const ext = extname(name);
      if (ext === '.md') md.push(full);
      else if (ext === '.ts' || ext === '.tsx') ts.push(full);
    }
  }
  return { md, ts };
}

function relPosix(root, file) {
  return relative(root, file).replaceAll('\\', '/');
}

/**
 * Scan one blob of text (a markdown file, or extracted comments) for unknown
 * env-like tokens. known/allow are subtracted here.
 */
function scanText(text, fileRel, known, allow) {
  /** @type {{ token: string, file: string, line: number, excerpt: string }[]} */
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    TOKEN_RE.lastIndex = 0;
    for (const m of line.matchAll(TOKEN_RE)) {
      const token = m[1];
      if (known.has(token) || allow.has(token)) continue;
      if (!looksLikeEnvVar(token, line)) continue;
      hits.push({
        token,
        file: fileRel,
        line: i + 1,
        excerpt: line.trim().slice(0, 160),
      });
    }
  }
  return hits;
}

function collectAllowlistHits(text, allow) {
  const seen = new Set();
  TOKEN_RE.lastIndex = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    if (allow.has(m[1])) seen.add(m[1]);
  }
  return seen;
}

function scanRepo(root = REPO_ROOT) {
  const registry = loadRegistry(root);
  if (!registry.ok) {
    return { status: 'NOT_CHECKED', reason: registry.reason, hits: [], stats: null, unusedAllow: [] };
  }
  const targets = walkScanTargets(root);
  const generatedRel = REGISTRY_REL.replaceAll('\\', '/');
  const ts = targets.ts.filter((f) => relPosix(root, f) !== generatedRel);
  if (targets.md.length === 0 || ts.length === 0) {
    return {
      status: 'NOT_CHECKED',
      reason: `walk found ${targets.md.length} markdown files and ${ts.length} TypeScript files — refusing to go green over an empty scan`,
      hits: [],
      stats: { md: targets.md.length, ts: ts.length, known: registry.names.size },
      unusedAllow: [],
    };
  }

  const known = registry.names;
  const allow = new Set(Object.keys(ALLOWLIST));
  const hits = [];
  const allowSeen = new Set();

  const scanFile = (file, extractor) => {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const body = extractor ? extractor(text) : text;
    const fileRel = relPosix(root, file);
    hits.push(...scanText(body, fileRel, known, allow));
    for (const t of collectAllowlistHits(body, allow)) allowSeen.add(t);
  };

  for (const f of targets.md) scanFile(f, null);
  for (const f of ts) scanFile(f, extractComments);

  const unusedAllow = [...allow].filter((t) => !allowSeen.has(t)).sort();
  const stats = {
    md: targets.md.length,
    ts: ts.length,
    known: known.size,
    allow: allow.size,
    hits: hits.length,
  };

  if (hits.length > 0 || unusedAllow.length > 0) {
    return { status: 'FAILED', reason: null, hits, stats, unusedAllow };
  }
  return { status: 'VERIFIED', reason: null, hits, stats, unusedAllow };
}

function groupHits(hits) {
  const byToken = new Map();
  for (const h of hits) {
    if (!byToken.has(h.token)) byToken.set(h.token, []);
    byToken.get(h.token).push(h);
  }
  return [...byToken.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function formatReport(result) {
  const lines = [];
  lines.push(result.status);
  if (result.status === 'NOT CHECKED' || result.status === 'NOT_CHECKED') {
    lines.push(result.reason || 'unknown reason');
    return lines.join('\n');
  }
  if (result.stats) {
    lines.push(
      `scanned ${result.stats.md} markdown files, ${result.stats.ts} TypeScript comment-sets; registry ${result.stats.known} names; allowlist ${result.stats.allow}`,
    );
  }
  if (result.hits.length > 0) {
    lines.push(`unknown env-var names: ${groupHits(result.hits).length} tokens, ${result.hits.length} locations`);
    for (const [token, locs] of groupHits(result.hits)) {
      lines.push(`  ${token}`);
      for (const loc of locs.slice(0, 5)) {
        lines.push(`    ${loc.file}:${loc.line}  ${loc.excerpt}`);
      }
      if (locs.length > 5) lines.push(`    … ${locs.length - 5} more`);
    }
  }
  if (result.unusedAllow.length > 0) {
    lines.push(`unused allowlist entries (remove them): ${result.unusedAllow.join(', ')}`);
  }
  return lines.join('\n');
}

function main() {
  let result;
  try {
    result = scanRepo(REPO_ROOT);
  } catch (err) {
    console.log('NOT CHECKED');
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(EXIT_NOT_CHECKED);
  }
  // Canonical three-word status on stdout, first line.
  const label = result.status === 'NOT_CHECKED' ? 'NOT CHECKED' : result.status;
  const body = formatReport({ ...result, status: label });
  console.log(body);
  if (result.status === 'VERIFIED') process.exit(EXIT_VERIFIED);
  if (result.status === 'FAILED') process.exit(EXIT_FAILED);
  process.exit(EXIT_NOT_CHECKED);
}

module.exports = {
  EXIT_VERIFIED,
  EXIT_FAILED,
  EXIT_NOT_CHECKED,
  REPO_ROOT,
  REGISTRY_REL,
  TOKEN_RE,
  SKIP_DIRS,
  ALLOWLIST,
  looksLikeEnvVar,
  extractComments,
  loadRegistry,
  walkScanTargets,
  scanText,
  collectAllowlistHits,
  scanRepo,
  formatReport,
  main,
};

if (require.main === module) main();
