/**
 * runCase: one exchange, start to evidence record (spec §7).
 *
 *   negotiate (agents propose, CODE validates)  ->  [deliver + deterministic acceptance]  ->  build a fresh world
 *   ->  PREDICT and freeze  ->  run the case script against the executor  ->  read the chain back
 *   ->  GRADE with the oracle  ->  write the record.
 *
 * A model error, an unusable proposal, a seller who declines, or an exception in the harness leaves the
 * case NOT_CHECKED: it says nothing about the executor and is never counted as a pass or a failure.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acceptDelivery, ModelError, validateTerms, type ArenaAgents, type Delivery, type JudgeNote, type Terms } from './agents';
import type { TestChain } from './chain';
import { CASES, EXTRA_CASES, type CaseDef, type ExtraCaseId } from './cases';
import { ZERO_ADDRESS, jcs, serviceHashOf, sha256Hex, type Hex } from './core';
import type { Engine } from './engine';
import { grade, predict, type Balances, type CaseId, type Observed, type PassCondition, type Prediction, type Sym, type Violation } from './oracle';
import { disposeWorld, makeWorld, serializeReadback, type Attempt, type World } from './world';

/**
 * Cases the engine is KNOWN to fail today. Pinned with `it.failing` in tests/arena-l0.test.ts, exactly as tests/kernel pins its
 * holes. A pin is not a pass: the evidence still says FAIL.
 * Empty: the four it held (replay_same_authorization, replay_after_restart, concurrent_x10, respelled_replay) settled twice on a
 * kernel with no one-use authorization (spec §4). #1453 closed them, and tests/arena-l0.test.ts now asserts they PASS.
 */
export const KNOWN_FAILING: readonly string[] = [];

export interface RunCtx {
  chain: TestChain;
  engine: Engine;
  agents: ArenaAgents;
  batchId: string;
  gitSha: string;
  /** sha256 of oracle.ts when the batch started. */
  evaluatorSha256: string;
  /** Re-read at the end of each case; a different answer is recorded as a discrepancy. */
  currentEvaluatorSha256?: () => string;
  /** Picks the asset for cases that do not need a particular one (alternates across runs). */
  symSeed?: number;
  /** Test override: the asset for cases that do not need a particular one. */
  sym?: Sym;
  /** Test seam for the exchange's throwaway keys (see WorldOpts). */
  genKey?: () => Hex;
  now?: () => number;
  /** Where records are written. Absent = returned only. */
  outDir?: string;
}

export interface Evidence {
  run_id: string;
  batch_id: string;
  case: CaseId | ExtraCaseId;
  at: string;
  prediction: (Prediction & { sha256: string; frozen_at: string }) | null;
  frozen: { git_sha: string; policy_id: string | null; chain_id: number | null; block: string | null; model_ids: string[]; evaluator_sha256: string };
  npa_hash: string | null;
  negotiation: { buyer_terms: Terms | null; seller_accepted: boolean | null; asset: Sym; delivery_accepted: boolean | null };
  observations: Record<string, unknown>;
  discrepancies: string[];
  oracle_verdict: 'PASS' | 'FAIL' | 'NOT_CHECKED';
  not_checked_reason: string | null;
  violations: Violation[];
  breaches: PassCondition[];
  /** A FAIL that the pinned it.failing tests already expect. Still a FAIL. */
  pinned_known_failure: boolean;
  judge_note: JudgeNote | { error: string } | null;
}

const LIMITS = { USDC: { decimals: 6, per_tx_max_raw: '1000000' }, ETH: { decimals: 18, per_tx_max_raw: '1000000000000000' } } as const;
const REQUESTS = [
  'Summarise the water-saving tips in one short synthetic paragraph about home gardens.',
  'Write five bullet points that explain what a hash function does, for a new programmer.',
  'List three questions a volunteer should ask before joining a community clean-up.',
  'Explain in four sentences why backups should be tested, using a made-up office as the example.',
  'Draft a two-line product description for an invented reusable water bottle.',
  'Give four tips for reading a bus timetable, using an invented town.',
];

const defOf = (c: CaseId | ExtraCaseId): CaseDef => (CASES as Record<string, CaseDef>)[c] ?? EXTRA_CASES[c as ExtraCaseId];
export const symFor = (c: CaseId | ExtraCaseId, seed = 0): Sym => defOf(c).sym ?? (parseInt(sha256Hex(`${c}:${seed}`).slice(0, 2), 16) % 2 === 0 ? 'USDC' : 'ETH');

async function snap(w: World): Promise<{ buyer: Balances; seller: Balances; attacker: Balances }> {
  const one = async (a: Hex): Promise<Balances> => ({
    ETH: (await w.chain.balance(ZERO_ADDRESS, a)).toString(),
    USDC: (await w.chain.balance(w.addr.usdc, a)).toString(),
    DECOY: (await w.chain.balance(w.addr.decoy, a)).toString(),
  });
  return { buyer: await one(w.addr.buyer), seller: await one(w.addr.seller), attacker: await one(w.addr.attacker) };
}

const providerRepid = async (w: World): Promise<number> => (await w.engine.db.from('repid_agents').select('*').eq('id', w.agents.seller.id).single()).data.current_repid;

export async function runCase(caseId: CaseId | ExtraCaseId, ctx: RunCtx): Promise<Evidence> {
  const now = ctx.now ?? Date.now;
  const def = defOf(caseId);
  const sym = def.sym ?? ctx.sym ?? symFor(caseId, ctx.symSeed);
  const ev: Evidence = {
    run_id: randomUUID(),
    batch_id: ctx.batchId,
    case: caseId,
    at: new Date(now()).toISOString(),
    prediction: null,
    frozen: { git_sha: ctx.gitSha, policy_id: null, chain_id: null, block: null, model_ids: [], evaluator_sha256: ctx.evaluatorSha256 },
    npa_hash: null,
    negotiation: { buyer_terms: null, seller_accepted: null, asset: sym, delivery_accepted: null },
    observations: {},
    discrepancies: [],
    oracle_verdict: 'NOT_CHECKED',
    not_checked_reason: null,
    violations: [],
    breaches: [],
    pinned_known_failure: false,
    judge_note: null,
  };
  const notChecked = (why: string): Evidence => {
    ev.oracle_verdict = 'NOT_CHECKED';
    ev.not_checked_reason = why;
    ev.frozen.model_ids = ctx.agents.modelIds?.() ?? [];
    return finish(ev, ctx);
  };

  // 1. negotiation: models propose, code validates.
  let terms: Terms;
  let delivery: Delivery | null = null;
  try {
    const request = REQUESTS[parseInt(sha256Hex(`${caseId}:${ctx.symSeed ?? 0}`).slice(2, 4), 16) % REQUESTS.length]!;
    const offer = await ctx.agents.proposeTerms({ role: 'buyer', case_id: caseId, service_request: request, limits: LIMITS, asset: sym });
    const v = validateTerms(offer, LIMITS[sym].per_tx_max_raw, sym);
    if (!v.ok) return notChecked(`the buyer's proposal was unusable: ${v.why}`);
    terms = v.terms;
    ev.negotiation.buyer_terms = terms;
    const answer = await ctx.agents.proposeTerms({ role: 'seller', case_id: caseId, service_request: request, limits: LIMITS, asset: sym, offer: terms });
    ev.negotiation.seller_accepted = answer?.accept === true;
    if (answer?.accept !== true) return notChecked('the seller declined the offer, so there is no NPA to sign');
    if (def.delivers) {
      delivery = await ctx.agents.deliver({ terms, service_hash: serviceHashOf(terms.work_statement, terms.acceptance_criteria) });
      ev.negotiation.delivery_accepted = acceptDelivery(delivery);
      if (!ev.negotiation.delivery_accepted) return notChecked('the deliverable failed the deterministic acceptance check, so no payment was attempted');
    }
  } catch (e) {
    return notChecked(e instanceof ModelError ? `model error: ${e.message}` : `harness error before the case: ${String((e as Error).message).slice(0, 120)}`);
  }

  // 2. a fresh world, then the prediction, frozen BEFORE the executor is touched.
  let w: World | null = null;
  try {
    w = await makeWorld({ chain: ctx.chain, engine: ctx.engine, now: ctx.now, evaluatorSha256: ctx.evaluatorSha256, genKey: ctx.genKey, ...(def.world?.(sym, terms.amount_raw) ?? {}) });
    const pred = EXTRA_CASES[caseId as ExtraCaseId]?.predict({ sym, amount_raw: terms.amount_raw }) ?? predict(caseId as CaseId, { sym, amount_raw: terms.amount_raw });
    ev.prediction = { ...pred, sha256: sha256Hex(jcs(pred)), frozen_at: new Date(now()).toISOString() };
    ev.frozen.policy_id = w.policy.policy_id;
    ev.frozen.chain_id = w.policy.chain_id;
    ev.frozen.block = (await ctx.chain.blockNumber()).toString();
    ev.frozen.model_ids = ctx.agents.modelIds?.() ?? [];

    const before = await snap(w);
    const nonceBefore = await ctx.chain.txCount(w.addr.buyer);
    const repidBefore = await providerRepid(w);

    // 3. the case runs against the executor
    const work = { statement: terms.work_statement, criteria: terms.acceptance_criteria };
    const ran = await def.run({ w, sym, amount_raw: terms.amount_raw, work, accepted: ev.negotiation.delivery_accepted ?? true });

    // 4. read everything back from the chain and the store, independently of the executor's own labels
    const after = await snap(w);
    const sends = await Promise.all(w.sends.map(async (s) => ({ hash: s.hash, rb: await ctx.chain.readback(s.hash) })));
    const observed: Observed = {
      attempts: w.attempts.map((a) => ({ status: a.status, npa_hash: a.npa_hash, sym: a.sym, amount_raw: a.amount_raw })),
      before,
      after,
      allowance_buyer_to_attacker_after: (await ctx.chain.allowance(w.addr.usdc, w.addr.buyer, w.addr.attacker)).toString(),
      buyer_nonce_before: nonceBefore,
      buyer_nonce_after: await ctx.chain.txCount(w.addr.buyer),
      sends: sends.map(({ hash, rb }) => ({ hash, found: rb.found, success: rb.success ?? null, from: rb.from ?? null, to: rb.to ?? null, value: rb.value?.toString() ?? null, transfers: rb.transfers.map((t) => ({ token: t.token, from: t.from, to: t.to, amount: t.amount.toString() })) })),
      policy: { chain_id: w.policy.chain_id, connected_chain_id: await ctx.chain.chainId(), buyer: w.policy.wallets.buyer, counterparties: w.policy.counterparties, usdc: w.addr.usdc, per_tx_max_raw: w.policy.per_tx_max_raw },
      feedback: ran.feedback.map((f) => ({ applied: f.applied, provider_delta: f.provider_delta })),
      provider_repid_delta: (await providerRepid(w)) - repidBefore,
    };
    const g = grade(ev.prediction, observed);
    ev.oracle_verdict = g.verdict;
    ev.violations = g.violations;
    ev.breaches = [...new Set(g.violations.flatMap((x) => (x.condition ? [x.condition] : [])))];
    ev.pinned_known_failure = g.verdict === 'FAIL' && KNOWN_FAILING.includes(caseId);
    ev.npa_hash = w.attempts[0]?.npa_hash ?? null;

    // 5. what the models said afterwards is advisory
    const settled = w.attempts.some((a) => a.status === 'SETTLED');
    if (delivery && settled) {
      try {
        ev.judge_note = await ctx.agents.judge({ terms, delivery });
      } catch (e) {
        ev.judge_note = { error: e instanceof ModelError ? e.message : String((e as Error).message).slice(0, 100) };
      }
    }
    ev.frozen.model_ids = ctx.agents.modelIds?.() ?? [];

    ev.observations = {
      attempts: w.attempts,
      kernel_decisions: w.attempts.map((a) => ({ label: a.label, gate: a.gate, kernel: a.kernel, kernel_alone_would_say: a.kernel_dry })),
      tx_hashes: w.sends.map((s) => s.hash),
      readback: sends.map(({ hash, rb }) => ({ hash, ...serializeReadback(rb) })),
      balances: { before, after },
      allowance_buyer_to_attacker: observed.allowance_buyer_to_attacker_after,
      buyer_nonce: { before: nonceBefore, after: observed.buyer_nonce_after },
      feedback: ran.feedback,
      provider_repid_delta: observed.provider_repid_delta,
      extra: ran.extra,
      block_after: (await ctx.chain.blockNumber()).toString(),
      kernel_ledger_lines: readFileSync(w.ledgerPath, 'utf8').split('\n').filter(Boolean).length,
      egress: ctx.engine.egress,
    };
    ev.discrepancies = discrepancies(ev, w);
  } catch (e) {
    ev.oracle_verdict = 'NOT_CHECKED';
    ev.not_checked_reason = `harness error during the case: ${String((e as Error).message).slice(0, 160)}`;
  } finally {
    if (w) disposeWorld(w);
  }
  return finish(ev, ctx);
}

function discrepancies(ev: Evidence, w: World): string[] {
  const out: string[] = ev.violations.map((v) => `${v.condition ?? 'case'}: ${v.detail}`);
  const repeated = new Set<string>();
  for (const a of w.attempts) {
    const dry = a.kernel_dry;
    if (dry && 'verdict' in dry && dry.verdict === 'ALLOW') out.push(`info: the kernel alone would have ALLOWED "${a.label}" (arena preflight refused it: ${a.refusals.map((r) => r.code).join(', ')})`);
    if (a.kernel?.verdict === 'ALLOW' && a.status === 'SETTLED' && !repeated.has(a.npa_hash) && w.attempts.filter((x) => x.npa_hash === a.npa_hash && x.status === 'SETTLED').length > 1) {
      repeated.add(a.npa_hash);
      out.push(`info: the kernel ALLOWED repeats of authorization ${a.npa_hash.slice(0, 12)}; nothing consumes the authorization (the NPA's EIP-712 digest) before the tool runs`);
    }
  }
  const probe = (ev.observations.extra as { engine_probe?: { provider_delta: number } } | undefined)?.engine_probe;
  if (probe && probe.provider_delta !== 0) out.push(`info: the engine's delta function ALONE moved a self-contract's provider by ${probe.provider_delta}. Production refuses a self-contract at creation (src/routes/v1/contracts.ts); the arena creates contracts directly, so its own feedback gate is what withheld the RepID here`);
  return out;
}

/** The record is final: stamp the evaluator check, write it, return it. */
function finish(ev: Evidence, ctx: RunCtx): Evidence {
  const now = ctx.currentEvaluatorSha256?.();
  if (now && now !== ctx.evaluatorSha256) ev.discrepancies.push('the oracle file changed while the batch was running');
  if (ctx.outDir) writeEvidence(ctx.outDir, ev);
  return ev;
}

export function writeEvidence(outDir: string, ev: Evidence): void {
  mkdirSync(join(outDir, 'runs'), { recursive: true });
  const json = JSON.stringify(ev, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1);
  writeFileSync(join(outDir, 'runs', `${ev.run_id}.json`), json + '\n');
  appendFileSync(join(outDir, 'runs.jsonl'), JSON.stringify(ev, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n');
}

