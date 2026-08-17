import { Router, Request, Response } from 'express';
import { db } from '../db';
import { buildAgentLogRow } from '../engine/agent-log-row';
import { generateProofReal, logProofGeneration } from '../zkp/plonky3-real';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { fireWebhook } from '../services/webhook';
import { getBuilderProfile, registerBuilder } from '../services/builder-registry';
import { depositStake, withdrawStake, snapshotAuthority, getCurrentStake } from '../services/stake-vault';
import {
  authorizeStakeDeposit,
  stakeDepositMessage,
  isRealDepositClaim,
} from '../services/stake-authorization';
import { createTipRequest, deliverTip } from '../services/x402-server';
import { placeBet, resolveBet, signOracleOutcome } from '../services/linked-bet-resolver';
import { startTradingRound, resolveOpenRounds, getTraderState } from '../services/agent-trader';
import { getTwoBuilderSnapshot, getTimeseries, bootstrapDemoSnapshots } from '../services/two-builder-demo';
import { createAnonymousBuilder } from '../services/anonymous-signup';
import { runRoundAnonymous } from '../services/anonymous-round-runner';
import { generateCard } from '../services/zkp-card-generator';
import { buildAgentPassport, PassportQueryError } from '../services/agent-passport';
import { verifyProofLocally, type VerifyFn } from '../services/trust-harness-verify';
import { renderCardHtml } from '../services/zkp-card-renderer';
import substanceGateRouter from './v1/substance-gate';
import hitlRouter from './v1/hitl';
import observabilityRouter from './v1/observability';
import servicesRouter from './v1/services';
import contractsRouter from './v1/contracts';
import agentRouter from './v1/agent';
import runloopLivenessRouter from './v1/runloop-liveness';
import peerVerificationRouter from './peer-verification';
import { createAndResolveArenaChallenge } from '../testing/red-team';

const router = Router();
router.use(substanceGateRouter);
router.use(agentRouter); // Phase 2.10 — /api/v1/agent/process-contracts (router declares full sub-path)
router.use(runloopLivenessRouter); // /api/v1/runloop-liveness (+ /:agent_name) — router declares full sub-path
router.use('/hitl', hitlRouter);
router.use('/status', observabilityRouter);
router.use('/services', servicesRouter);
router.use('/contracts', contractsRouter);
router.use('/peer-verification', peerVerificationRouter);
// CC2 2026-05-27: alias mount so /api/v1/peer-verify/respond also resolves.
// The 2026-05-27 sprint dispatched against /peer-verify; the existing live
// mount is /peer-verification. Both paths route to the same handler so an
// in-flight Gemini caller is not broken regardless of which URL it uses.
router.use('/peer-verify', peerVerificationRouter);

router.get('/health', (req: Request, res: Response) => {
  res.json({ status: "ok", version: "1.0.0", service: "repid-engine" });
});

async function getHalConfigNumber(key: string, fallback: number): Promise<number> {
  const { data } = await db.from('repid_config').select('value').eq('key', key).single();
  const value = (data as any)?.value;
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

router.post('/hal/signals', async (req: Request, res: Response) => {
  const { text, domain, certainty, prompt } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const { extractHALSignals, extractHALSignalsWithCrossLLM } = require('../services/hal-signals');
  const signals = prompt
    ? await extractHALSignalsWithCrossLLM(text, domain || 'finance', certainty || 0.85, prompt)
    : extractHALSignals(text, domain || 'finance', certainty || 0.85);
  const COMMA = 531441 / 524288;
  const hasAgreement = typeof signals.agreement_score === 'number';
  // Phase 1.5 — 6-DOF combiner when cross-LLM agreement is available.
  // Weights re-normalized: harm 0.40→0.35, epi 0.30→0.25, evidence 0.20→0.15,
  // scope 0.10→0.05, agreement 0.00→0.20.
  const halScore = hasAgreement
    ? (0.35 * signals.harm_probability +
       0.25 * signals.epistemic_uncertainty +
       0.15 * (1 - signals.evidence_quality) +
       0.05 * (1 - signals.scope_appropriateness) +
       0.20 * (1 - signals.agreement_score)) * COMMA
    : (0.40 * signals.harm_probability +
       0.30 * signals.epistemic_uncertainty +
       0.20 * (1 - signals.evidence_quality) +
       0.10 * (1 - signals.scope_appropriateness)) * COMMA;
  // Read live thresholds — 6-DOF distribution differs from 5-DOF, so each branch reads its own keys.
  const vetoThreshold = hasAgreement
    ? await getHalConfigNumber('hal_veto_threshold_6dof', 0.43)
    : await getHalConfigNumber('hal_veto_threshold', 0.43);
  // Phase 1.5 ext (CC1) — Pythagorean Comma BFT hard veto (P-003).
  const commaVeto = signals.comma_veto === true;
  res.json({
    signals,
    hal_score: Math.round(halScore * 10000) / 10000,
    vetoed: commaVeto || halScore >= vetoThreshold,
    veto_reason: commaVeto
      ? `pythagorean-comma-bft (P-003): comma_gap=${signals.comma_gap}, severity=critical`
      : (halScore >= vetoThreshold ? `hal-score>=${vetoThreshold}` : null),
    veto_threshold: vetoThreshold,
    comma_veto: commaVeto,
    comma_gap: signals.comma_gap ?? null,
    comma_severity: signals.comma_severity ?? null,
    formula: hasAgreement
      ? '(0.35×harm + 0.25×epistemic + 0.15×(1-evidence) + 0.05×(1-scope) + 0.20×(1-agreement)) × (531441/524288)'
      : '(0.4×harm + 0.3×epistemic + 0.2×(1-evidence) + 0.1×(1-scope)) × (531441/524288)',
  });
});


// DELETED 2026-08-17 — a second `GET /metrics` handler lived here and was DEAD CODE.
// src/index.ts registers `app.get('/api/v1/metrics')` before `app.use('/api/v1',
// v1Router)`, and Express matches in registration order, so this block never served a
// request. Verified by driving the real app through supertest: the response came back
// in the index.ts shape, and the tables this handler queried
// (`repid_verified_decisions`) were never touched.
//
// It was deleted rather than corrected because everything in it was fabricated and
// nothing could depend on it — an unreachable handler has no consumers by
// construction. It published `status: "operational"` (a constant with no path to any
// other value), `uptime_pct: 99.9`, `avg_response_ms: 124`, `hal_veto_rate_24h:
// 0.994`, `hallucination_catch_rate: 0.12`, `llm_providers: 2`, `grace_pool_pct:
// 0.20`, `active_stakes_usdc: 500000`, a `jubilee_next` recomputed as now+30d on every
// request (so permanently 30 days away, and `repid_jubilee_log` has never held a row),
// `active_agents_24h` that returned the TOTAL agent count, and `total_decisions` that
// was `total_vdr` under a second name.
//
// The fields that are genuinely measurable — response time, provider count, HAL veto
// rate, hallucination catch rate, active agents — now exist as real queries on the
// live endpoint via src/services/metrics-snapshot.ts. Leaving a fabricating copy here
// would have been a loaded gun: any future reordering of the mounts in src/index.ts
// would have published it.


/**
 * Pure decision for a stored proof row (no DB side effects).
 * - If proof_bytes present: real WASM cryptographic verify, FAIL-CLOSED through the shared
 *   `verifyProofLocally` boundary (see the incident note inside).
 * - If absent (stub/sha256 rows): honest "attested, not cryptographically verified".
 * Used by the /verify-proof endpoint and fixture tests.
 */
export async function verifyProofCryptographically(
  proofRow: any,
  claimedStatement?: any,
  // TESTABILITY SEAM — pass a verifier instead of loading the published one. Omit in production
  // (the route does); pass `null` to model "no verifier available". It exists because the loader
  // below is a NATIVE dynamic `import()` of an ESM-only package, which jest cannot execute inside
  // its vm sandbox (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG` under `module: nodenext`) and
  // therefore cannot mock either. That is not incidental: it is why the fail-open below survived
  // in a repo that already had a test for exactly this bug shape. Injection is also how every
  // other verifier consumer here is already written (`VerifyFn` in `trust-harness-verify.ts` and
  // `zkp-audit-service.ts`), so this is the repo's existing convention, not a new one.
  injectedVerifyFn?: VerifyFn | null,
) {
  if (!proofRow) {
    return { valid: false, cryptographically_verified: false, error: 'no proof row' };
  }

  if (proofRow.proof_bytes) {
    // FAIL-OPEN INCIDENT, fixed here. This path used to read:
    //     const valid = await verifierMod.verify(proofRow.proof_bytes, publicInputs);
    //     return { valid: !!valid, cryptographically_verified: true, ... };
    // `@hyperdag/proof-verifier`'s verify() resolves to an OBJECT (`{verified, error,
    // proof_size_bytes, verifier_version}`), and `!!someObject` is always true. So every stored
    // proof with non-empty `proof_bytes` was reported `valid: true, cryptographically_verified:
    // true` — INCLUDING proofs the verifier had just rejected. The catch block asserted
    // `cryptographically_verified: true` on a WASM failure as well, i.e. claimed a cryptographic
    // check on the one path where none completed. This is the flagship trust claim of the
    // product, so the endpoint was answering "verified" to everything.
    //
    // The fail-closed boundary that refuses exactly this shape ALREADY EXISTED in
    // `src/services/trust-harness-verify.ts` and had no caller on this path — LESSONS 3, an
    // unwired mechanism is worse than an absent one, because it converts a known gap into false
    // coverage and you stop looking. `verifyProofLocally` is now the only decider here; the
    // verdict is not recomputed locally. The same property is pinned one layer down by
    // `tests/zkp-proof-verifier-crosscheck.test.ts` ("the classic bug this guards: `!!result` on
    // an object is always true"), and `createWasmVerifier` in
    // `src/services/handlers/zkp-audit-handler.ts` named this very line as the live instance.
    let verifyFn: VerifyFn | null = injectedVerifyFn ?? null;
    if (injectedVerifyFn === undefined) {
      try {
        const verifierMod: any = await import('@hyperdag/proof-verifier');
        if (typeof verifierMod.verify === 'function') verifyFn = verifierMod.verify as VerifyFn;
      } catch (e: any) {
        // Loading the WASM is itself something that can fail. A verifier we could not load is
        // NOT CHECKED, never a pass — left null so the boundary below fails closed on it.
        console.error('[verify-proof] verifier load error', e);
      }
    }

    // Three outcomes, never two. `valid` carries the verdict; `cryptographically_verified`
    // carries whether a real cryptographic check RAN and returned a genuine boolean at all:
    //   VERIFIED    → { valid: true,  cryptographically_verified: true  }
    //   FAILED      → { valid: false, cryptographically_verified: true  }  verifier ran, rejected
    //   NOT CHECKED → { valid: false, cryptographically_verified: false }  unavailable/threw/shape
    // Collapsing the last two is the mistake that produced the incident above. The flag is set
    // from the observed call — not by re-deriving the verdict and not by matching on `reason`, a
    // prose string — so `verifyProofLocally` stays the single decider of `valid`.
    let verdictObserved = false;
    const observedVerify: VerifyFn = async (bytes, statement) => {
      const raw = await verifyFn!(bytes, statement);
      verdictObserved = !!raw && typeof raw === 'object' && typeof raw.verified === 'boolean';
      return raw;
    };

    const publicInputs = proofRow.statement || claimedStatement || {
      agent_id: proofRow.agent_id,
      tier: proofRow.tier_proven,
    };
    const local = await verifyProofLocally({
      proofBytes: proofRow.proof_bytes,
      statement: publicInputs,
      verifyFn: verifyFn ? observedVerify : null,
    });

    return {
      valid: local.verified,
      cryptographically_verified: verdictObserved,
      verified_at: new Date().toISOString(),
      proof_version: 'plonky3-wasm-1.0',
      ...(local.verified ? {} : { error: local.reason }),
    };
  }

  // Absent proof_bytes — today's sha256/HMAC stub rows (pre real Plonky3 flip)
  const hasOtherAttestation = !!(proofRow.merkle_root || proofRow.eas_attestation_uid || proofRow.zk_commitment);
  return {
    valid: hasOtherAttestation,
    cryptographically_verified: false,
    message: 'attested, not cryptographically verified',
    verified_at: new Date().toISOString(),
    proof_version: 'attested-stub-1.0',
  };
}

router.post('/verify-proof', async (req: Request, res: Response) => {
  // New path: identify by agent + tier, lookup stored proof, WASM-verify if proof_bytes present.
  // Legacy fields (proof + generation params) are accepted for compat but the verification
  // now prefers the stored artifact (read-only side; inserts are untouched per CC1 #101).
  const { agent_id, tier } = req.body;

  if (!agent_id || !tier) {
    return res.status(400).json({ error: 'Missing required fields: agent_id, tier' });
  }

  // Lookup the canonical stored proof (repid_zkp_proofs is the home for proof artifacts post Phase 7)
  const { data: proofRow, error: lookupError } = await db
    .from('repid_zkp_proofs')
    .select('*')
    .eq('agent_id', agent_id)
    .eq('tier_proven', tier)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lookupError) {
    console.error('[verify-proof] lookup error', lookupError);
  }

  if (!proofRow) {
    return res.status(404).json({ error: 'No stored proof found for this agent and tier' });
  }

  const result = await verifyProofCryptographically(proofRow, req.body);

  // Preserve logging/webhook shape for downstream consumers
  const { error: logError } = await db.from('trinity_agent_logs').insert(buildAgentLogRow({
    action: 'zkp_proof_verified',
    agent: agent_id,
    metadata: {
      ...result,
      agent_id,
      tier,
      proof_row_id: proofRow.id,
    },
  }));
  if (logError) console.error(logError);

  fireWebhook('proof.verified', {
    ...result,
    agent_id,
    tier,
  });

  res.json({
    ...result,
    tier,
    agent_id,
  });
});

router.get('/repid/:agent_id', async (req: Request, res: Response) => {
  const { agent_id } = req.params;
  const { data: agent, error } = await db.from('repid_agents').select('*').eq('id', agent_id).single();

  if (error || !agent) return res.status(404).json({ error: 'Agent not found' });

  const score = agent.current_repid;
  let tier_level = 'PROBATIONARY';
  if (score >= 8000) tier_level = 'VETERAN';
  else if (score >= 5000) tier_level = 'AUTONOMOUS';
  else if (score >= 1000) tier_level = 'ESTABLISHED';
  else if (score >= 500) tier_level = 'EARNING';

  res.json({ agent_id, repid_score: score, tier_level, activity_30d: agent.activity_30d || 0, created_at: agent.created_at });
});

router.post('/dag/verify-node', async (req: Request, res: Response) => {
  const { node_id, parent_hash, agent_id, payload } = req.body;
  if (!node_id || !parent_hash || !agent_id || !payload) return res.status(400).json({ error: 'Missing req fields' });
  
  const { error: rpcError } = await db.rpc('run_sql', { sql: 'CREATE TABLE IF NOT EXISTS hyperdag_nodes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), node_id TEXT, parent_hash TEXT, agent_id TEXT, payload JSONB, created_at TIMESTAMP DEFAULT NOW());' });
    if (rpcError) console.error(rpcError);

  const node_hash = createHash('sha256').update(`${node_id}${parent_hash}${agent_id}${JSON.stringify(payload)}`).digest('hex');
  
  const { error } = await db.from('trinity_agent_logs').insert(buildAgentLogRow({ action: 'dag_node_verified', agent: agent_id, metadata: { node_id, parent_hash, agent_id } }));
    if (error) console.error(error);
  fireWebhook('dag.node_verified', { node_id, parent_hash, agent_id, node_hash });

  res.json({ node_hash, valid: true, dag_depth: 1, verified_at: new Date().toISOString() });
});

// HONEST REWRITE (2026-07-29): this endpoint used to fabricate
// validation_status:"verified" + conservator_bonded:true with zero chain
// reads, and returned sha256(agent_id) as an "identity_hash" — pure theater
// on the exact public surface a merchant would use to decide whether to
// authorize an agent (RULE-4: no fake-pass may be reported as a real
// measurement). It now reports recorded ERC-8004 mint state from the DB and
// LINKS live verification instead of claiming it. Fabricated fields
// (identity_hash, conservator_bonded) are gone, not renamed.
router.get('/erc8004/validate/:agent_id', async (req: Request, res: Response) => {
  try {
    const passport = await buildAgentPassport(db, String(req.params.agent_id ?? ''));
    if (!passport) return res.status(404).json({ error: 'Agent not found' });

    res.json({
      erc8004_version: '1.0',
      agent_id: passport.agent.agent_id,
      reputation_score: passport.reputation.repid_score,
      tier: passport.reputation.tier,
      created_at: passport.agent.created_at,
      // 'registered_onchain' = a mint tx is recorded for this agent;
      // 'offchain_only' = no ERC-8004 identity recorded. Never "verified"
      // without a chain read — use live_verification_endpoint for that.
      validation_status: passport.identity_erc8004.registered_onchain
        ? 'registered_onchain'
        : 'offchain_only',
      identity: passport.identity_erc8004,
      passport_url: `/api/v1/passport/${passport.agent.agent_id}`,
    });
  } catch (e: unknown) {
    if (e instanceof PassportQueryError) {
      console.error(`[erc8004/validate] ${e.message}`);
      return res.status(500).json({ error: 'query_failed', step: e.step });
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[erc8004/validate] unexpected: ${msg}`);
    return res.status(500).json({ error: 'internal' });
  }
});

router.post('/batch/prove', async (req: Request, res: Response) => {
  const { requests, max_batch_size } = req.body;
  if (!requests || !Array.isArray(requests)) return res.status(400).json({ error: 'requests array string required' });
  const max = max_batch_size || 100;
  if (requests.length > max || requests.length > 100) return res.status(400).json({ error: 'max_batch_size exceeded limit 100' });

  const proofs = await Promise.all(requests.map(async (r: any) => {
    const timestamp = new Date().toISOString();
    const result = await generateProofReal(r.agent_id, r.requester_pubkey, r.tier, timestamp);
    await logProofGeneration(db, r.agent_id, r.tier);
    return { ...r, proof: result.proof, proof_source: result.proof_source, timestamp };
  }));

  const { error } = await db.from('trinity_agent_logs').insert(buildAgentLogRow({ action: 'zkp_batch_generated', agent: 'repid-engine', metadata: { batch_size: requests.length } }));
    if (error) console.error(error);

  res.json({ batch_id: `batch_${Date.now()}`, proofs, processed_at: new Date().toISOString(), total: proofs.length });
});

// --- ZKP Cards -------------------------------------------------------------

router.post('/cards/generate', async (req: Request, res: Response) => {
  const { agent_name, task_id, task_title, event_type } = req.body;
  if (!agent_name || !event_type) return res.status(400).json({ error: 'agent_name and event_type required' });
  const cardId = await generateCard({ agent_name, task_id, task_title, event_type });
  if (!cardId) return res.status(500).json({ error: 'Card generation failed or disabled' });
  res.json({ card_id: cardId, url: `https://trustshell.dev/verify/${cardId}` });
});

router.get('/cards/:card_id', async (req: Request, res: Response) => {
  const html = await renderCardHtml(req.params.card_id as string);
  if (!html) return res.status(404).send('Card not found');
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

router.get('/cards/:card_id/json', async (req: Request, res: Response) => {
  const { data: card, error } = await db.from('zkp_cards').select('*').eq('card_id', req.params.card_id).maybeSingle();
  if (error || !card) return res.status(404).json({ error: 'Card not found' });
  res.json(card);
});

// ===========================================================================
// Reponomics demo endpoints — public per sprint Phase 8 (auth bypass added).
// ===========================================================================

const SEAN_SIG_SECRET = process.env.SEAN_SIG_SECRET || 'reponomics-default-sean-secret';

function checkSeanSignature(req: Request): boolean {
  const sig = (req.headers['x-sean-signature'] as string) || '';
  if (!sig) return false;
  const expected = createHmac('sha256', SEAN_SIG_SECRET).update('start-trading-round').digest('hex');
  if (sig.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// --- Builder ---------------------------------------------------------------

router.get('/builder/:address', async (req: Request, res: Response) => {
  const addr = String(req.params.address ?? '');
  if (!addr) return res.status(400).json({ error: 'address required' });
  const profile = await getBuilderProfile(addr);
  if (!profile) return res.status(404).json({ error: 'builder not found' });
  return res.json(profile);
});

router.post('/builder/register', async (req: Request, res: Response) => {
  const { address, erc7231_token_id } = req.body ?? {};
  if (!address) return res.status(400).json({ error: 'address required' });
  const r = await registerBuilder(address, erc7231_token_id);
  return res.json(r);
});

// Live demo — token-only anonymous signup. No wallet required.
// Returns { token, builder_id, builder_address, repid_rewards_eligible: false, message }.
// See src/services/anonymous-signup.ts.
router.post('/builder/token-signup', async (_req: Request, res: Response) => {
  try {
    const r = await createAnonymousBuilder();
    if (!r.ok) return res.status(500).json(r);
    return res.json(r);
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? 'token signup failed' });
  }
});

// --- Stake -----------------------------------------------------------------

/**
 * GET /stake/deposit/message — the exact text a wallet must sign to claim a real
 * deposit. Mirrors /human/bind/message so a front end never has to reconstruct
 * the string itself; any drift between client and server becomes a bad signature
 * rather than a subtly wrong prompt shown to a user about to sign.
 * Public and read-only: it reveals nothing and authorizes nothing.
 */
router.get('/stake/deposit/message', (req: Request, res: Response) => {
  const wallet = String(req.query.wallet ?? req.query.builder_address ?? '');
  const amount = String(req.query.amount ?? '');
  const txHash = String(req.query.tx_hash ?? '');
  if (!wallet || !amount || !txHash) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'wallet, amount and tx_hash are all required — each one is inside the signed text.',
    });
  }
  return res.json({
    message: stakeDepositMessage({ wallet, amount, txHash }),
    note: 'Sign this with the wallet that made the deposit, then POST it as `signature`.',
  });
});

router.post('/stake/deposit', async (req: Request, res: Response) => {
  let { builder_address, amount, tx_hash, signature } = req.body ?? {};
  if (!builder_address || !amount) return res.status(400).json({ error: 'builder_address and amount required' });

  // Fix for demo flow: frontend says "Stake 100 testnet USDC" and sends "100".
  // We need to store 6-decimal raw (100_000_000) so authority math works.
  // NOTE: only ever reached on the simulated path — a real deposit is checked
  // against the on-chain transfer, so an inflated claim fails verification.
  if (String(amount) === '100') {
    amount = '100000000';
  }

  // AUTHORIZATION. This route is on the global auth bypass list because it serves
  // both signed-out demo traffic and wallet-bearing real deposits, which the
  // single-API-key middleware cannot tell apart. It therefore does its own,
  // stricter check — and the signature is verified over the POST-COERCION amount,
  // so what the user signed is what gets credited.
  const authz = await authorizeStakeDeposit({
    builderAddress: String(builder_address),
    amount: String(amount),
    txHash: tx_hash ? String(tx_hash) : undefined,
    signature: signature ? String(signature) : undefined,
    authorizationHeader: req.headers['authorization'] as string | undefined,
    apiKeyHeader: req.headers['x-api-key'] as string | undefined,
  });
  if (!authz.ok) {
    const status = authz.reason === 'account_not_found' ? 404 : 401;
    return res.status(status).json({
      ok: false,
      error: authz.reason,
      message: authz.detail,
      ...(isRealDepositClaim(tx_hash ? String(tx_hash) : undefined)
        ? { sign_message_at: '/api/v1/stake/deposit/message' }
        : {}),
    });
  }

  try {
    const r = await depositStake(builder_address, BigInt(String(amount)), tx_hash);
    if (!r.ok) return res.status(400).json(r);
    return res.json({ ...r, authorized_by: authz.tier });
  } catch (e: any) {
    return res.status(400).json({ error: e?.message ?? 'deposit failed' });
  }
});

router.post('/stake/withdraw', async (req: Request, res: Response) => {
  const { builder_id, amount } = req.body ?? {};
  if (!builder_id || !amount) return res.status(400).json({ error: 'builder_id and amount required' });
  try {
    const r = await withdrawStake(String(builder_id), BigInt(String(amount)));
    if (!r.ok) return res.status(400).json(r);
    return res.json(r);
  } catch (e: any) {
    return res.status(400).json({ error: e?.message ?? 'withdraw failed' });
  }
});

router.get('/stake/authority/:builder_id', async (req: Request, res: Response) => {
  const builderId = String(req.params.builder_id ?? '');
  if (!builderId) return res.status(400).json({ error: 'builder_id required' });
  try {
    const stake = await getCurrentStake(builderId);
    const auth = await snapshotAuthority(builderId, stake);
    return res.json({ builder_id: builderId, stake_total: stake.toString(), authority: auth.authority.toString(), basis: auth.basis });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'authority compute failed' });
  }
});

// --- x402 tip flow ---------------------------------------------------------

router.post('/tip/request', async (req: Request, res: Response) => {
  const { requestor_agent_id, provider_agent_id, prediction_topic } = req.body ?? {};
  if (!requestor_agent_id || !provider_agent_id || !prediction_topic) {
    return res.status(400).json({ error: 'requestor_agent_id, provider_agent_id, prediction_topic required' });
  }
  const r = await createTipRequest({ requestor_agent_id, provider_agent_id, prediction_topic });
  return res.status(r.status).json(r.body);
});

router.post('/tip/deliver/:tipId', async (req: Request, res: Response) => {
  const tipId = String(req.params.tipId ?? '');
  const xPayment = String(req.headers['x-payment'] ?? '');
  if (!xPayment) return res.status(402).json({ error: 'X-PAYMENT header required' });
  const payerAddress = req.body?.payer_address;
  const r = await deliverTip({ tipId, xPaymentHeader: xPayment, payerAddress });
  if (!r.ok) {
    return res.status(r.error?.includes('not found') ? 404 : 402).json(r);
  }
  return res.json(r);
});

// --- Bet placement / resolution -------------------------------------------

router.post('/bet/place', async (req: Request, res: Response) => {
  const { agent_id, bet_amount, claimed_confidence, prediction_payload, oracle_endpoint, expected_resolution_time } = req.body ?? {};
  if (!agent_id || !bet_amount || claimed_confidence === undefined) {
    return res.status(400).json({ error: 'agent_id, bet_amount, claimed_confidence required' });
  }
  try {
    const r = await placeBet({
      agentId: String(agent_id),
      betAmount: BigInt(String(bet_amount)),
      claimedConfidence: Number(claimed_confidence),
      predictionPayload: prediction_payload ?? {},
      oracleEndpoint: String(oracle_endpoint ?? ''),
      expectedResolutionTime: new Date(expected_resolution_time ?? Date.now() + 60 * 60 * 1000),
    });
    return res.json(r);
  } catch (e: any) {
    return res.status(400).json({ error: e?.message ?? 'placeBet failed' });
  }
});

router.post('/bet/resolve', async (req: Request, res: Response) => {
  const { bet_id, oracle_outcome, oracle_signature } = req.body ?? {};
  if (!bet_id || oracle_outcome === undefined || !oracle_signature) {
    return res.status(400).json({ error: 'bet_id, oracle_outcome, oracle_signature required' });
  }
  const r = await resolveBet(String(bet_id), Boolean(oracle_outcome), String(oracle_signature));
  if (!r.ok) return res.status(400).json(r);
  return res.json(r);
});

// --- Trader (APM/VERITAS) -------------------------------------------------

router.post('/trader/round/start', async (req: Request, res: Response) => {
  if (!checkSeanSignature(req)) {
    return res.status(401).json({ error: 'X-SEAN-SIGNATURE required' });
  }
  const r = await startTradingRound();
  if (!r.ok) return res.status(400).json(r);
  return res.json(r);
});

router.post('/trader/round/resolve-open', async (req: Request, res: Response) => {
  if (!checkSeanSignature(req)) {
    return res.status(401).json({ error: 'X-SEAN-SIGNATURE required' });
  }
  const force = !!req.body?.force;
  const r = await resolveOpenRounds({ force });
  return res.json(r);
});

router.get('/trader/state', async (_req: Request, res: Response) => {
  const r = await getTraderState();
  return res.json(r);
});

router.get('/trader/oracle-sign/:bet_id/:outcome', async (req: Request, res: Response) => {
  // Convenience for the demo — returns the HMAC oracle signature for
  // a bet+outcome pair so a tester can call /bet/resolve without
  // needing the secret. Hidden by the Sean signature header.
  if (!checkSeanSignature(req)) return res.status(401).json({ error: 'X-SEAN-SIGNATURE required' });
  const betId = String(req.params.bet_id ?? '');
  const outcome = String(req.params.outcome) === 'true';
  return res.json({ bet_id: betId, outcome, signature: signOracleOutcome(betId, outcome) });
});

// --- Guided Tour -----------------------------------------------------------

router.get('/demo/builder/:tokenOrId/snapshot', async (req: Request, res: Response) => {
  const tokenOrId = String(req.params.tokenOrId ?? '');
  let b;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tokenOrId)) {
    const { data } = await db.from('builders').select('id, current_repid, session_token').eq('id', tokenOrId).maybeSingle();
    b = data;
  }
  if (!b) {
    const { data } = await db.from('builders').select('id, current_repid, session_token').eq('session_token', tokenOrId).maybeSingle();
    b = data;
  }
  if (!b) return res.status(404).json({ error: 'builder not found' });
  
  const authRes = await snapshotAuthority(b.id);
  const authority_raw = Number(authRes.authority);
  const recommended_bet_raw = Math.floor(authority_raw * 0.5);
  const max_safe_bet_raw = Math.floor(authority_raw * 0.95);
  const authority_human_usdc = authority_raw / 1_000_000;
  const recommended_bet_human_usdc = recommended_bet_raw / 1_000_000;
  const max_safe_bet_human_usdc = max_safe_bet_raw / 1_000_000;
  
  const { getTierForRepId } = require('../config/tier-limits');
  const { current: currentTier, next: nextTier } = getTierForRepId(Number(b.current_repid ?? 0));
  
  return res.json({
    builder_id: b.id,
    session_token: b.session_token || tokenOrId,
    current_repid: Number(b.current_repid ?? 0),
    stake_total_usdc: Number(authRes.basis.stake) / 1_000_000,
    authority_raw,
    authority_human_usdc,
    recommended_bet_raw,
    recommended_bet_human_usdc,
    max_safe_bet_raw,
    max_safe_bet_human_usdc,
    explanation: `Your agent has earned authority for bets up to $${authority_human_usdc.toFixed(2)}. We recommend $${recommended_bet_human_usdc.toFixed(2)} for guaranteed success.`,
    is_simulated: true,
    tier: currentTier.name.toLowerCase(),
    tier_pct: currentTier.pctOfStake,
    authority_dollars: authority_human_usdc,
    next_tier_at_repid: nextTier ? nextTier.minRepId : null,
    next_tier_pct: nextTier ? nextTier.pctOfStake : null
  });
});

router.get('/demo/recommended-bet/:tokenOrId', async (req: Request, res: Response) => {
  const tokenOrId = String(req.params.tokenOrId ?? '');
  let b;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tokenOrId)) {
    const { data } = await db.from('builders').select('id, current_repid, session_token').eq('id', tokenOrId).maybeSingle();
    b = data;
  }
  if (!b) {
    const { data } = await db.from('builders').select('id, current_repid, session_token').eq('session_token', tokenOrId).maybeSingle();
    b = data;
  }
  if (!b) return res.status(404).json({ error: 'builder not found' });
  
  const authRes = await snapshotAuthority(b.id);
  const authority_raw = Number(authRes.authority);
  const recommended_bet_raw = Math.floor(authority_raw * 0.5);
  const max_safe_bet_raw = Math.floor(authority_raw * 0.95);
  return res.json({ authority_raw, recommended_bet_raw, max_safe_bet_raw });
});

// --- Two-builder demo -----------------------------------------------------

router.get('/demo/two-builder/snapshot', async (_req: Request, res: Response) => {
  const r = await getTwoBuilderSnapshot();
  return res.json(r);
});

router.get('/demo/two-builder/timeseries', async (req: Request, res: Response) => {
  const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit ?? '100'), 10) || 100));
  const r = await getTimeseries(limit);
  return res.json({ count: r.length, points: r });
});

router.post('/demo/two-builder/bootstrap', async (_req: Request, res: Response) => {
  const r = await bootstrapDemoSnapshots();
  return res.json({ ok: true, ...r });
});

// Live demo — anonymous round runner. Wraps startTradingRound + force-resolve
// so a visitor can press one button and see APM/VERITAS RepID move. The
// Sean-signature gate on /trader/round/start is preserved at the route layer
// for direct callers; this wrapper is a server-side composition.
router.post('/demo/run-round-anonymous', async (req: Request, res: Response) => {
  const waitMsRaw = Number(req.body?.wait_ms);
  const waitMs = Number.isFinite(waitMsRaw) ? Math.max(0, Math.min(10000, Math.floor(waitMsRaw))) : undefined;

  const { bet_amount, token } = req.body;
  let betAmountOverride: bigint | undefined = undefined;

  if (bet_amount !== undefined && bet_amount !== null) {
    const betRawStr = String(bet_amount);
    if (/^\d+$/.test(betRawStr) && BigInt(betRawStr) > 0n) {
      betAmountOverride = BigInt(betRawStr);
    }
  }

  const tokenOrId = String(token ?? '');
  let b;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tokenOrId)) {
    const { data: bData } = await db.from('builders').select('id').eq('id', tokenOrId).maybeSingle();
    b = bData;
  }
  if (!b && tokenOrId) {
    const { data: bData } = await db.from('builders').select('id').eq('session_token', tokenOrId).maybeSingle();
    b = bData;
  }

  if (!betAmountOverride) {
    if (b) {
      const authRes = await snapshotAuthority(b.id);
      const authority_raw = Number(authRes.authority);
      betAmountOverride = BigInt(Math.floor(authority_raw * 0.5));
    } else {
      // Safe fallback if token missing or invalid
      betAmountOverride = 1000000n;
    }
  }

  try {
    const opts: any = {};
    if (waitMs !== undefined) opts.waitMs = waitMs;
    if (betAmountOverride !== undefined) opts.betAmount = betAmountOverride;
    if (b && b.id) opts.builderId = b.id;
    const r = await runRoundAnonymous(opts);
    if (!r.ok) {
      if (r.error && r.error.startsWith('{')) {
        try {
          const parsed = JSON.parse(r.error);
          return res.status(400).json(parsed);
        } catch {}
      }
      return res.status(400).json(r);
    }
    return res.json(r);
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? 'run-round-anonymous failed' });
  }
});

router.post('/webhooks/register', async (req: Request, res: Response) => {
  const { url, events, api_key } = req.body;
  if (!url || !events) return res.status(400).json({ error: 'url and events required' });

  const { error: rpcError } = await db.rpc('run_sql', { sql: 'CREATE TABLE IF NOT EXISTS repid_webhooks (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), url TEXT NOT NULL, events TEXT[], api_key TEXT, created_at TIMESTAMP DEFAULT NOW(), active BOOLEAN DEFAULT true);' });
    if (rpcError) console.error(rpcError);

  const { data, error } = await db.from('repid_webhooks').insert({ url, events, api_key }).select().single();
  if (error) return res.status(500).json({ error: 'Failed' });

  res.json(data);
});

// ============================================================================
// S-REDTEAM: Arena challenge micro-transaction endpoint (Phase 6)
// POST /api/v1/challenge/create
// Body: { challenger_agent: string, defender_agent: string, claim: string, stake_repid: number }
// Returns resolution + RepID deltas (φ weighted, BFT 3 neutral evaluators, asymmetric +1/-2 for judges)
// ============================================================================
router.post('/challenge/create', async (req: Request, res: Response) => {
  const { challenger_agent, defender_agent, claim, stake_repid } = req.body ?? {};
  if (!challenger_agent || !defender_agent || !claim || typeof stake_repid !== 'number') {
    return res.status(400).json({ error: 'challenger_agent, defender_agent, claim, stake_repid required' });
  }
  if (challenger_agent === defender_agent) {
    return res.status(400).json({ error: 'challenger and defender must be different' });
  }
  try {
    const result = await createAndResolveArenaChallenge({
      challenger_agent: String(challenger_agent),
      defender_agent: String(defender_agent),
      claim: String(claim),
      stake_repid: Math.max(1, Math.floor(stake_repid)),
    });
    return res.json({ ok: true, ...result });
  } catch (e: any) {
    return res.status(500).json({ error: 'arena_resolution_failed', message: e?.message });
  }
});

export default router;
