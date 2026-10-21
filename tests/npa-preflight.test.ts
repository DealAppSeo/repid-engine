/**
 * src/services/npa-preflight.ts: the pure spec §2-§4 data checks that sit in front of the x402 gate and the kernel
 * in the L1 executor (preflight -> x402 gate -> kernel). They only REFUSE; the kernel alone authorises.
 *
 * Every refusal code has its own case. The shape of each case is the same: a positive control (the same
 * presentation, unmutated, is refused by NOTHING), then ONE change that must produce that code. A check that is
 * deleted turns its own case red: this was run as a mutation check on 2026-10-21 (each of the 34 refusal sites
 * neutralised in turn, the file restored byte-identical after); all 34 turned this file red, none survived. The
 * wallets and signatures are throwaway: nothing here touches a chain, a file, or the network.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { privateKeyToAccount } from 'viem/accounts';
import {
  NPA_TYPES, ZERO_ADDRESS, checkPolicy, evaluateNpa, jcs, npaDomain, npaHashOf, npaHashOrNull, npaMessage, npaShapeProblem, policyIdOf, recoverNpaSigner, serviceHashOf, stampPolicy,
  type ExperimentPolicy, type ExperimentPolicyBody, type Hex, type Npa, type PreflightInput,
} from '../src/services/npa-preflight';

const NOW = 1_800_000_000;
const CHAIN = 31337;
const TOKEN = '0x00000000000000000000000000000000000000c1' as Hex;
const DECOY = '0x00000000000000000000000000000000000000d2' as Hex;
const OTHER_TOKEN = '0x00000000000000000000000000000000000000e3' as Hex;
const buyerW = Wallet.createRandom();
const sellerW = Wallet.createRandom();
const strangerW = Wallet.createRandom();
const attackerW = Wallet.createRandom();
const B = buyerW.address as Hex;
const S = sellerW.address as Hex;
const X = strangerW.address as Hex;
const A = attackerW.address as Hex;

const body: ExperimentPolicyBody = {
  level: 0,
  chain_id: CHAIN,
  assets: [
    { symbol: 'ETH', contract: 'native', decimals: 18 },
    { symbol: 'USDC', contract: TOKEN, decimals: 6 },
  ],
  wallets: { buyer: [B], seller: [S] },
  counterparties: [S],
  operations: ['pay'],
  per_tx_max_raw: { USDC: '1000000', ETH: '1000000000000000' },
  aggregate_max_raw: { USDC: '5000000', ETH: '5000000000000000' },
  max_tx_count: 20,
  max_fee_wei: '1000000000000000',
  not_before: NOW - 60,
  expires_at: NOW + 3600,
  kill_switch_path: '/not/read/by/a/pure/module',
  evaluator_sha256: 'ab'.repeat(32),
};
const policy: ExperimentPolicy = stampPolicy(body);

type Who = 'buyer' | 'seller' | 'stranger' | 'attacker';
const wallet = (w: Who) => ({ buyer: buyerW, seller: sellerW, stranger: strangerW, attacker: attackerW })[w];
const sign = (w: Who, n: Npa) => wallet(w).signTypedData(npaDomain(n), NPA_TYPES, npaMessage(n)) as Promise<Hex>;

interface Opts {
  npa?: Partial<Npa>;
  /** who signs each slot: the named party (default), a key that is not the party's, or nobody */
  buyerSig?: Who | 'none';
  sellerSig?: Who | 'none';
  /** sign THIS NPA, then present the (mutated) one: a signature over something else */
  signedFrom?: Partial<Npa>;
  request?: Partial<{ chain_id: number; asset: string; recipient: string; amount_raw: string; payer: string }>;
  operation?: string;
  now_s?: number;
  tally?: { spent: Record<string, bigint>; count: number };
  connected?: number;
  token_info?: { symbol: string; decimals: number } | null;
  policy?: ExperimentPolicy;
}

const baseNpa = (): Npa => ({
  buyer: B,
  seller: S,
  service_hash: serviceHashOf('Summarise a short text.', ['five bullets']),
  chain_id: CHAIN,
  asset: TOKEN,
  decimals: 6,
  amount_raw: '250000',
  quote_source: 'l0:fixed-amount-in-payment-asset',
  quote_expires_at: NOW + 300,
  max_fee_wei: body.max_fee_wei,
  settlement: 'onchain-readback',
  nonce: `0x${'11'.repeat(32)}`,
});

async function build(o: Opts = {}): Promise<PreflightInput> {
  const npa: Npa = { ...baseNpa(), ...o.npa };
  const signedNpa: Npa = { ...npa, ...o.signedFrom };
  const slot = async (who: Who | 'none' | undefined, named: Who) => (who === 'none' ? null : sign(who ?? named, signedNpa));
  return {
    policy: o.policy ?? policy,
    pres: {
      operation: o.operation ?? 'pay',
      npa: { npa, buyer_sig: await slot(o.buyerSig, 'buyer'), seller_sig: await slot(o.sellerSig, 'seller') },
      request: { chain_id: npa.chain_id, asset: npa.asset, recipient: npa.seller, amount_raw: npa.amount_raw, payer: npa.buyer, ...o.request },
    },
    now_s: o.now_s ?? NOW,
    tally: o.tally ?? { spent: {}, count: 0 },
    connected_chain_id: o.connected ?? CHAIN,
    token_info: o.token_info === undefined ? { symbol: 'USDC', decimals: 6 } : o.token_info,
  };
}
const codes = (i: PreflightInput) => evaluateNpa(i).map((r) => r.code);

describe('evaluateNpa: the positive controls', () => {
  it('a valid, in-policy, fully-signed USDC presentation is refused by nothing', async () => expect(evaluateNpa(await build())).toEqual([]));
  it('a valid native ETH presentation is refused by nothing (no token to verify)', async () => {
    const i = await build({ npa: { asset: ZERO_ADDRESS, decimals: 18, amount_raw: '100000000000000' }, token_info: null });
    expect(evaluateNpa(i)).toEqual([]);
  });
  it('an NPA signed by viem verifies exactly as one signed by ethers (the arena signs with viem)', async () => {
    const n = baseNpa();
    const key = `0x${'a1'.repeat(32)}` as Hex;
    const acct = privateKeyToAccount(key);
    const nn = { ...n, buyer: acct.address };
    const sig = await acct.signTypedData({ domain: { ...npaDomain(nn) }, types: NPA_TYPES, primaryType: 'NegotiatedPaymentAgreement', message: npaMessage(nn) } as never);
    expect(recoverNpaSigner(nn, sig)?.toLowerCase()).toBe(acct.address.toLowerCase());
  });
  it('address letter case never matters (the same 20 bytes are the same wallet)', async () => {
    const i = await build({ request: { recipient: `0x${S.slice(2).toUpperCase()}`, payer: B.toLowerCase(), asset: TOKEN.toUpperCase().replace('0X', '0x') } });
    expect(evaluateNpa(i)).toEqual([]);
  });
  it('the boundaries are inclusive/exclusive where the spec says: amount == per-tx cap, exactly the aggregate left, the last tx slot, a quote one second from expiry', async () => {
    expect(await codes(await build({ npa: { amount_raw: '1000000' } }))).toEqual([]);
    expect(await codes(await build({ npa: { amount_raw: '250000' }, tally: { spent: { USDC: 4_750_000n }, count: 0 } }))).toEqual([]);
    expect(await codes(await build({ tally: { spent: {}, count: 19 } }))).toEqual([]);
    expect(await codes(await build({ npa: { quote_expires_at: NOW + 1 } }))).toEqual([]);
  });
});

/** [code, options that must produce it, true when it must be the ONLY refusal] */
const REFUSALS: Array<[string, Opts, boolean]> = [
  ['operation_not_allowed', { operation: 'approve' }, true],
  ['npa_not_signed_by_both', { sellerSig: 'none' }, true],
  ['npa_not_signed_by_both', { buyerSig: 'none', sellerSig: 'none' }, false],
  ['buyer_signature_invalid', { buyerSig: 'attacker' }, true],
  ['seller_signature_invalid', { sellerSig: 'attacker' }, true],
  ['seller_signature_invalid', { sellerSig: 'buyer' }, true],
  ['seller_signature_invalid', { signedFrom: { amount_raw: '1' } }, false],
  ['buyer_is_seller', { npa: { seller: B }, sellerSig: 'buyer' }, false],
  ['settlement_mode_not_onchain_readback', { npa: { settlement: 'escrow' as never } }, true],
  ['buyer_wallet_not_approved', { npa: { buyer: X }, buyerSig: 'stranger' }, true],
  ['seller_wallet_not_approved', { npa: { seller: X }, sellerSig: 'stranger' }, false],
  ['counterparty_not_approved', { npa: { seller: X }, sellerSig: 'stranger' }, false],
  ['wrong_chain', { npa: { chain_id: 84532 } }, true],
  ['asset_not_in_policy', { npa: { asset: OTHER_TOKEN } }, true],
  ['decimals_mismatch', { npa: { decimals: 18 } }, true],
  ['amount_invalid', { npa: { amount_raw: '0' } }, true],
  ['over_per_tx_cap', { npa: { amount_raw: '1000001' } }, true],
  ['over_aggregate_cap', { tally: { spent: { USDC: 4_750_001n }, count: 0 } }, true],
  ['tx_count_exhausted', { tally: { spent: {}, count: 20 } }, true],
  ['quote_expired', { npa: { quote_expires_at: NOW } }, true],
  ['quote_expired', { npa: { quote_expires_at: NOW - 1 } }, true],
  ['max_fee_above_policy', { npa: { max_fee_wei: '1000000000000001' } }, true],
  ['request_chain_differs_from_npa', { request: { chain_id: 1 } }, true],
  ['token_substitution', { request: { asset: DECOY } }, true],
  ['token_substitution', { request: { asset: ZERO_ADDRESS } }, true],
  ['recipient_substitution', { request: { recipient: A } }, true],
  ['amount_differs_from_npa', { request: { amount_raw: '250001' } }, true],
  ['amount_differs_from_npa', { request: { amount_raw: '0250000' } }, true],
  ['payer_differs_from_npa', { request: { payer: A } }, true],
  ['connected_chain_differs_from_policy', { connected: 1 }, true],
  ['asset_not_verified_on_chain', { token_info: null }, true],
  ['asset_not_verified_on_chain', { token_info: { symbol: 'USDC', decimals: 18 } }, true],
  ['asset_not_verified_on_chain', { token_info: { symbol: 'USDT', decimals: 6 } }, true],
];

describe('evaluateNpa: each refusal, on a presentation that is otherwise valid', () => {
  it.each(REFUSALS.map((r, i) => [`${r[0]} #${i}`, ...r] as const))('%s', async (_name, code, opts, only) => {
    const got = await codes(await build(opts));
    expect(got).toContain(code);
    if (only) expect(got).toEqual([code]);
  });

  it('collects every failure, not just the first, in spec order', async () => {
    const got = await codes(await build({ operation: 'approve', npa: { chain_id: 84532 }, request: { recipient: A, asset: DECOY } }));
    expect(got).toEqual(['operation_not_allowed', 'wrong_chain', 'request_chain_differs_from_npa', 'token_substitution', 'recipient_substitution'].filter((c) => got.includes(c)));
    expect(got).toEqual(expect.arrayContaining(['operation_not_allowed', 'wrong_chain', 'token_substitution', 'recipient_substitution']));
  });

  it('the aggregate is per asset: a lot of ETH spent does not eat the USDC budget', async () => {
    expect(await codes(await build({ tally: { spent: { ETH: 5_000_000_000_000_000n }, count: 0 } }))).toEqual([]);
  });

  it('an unset cap is zero, never unlimited', async () => {
    const p = stampPolicy({ ...body, per_tx_max_raw: {}, aggregate_max_raw: {} });
    expect(await codes(await build({ policy: p }))).toEqual(expect.arrayContaining(['over_per_tx_cap', 'over_aggregate_cap']));
  });

  it('an empty approved-wallet list approves nobody', async () => {
    const p = stampPolicy({ ...body, wallets: { buyer: [], seller: [] }, counterparties: [] });
    expect(await codes(await build({ policy: p }))).toEqual(expect.arrayContaining(['buyer_wallet_not_approved', 'seller_wallet_not_approved', 'counterparty_not_approved']));
  });
});

describe('evaluateNpa: what is not a presentation is refused, never thrown on', () => {
  const junk: Array<[string, unknown]> = [
    ['null', null], ['a string', 'pay'], ['an array', []], ['a number', 7], ['an empty object', {}],
    ['no request', { operation: 'pay', npa: { npa: baseNpa(), buyer_sig: null, seller_sig: null } }],
    ['request.chain_id a string', { operation: 'pay', npa: { npa: baseNpa(), buyer_sig: null, seller_sig: null }, request: { chain_id: '31337', asset: TOKEN, recipient: S, amount_raw: '1', payer: B } }],
    ['request.amount a number', { operation: 'pay', npa: { npa: baseNpa(), buyer_sig: null, seller_sig: null }, request: { chain_id: CHAIN, asset: TOKEN, recipient: S, amount_raw: 1, payer: B } }],
    ['a signature that is an object', { operation: 'pay', npa: { npa: baseNpa(), buyer_sig: {}, seller_sig: null }, request: { chain_id: CHAIN, asset: TOKEN, recipient: S, amount_raw: '1', payer: B } }],
    ['operation missing', { npa: { npa: baseNpa(), buyer_sig: null, seller_sig: null }, request: { chain_id: CHAIN, asset: TOKEN, recipient: S, amount_raw: '1', payer: B } }],
  ];
  it.each(junk)('%s -> presentation_malformed', (_n, pres) => {
    const r = evaluateNpa({ policy, pres, now_s: NOW, tally: { spent: {}, count: 0 }, connected_chain_id: CHAIN, token_info: null });
    expect(r.map((x) => x.code)).toEqual(['presentation_malformed']);
  });

  const badNpa: Array<[string, Record<string, unknown>]> = [
    ['buyer not an address', { buyer: '0x1234' }], ['seller with a trailing NUL', { seller: `${S}\u0000` }], ['service_hash short', { service_hash: '0x11' }],
    ['chain_id a bigint', { chain_id: 31337n }], ['chain_id zero', { chain_id: 0 }], ['chain_id a float', { chain_id: 1.5 }], ['asset missing', { asset: undefined }],
    ['decimals 256', { decimals: 256 }], ['amount a number', { amount_raw: 250000 }], ['amount negative', { amount_raw: '-1' }], ['amount with a leading zero', { amount_raw: '01' }],
    ['amount above uint256', { amount_raw: (2n ** 256n).toString() }], ['quote_source not a string', { quote_source: 5 }], ['quote_expires_at NaN', { quote_expires_at: NaN }],
    ['max_fee_wei an exponent', { max_fee_wei: '1e15' }], ['settlement not a string', { settlement: null }], ['nonce short', { nonce: '0x11' }],
  ];
  it.each(badNpa)('an NPA with %s -> npa_malformed (and no exception from hashing or recovery)', (_n, over) => {
    const npa = { ...baseNpa(), ...over };
    expect(() => npaHashOrNull(npa)).not.toThrow();
    const r = evaluateNpa({ policy, pres: { operation: 'pay', npa: { npa, buyer_sig: `0x${'00'.repeat(65)}`, seller_sig: null }, request: { chain_id: CHAIN, asset: TOKEN, recipient: S, amount_raw: '1', payer: B } }, now_s: NOW, tally: { spent: {}, count: 0 }, connected_chain_id: CHAIN, token_info: null });
    expect(r.map((x) => x.code)).toEqual(['npa_malformed']);
    expect(npaShapeProblem(npa)).not.toBeNull();
  });

  it('a refusal names the field and never echoes the value', () => {
    const r = evaluateNpa({ policy, pres: { operation: 'pay', npa: { npa: { ...baseNpa(), amount_raw: 'SECRET-LOOKING-VALUE' }, buyer_sig: null, seller_sig: null }, request: { chain_id: CHAIN, asset: TOKEN, recipient: S, amount_raw: '1', payer: B } }, now_s: NOW, tally: { spent: {}, count: 0 }, connected_chain_id: CHAIN, token_info: null });
    expect(JSON.stringify(r)).not.toContain('SECRET-LOOKING-VALUE');
    expect(r[0]!.detail).toBe('field amount_raw');
  });
});

describe('checkPolicy: the policy file is the policy', () => {
  const ok = (raw: unknown, pinned = policy.policy_id, now = NOW, kill = false) => checkPolicy(raw, pinned, now, kill);
  const code = (r: ReturnType<typeof checkPolicy>) => (r.ok ? 'OK' : r.refusal.code);
  const restamp = (edit: (b: Record<string, unknown>) => void) => {
    const b = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    edit(b);
    return { policy_id: policyIdOf(b as never), ...b };
  };

  it('the stamped policy passes and is returned as parsed', () => {
    const r = ok(JSON.parse(JSON.stringify(policy)));
    expect(r.ok && r.policy.policy_id).toBe(policy.policy_id);
  });
  it('the id is the sha256 of the RFC 8785 bytes, so key order and whitespace never matter', () => {
    const shuffled = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(policy).reverse())));
    expect(code(ok(shuffled))).toBe('OK');
  });
  it.each([['null', null], ['a string', 'policy'], ['an array', []], ['a number', 1]])('%s -> policy_malformed', (_n, raw) => expect(code(ok(raw))).toBe('policy_malformed'));
  it('a file with no policy_id is policy_malformed', () => {
    const { policy_id: _drop, ...rest } = policy;
    expect(code(ok(rest))).toBe('policy_malformed');
  });
  it('edited but not re-stamped -> policy_id_mismatch', () => {
    const edited = JSON.parse(JSON.stringify(policy));
    edited.per_tx_max_raw.USDC = '10000000';
    expect(code(ok(edited))).toBe('policy_id_mismatch');
  });
  it('edited AND re-stamped with its own new id -> policy_pinned_id_mismatch (the id pinned at the start is the authority)', () => {
    const raw = restamp((b) => ((b['per_tx_max_raw'] as Record<string, string>)['USDC'] = '10000000'));
    expect(code(ok(raw))).toBe('policy_pinned_id_mismatch');
  });
  it('a level other than 0 -> policy_level_not_l0, even when the file is the pinned one', () => {
    const raw = restamp((b) => (b['level'] = 1));
    expect(code(ok(raw, raw.policy_id))).toBe('policy_level_not_l0');
  });
  it.each<[string, (b: Record<string, unknown>) => void]>([
    ['chain_id negative', (b) => (b['chain_id'] = -1)],
    ['chain_id a string', (b) => (b['chain_id'] = '31337')],
    ['assets empty', (b) => (b['assets'] = [])],
    ['an asset with a bad contract', (b) => ((b['assets'] as Array<Record<string, unknown>>)[1]!['contract'] = '0xabc')],
    ['an asset symbol in lower case', (b) => ((b['assets'] as Array<Record<string, unknown>>)[1]!['symbol'] = 'usdc')],
    ['two assets with one symbol', (b) => ((b['assets'] as Array<Record<string, unknown>>)[0]!['symbol'] = 'USDC')],
    ['wallets.buyer not an array', (b) => ((b['wallets'] as Record<string, unknown>)['buyer'] = B)],
    ['a counterparty that is not an address', (b) => (b['counterparties'] = ['seller'])],
    ['operations not strings', (b) => (b['operations'] = [1])],
    ['a cap with a leading zero', (b) => ((b['per_tx_max_raw'] as Record<string, string>)['USDC'] = '01000000')],
    ['a negative aggregate', (b) => ((b['aggregate_max_raw'] as Record<string, string>)['USDC'] = '-5')],
    ['max_tx_count negative', (b) => (b['max_tx_count'] = -1)],
    ['max_fee_wei a number', (b) => (b['max_fee_wei'] = 1e15)],
    ['not_before a string', (b) => (b['not_before'] = 'now')],
    ['kill_switch_path empty', (b) => (b['kill_switch_path'] = '')],
    ['evaluator_sha256 short', (b) => (b['evaluator_sha256'] = 'ab')],
  ])('a consistent but ill-formed policy (%s) -> policy_malformed', (_n, edit) => {
    const raw = restamp(edit);
    expect(code(ok(raw, raw.policy_id))).toBe('policy_malformed');
  });
  it('the validity window: not before, and not at or after the expiry', () => {
    const raw = JSON.parse(JSON.stringify(policy));
    expect(code(ok(raw, policy.policy_id, body.not_before - 1))).toBe('policy_not_yet_valid');
    expect(code(ok(raw, policy.policy_id, body.not_before))).toBe('OK');
    expect(code(ok(raw, policy.policy_id, body.expires_at - 1))).toBe('OK');
    expect(code(ok(raw, policy.policy_id, body.expires_at))).toBe('policy_expired');
  });
  it('the kill switch refuses, on an otherwise valid policy', () => expect(code(ok(JSON.parse(JSON.stringify(policy)), policy.policy_id, NOW, true))).toBe('kill_switch'));
  it('a tampered policy is refused whether or not the kill switch is on (integrity first)', () => {
    const edited = JSON.parse(JSON.stringify(policy));
    edited.max_tx_count = 9999;
    expect(code(ok(edited, policy.policy_id, NOW, true))).toBe('policy_id_mismatch');
  });
});

describe('identities', () => {
  it('RFC 8785 §3.2.4 vector', () => {
    const v = { numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001], string: '€$\u000f\nA\'B"\\\\"/', literals: [null, true, false] };
    expect(jcs(v)).toBe('{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}');
  });
  it('jcs refuses what has no canonical form', () => {
    expect(() => jcs({ a: 1n })).toThrow();
    expect(() => jcs({ a: Infinity })).toThrow();
    expect(npaHashOrNull({ a: 1n })).toBeNull();
  });
  it('the NPA identity ignores key order and the signatures, and changes with any field', () => {
    const n = baseNpa();
    expect(npaHashOf(JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(n).reverse()))))).toBe(npaHashOf(n));
    expect(npaHashOf({ ...n, amount_raw: '250001' })).not.toBe(npaHashOf(n));
    expect(npaHashOf({ ...n, nonce: `0x${'12'.repeat(32)}` })).not.toBe(npaHashOf(n));
  });
  it('a signature recovers its signer, a different NPA recovers someone else, garbage recovers nobody and never throws', async () => {
    const n = baseNpa();
    const sig = await sign('buyer', n);
    expect(recoverNpaSigner(n, sig)).toBe(B);
    expect(recoverNpaSigner({ ...n, amount_raw: '250001' }, sig)).not.toBe(B);
    for (const g of [null, undefined, '', '0x', '0x1234', 5, {}, `0x${'00'.repeat(65)}`, `0x${'ff'.repeat(65)}`]) expect(() => recoverNpaSigner(n, g)).not.toThrow();
    expect(recoverNpaSigner(n, '0x1234')).toBeNull();
  });
});

describe('purity: the module reads no file, no network, no clock, no environment', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'services', 'npa-preflight.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  it('imports only node:crypto and ethers', () => {
    const imports = [...code.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['ethers', 'node:crypto']);
  });
  it.each([['process.env'], ['Date.now'], ['new Date'], ['Math.random'], ['randomBytes'], ['fetch('], ['require('], ['existsSync'], ['readFileSync'], ['setTimeout']])('does not use %s', (needle) => {
    expect(code).not.toContain(needle);
  });
});
