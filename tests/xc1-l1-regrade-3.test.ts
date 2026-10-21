/**
 * XC1 L1-GATE RE-GRADE 3 (2026-10-21): attacks on the new authorization identity (#1452 5ac7bcdb: the NPA's EIP-712
 * digest) and the kill-switch re-check (385e4bb2). Report: E:\dev\reports\2026-10-21\XC1_KERNEL_REGRADE.md, "Re-grade 3".
 *
 * READ-ONLY on src/ and on the arena. Keys are random and in memory; the chain is the arena's in-memory twin (or a Hardhat
 * node when ARENA_RPC is set); nothing leaves the machine. Runs only where the preflight and the arena exist (#1452);
 * elsewhere every probe is reported SKIPPED, never passed. Pinned by code version exactly as xc1-l1-regrade-2.test.ts is.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet, Signature, type BaseWallet } from 'ethers';

const ROOT = join(__dirname, '..');
const HAVE = existsSync(join(ROOT, 'src/services/npa-preflight.ts')) && existsSync(join(ROOT, 'scripts/e2e-local/arena/world.ts'));
const d = HAVE ? describe : describe.skip;
/* eslint-disable @typescript-eslint/no-var-requires */
const engine: any = HAVE ? require('../scripts/e2e-local/arena/engine').bootEngine() : null;
const pf: any = HAVE ? require('../src/services/npa-preflight') : null;
const W: any = HAVE ? require('../scripts/e2e-local/arena/world') : null;
const C: any = HAVE ? require('../scripts/e2e-local/arena/chain') : null;
const KERNEL_FIXES = HAVE && typeof require('../src/kernel/store').StoreLedger.prototype.indeterminate === 'function';
const ARENA_B3 = HAVE && Array.isArray(require('../scripts/e2e-local/arena/cases').EXTRA_CASE_IDS);
/* eslint-enable @typescript-eslint/no-var-requires */
// #1453 at ac21fcc5 or later: the spend/post key no longer carries the policy hash (re-grade 4). Marker: the key's own doc names
// XC1-R3-06. A marker of the code version, not the property: the probes below still fail loudly if the behaviour regresses.
const B4_FIX = HAVE && readFileSync(join(ROOT, 'src/kernel/receipt.ts'), 'utf8').includes('XC1-R3-06');
const pin = (holds: boolean) => (holds ? it : it.failing);
const on = (holds: boolean) => (holds ? 'holds on this code' : 'open on this code');
jest.setTimeout(120_000);

const realConsoleError = console.error;
beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { if (!String(a[0]).startsWith('[scoring/pipeline] proof')) realConsoleError(...a); });
});

// secp256k1 group order: s and n - s are both valid for the same signer (the malleable twin).
const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const hex32 = (x: bigint) => x.toString(16).padStart(64, '0');
/** The same signature in the spellings a verifier may or may not accept. */
function sigForms(sig: string): Record<string, string> {
  const s = Signature.from(sig);
  const r = s.r.slice(2);
  const sv = BigInt(s.s);
  const v = s.v; // 27 or 28
  return {
    'v as 0/1': `0x${r}${hex32(sv)}${(v - 27).toString(16).padStart(2, '0')}`,
    'high-s twin (s = n - s, v flipped)': `0x${r}${hex32(N - sv)}${(v === 27 ? 28 : 27).toString(16)}`,
    'EIP-2098 compact (64 bytes)': s.compactSerialized,
    'upper-case hex': `0x${sig.slice(2).toUpperCase()}`,
  };
}

// ── the identity itself, pure ───────────────────────────────────────────────────────────────────
const NOW = 1_900_000_000;
const USDC = '0x' + '44'.repeat(20);
const buyer = Wallet.createRandom();
const seller = Wallet.createRandom();
const policy = () => pf.stampPolicy({
  level: 0, chain_id: 31337,
  assets: [{ symbol: 'ETH', contract: 'native', decimals: 18 }, { symbol: 'USDC', contract: USDC, decimals: 6 }],
  wallets: { buyer: [buyer.address], seller: [seller.address] }, counterparties: [seller.address], operations: ['pay'],
  per_tx_max_raw: { USDC: '1000000', ETH: '1000000000000000' }, aggregate_max_raw: { USDC: '5000000', ETH: '5000000000000000' },
  max_tx_count: 20, max_fee_wei: '1000000000000000', not_before: NOW - 60, expires_at: NOW + 3600,
  kill_switch_path: 'C:/nonexistent/KILL', evaluator_sha256: 'ab'.repeat(32),
});
const baseNpa = (over: Record<string, unknown> = {}) => ({
  buyer: buyer.address, seller: seller.address, service_hash: '0x' + '1a'.repeat(32), chain_id: 31337, asset: USDC, decimals: 6,
  amount_raw: '500000', quote_source: 'l0:fixed', quote_expires_at: NOW + 300, max_fee_wei: '1000000000000000',
  settlement: 'onchain-readback', nonce: '0x' + 'ab'.repeat(32), ...over,
});
const sign = (w: BaseWallet, n: any, domainOver: Record<string, unknown> = {}) => w.signTypedData({ ...pf.npaDomain(n), ...domainOver }, pf.NPA_TYPES, pf.npaMessage(n));
const presOf = (s: any) => ({ operation: 'pay', npa: s, request: { chain_id: s.npa.chain_id, asset: s.npa.asset, recipient: s.npa.seller, amount_raw: s.npa.amount_raw, payer: s.npa.buyer } });
const evalP = (pres: unknown, over: Record<string, unknown> = {}) =>
  (pf.evaluateNpa({ policy: policy(), pres, now_s: NOW, tally: { spent: {}, count: 0 }, connected_chain_id: 31337, token_info: { symbol: 'USDC', decimals: 6 }, ...over }) as Array<{ code: string }>).map((x) => x.code);

d('XC1-R3 the EIP-712 identity, pure', () => {
  it('[XC1-R3-01] domain and chain swaps: a signature made under another chain\'s domain is refused; a valid NPA for another chain is refused; the identity differs per chain', async () => {
    const n = baseNpa();
    const bsig = await sign(buyer, n);
    expect(evalP(presOf({ npa: n, buyer_sig: bsig, seller_sig: await sign(seller, n, { chainId: 1n }) }))).toContain('seller_signature_invalid');
    expect(evalP(presOf({ npa: n, buyer_sig: bsig, seller_sig: await sign(seller, n, { name: 'Some Other Protocol' }) }))).toContain('seller_signature_invalid');
    const other = baseNpa({ chain_id: 84532 });
    expect(evalP(presOf({ npa: other, buyer_sig: await sign(buyer, other), seller_sig: await sign(seller, other) }))).toContain('wrong_chain');
    expect(pf.npaHashOf(other)).not.toBe(pf.npaHashOf(n));
  });

  pin(ARENA_B3)(`[XC1-R3-02] a property the NPA does not define, or one it omits, is refused as malformed before any signature is believed [${on(ARENA_B3)}]`, async () => {
    const n = baseNpa();
    const sigs = { buyer_sig: await sign(buyer, n), seller_sig: await sign(seller, n) };
    expect(evalP(presOf({ npa: { ...n, memo: 'pay twice' }, ...sigs }))).toEqual(['npa_malformed']);
    const { nonce: _drop, ...noNonce } = n;
    expect(evalP(presOf({ npa: noNonce, ...sigs }))).toEqual(['npa_malformed']);
  });

  it('CHARACTERISE XC1-R3-05: the quote lifetime is not bounded: an NPA whose quote expires in ten years passes the preflight (it widens any replay window to the policy\'s own expiry)', async () => {
    const n = baseNpa({ quote_expires_at: NOW + 10 * 365 * 86400 });
    expect(evalP(presOf({ npa: n, buyer_sig: await sign(buyer, n), seller_sig: await sign(seller, n) }))).toEqual([]);
  });
});

// ── the executor, present() ─────────────────────────────────────────────────────────────────────
d('XC1-R3 the L1 executor, present()', () => {
  const chain = () => (process.env.ARENA_RPC ? new C.ViemChain(process.env.ARENA_RPC) : new C.MemoryChain());
  const world = (o: Record<string, unknown> = {}) => W.makeWorld({ chain: chain(), engine, evaluatorSha256: 'ab'.repeat(32), aggregateUsdc: '50000000', ...o });

  pin(ARENA_B3)(`[XC1-R3-03] the same agreement re-presented with an extra property after it settled is refused (the preflight's shape check, so it holds even without #1453), nothing broadcast [${on(ARENA_B3)}]`, async () => {
    const w = await world();
    try {
      const s = await W.buildNpa(w, { sym: 'USDC', amount_raw: '500000' });
      await W.present(w, W.presentationOf(s), 'as signed');
      await W.present(w, W.presentationOf({ ...s, npa: { ...s.npa, memo: 'a second invoice' } }), 'plus a property nobody signed');
      expect(w.sends).toHaveLength(1);
    } finally { W.disposeWorld(w); }
  });

  pin(KERNEL_FIXES)(`[XC1-R3-04] signature malleability: after the agreement settled, its signatures re-presented as v 0/1, the high-s twin, EIP-2098 compact or upper-case hex never pay again [${on(KERNEL_FIXES)}]`, async () => {
    const w = await world();
    try {
      const s = await W.buildNpa(w, { sym: 'USDC', amount_raw: '500000' });
      await W.present(w, W.presentationOf(s), 'as signed');
      for (const slot of ['buyer_sig', 'seller_sig'] as const) {
        for (const [name, form] of Object.entries(sigForms(s[slot]))) await W.present(w, W.presentationOf({ ...s, [slot]: form }), `${slot}: ${name}`);
      }
      expect(w.sends).toHaveLength(1);
    } finally { W.disposeWorld(w); }
  });

  it('[XC1-R3-04b] malleability the other way round: the high-s twin presented FIRST, then the original, pays at most once', async () => {
    const w = await world();
    try {
      const s = await W.buildNpa(w, { sym: 'USDC', amount_raw: '500000' });
      await W.present(w, W.presentationOf({ ...s, seller_sig: sigForms(s.seller_sig)['high-s twin (s = n - s, v flipped)'] }), 'high-s first');
      await W.present(w, W.presentationOf(s), 'then the original');
      expect(w.sends.length).toBeLessThanOrEqual(1);
    } finally { W.disposeWorld(w); }
  });

  /** The owner signs the next kernel policy version for the USDC subject (same limits): an ordinary owner act. */
  async function rotate(w: any, nonce: string) {
    const nowS = Math.floor(w.now() / 1000);
    const p = {
      subject: w.kernelSubjects.USDC, owner: w.owner.address, actions: ['spend'], payees: [w.addr.seller],
      per_tx_raw: w.policy.per_tx_max_raw.USDC, daily_raw: w.policy.aggregate_max_raw.USDC, total_raw: w.policy.aggregate_max_raw.USDC,
      expires_at: nowS + 3600, nonce,
    };
    const signature = await w.owner.signTypedData(engine.kernel.POLICY_DOMAIN, engine.kernel.POLICY_TYPES, engine.kernel.policyTypedValue(p));
    await w.deps.ledger.appendPolicy({ policy: p, signature }, new Date(w.now()).toISOString());
  }

  // B4 (re-grade 3): the one-use key carried the policy hash, so the owner's next policy version gave every consumed agreement a
  // fresh key. Fixed in #1453 ac21fcc5 (re-grade 4).
  pin(KERNEL_FIXES && B4_FIX)(`[XC1-R3-06] the same signed agreement presented again after the owner signs the next kernel policy version (nonce 2, same limits) does not pay again [${on(KERNEL_FIXES && B4_FIX)}]`, async () => {
    const w = await world();
    try {
      const s = await W.buildNpa(w, { sym: 'USDC', amount_raw: '500000' });
      await W.present(w, W.presentationOf(s), 'under policy nonce 1');
      await rotate(w, '2');
      await W.present(w, W.presentationOf(s), 'the same agreement under policy nonce 2');
      expect(w.sends).toHaveLength(1);
    } finally { W.disposeWorld(w); }
  });

  pin(KERNEL_FIXES && B4_FIX)(`[XC1-R4-01] rotation, then an engine restart, then the same agreement: still one payment (the consumption is rebuilt from the ledger under the new policy) [${on(KERNEL_FIXES && B4_FIX)}]`, async () => {
    const w = await world();
    try {
      const s = await W.buildNpa(w, { sym: 'USDC', amount_raw: '500000' });
      await W.present(w, W.presentationOf(s), 'under policy nonce 1');
      await rotate(w, '2');
      W.restart(w);
      await W.present(w, W.presentationOf(s), 'after rotation and restart');
      expect(w.sends).toHaveLength(1);
    } finally { W.disposeWorld(w); }
  });

  pin(KERNEL_FIXES && B4_FIX)(`[XC1-R4-02] rotation, then 10 concurrent presentations of the consumed agreement: none pays [${on(KERNEL_FIXES && B4_FIX)}]`, async () => {
    const w = await world();
    try {
      const s = await W.buildNpa(w, { sym: 'USDC', amount_raw: '500000' });
      await W.present(w, W.presentationOf(s), 'under policy nonce 1');
      await rotate(w, '2');
      await Promise.all(Array.from({ length: 10 }, (_, i) => W.present(w, W.presentationOf(s), `concurrent ${i + 1} after rotation`)));
      expect(w.sends).toHaveLength(1);
    } finally { W.disposeWorld(w); }
  });

  pin(KERNEL_FIXES && B4_FIX)(`[XC1-R4-03] two rotations (nonce 2, then 3) with a presentation after each: still one payment; and a NEW agreement under nonce 3 still pays (control) [${on(KERNEL_FIXES && B4_FIX)}]`, async () => {
    const w = await world();
    try {
      const s = await W.buildNpa(w, { sym: 'USDC', amount_raw: '500000' });
      await W.present(w, W.presentationOf(s), 'under policy nonce 1');
      await rotate(w, '2');
      await W.present(w, W.presentationOf(s), 'under nonce 2');
      await rotate(w, '3');
      await W.present(w, W.presentationOf(s), 'under nonce 3');
      expect(w.sends).toHaveLength(1);
      const fresh = await W.buildNpa(w, { sym: 'USDC', amount_raw: '500000' });
      const ok = await W.present(w, W.presentationOf(fresh), 'a new agreement under nonce 3');
      expect(ok.status).toBe('SETTLED');
      expect(w.sends).toHaveLength(2);
    } finally { W.disposeWorld(w); }
  });
});
