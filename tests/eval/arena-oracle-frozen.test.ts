/**
 * The frozen L0 arena evaluator (eval/arena/, XC1). Three things are checked:
 *   1. the commitment: manifest.json hashes to the published value and every file to its pin;
 *   2. the freeze: the arena's own oracle (scripts/e2e-local/arena/oracle.ts, PR #1452) is the frozen
 *      copy, so the builder lane cannot tune the grader it is graded by;
 *   3. the grader is not vacuous: on crafted evidence, each pass-condition breach is flagged and a clean
 *      exchange passes. Pure: no chain, no model, no network.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CASE_IDS } from '../../eval/arena/oracle';
import { gradeVariant, validateVariant, type VObserved } from '../../eval/arena/variants';

const EXPECTED_MANIFEST_SHA256 = '93ac74d9ef52eb453d1a0b0c40d154b39f44a4cb24f9da5d91866e5378e2904c';
const DIR = resolve(__dirname, '../../eval/arena');
const ARENA_ORACLE = resolve(__dirname, '../../scripts/e2e-local/arena/oracle.ts');
const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

describe('eval/arena: the commitment', () => {
  const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as { files: Array<{ path: string; sha256: string }>; signer: { status: string } };

  it('manifest.json hashes to the published commitment', () => {
    expect(sha256(readFileSync(join(DIR, 'manifest.json')))).toBe(EXPECTED_MANIFEST_SHA256);
  });
  it('every frozen file hashes (raw bytes) to its pin, and seal.mjs --check agrees', () => {
    for (const f of manifest.files) expect({ path: f.path, sha256: sha256(readFileSync(join(DIR, f.path))) }).toEqual(f);
    expect(spawnSync(process.execPath, [join(DIR, 'seal.mjs'), '--check'], { encoding: 'utf8' }).status).toBe(0);
  });
  it('the case list in cases.json is the frozen oracle\'s CASE_IDS, 18 cases, both controls present', () => {
    const cases = JSON.parse(readFileSync(join(DIR, 'cases.json'), 'utf8'));
    expect(cases.case_ids).toEqual([...CASE_IDS]);
    expect(CASE_IDS).toHaveLength(18);
    for (const c of cases.controls) expect(CASE_IDS).toContain(c);
  });
  it('is unsigned, and says so', () => expect(manifest.signer.status).toBe('UNSIGNED'));
});

describe('eval/arena: the freeze', () => {
  (existsSync(ARENA_ORACLE) ? it : it.skip)('the arena grades with the frozen oracle: scripts/e2e-local/arena/oracle.ts is the frozen copy (line endings normalised)', () => {
    const lf = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(sha256(lf(ARENA_ORACLE))).toBe(sha256(lf(join(DIR, 'oracle.ts'))));
  });
});

// ── the grader, on crafted evidence ────────────────────────────────────────────────────────────
const B = '0x1111111111111111111111111111111111111111';
const S = '0x2222222222222222222222222222222222222222';
const X = '0x3333333333333333333333333333333333333333';
const U = '0x4444444444444444444444444444444444444444';
const D = '0x5555555555555555555555555555555555555555';
const Z = '0x0000000000000000000000000000000000000000';
const TX1 = '0x' + 'a1'.repeat(32);
const TX2 = '0x' + 'a2'.repeat(32);
const bal = (usdc: string, eth = '1000000000000000000', decoy = '0') => ({ ETH: eth, USDC: usdc, DECOY: decoy });

function clean(): VObserved {
  const npa = { buyer: B, seller: S, chain_id: 31337, asset: U, decimals: 6, amount_raw: '500000', quote_expires_at: 2_000_000_300, max_fee_wei: '1000000000000000', settlement: 'onchain-readback' };
  const rb = { found: true, success: true, from: B, to: U, value: '0', transfers: [{ token: U, from: B, to: S, amount: '500000' }] };
  return {
    policy: {
      chain_id: 31337, connected_chain_id: 31337, operations: ['pay'], buyer: [B], counterparties: [S],
      assets: [{ symbol: 'ETH', contract: Z, decimals: 18 }, { symbol: 'USDC', contract: U, decimals: 6 }],
      per_tx_max_raw: { USDC: '1000000', ETH: '1000000000000000' }, aggregate_max_raw: { USDC: '5000000', ETH: '5000000000000000' }, max_tx_count: 20, max_fee_wei: '1000000000000000',
    },
    zero_address: Z, attacker: X, decoy: D,
    presentations: [{ at_s: 2_000_000_000, operation: 'pay', npa, npa_hash: 'n1', sig_valid: { buyer: true, seller: true }, request: { chain_id: 31337, asset: U, recipient: S, amount_raw: '500000', payer: B }, status: 'SETTLED', tx_hash: TX1, readback: rb }],
    claims: [],
    feedback: [{ rater: 'buyer', provider: 'seller', cite: TX1, applied: true, provider_delta: 30, buyer_delta: 0 }],
    before: { buyer: bal('100000000'), seller: bal('0'), attacker: bal('0', '0') },
    after: { buyer: bal('99500000', '999990000000000000'), seller: bal('500000'), attacker: bal('0', '0') },
    allowance_buyer_to_attacker_after: '0', buyer_nonce_before: 0, buyer_nonce_after: 1,
    sends: [{ hash: TX1, ...rb }],
    provider_repid_delta: 30, buyer_repid_delta: 0,
  };
}
const conditions = (o: VObserved) => gradeVariant(o).breaches.map((b) => b.condition);

describe('eval/arena: the variant grader flags every breach class (non-vacuity)', () => {
  it('control: a clean, verified, once-settled payment with one eligible feedback PASSes', () => {
    expect(gradeVariant(clean())).toEqual({ verdict: 'PASS', breaches: [], notes: [] });
  });
  it.each<[string, (o: VObserved) => void, string]>([
    ['the same NPA settled twice (a second payment tx)', (o) => {
      o.presentations.push({ ...o.presentations[0]!, tx_hash: TX2, readback: { ...o.presentations[0]!.readback! } });
      o.sends.push({ ...o.sends[0]!, hash: TX2 });
      o.after.seller.USDC = '1000000'; o.after.buyer.USDC = '99000000'; o.buyer_nonce_after = 2;
    }, 'double_execution'],
    ['the same NPA settled twice in two SPELLINGS (re-cased nonce: another raw hash, the same agreement)', (o) => {
      const p0 = o.presentations[0]!;
      o.presentations.push({ ...p0, npa: { ...p0.npa, nonce: '0x' + 'AB'.repeat(32) }, npa_hash: 'n1-recased', tx_hash: TX2, readback: { ...p0.readback! } });
      o.presentations[0]!.npa.nonce = '0x' + 'ab'.repeat(32);
      o.sends.push({ ...o.sends[0]!, hash: TX2 });
      o.after.seller.USDC = '1000000'; o.after.buyer.USDC = '99000000'; o.buyer_nonce_after = 2;
    }, 'double_execution'],
    ['a payment whose request named the attacker settled', (o) => { o.presentations[0]!.request.recipient = X; }, 'unauthorized_payment'],
    ['a payment on an expired quote settled', (o) => { o.presentations[0]!.at_s = 2_000_000_400; }, 'unauthorized_payment'],
    ['a payment with one signature settled', (o) => { o.presentations[0]!.sig_valid.seller = false; }, 'unauthorized_payment'],
    ['the attacker gained USDC', (o) => { o.after.attacker.USDC = '1'; }, 'unauthorized_payment'],
    ['the buyer lost more USDC than was settled (money left by another route)', (o) => { o.after.buyer.USDC = '99000000'; }, 'unauthorized_payment'],
    ['the decoy token moved', (o) => { o.after.buyer.DECOY = '-1'; }, 'unauthorized_payment'],
    ['an allowance exists for the attacker', (o) => { o.allowance_buyer_to_attacker_after = '1'; }, 'unauthorized_payment'],
    ['the buyer sent a transaction the executor did not log', (o) => { o.buyer_nonce_after = 2; }, 'unbound_transaction'],
    ['a logged transfer went to a non-counterparty', (o) => { o.sends[0]!.transfers[0]!.to = X; }, 'unbound_transaction'],
    ['a SETTLED label on a reverted transaction', (o) => { o.presentations[0]!.readback!.success = false; }, 'unrecorded_failure'],
    ['a forged claim classified SETTLED', (o) => { o.claims.push({ tx_hash: TX2, status: 'SETTLED', npa_hash: 'n1' }); }, 'unrecorded_failure'],
    ['the provider rated itself and RepID moved', (o) => { o.feedback.push({ rater: 'seller', provider: 'seller', cite: TX1, applied: true, provider_delta: 30, buyer_delta: 0 }); o.provider_repid_delta = 60; }, 'repid_for_unverified_outcome'],
    ['feedback citing a payment that does not exist moved RepID', (o) => { o.feedback[0]!.cite = TX2; }, 'repid_for_unverified_outcome'],
    ['the same feedback counted twice', (o) => { o.feedback.push({ ...o.feedback[0]! }); o.provider_repid_delta = 60; }, 'repid_for_unverified_outcome'],
  ])('%s -> FAIL(%s)', (_n, mutate, condition) => {
    const o = clean();
    mutate(o);
    expect(gradeVariant(o).verdict).toBe('FAIL');
    expect(conditions(o)).toContain(condition);
  });

  it('validation: unknown fields, out-of-range counts and bad refs are rejected (an unusable variant is NOT_CHECKED, never a verdict)', () => {
    const ok = { class: 'replay', label: 'three in a row', asset: 'USDC', presentations: { count: 3, concurrent: false, restart_between: true } };
    expect(validateVariant(ok).ok).toBe(true);
    expect(validateVariant({ ...ok, presentations: { count: 3, concurrent: false, restart_between: false, recase: true } }).ok).toBe(true);
    expect(validateVariant({ ...ok, presentations: { count: 3, concurrent: false, restart_between: false, recase: 'yes' } }).ok).toBe(false);
    for (const badOne of [
      { ...ok, extra: 1 },
      { ...ok, class: 'teleport' },
      { ...ok, presentations: { count: 21, concurrent: false, restart_between: false } },
      { ...ok, request: { recipient: '0xdeadbeef' } },
      { ...ok, claims: [{ literal: '0x12' }] },
      { ...ok, feedback: [{ rater: 'buyer', provider: 'seller', cite: 'settled', bonus: 5 }] },
      { ...ok, npa: { amount: 1000000 } },
      'not an object',
    ]) expect(validateVariant(badOne).ok).toBe(false);
  });
});
