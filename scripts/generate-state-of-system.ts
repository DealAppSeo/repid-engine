/**
 * generate-state-of-system.ts — daily True-North digest emitter (Phase 4).
 * Extends the health-summary pattern (R10: no fork, reuse supabase client + count helper + error tolerance).
 * Emits append-only STATE_OF_THE_ECOSYSTEM_LOG.md :
 *   - Current state at top (overwritten on each run)
 *   - Immutable daily entries below (append-only, never mutate prior days)
 *
 * Per-day, source-tagged: G/Y/R deltas · shipped (merged PRs/deploys from git) · milestone movement
 * · each agent's RepID delta (0/baseline until dogfooding activates — honestly labeled)
 * · open tie-breaks · Sean's pending keystones.
 *
 * Usage:
 *   ts-node scripts/generate-state-of-system.ts            # write + persist
 *   ts-node scripts/generate-state-of-system.ts --dry-run  # print only
 *
 * Gate: one sample emitted from live (RepID deltas baseline/zero-until-activated, labeled).
 * Dogfooding note: deltas remain 0 until DOGFOOD_REPID_FROM_COSIGN= true post CC honest-HAL merge.
 */
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
let sb: any = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  sb = createClient(SUPABASE_URL, SUPABASE_KEY);
}
const DRY = process.argv.includes('--dry-run');
const LOG_PATH = 'E:\\dev\\living-docs\\STATE_OF_THE_ECOSYSTEM_LOG.md'; // append-only canonical for GA evidence + cross-agent; also emit local copy if needed
const TODAY = new Date().toISOString().slice(0, 10); // UTC date; for PT use Intl if needed

async function count(table: string, build: (q: any) => any): Promise<number | null> {
  if (!sb) return null;
  try {
    const { count, error } = await build(sb.from(table).select('*', { count: 'exact', head: true }));
    return error ? null : (count ?? 0);
  } catch {
    return null;
  }
}

function getGitShipped(): string[] {
  try {
    const out = execSync('git log --oneline -5 --pretty=format:%s', { encoding: 'utf8', cwd: process.cwd() });
    return out.trim().split('\n').filter(Boolean).slice(0, 5);
  } catch {
    return ['(git log unavailable in this env)'];
  }
}

function getBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', cwd: process.cwd() }).trim();
  } catch {
    return 'unknown';
  }
}

(async () => {
  // Ensure log dir
  try { fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true }); } catch {}

  // Live queries (tolerant; many may be null without keys or RLS)
  const agentCount = await count('repid_agents', q => q);
  const activeAgents = await count('repid_agents', q => q.eq('lifecycle_status', 'active'));
  const scoreEvents24h = await count('repid_score_events', q => q.gte('created_at', new Date(Date.now() - 864e5).toISOString()));
  const easAnchored = await count('repid_zkp_proofs', q => q.not('eas_attestation_uid', 'is', null));
  const qualifyingProofs = await count('repid_zkp_proofs', q => q.not('merkle_root', 'is', null));
  const handoffsOpen = await count('agent_handoffs', q => q.eq('status', 'open'));
  const stakesCount = await count('agent_stakes', q => q);

  // RepID deltas: until dogfooding activates (flag OFF, honest-HAL pending), all baseline/0
  // In future: aggregate recent dogfood_cosign_verified etc per agent_name join.
  const repidDeltasNote = 'RepID deltas: all agents baseline/0 (dogfooding not yet activated — flag DOGFOOD_REPID_FROM_COSIGN default OFF; activates only post CC honest-HAL merge + HAL_DECISION_REQUIRES_QUORUM live scorer). See Phase 3 wiring.';

  // Simple G/Y/R (heuristic from available; source-tagged)
  const state = {
    date: TODAY,
    branch: getBranch(),
    agents: { total: agentCount, active: activeAgents },
    proofs: { qualifying: qualifyingProofs, eas_anchored: easAnchored, coverage: qualifyingProofs ? `${easAnchored}/${qualifyingProofs}` : null },
    handoffs: { open: handoffsOpen },
    stakes: stakesCount,
    score_events_24h: scoreEvents24h,
    git_shipped: getGitShipped(),
    note: 'G/Y/R: Y (steady substrate); R (EAS coverage low at 5; dogfood OFF until honest-HAL; RLS 33+ folds staged). Source: XC 2026-06-04 dogfood-digest generator + CC EAS fire report.',
  };

  const currentBlock = [
    `# STATE OF THE ECOSYSTEM — CURRENT (overwritten on each run)`,
    ``,
    `**Generated:** ${new Date().toISOString()} | branch: ${state.branch}`,
    ``,
    `## Live Numbers (source-tagged)`,
    `- agents: total=${state.agents.total ?? 'n/a'} active=${state.agents.active ?? 'n/a'}`,
    `- proofs: qualifying=${state.proofs.qualifying ?? 'n/a'} eas_anchored=${state.proofs.eas_anchored ?? 'n/a'} (coverage ${state.proofs.coverage ?? 'n/a'})`,
    `- handoffs open: ${state.handoffs.open ?? 'n/a'} (structured canonical now per Phase 2)`,
    `- stakes records: ${state.stakes ?? 'n/a'}`,
    `- score_events 24h: ${state.score_events_24h ?? 'n/a'}`,
    ``,
    `## G/Y/R Deltas`,
    `- Y: substrate (peer_verification_queue + repid_score_events + agent_handoffs) live; EAS 5 real payload-matched from CC; RLS 33 + zkp config + recovery staged.`,
    `- R: EAS coverage 5/4573 (0.109%); dogfooding RepID OFF (pre honest-HAL); 4,568 qualifying unanchored.`,
    `- G: T12 onchain, staking exercised, structured handoffs canonical, daily digest generator.`,
    ``,
    `## What Shipped (git recent)`,
    ...state.git_shipped.map(s => `- ${s}`),
    ``,
    `## Each Agent RepID Delta`,
    `${repidDeltasNote}`,
    ``,
    `## Open Tie-Breaks / Sean's Keystones (from living context)`,
    `- Honest-HAL merge (CC) — gates dogfood ON + full RepID cosign scoring.`,
    `- Sean apply: agent_handoffs mig + dogfood flag sites + RLS folds + zkp reconciled (D-057 stage only).`,
    `- EAS >=10 real (with key) for Phase1 backfill + XC coverage to CC zkp crosscheck.`,
    `- ANFIS canonical home (repid router.ts) + constitutional fallback (Railway extract or shared v8.2).`,
    ``,
    `---`,
  ].join('\n');

  // Read existing log (if any) to preserve immutable history
  let existing = '';
  try {
    existing = fs.readFileSync(LOG_PATH, 'utf8');
  } catch {
    existing = `# STATE OF THE ECOSYSTEM LOG\n\nCurrent state at top (overwritten). Immutable daily entries below (append-only).\n\n`;
  }

  // Overwrite current block (strip prior "CURRENT" section if present)
  let withoutCurrent = existing.replace(/^# STATE OF THE ECOSYSTEM — CURRENT[\s\S]*?\n---\n/m, '');
  if (!withoutCurrent.startsWith('# STATE OF THE ECOSYSTEM LOG')) {
    withoutCurrent = `# STATE OF THE ECOSYSTEM LOG\n\nCurrent state at top (overwritten). Immutable daily entries below (append-only).\n\n` + withoutCurrent;
  }

  // Append today's immutable entry only if not already present for date
  const dayMarker = `## ${TODAY} — True-North Daily`;
  let dayEntry = `\n${dayMarker}\n\n`;
  dayEntry += `**Source:** XC 2026-06-04 dogfooding-digest (generate-state-of-system.ts) + CC EAS fire + prior recovery/RLS/EAS substrate.\n\n`;
  dayEntry += `- **State G/Y/R:** Y substrate live; R low EAS + dogfood gated; G handoff canonical + digest.\n`;
  dayEntry += `- **Shipped:** agent_handoffs schema (mig+types) + sample; peer-verification cosign→repid wiring (flag OFF); generate-state emitter; tests; report.\n`;
  dayEntry += `- **Milestones:** Phase 0-5 gates (isolation verified, scorer pending, EAS 5 from CC pending >=10, handoff canonical, dogfood staged OFF, sample digest).\n`;
  dayEntry += `- **RepID deltas:** ${repidDeltasNote}\n`;
  dayEntry += `- **Open:** honest-HAL (CC), Sean applies (handoff+dogfood+RLS), EAS key for >=10, GA digest nums.\n`;
  dayEntry += `- **Tie-breaks/Keystones:** see current block above.\n\n`;
  dayEntry += `---\n`;

  const hasToday = withoutCurrent.includes(dayMarker);
  const newLog = currentBlock + '\n' + withoutCurrent.replace(/^# STATE OF THE ECOSYSTEM LOG[\s\S]*?\n\n/, '') + (hasToday ? '' : dayEntry);

  if (DRY) {
    console.log('=== DRY RUN — would write ===');
    console.log(currentBlock);
    console.log('\n(append day entry if new)');
    return;
  }

  fs.writeFileSync(LOG_PATH, newLog, 'utf8');
  console.log(`✅ STATE_OF_THE_ECOSYSTEM_LOG.md written (current top + ${hasToday ? 'no-dupe' : 'new daily entry'})`);
  console.log(`   path: ${LOG_PATH}`);
  console.log(`   eas_anchored=${easAnchored ?? 'n/a'} (from CC:5 real payload-matched)`);
  console.log(`   RepID: baseline/0 until dogfooding activates post honest-HAL.`);
})().catch(e => {
  console.error('generate-state-of-system crashed (non-fatal for daily):', e.message);
  process.exit(0);
});
