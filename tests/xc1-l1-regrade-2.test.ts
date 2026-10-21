/**
 * XC1 L1-GATE RE-GRADE 2 (2026-10-21): the B1 fix (#1453 head 6c5bf253: the spend/post one-use key is the argument
 * digest alone) and the B2 fix (#1452 head e7f7ccf9: the NPA preflight moved into src/services/npa-preflight.ts; the
 * L1 executor is preflight -> x402 gate -> kernel). Report: E:\dev\reports\2026-10-21\XC1_KERNEL_REGRADE.md §11.
 *
 * READ-ONLY on src/ and on the arena: this file imports them and attacks them. Keys are random, in memory, never
 * funded; the chain is the arena's in-memory twin; nothing leaves the machine.
 *
 * Both modules exist only with #1452. On a tree without them every probe here is reported SKIPPED, never passed.
 *   it(...)            the property held (or a positive control).
 *   it.failing(...)    a SECURE expectation the code does not meet: green while the hole is open, red when it closes.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet } from 'ethers';

const ROOT = join(__dirname, '..');
const HAVE = existsSync(join(ROOT, 'src/services/npa-preflight.ts')) && existsSync(join(ROOT, 'scripts/e2e-local/arena/world.ts'));
const d = HAVE ? describe : describe.skip;
/* eslint-disable @typescript-eslint/no-var-requires */
// The engine reads its environment when it loads, so boot it first (as tests/arena-l0.test.ts does).
const engine: any = HAVE ? require('../scripts/e2e-local/arena/engine').bootEngine() : null;
const pf: any = HAVE ? require('../src/services/npa-preflight') : null;
const W: any = HAVE ? require('../scripts/e2e-local/arena/world') : null;
const C: any = HAVE ? require('../scripts/e2e-local/arena/chain') : null;
/* eslint-enable @typescript-eslint/no-var-requires */
jest.setTimeout(120_000);

const realConsoleError = console.error;
beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { if (!String(a[0]).startsWith('[scoring/pipeline] proof')) realConsoleError(...a); });
});

// ── the pure module, on its own ────────────────────────────────────────────────────────────────
const NOW = 1_900_000_000;
const USDC = '0x' + '44'.repeat(20);
const buyer = Wallet.createRandom();
const seller = Wallet.createRandom();
const attacker = Wallet.createRandom();
const policy = () => pf.stampPolicy({
  level: 0, chain_id: 31337,
  assets: [{ symbol: 'ETH', contract: 'native', decimals: 18 }, { symbol: 'USDC', contract: USDC, decimals: 6 }],
  wallets: { buyer: [buyer.address], seller: [seller.address] }, counterparties: [seller.address], operations: ['pay'],
  per_tx_max_raw: { USDC: '1000000', ETH: '1000000000000000' }, aggregate_max_raw: { USDC: '5000000', ETH: '5000000000000000' },
  max_tx_count: 20, max_fee_wei: '1000000000000000', not_before: NOW - 60, expires_at: NOW + 3600,
  kill_switch_path: 'C:/nonexistent/KILL', evaluator_sha256: 'ab'.repeat(32),
});
const baseNpa = () => ({
  buyer: buyer.address, seller: seller.address, service_hash: '0x' + '1a'.repeat(32), chain_id: 31337, asset: USDC, decimals: 6,
  amount_raw: '500000', quote_source: 'l0:fixed', quote_expires_at: NOW + 300, max_fee_wei: '1000000000000000',
  settlement: 'onchain-readback', nonce: '0x' + 'ab'.repeat(32),
});
const sign = (w: Wallet, n: any) => w.signTypedData(pf.npaDomain(n), pf.NPA_TYPES, pf.npaMessage(n));
async function signed(n = baseNpa()) {
  return { npa: n, buyer_sig: await sign(buyer, n), seller_sig: await sign(seller, n) };
}
const presOf = (s: any, req: Record<string, unknown> = {}, operation = 'pay') => ({
  operation, npa: s, request: { chain_id: s.npa.chain_id, asset: s.npa.asset, recipient: s.npa.seller, amount_raw: s.npa.amount_raw, payer: s.npa.buyer, ...req },
});
const evalP = (pres: unknown, over: Record<string, unknown> = {}) =>
  pf.evaluateNpa({ policy: policy(), pres, now_s: NOW, tally: { spent: {}, count: 0 }, connected_chain_id: 31337, token_info: { symbol: 'USDC', decimals: 6 }, ...over }) as Array<{ code: string }>;
const codes = (r: Array<{ code: string }>) => r.map((x) => x.code);
/** Every hex field of an NPA re-cased: the same agreement, the same EIP-712 struct, other bytes in its JSON. */
const recase = (n: any) => ({
  ...n, buyer: n.buyer.toLowerCase(), seller: n.seller.toLowerCase(), asset: n.asset.toUpperCase().replace('0X', '0x'),
  service_hash: n.service_hash.toUpperCase().replace('0X', '0x'), nonce: n.nonce.toUpperCase().replace('0X', '0x'),
});

d('XC1-PF the NPA preflight module, attacked directly', () => {
  it('[XC1-PF-00] control: a valid presentation draws no refusal, and the same addresses in other letter case in the REQUEST are still the same addresses', async () => {
    const s = await signed();
    expect(evalP(presOf(s))).toEqual([]);
    expect(evalP(presOf(s, { recipient: seller.address.toLowerCase(), asset: USDC.toUpperCase().replace('0X', '0x'), payer: buyer.address.toLowerCase() }))).toEqual([]);
  });

  it.each([
    ['recipient, leading space', { recipient: ` ${'SELLER'}` }, 'recipient_substitution'],
    ['recipient, trailing zero-width space', { recipient: 'SELLER\u200b' }, 'recipient_substitution'],
    ['recipient, a look-alike (one nibble changed)', { recipient: 'FLIP' }, 'recipient_substitution'],
    ['recipient, the attacker', { recipient: 'ATTACKER' }, 'recipient_substitution'],
    ['asset, trailing space', { asset: `${USDC} ` }, 'token_substitution'],
    ['asset, fullwidth digits', { asset: '0x' + '４４'.repeat(20) }, 'token_substitution'],
    ['payer, BOM prefix', { payer: '\uFEFFBUYER' }, 'payer_differs_from_npa'],
    ['amount, leading zero', { amount_raw: '0500000' }, 'amount_differs_from_npa'],
    ['amount, exponent', { amount_raw: '5e5' }, 'amount_differs_from_npa'],
    ['amount, trailing space', { amount_raw: '500000 ' }, 'amount_differs_from_npa'],
    ['amount, decimal point', { amount_raw: '500000.0' }, 'amount_differs_from_npa'],
    ['chain, another chain', { chain_id: 84532 }, 'request_chain_differs_from_npa'],
  ])('[XC1-PF-01] a request field that is not exactly what was signed is refused: %s', async (_n, raw, code) => {
    const s = await signed();
    const sub = (v: unknown) => (typeof v === 'string' ? v.replace('SELLER', seller.address).replace('BUYER', buyer.address).replace('ATTACKER', attacker.address).replace('FLIP', `${seller.address.slice(0, 41)}${seller.address[41] === 'f' ? '0' : 'f'}`) : v);
    const req = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, sub(v)]));
    expect(codes(evalP(presOf(s, req)))).toContain(code);
  });

  it('[XC1-PF-02] padded or malformed NPA fields are refused as malformed before any signature is believed', async () => {
    for (const [k, v] of [['seller', ` ${seller.address}`], ['asset', 'native'], ['amount_raw', '01'], ['amount_raw', '1e6'], ['nonce', '0x12'], ['chain_id', '31337'], ['quote_expires_at', 1e300], ['decimals', 6.5]] as const) {
      const n = { ...baseNpa(), [k]: v };
      const got = codes(evalP(presOf({ npa: n, buyer_sig: '0x', seller_sig: '0x' })));
      expect(got).toHaveLength(1); // malformed stops there: nothing else is evaluated
      expect(['npa_malformed', 'presentation_malformed']).toContain(got[0]); // a string chain_id is copied into the request, which is checked first
    }
  });

  it('[XC1-PF-03] expiry edges: the quote is expired AT its expiry second, valid one second before; the policy likewise', async () => {
    const s = await signed();
    expect(codes(evalP(presOf(s), { now_s: NOW + 300 }))).toContain('quote_expired');
    expect(codes(evalP(presOf(s), { now_s: NOW + 299 }))).not.toContain('quote_expired');
    const p = policy();
    expect(pf.checkPolicy(p, p.policy_id, NOW + 3600, false).refusal?.code).toBe('policy_expired');
    expect(pf.checkPolicy(p, p.policy_id, NOW - 61, false).refusal?.code).toBe('policy_not_yet_valid');
    expect(pf.checkPolicy(p, p.policy_id, NOW - 60, false).ok).toBe(true);
    expect(pf.checkPolicy(p, p.policy_id, NOW, true).refusal?.code).toBe('kill_switch');
  });

  it('[XC1-PF-04] signature tricks: the buyer\'s signature in the seller slot, a signature for another chain\'s domain, and one signature in both slots are refused', async () => {
    const n = baseNpa();
    const bsig = await sign(buyer, n);
    expect(codes(evalP(presOf({ npa: n, buyer_sig: bsig, seller_sig: bsig })))).toContain('seller_signature_invalid');
    const otherChain = await seller.signTypedData({ ...pf.npaDomain(n), chainId: 1n }, pf.NPA_TYPES, pf.npaMessage(n));
    expect(codes(evalP(presOf({ npa: n, buyer_sig: bsig, seller_sig: otherChain })))).toContain('seller_signature_invalid');
    const self = { ...n, seller: buyer.address };
    const selfSig = await sign(buyer, self);
    expect(codes(evalP(presOf({ npa: self, buyer_sig: selfSig, seller_sig: selfSig })))).toEqual(expect.arrayContaining(['buyer_is_seller', 'counterparty_not_approved']));
  });

  it('[XC1-PF-05] hostile JSON-shaped presentations never throw and are never an empty refusal list', () => {
    const hostile: unknown[] = [null, [], {}, 'pay', 1, { operation: 1 }, { operation: 'pay', npa: null, request: {} },
      { operation: 'pay', npa: { npa: baseNpa(), buyer_sig: 1, seller_sig: null }, request: {} },
      JSON.parse('{"operation":"pay","npa":{"npa":{"__proto__":{"buyer":"x"}},"buyer_sig":null,"seller_sig":null},"request":{"chain_id":1,"asset":"","recipient":"","amount_raw":"","payer":""}}'),
      { operation: 'pay', npa: { npa: { ...baseNpa(), amount_raw: 'x'.repeat(100000) }, buyer_sig: null, seller_sig: null }, request: { chain_id: 31337, asset: USDC, recipient: seller.address, amount_raw: '1', payer: buyer.address } }];
    for (const h of hostile) {
      let r: Array<{ code: string }> = [];
      expect(() => { r = evalP(h); }).not.toThrow();
      expect(r.length).toBeGreaterThan(0);
    }
  });

  it('CHARACTERISE XC1-PF-06: the authorization identity is not canonical. The same agreement with its hex fields re-cased passes the preflight with the ORIGINAL signatures, yet hashes to a different npa hash (= the kernel args_hash)', async () => {
    const s = await signed();
    const re = { ...s, npa: recase(s.npa) };
    expect(evalP(presOf(re))).toEqual([]);
    expect(pf.npaHashOf(re.npa)).not.toBe(pf.npaHashOf(s.npa));
  });
});

// ── the executor end to end: present() = preflight -> x402 gate -> kernel ───────────────────────
d('XC1-NPA the L1 executor, present(), on the in-memory chain', () => {
  const ORACLE_SHA = 'ab'.repeat(32);
  // The in-memory twin by default; the same probes on a real Hardhat node when ARENA_RPC is set (as tests/arena-l0.test.ts).
  const chain = () => (process.env.ARENA_RPC ? new C.ViemChain(process.env.ARENA_RPC) : new C.MemoryChain());
  async function world(o: Record<string, unknown> = {}) { return W.makeWorld({ chain: chain(), engine, evaluatorSha256: ORACLE_SHA, ...o }); }
  const settled = (w: any) => w.attempts.filter((a: any) => a.status === 'SETTLED').length;

  it('[XC1-NPA-00] control: the identical signed agreement presented twice settles once; the second is refused by the kernel (authorization_consumed)', async () => {
    const w = await world({ aggregateUsdc: '50000000' });
    try {
      const s = await W.buildNpa(w, { sym: 'USDC', amount_raw: '500000' });
      await W.present(w, W.presentationOf(s), 'first');
      const again = await W.present(w, W.presentationOf(s), 'again');
      expect(settled(w)).toBe(1);
      expect(again.refusals.map((r: any) => r.detail ?? r.code).join(',')).toContain('authorization_consumed');
    } finally { W.disposeWorld(w); }
  });

  it.failing('[XC1-NPA-01] the same signed agreement re-presented with its hex fields re-cased (same signatures) must settle at most once (BREACHED: a re-cased NPA is a new npa hash, so a new one-use key)', async () => {
    const w = await world({ aggregateUsdc: '50000000' });
    try {
      const s = await W.buildNpa(w, { sym: 'USDC', amount_raw: '500000' });
      await W.present(w, W.presentationOf(s), 'first');
      const variants = [
        { ...s.npa, seller: s.npa.seller.toLowerCase() },
        { ...s.npa, nonce: s.npa.nonce.toUpperCase().replace('0X', '0x') },
        { ...s.npa, service_hash: s.npa.service_hash.toUpperCase().replace('0X', '0x') },
        recase(s.npa),
      ];
      for (const n of variants) await W.present(w, W.presentationOf({ ...s, npa: n }), 're-cased');
      expect(w.sends.length).toBeLessThanOrEqual(1); // broadcasts, not labels
      expect(settled(w)).toBeLessThanOrEqual(1);
    } finally { W.disposeWorld(w); }
  });

  it('[XC1-NPA-02] 10 concurrent DISTINCT agreements against an aggregate of 1.5 payments: exactly one settles (the preflight tally is not atomic; the kernel reservation is)', async () => {
    const w = await world({ aggregateUsdc: '750000' });
    try {
      const ss = await Promise.all(Array.from({ length: 10 }, () => W.buildNpa(w, { sym: 'USDC', amount_raw: '500000' })));
      await Promise.all(ss.map((s: any, i: number) => W.present(w, W.presentationOf(s), `distinct ${i}`)));
      expect(settled(w)).toBe(1);
      expect(w.sends).toHaveLength(1);
    } finally { W.disposeWorld(w); }
  });

  it.failing('[XC1-NPA-03] a kill switch that appears while a payment is in flight (after the preflight, before the broadcast) must stop it (BREACHED, LOW: the file is read once, at the preflight)', async () => {
    const w = await world();
    try {
      const s = await W.buildNpa(w, { sym: 'ETH', amount_raw: '500000000000000' });
      const resolve = w.deps.resolveOwner;
      w.deps = { ...w.deps, resolveOwner: async (...a: unknown[]) => { writeFileSync(w.killPath, 'stop'); return resolve(...a); } }; // the operator pulls the switch now
      await W.present(w, W.presentationOf(s), 'in flight when the switch appears');
      expect(w.sends).toHaveLength(0);
    } finally { rmSync(w.killPath, { force: true }); W.disposeWorld(w); }
  });
});
