/**
 * scripts/trust-backend-conformance.mjs, run offline against saved public responses.
 *
 * The fixtures under tests/fixtures/trust-backend-conformance/good are the live API's own answers for one agent
 * (saved with `--save` on 2026-11-19). The good set must pass. Each planted defect below changes ONE answer the
 * way a real fault would, and the run must go red on the leg that owns it. A checker that cannot fail has
 * measured nothing, so the planted cases are the point of this file.
 */
import { spawnSync } from 'child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCRIPT = join(__dirname, '..', 'scripts', 'trust-backend-conformance.mjs');
const GOOD = join(__dirname, 'fixtures', 'trust-backend-conformance', 'good');

type Leg = { name: string; outcome: 'VERIFIED' | 'NOT_CHECKED' | 'FAILED'; detail: string };
function run(dir: string): { code: number | null; legs: Leg[]; verified: number; failed: number } {
  const r = spawnSync(process.execPath, [SCRIPT, '--offline', dir, '--json'], { encoding: 'utf8' });
  const out = JSON.parse(r.stdout);
  return { code: r.status, legs: out.legs, verified: out.verified, failed: out.failed };
}
/** A copy of the good fixtures with one file changed. */
function planted(file: string, change: (body: any) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'conformance-'));
  cpSync(GOOD, dir, { recursive: true });
  const f = join(dir, `${file}.json`);
  const doc = JSON.parse(readFileSync(f, 'utf8'));
  change(doc.json);
  writeFileSync(f, JSON.stringify(doc));
  return dir;
}
const failedLegs = (dir: string) => { const r = run(dir); rmSync(dir, { recursive: true, force: true }); return { code: r.code, names: r.legs.filter((l) => l.outcome === 'FAILED').map((l) => l.name) }; };

describe('trust backend conformance (offline)', () => {
  it('the saved live answers pass: every leg that has a fixture is VERIFIED and nothing FAILED', () => {
    const r = run(GOOD);
    expect(r.failed).toBe(0);
    expect(r.code).toBe(0);
    const verified = r.legs.filter((l) => l.outcome === 'VERIFIED').map((l) => l.name);
    for (const name of ['health', 'repid', 'passport', 'zk proof read', 'zk verify (published verifier, run locally)', 'zk verify (this API, real proof)', 'zk verify (this API, altered statement)', 'erc8004 validate', 'reputation on chain (as the API reports it)', 'public receipt'])
      expect(verified).toContain(name);
    // the chain readback cannot run offline, and says so; it is never counted as a pass
    expect(r.legs.find((l) => l.name === 'chain readback')?.outcome).toBe('NOT_CHECKED');
  });

  it.each([
    ['a proof that belongs to another agent', 'proof', (j: any) => { j.statement.agent_id = '00000000-0000-4000-8000-000000000000'; }, 'zk proof read'],
    ['a proof whose statement is false', 'proof', (j: any) => { j.statement.threshold = j.statement.repid_score + 1; }, 'zk proof read'],
    ['a verifier that ACCEPTS an altered statement', 'verify_altered', (j: any) => { j.verified = true; }, 'zk verify (this API, altered statement)'],
    ['a verifier that refuses its own real proof', 'verify_real', (j: any) => { j.verified = false; }, 'zk verify (this API, real proof)'],
    ['a tier above what the score allows', 'repid', (j: any) => { j.tier = 'VETERAN'; }, 'repid'],
    ['a passport that disagrees with /repid on the score', 'passport', (j: any) => { j.reputation.repid_score += 7; }, 'passport'],
    ['an ERC-8004 view for a different agent', 'erc8004', (j: any) => { j.agent_id = '00000000-0000-4000-8000-000000000000'; }, 'erc8004 validate'],
    ['an on-chain record for a different token', 'reputation_onchain', (j: any) => { j.token_id = '1'; }, 'reputation on chain (as the API reports it)'],
    ['a receipt listing a proof that is not real', 'receipt', (j: any) => { j.zk_proofs[0].is_real = false; }, 'public receipt'],
    ['an engine that reports itself unhealthy', 'health', (j: any) => { j.status = 'degraded'; }, 'health'],
    // from the independent review, 2026-11-19
    ['a passport that names its own registry', 'passport', (j: any) => { j.onchain.registry = '0x' + '1'.repeat(40); }, 'passport'],
    ['a receipt with an empty proof list', 'receipt', (j: any) => { j.zk_proofs = []; }, 'public receipt'],
    ['a proof whose claim the current score no longer meets', 'proof', (j: any) => { j.statement.threshold = 2930; }, 'zk proof read'],
    ['served proof bytes the published verifier rejects', 'proof', (j: any) => { const b = Buffer.from(j.proof_bytes, 'base64'); b[100] ^= 1; j.proof_bytes = b.toString('base64'); }, 'zk verify (published verifier, run locally)'],
  ])('planted: %s -> exit 1 on the leg that owns it', (_what, file, change, leg) => {
    const r = failedLegs(planted(file as string, change as (b: any) => void));
    expect(r.code).toBe(1);
    expect(r.names).toContain(leg);
  });

  it('an endpoint answering HTTP 500 is FAILED; a missing answer is NOT_CHECKED, never a pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conformance-'));
    cpSync(GOOD, dir, { recursive: true });
    writeFileSync(join(dir, 'erc8004.json'), JSON.stringify({ status: 500, json: { error: 'boom' } }));
    rmSync(join(dir, 'receipt.json'));
    const r = run(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(r.code).toBe(1);
    expect(r.legs.find((l) => l.name === 'erc8004 validate')?.outcome).toBe('FAILED');
    expect(r.legs.find((l) => l.name === 'public receipt')?.outcome).toBe('NOT_CHECKED');
  });

  it('nothing to read at all is exit 2, not a pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conformance-empty-'));
    const r = run(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(r.verified).toBe(0);
    expect(r.code).toBe(2);
  });

  it('HAL: three checkers answering UNCERTAIN must not be a veto. The saved default-settings reply (vetoed at 0.5) is FAILED', () => {
    // defect-uncertain-vetoed/hal_abstain.json is what the route returned on 2026-11-19 with code defaults.
    // good/hal_abstain.json is the same claim with HAL_VERDICT_DRIVEN_VETO=true (flagged).
    const dir = mkdtempSync(join(tmpdir(), 'conformance-'));
    cpSync(GOOD, dir, { recursive: true });
    cpSync(join(GOOD, '..', 'defect-uncertain-vetoed', 'hal_abstain.json'), join(dir, 'hal_abstain.json'));
    const r = failedLegs(dir);
    expect(r.code).toBe(1);
    expect(r.names).toEqual(['HAL (unknowable claim)']);
  });

  it('HAL: a known-false claim that comes back clean is FAILED (when HAL fixtures are present)', () => {
    if (!existsSync(join(GOOD, 'hal_known.json'))) return; // no HAL fixture saved yet: nothing to plant against
    const r = failedLegs(planted('hal_known', (j: any) => { for (const k of ['decision', 'hal_decision', 'verdict']) if (k in j) j[k] = 'clean'; }));
    expect(r.code).toBe(1);
    expect(r.names).toContain('HAL (known false claim)');
  });
});
