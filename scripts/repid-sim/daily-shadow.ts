/**
 * RepID DAILY SIM — shadow weight proposals (vision-loop item E6).
 *
 * MEASURE-ONLY. At most it SELECTs; it writes no DB row, touches no env var, and changes no live
 * weight anywhere. Its outputs are a markdown report and SHADOW proposal lines. Applying any
 * proposal is a MAJOR change (rule 31): Sean, one item at a time.
 *
 *   LOCAL_MODE=true npx ts-node scripts/repid-sim/daily-shadow.ts --rows rows.json [--date 2026-10-15]
 *       (LOCAL_MODE only lets the imported engine config boot without a key; --rows mode never opens the DB)
 *   npx ts-node scripts/repid-sim/daily-shadow.ts --live [--date 2026-10-15]      (engine env: SUPABASE_URL + key)
 *       [--reports-dir E:/dev/reports] [--proposals E:/dev/ops/loop/repid-weight-proposals.jsonl]
 *
 * --date defaults to yesterday (UTC). --rows is for an agent that can SELECT but holds no key; make it with:
 *   SELECT c.id AS contract_id, (c.fulfilled_at IS NOT NULL) AS fulfilled, c.buyer_satisfaction_score::float8 AS satisfaction,
 *          c.dispute_verdict, (c.provider_agent_id = c.buyer_agent_id) AS self_deal,
 *          (pa.builder_id IS NOT NULL AND pa.builder_id = ba.builder_id) AS same_owner,
 *          (coalesce(x.is_simulated, false) OR lower(coalesce(c.metadata->>'simulated', c.payload->>'simulated', '')) IN ('true','1','yes')) AS simulated,
 *          o.rating AS outcome_rating, o.rater_repid_at_rating AS rater_repid
 *   FROM service_contracts c
 *   LEFT JOIN repid_agents pa ON pa.id = c.provider_agent_id LEFT JOIN repid_agents ba ON ba.id = c.buyer_agent_id
 *   LEFT JOIN x402_settlements x ON x.id = c.x402_payment_id
 *   LEFT JOIN LATERAL (SELECT rating, rater_repid_at_rating FROM service_outcomes so WHERE so.contract_id = c.id ORDER BY so.id DESC LIMIT 1) o ON true
 *   WHERE (c.settled_at >= :D AND c.settled_at < :D+1) OR (c.disputed_at >= :D AND c.disputed_at < :D+1) OR (c.resolved_at >= :D AND c.resolved_at < :D+1);
 *
 * WEIGHTS BASE = COMMITTED DEFAULTS, NOT PROD. The grid moves only the committed A2A touchpoint
 * constants (src/services/validation-repid-delta.ts), already public. The env-tuned parameters
 * (challenge, decay, prediction, ecosystem-need) live in Railway env, have no committed default, and
 * are deliberately NOT in the grid: a candidate value for them committed here would pre-burn it.
 *
 * CORPUS = everything that determines the proposals: the fixed A2A scenario set (a2a-ring-sim: honest,
 * fabricator, same-owner ring, Sybil, volume farmer; seed and sizes), the sha256 of the sim and verdict code
 * (rates, PRNG streams, rules), the base tariff, RATER_WEIGHT, the clamp, the grid, and day D's real contract
 * outcomes. Its sha256 is the ruler (CLAUDE_RULES r24): a proposal line without one is refused, a different body
 * under the same hash is refused, and numbers on different hashes are not comparable.
 *
 * OBJECTIVES (reports/2026-10-09/REPID-TUNING-ANALYSIS.md):
 *   P3_narrow        a provider-at-fault reversal exceeds the satisfied gain
 *   P3_full          the reversal is >= 1.25x the max stacked gain (fulfilled + satisfied + good x max rater weight)
 *   T3_bad_outweighs a bad outcome outweighs fulfilled + satisfied (the code's own comment)
 *   REAL_DAY_SIGN    on D's real contracts the provider's net has the sign of the ground truth
 * ANTI-GAMING (live rules, no owner-distinct rule): honest out-earns fabrication, a same-owner ring,
 *   a Sybil provider, and a volume farmer.
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { runA2ARingSim, COMMITTED_TARIFF, type Tariff } from './a2a-ring-sim';
import { RATER_WEIGHT } from '../../src/services/validation-repid-delta';
import { REPID_MIN, REPID_MAX } from '../../src/scoring/repid-deltas';

export const CORPUS_VERSION = 'repid-daily-sim-v1';
export const SCENARIOS = { seed: 12345, days: 30, ringTradesPerPairPerDay: 2 } as const;
const MINT_GUARD = 1.5; // a candidate may not mint more than 1.5x the base on D's real contracts
const RULE_FIX = {
  fabrication: 'the detector has to catch it (dispute rate), not the tariff',
  collusion: 'owner-distinct counterparties (a2a-ring-sim shadow counterfactual)',
  sybil: 'owner-distinct counterparties (a2a-ring-sim shadow counterfactual)',
  farming: 'per-window diminishing returns on same-type positives (tuning analysis rec 5)',
} as const;
/** The sim's rates, PRNG streams and verdict rules are code: hash the source (line endings normalised) so any change to them is a new ruler. */
const CODE_SHA256 = createHash('sha256')
  .update(['a2a-ring-sim.ts', 'daily-shadow.ts'].map((f) => readFileSync(join(__dirname, f), 'utf8').replace(/\r/g, '')).join('\n'))
  .digest('hex');

export interface RealOutcome {
  contract_id: string;
  fulfilled: boolean;
  satisfaction: number | null;
  dispute_verdict: string | null;
  self_deal: boolean;
  same_owner: boolean;
  simulated: boolean;
  outcome_rating: 'good' | 'ok' | 'bad' | null;
  rater_repid: number | null;
}

/** Small and documented. One constant per delta, so each proposal is one item (rule 31: MAJOR is never bundled). */
export const GRID: Array<{ id: string; why: string; delta: Record<string, number> }> = [
  { id: 'dispute-150', why: 'P3: reversal toward 1.25x the stacked gain', delta: { 'dispute.provider_at_fault.provider': -150 } },
  { id: 'dispute-200', why: 'P3: reversal = 1.25x the max stacked gain (160)', delta: { 'dispute.provider_at_fault.provider': -200 } },
  { id: 'rater-max-1.0', why: 'P3 alt: cap T3 good x rater weight instead of growing the reversal', delta: { raterWeightMax: 1.0 } },
  { id: 'fulfilled-5', why: 'farming: halve the flat per-contract reward', delta: { 'fulfilled.provider': 5 } },
  { id: 'fulfilled-0', why: 'farming: no flat reward, quality-only pay', delta: { 'fulfilled.provider': 0 } },
  { id: 'satisfied-40', why: 'shift weight from volume to quality', delta: { 'satisfied.provider': 40 } },
];

const r2 = (x: number) => Math.round(x * 100) / 100;

function normalize(r: any): RealOutcome {
  const num = (v: any) => (v === null || v === undefined || v === '' ? null : Number(v));
  return {
    contract_id: String(r.contract_id),
    fulfilled: r.fulfilled !== false,
    satisfaction: num(r.satisfaction),
    dispute_verdict: r.dispute_verdict ?? null,
    self_deal: r.self_deal === true,
    same_owner: r.same_owner === true,
    simulated: r.simulated === true,
    outcome_rating: r.outcome_rating ?? null,
    rater_repid: num(r.rater_repid),
  };
}

/**
 * The corpus and its sha256: everything that determines the proposals. Scenario seed and sizes, the sim and
 * verdict code (rates, streams, rules), the base tariff, RATER_WEIGHT, the clamp, the grid, and D's rows.
 * Same inputs in any row order => same hash; change any of them => new hash. `base` is a parameter only so
 * a test can prove the tariff is bound.
 */
export function buildCorpus(date: string, rows: any[], base: Tariff = COMMITTED_TARIFF) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`date must be YYYY-MM-DD, got ${date}`);
  // Code-unit order, not localeCompare: the hash must not depend on the runtime locale.
  const real = rows.map(normalize).sort((a, b) => (a.contract_id < b.contract_id ? -1 : a.contract_id > b.contract_id ? 1 : 0));
  const corpus = {
    version: CORPUS_VERSION, date, scenarios: SCENARIOS, code_sha256: CODE_SHA256,
    tariff: base, rater_weight: { min: RATER_WEIGHT.min, pivot: RATER_WEIGHT.pivot }, clamp: [REPID_MIN, REPID_MAX],
    grid: GRID, real,
  };
  return { corpus, hash: 'sha256:' + createHash('sha256').update(JSON.stringify(corpus)).digest('hex') };
}

export function applyDelta(base: Tariff, delta: Record<string, number>): Tariff {
  const t: any = structuredClone(base);
  for (const [path, v] of Object.entries(delta)) {
    const keys = path.split('.');
    let o = t;
    for (const k of keys.slice(0, -1)) o = o[k];
    if (!(keys.at(-1)! in o)) throw new Error(`unknown tariff path ${path}`);
    o[keys.at(-1)!] = v;
  }
  return t;
}

/** What the live writers would move on one real contract under tariff t (simulated => 0, the G1 gate). */
export function contractNet(t: Tariff, r: RealOutcome): { provider: number; buyer: number } {
  if (r.simulated) return { provider: 0, buyer: 0 };
  let provider = r.fulfilled ? t.fulfilled.provider : 0;
  let buyer = r.fulfilled ? t.fulfilled.buyer : 0;
  if (r.satisfaction !== null && r.satisfaction > 0) {
    const s = Math.min(1, r.satisfaction);
    provider += Math.round(t.satisfied.provider * s);
    buyer += Math.round(t.satisfied.buyer * s);
  }
  if (r.outcome_rating === 'good' || r.outcome_rating === 'bad') {
    const w = Math.min(t.raterWeightMax, Math.max(RATER_WEIGHT.min, (r.rater_repid ?? 0) / RATER_WEIGHT.pivot));
    provider += Math.round(t.outcome[r.outcome_rating] * w);
  }
  if (r.dispute_verdict === 'provider_at_fault' || r.dispute_verdict === 'buyer_at_fault') {
    provider += t.dispute[r.dispute_verdict].provider;
    buyer += t.dispute[r.dispute_verdict].buyer;
  }
  return { provider, buyer };
}

/** Ground truth for the provider: bad if found at fault or rated bad; good if satisfied or rated good; else unlabelled. */
function label(r: RealOutcome): 'good' | 'bad' | null {
  if (r.simulated) return null;
  if (r.dispute_verdict === 'provider_at_fault' || r.outcome_rating === 'bad') return 'bad';
  if ((r.satisfaction ?? 0) > 0 || r.outcome_rating === 'good') return 'good';
  return null;
}

type Check = { pass: boolean | null; value: number; note?: string };

export function objectives(t: Tariff, real: RealOutcome[]) {
  const reversal = -t.dispute.provider_at_fault.provider;
  const stacked = t.fulfilled.provider + t.satisfied.provider + t.outcome.good * t.raterWeightMax;
  const labelled = real.filter((r) => label(r) !== null);
  const agree = labelled.filter((r) => (label(r) === 'good' ? contractNet(t, r).provider > 0 : contractNet(t, r).provider < 0)).length;
  const checks: Record<string, Check> = {
    P3_narrow: { pass: reversal > t.satisfied.provider, value: reversal - t.satisfied.provider },
    P3_full: { pass: reversal >= 1.25 * stacked, value: r2(reversal / stacked), note: 'reversal / max stacked gain; target >= 1.25' },
    T3_bad_outweighs: { pass: -t.outcome.bad > t.fulfilled.provider + t.satisfied.provider, value: -t.outcome.bad - t.fulfilled.provider - t.satisfied.provider },
    REAL_DAY_SIGN: labelled.length
      ? { pass: agree === labelled.length, value: r2(agree / labelled.length), note: `${agree}/${labelled.length} labelled contracts` }
      : { pass: null, value: 0, note: 'NOT_CHECKED: no labelled real contract on D' },
  };
  const counted = Object.values(checks).filter((c) => c.pass !== null);
  const real_mint = real.reduce((s, r) => { const n = contractNet(t, r); return s + Math.max(0, n.provider) + Math.max(0, n.buyer); }, 0);
  return { met: counted.filter((c) => c.pass).length, of: counted.length, checks, real_mint };
}

export function antiGaming(t: Tariff, real: RealOutcome[]) {
  const s = runA2ARingSim({ ...SCENARIOS, ownerDistinctRule: false, tariff: t });
  const margins = {
    fabrication: s.honest.net - s.fabricator.net,
    collusion: s.honest.net - s.ring_member.net_avg,
    sybil: s.honest.net - s.sybil_provider.net,
    farming: s.honest.net - s.farmer.net,
  };
  // Real-day exposure: RepID the tariff would mint on same-owner or self-dealt contracts on D.
  const same_owner_mint = real
    .filter((r) => r.same_owner || r.self_deal)
    .reduce((acc, r) => { const n = contractNet(t, r); return acc + Math.max(0, n.provider) + Math.max(0, n.buyer); }, 0);
  return { holds: Object.values(margins).filter((m) => m > 0).length, of: 4, margins, same_owner_mint };
}

export interface ProposalLine {
  date: string;
  corpus_hash: string;
  weights_base: 'committed-defaults';
  id: string;
  delta: Record<string, number>;
  objective_before: ReturnType<typeof objectives>;
  objective_after: ReturnType<typeof objectives>;
  anti_gaming_before: ReturnType<typeof antiGaming>;
  anti_gaming_after: ReturnType<typeof antiGaming>;
  verdict: 'propose' | 'reject';
  reason: string;
}

/**
 * propose ONLY when something is newly met AND no objective regresses AND no anti-gaming margin falls at all
 * (an already-negative margin falling further still counts) AND neither mint guard trips. Every reject names
 * what fell; the propose reason states only what was computed.
 */
export function verdictOf(ob: ProposalLine['objective_before'], oa: ProposalLine['objective_after'], ab: ProposalLine['anti_gaming_before'], aa: ProposalLine['anti_gaming_after']) {
  const keys = Object.keys(ab.margins) as Array<keyof typeof ab.margins>;
  const problems = [
    ...Object.keys(ob.checks).filter((k) => ob.checks[k]!.pass === true && oa.checks[k]!.pass !== true).map((k) => `objective ${k} regresses`),
    ...keys.filter((k) => aa.margins[k] < ab.margins[k]).map((k) => `anti-gaming margin falls: ${k} ${ab.margins[k]} -> ${aa.margins[k]} (${aa.margins[k] - ab.margins[k]})`),
    ...(aa.same_owner_mint > ab.same_owner_mint ? [`same-owner real-day mint rises ${ab.same_owner_mint} -> ${aa.same_owner_mint}`] : []),
    ...(ob.real_mint > 0 && oa.real_mint > MINT_GUARD * ob.real_mint ? [`real-day mint ${oa.real_mint} > ${MINT_GUARD}x base ${ob.real_mint}`] : []),
  ];
  if (problems.length) return { verdict: 'reject' as const, reason: problems.join('; ') };
  const gained = [
    ...Object.keys(ob.checks).filter((k) => ob.checks[k]!.pass !== true && oa.checks[k]!.pass === true),
    ...keys.filter((k) => ab.margins[k] <= 0 && aa.margins[k] > 0),
  ];
  if (!gained.length) return { verdict: 'reject' as const, reason: 'no objective or anti-gaming check newly met (no margin fell)' };
  return { verdict: 'propose' as const, reason: `newly meets ${gained.join(', ')}; computed: 0 objectives regress, 0 of ${keys.length} anti-gaming margins fall` };
}

/** Deterministic: no wall clock, no PRNG outside the seeded sim. Same corpus => same lines. */
export function runDaily(date: string, rows: any[]) {
  const { corpus, hash } = buildCorpus(date, rows);
  const objective_before = objectives(COMMITTED_TARIFF, corpus.real);
  const anti_gaming_before = antiGaming(COMMITTED_TARIFF, corpus.real);
  const lines: ProposalLine[] = GRID.map((g) => {
    const t = applyDelta(COMMITTED_TARIFF, g.delta);
    const objective_after = objectives(t, corpus.real);
    const anti_gaming_after = antiGaming(t, corpus.real);
    return {
      date, corpus_hash: hash, weights_base: 'committed-defaults', id: g.id, delta: g.delta,
      objective_before, objective_after, anti_gaming_before, anti_gaming_after,
      ...verdictOf(objective_before, objective_after, anti_gaming_before, anti_gaming_after),
    };
  });
  return { corpus, hash, objective_before, anti_gaming_before, lines };
}

/**
 * Refuses the whole batch if any line lacks a corpus hash. A line identical to one already written is skipped
 * (a rerun adds nothing); a DIFFERENT body under the same date|hash|id refuses the whole batch loudly, because it
 * means the hash failed to bind the result.
 */
export function appendProposals(path: string, lines: ProposalLine[]): number {
  const bad = lines.filter((l) => !/^sha256:[0-9a-f]{64}$/.test(String(l?.corpus_hash ?? '')));
  if (bad.length) throw new Error(`refusing to write ${bad.length} proposal line(s) without a corpus hash — a delta without its ruler is not a result (CLAUDE_RULES r24)`);
  const key = (l: { date: string; corpus_hash: string; id: string }) => `${l.date}|${l.corpus_hash}|${l.id}`;
  const written = new Map<string, string>();
  if (existsSync(path)) for (const s of readFileSync(path, 'utf8').split('\n').filter(Boolean)) written.set(key(JSON.parse(s)), s);
  const fresh: string[] = [];
  const conflicts: string[] = [];
  for (const l of lines) {
    const s = JSON.stringify(l);
    const prev = written.get(key(l));
    if (prev === undefined) fresh.push(s);
    else if (prev !== s) conflicts.push(key(l));
  }
  if (conflicts.length) {
    throw new Error(`refusing to write: ${conflicts.length} line(s) already in ${path} under the same date|hash|id with a DIFFERENT body (${conflicts.join(', ')}) — the corpus hash did not bind the result`);
  }
  mkdirSync(dirname(path), { recursive: true });
  if (fresh.length) appendFileSync(path, fresh.join('\n') + '\n');
  return fresh.length;
}

export function renderReport(run: ReturnType<typeof runDaily>, source: string): string {
  const { corpus, hash, objective_before: ob, anti_gaming_before: ab, lines } = run;
  const t = COMMITTED_TARIFF;
  const fmt = (o: ReturnType<typeof objectives>) => `${o.met}/${o.of}`;
  const failing = (o: ReturnType<typeof objectives>) => Object.entries(o.checks).filter(([, c]) => c.pass === false).map(([k]) => k).join(', ') || 'none';
  const ag = (a: ReturnType<typeof antiGaming>) => `${a.holds}/${a.of} (fab ${a.margins.fabrication}, ring ${a.margins.collusion}, sybil ${a.margins.sybil}, farm ${a.margins.farming})`;
  const real = corpus.real;
  return [
    `# RepID daily sim — ${corpus.date}`,
    '',
    `**Corpus:** \`${CORPUS_VERSION}@${hash}\` — fixed scenarios (seed ${SCENARIOS.seed}, ${SCENARIOS.days} days, ring ${SCENARIOS.ringTradesPerPairPerDay} trades/pair/day) + ${real.length} real contract outcome(s) on ${corpus.date} (${source}). The hash also binds the sim and verdict code (sha256 \`${corpus.code_sha256.slice(0, 12)}…\`), the base tariff, RATER_WEIGHT (min ${corpus.rater_weight.min}, pivot ${corpus.rater_weight.pivot}), the clamp [${corpus.clamp.join(', ')}] and the ${corpus.grid.length}-entry grid.`,
    '',
    '**Weights base: COMMITTED DEFAULTS, not prod.** The live tuned weights live in Railway env and were not read. Every delta below is relative to the committed constants in `src/services/validation-repid-delta.ts`. No live weight was changed; these are SHADOW proposals. Applying any of them is MAJOR (rule 31, Sean).',
    '',
    `Committed tariff: fulfilled ${t.fulfilled.provider}/${t.fulfilled.buyer} · satisfied ${t.satisfied.provider}x s/${t.satisfied.buyer}x s · outcome good ${t.outcome.good} bad ${t.outcome.bad} x rater weight (max ${t.raterWeightMax}) · dispute provider_at_fault ${t.dispute.provider_at_fault.provider}/+${t.dispute.provider_at_fault.buyer}.`,
    '',
    '## Real outcomes on D',
    `- contracts: ${real.length} · simulated: ${real.filter((r) => r.simulated).length} · same-owner/self-deal: ${real.filter((r) => r.same_owner || r.self_deal).length} · disputed (provider at fault): ${real.filter((r) => r.dispute_verdict === 'provider_at_fault').length} · T3 outcome rated: ${real.filter((r) => r.outcome_rating).length}`,
    `- RepID the committed tariff mints on them: ${ob.real_mint}`,
    '',
    '## Baseline (committed defaults)',
    `- objectives met: ${fmt(ob)} · failing: ${failing(ob)} · P3_full ratio ${ob.checks.P3_full!.value} (target >= 1.25) · real-day sign ${ob.checks.REAL_DAY_SIGN!.note}`,
    `- anti-gaming holds: ${ag(ab)} — margin = honest net minus attacker net over ${SCENARIOS.days} days; > 0 holds`,
    '',
    '## Candidate deltas',
    '| id | delta | objectives before → after | P3_full ratio | anti-gaming after | verdict | reason |',
    '|---|---|---|---|---|---|---|',
    ...lines.map((l) => `| ${l.id} | \`${JSON.stringify(l.delta)}\` | ${fmt(l.objective_before)} → ${fmt(l.objective_after)} | ${l.objective_after.checks.P3_full!.value} | ${ag(l.anti_gaming_after)} | **${l.verdict}** | ${l.reason} |`),
    '',
    `Proposals: ${lines.filter((l) => l.verdict === 'propose').length} propose, ${lines.filter((l) => l.verdict === 'reject').length} reject.`,
    '',
    '## Read this before quoting',
    '- MODELLED: scenario demand, quality, dispute rates and attacker volume (scripts/repid-sim/a2a-ring-sim.ts). REAL: the tariff arithmetic and D\'s outcomes.',
    '- Verdict rule: **propose** only when something is newly met AND no objective regresses AND no anti-gaming margin falls at all (an already-negative margin falling further counts) AND neither mint guard trips. A margin is honest net minus attacker net over the scenario days.',
    ...(['fabrication', 'collusion', 'sybil', 'farming'] as const)
      .filter((k) => ab.margins[k] <= 0 && lines.every((l) => l.anti_gaming_after.margins[k] <= 0))
      .map((k) => `- No single-weight delta in this grid makes honest out-earn **${k}** (best margin ${Math.max(...lines.map((l) => l.anti_gaming_after.margins[k]))}). A rule problem, not a weight problem: ${RULE_FIX[k]}.`),
    '- T3 SERVICE_OUTCOME is modelled in the objectives but cannot land live today (not in the repid_score_events event_type CHECK).',
    '- Numbers on a different corpus hash are not comparable.',
    '',
  ].join('\n');
}

/**
 * SELECT-only. Every read asks for an exact count and is refused if it came back short or paginated: a partial
 * day is not a corpus, and a hash over it would be a ruler for a number nobody measured. Returns the per-table
 * row counts so the report records what was read.
 */
async function liveRows(date: string): Promise<{ rows: RealOutcome[]; reads: Record<string, number> }> {
  const { db } = await import('../../src/db');
  const { hasTruthySimFlag } = await import('../../src/utils/truthy');
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const win = (c: string) => `and(${c}.gte.${date},${c}.lt.${next})`;
  const reads: Record<string, number> = {};
  const whole = (table: string, res: { data: any[] | null; error: any; count: number | null }, expected?: number) => {
    if (res.error) throw new Error(`SELECT ${table} failed: ${res.error.message}`);
    const got = (res.data ?? []).length;
    const want = expected ?? res.count;
    if (want === null || want === undefined || got !== want || (res.count !== null && res.count !== got)) {
      throw new Error(`refusing: ${table} returned ${got} row(s), count ${res.count}, expected ${want} — short or paginated read, corpus would be partial`);
    }
    reads[table] = got;
    return res.data ?? [];
  };
  const none = { data: [], error: null, count: 0 };

  const contracts = whole('service_contracts', await db.from('service_contracts')
    .select('id, provider_agent_id, buyer_agent_id, buyer_satisfaction_score, dispute_verdict, fulfilled_at, metadata, payload, x402_payment_id', { count: 'exact' })
    .or([win('settled_at'), win('disputed_at'), win('resolved_at')].join(',')));
  const agentIds = [...new Set(contracts.flatMap((c: any) => [c.provider_agent_id, c.buyer_agent_id]))];
  // Every party must resolve, or same_owner is unknown rather than false.
  const agents = whole('repid_agents', agentIds.length
    ? await db.from('repid_agents').select('id, builder_id', { count: 'exact' }).in('id', agentIds) : none, agentIds.length);
  const ids = contracts.map((c: any) => c.id);
  const outs = whole('service_outcomes', ids.length
    ? await db.from('service_outcomes').select('id, contract_id, rating, rater_repid_at_rating', { count: 'exact' }).in('contract_id', ids).order('id') : none);
  const payIds = [...new Set(contracts.map((c: any) => c.x402_payment_id).filter(Boolean))];
  const pays = whole('x402_settlements', payIds.length
    ? await db.from('x402_settlements').select('id, is_simulated', { count: 'exact' }).in('id', payIds) : none);

  const builder = new Map<string, string | null>(agents.map((a: any) => [a.id, a.builder_id]));
  const outcome = new Map<string, any>(outs.map((o: any) => [o.contract_id, o])); // ordered by id, so the latest wins
  const simPay = new Map<string, boolean>(pays.map((x: any) => [x.id, x.is_simulated === true]));
  const rows = contracts.map((c: any) => {
    const pb = builder.get(c.provider_agent_id);
    const o = outcome.get(c.id);
    return normalize({
      contract_id: c.id, fulfilled: c.fulfilled_at !== null, satisfaction: c.buyer_satisfaction_score, dispute_verdict: c.dispute_verdict,
      self_deal: c.provider_agent_id === c.buyer_agent_id, same_owner: pb != null && pb === builder.get(c.buyer_agent_id),
      // Same rule as contractRowIsSimulated (sim flag on metadata/payload, or the linked settlement), minus its fail-open fetch.
      simulated: hasTruthySimFlag(c.metadata ?? {}) || hasTruthySimFlag(c.payload ?? {}) || simPay.get(c.x402_payment_id) === true,
      outcome_rating: o?.rating ?? null, rater_repid: o?.rater_repid_at_rating ?? null,
    });
  });
  return { rows, reads };
}

async function main(): Promise<number> {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  const date = arg('--date') ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const rowsPath = arg('--rows');
  let rows: any[];
  let source = `rows from ${rowsPath}`;
  if (rowsPath) rows = JSON.parse(readFileSync(rowsPath, 'utf8'));
  else if (process.argv.includes('--live')) {
    const live = await liveRows(date);
    rows = live.rows;
    source = `live SELECT, rows read: ${Object.entries(live.reads).map(([t, n]) => `${t} ${n}`).join(', ')}`;
  }
  else { console.error('usage: (--rows rows.json | --live) [--date YYYY-MM-DD] [--reports-dir DIR] [--proposals FILE]'); return 2; }

  const run = runDaily(date, rows);
  const report = renderReport(run, source);
  const reportPath = join(arg('--reports-dir') ?? 'E:/dev/reports', date, `REPID_DAILY_SIM_${date}.md`);
  const written = appendProposals(arg('--proposals') ?? 'E:/dev/ops/loop/repid-weight-proposals.jsonl', run.lines); // may refuse: then no report either
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report);
  console.log(report);
  console.log(`corpus ${run.hash} · report ${reportPath} · proposal lines written ${written} (${run.lines.length - written} already present)`);
  return 0;
}

if (require.main === module) {
  // exitCode, not exit(): on Windows a piped stdout is async and exit() truncates the report.
  main().then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 2; });
}
