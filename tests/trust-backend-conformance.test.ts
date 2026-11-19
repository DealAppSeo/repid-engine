/**
 * scripts/trust-backend-conformance.mjs, run offline.
 *
 * NO PRODUCTION DATA IS COMMITTED HERE (the #376 fence). Every answer the script reads is BUILT in this file
 * from the repo's SYNTHETIC range-check proof (tests/fixtures/zkp/leaf-rangecheck.synthetic.json): a real
 * Plonky3 proof over a made-up agent id and score. So the "published verifier, run locally" leg checks real
 * proof bytes, and nothing here was lifted from a live system.
 *
 * The good set must pass. Each planted defect changes ONE answer the way a real fault would, and the run must
 * go red on the leg that owns it. A checker that cannot fail has measured nothing; the planted cases are the
 * point of this file.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCRIPT = join(__dirname, '..', 'scripts', 'trust-backend-conformance.mjs');
const ZKP = join(__dirname, 'fixtures', 'zkp');
const meta = JSON.parse(readFileSync(join(ZKP, 'leaf-rangecheck.synthetic.json'), 'utf8'));
const ST = meta.statement as { agent_id: string; tier: string; repid_score: number; threshold: number };
const PROOF_B64 = readFileSync(join(ZKP, meta.proof_file)).toString('base64');
const REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e'; // the public ERC-8004 IdentityRegistry address the script pins

type Answers = Record<string, { status: number; json: any }>;
/** A consistent, entirely made-up backend: every answer agrees with the synthetic statement. */
function answers(): Answers {
  const ok = (json: any) => ({ status: 200, json });
  return {
    health: ok({ status: 'ok', deployed_commit: '0'.repeat(40), supabaseConnected: true }),
    repid: ok({ score: ST.repid_score, tier: ST.tier }),
    passport: ok({ agent: { agent_id: ST.agent_id, agent_name: 'synthetic-agent' }, reputation: { repid_score: ST.repid_score, tier: ST.tier },
      identity_erc8004: { token_id: '1' }, onchain: { registry: REGISTRY, owner: '0x' + 'a'.repeat(40) } }),
    proof: ok({ scheme: meta.scheme, proof_bytes: PROOF_B64, statement: { ...ST } }),
    verify_real: ok({ verified: true, scheme: meta.scheme }),
    verify_altered: ok({ verified: false, scheme: meta.scheme, error: 'made-up refusal' }),
    erc8004: ok({ agent_id: ST.agent_id, reputation_score: ST.repid_score, tier: ST.tier, validation_status: 'registered_onchain' }),
    reputation_onchain: ok({ token_id: '1', feedback_count: 2, contract: '0x' + 'b'.repeat(40) }),
    receipt: ok({ contract_id: 'made-up-contract', settlement_tx: '0x' + 'c'.repeat(64), is_simulated: false, zk_proofs: [{ is_real: true }], reputation_events: [{ delta: 1 }] }),
    hal_known: ok({ decision: 'vetoed', hal_score: 1 }),
    hal_abstain: ok({ decision: 'flagged', hal_score: 0.5 }),
  };
}
type Leg = { name: string; outcome: 'VERIFIED' | 'NOT_CHECKED' | 'FAILED'; detail: string };
function run(a: Answers): { code: number | null; legs: Leg[]; verified: number; failed: number; failedNames: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'conformance-'));
  for (const [k, v] of Object.entries(a)) writeFileSync(join(dir, `${k}.json`), JSON.stringify(v));
  const r = spawnSync(process.execPath, [SCRIPT, '--offline', dir, '--json'], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  const out = JSON.parse(r.stdout);
  return { code: r.status, legs: out.legs, verified: out.verified, failed: out.failed, failedNames: out.legs.filter((l: Leg) => l.outcome === 'FAILED').map((l: Leg) => l.name) };
}
const planted = (change: (a: Answers) => void) => { const a = answers(); change(a); return run(a); };

describe('trust backend conformance (offline, synthetic answers)', () => {
  it('a consistent backend passes: every leg with an answer is VERIFIED, nothing FAILED', () => {
    const r = run(answers());
    expect(r.failedNames).toEqual([]);
    expect(r.code).toBe(0);
    const verified = r.legs.filter((l) => l.outcome === 'VERIFIED').map((l) => l.name);
    for (const name of ['health', 'repid', 'passport', 'zk proof read', 'zk verify (this API, real proof)', 'zk verify (this API, altered statement)',
      'zk verify (published verifier, run locally)', 'erc8004 validate', 'reputation on chain (as the API reports it)', 'public receipt', 'HAL (known false claim)', 'HAL (unknowable claim)'])
      expect(verified).toContain(name);
    // what cannot run offline says so; it is never counted as a pass
    expect(r.legs.find((l) => l.name === 'chain readback')?.outcome).toBe('NOT_CHECKED');
    expect(r.legs.find((l) => l.name === 'settlement on chain')?.outcome).toBe('NOT_CHECKED');
  });

  it.each<[string, (a: Answers) => void, string]>([
    ['a proof that belongs to another agent', (a) => { a.proof.json.statement.agent_id = '00000000-0000-4000-8000-0000000000bb'; }, 'zk proof read'],
    ['a proof whose statement is false', (a) => { a.proof.json.statement.threshold = ST.repid_score + 1; }, 'zk proof read'],
    ['a verifier that ACCEPTS an altered statement', (a) => { a.verify_altered.json.verified = true; }, 'zk verify (this API, altered statement)'],
    ['a verifier that refuses its own real proof', (a) => { a.verify_real.json.verified = false; }, 'zk verify (this API, real proof)'],
    ['served proof bytes the published verifier rejects', (a) => { const b = Buffer.from(PROOF_B64, 'base64'); b[100] ^= 1; a.proof.json.proof_bytes = b.toString('base64'); }, 'zk verify (published verifier, run locally)'],
    ['a tier above what the score allows', (a) => { a.repid.json.tier = 'VETERAN'; }, 'repid'],
    ['a passport that disagrees with /repid on the score', (a) => { a.passport.json.reputation.repid_score += 7; }, 'passport'],
    ['a passport that names its own registry', (a) => { a.passport.json.onchain.registry = '0x' + '1'.repeat(40); }, 'passport'],
    ['an ERC-8004 view for a different agent', (a) => { a.erc8004.json.agent_id = '00000000-0000-4000-8000-0000000000bb'; }, 'erc8004 validate'],
    ['an on-chain record for a different token', (a) => { a.reputation_onchain.json.token_id = '2'; }, 'reputation on chain (as the API reports it)'],
    ['a receipt listing a proof that is not real', (a) => { a.receipt.json.zk_proofs[0].is_real = false; }, 'public receipt'],
    ['a receipt with an empty proof list', (a) => { a.receipt.json.zk_proofs = []; }, 'public receipt'],
    ['an engine that reports itself unhealthy', (a) => { a.health.json.status = 'degraded'; }, 'health'],
    ['a known-false claim that comes back clean', (a) => { a.hal_known.json.decision = 'clean'; }, 'HAL (known false claim)'],
  ])('planted: %s -> exit 1 on the leg that owns it', (_what, change, leg) => {
    const r = planted(change);
    expect(r.code).toBe(1);
    expect(r.failedNames).toContain(leg);
  });

  it('a proof whose claim the CURRENT score no longer meets is FAILED, even though every view agrees', () => {
    const r = planted((a) => { // the agent's score fell below the proved threshold after the proof was made
      const now = ST.threshold - 1;
      a.repid.json = { score: now, tier: 'EARNING' };
      a.passport.json.reputation = { repid_score: now, tier: 'EARNING' };
      a.erc8004.json.reputation_score = now; a.erc8004.json.tier = 'EARNING';
    });
    expect(r.code).toBe(1);
    expect(r.failedNames).toEqual(['zk proof read']);
  });

  it('HAL: three checkers answering UNCERTAIN must not be a veto', () => {
    // The route's reply for an unknowable claim under code defaults, measured 2026-11-19: vetoed at exactly 0.5,
    // every provider UNCERTAIN. With HAL_VERDICT_DRIVEN_VETO=true the same claim comes back flagged (the good set).
    const r = planted((a) => { a.hal_abstain.json = { decision: 'vetoed', hal_score: 0.5, provider_responses: [{ verdict: 'UNCERTAIN' }, { verdict: 'UNCERTAIN' }, { verdict: 'UNCERTAIN' }] }; });
    expect(r.code).toBe(1);
    expect(r.failedNames).toEqual(['HAL (unknowable claim)']);
  });

  it('an endpoint answering HTTP 500 is FAILED; a missing answer is NOT_CHECKED, never a pass', () => {
    const a = answers();
    a.erc8004 = { status: 500, json: { error: 'boom' } };
    delete a.receipt;
    const r = run(a);
    expect(r.code).toBe(1);
    expect(r.legs.find((l) => l.name === 'erc8004 validate')?.outcome).toBe('FAILED');
    expect(r.legs.find((l) => l.name === 'public receipt')?.outcome).toBe('NOT_CHECKED');
  });

  it('nothing to read at all is exit 2, not a pass', () => {
    const r = run({});
    expect(r.verified).toBe(0);
    expect(r.code).toBe(2);
  });
});
