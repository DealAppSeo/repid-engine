/**
 * R3 (2026-11-16): gasless owner deposit via USDC EIP-3009 transferWithAuthorization.
 *
 * Real EIP-712 signatures from a throwaway wallet made in this test (ethers.Wallet.createRandom), over
 * the same domain the live check uses (Base Sepolia USDC, name "USDC", version "2"). The chain, the
 * relay and the credit are fakes, so nothing is read from or sent to a chain. The fake chain keeps a
 * nonce set the way the USDC contract does, so replay is tested against "used on chain", not a flag.
 */
import { ethers } from 'ethers';
import { gaslessDeposit, gaslessDepositMode, createGaslessAdmission, MIN_GASLESS_DEPOSIT, MIN_WINDOW_S, type GaslessDeps } from '../src/services/gasless-deposit';
import { RefundBroadcastUnconfirmed, type Eip3009Authorization } from '../src/services/escrow-refunder';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ESCROW = ethers.getAddress('0x' + 'e5'.repeat(20));
const NOW = 1_800_000_000;
const DOMAIN = { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC };
const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

const owner = ethers.Wallet.createRandom();
const stranger = ethers.Wallet.createRandom();

async function signed(over: Partial<Eip3009Authorization> = {}, signer: ethers.HDNodeWallet = owner) {
  const authorization: Eip3009Authorization = {
    from: owner.address,
    to: ESCROW,
    value: '1000000',
    validAfter: '0',
    validBefore: String(NOW + 3600),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
    ...over,
  };
  const signature = await signer.signTypedData(DOMAIN, TYPES, authorization);
  return { authorization, signature };
}

function harness(over: Partial<GaslessDeps> = {}) {
  const usedNonces = new Set<string>();
  const relayed: Eip3009Authorization[] = [];
  const credits: Array<[string, bigint, string]> = [];
  const deps: GaslessDeps = {
    mode: 'on',
    escrow: ESCROW,
    usdc: USDC,
    realStaking: true,
    chain: {
      authorizationState: async (from, nonce) => usedNonces.has(`${from.toLowerCase()}:${nonce.toLowerCase()}`),
      balanceOf: async () => 5_000_000n,
      usdcDomain: async () => ({ name: 'USDC', version: '2' }),
    },
    accountOf: async (w) => (w.toLowerCase() === owner.address.toLowerCase() ? 'acct-owner' : null),
    relay: async (a) => {
      const k = `${a.from.toLowerCase()}:${a.nonce.toLowerCase()}`;
      if (usedNonces.has(k)) throw new Error('FiatTokenV2: authorization is used or canceled');
      usedNonces.add(k);
      relayed.push(a);
      return { txHash: '0x' + 'ab'.repeat(32) };
    },
    credit: async (w, amount, tx) => {
      credits.push([w, amount, tx]);
      return { ok: true, builder_id: 'acct-owner', total_active_stake: amount.toString(), authority_after: '0', is_simulated: false, verified: true, tx_hash: tx };
    },
    now: () => NOW,
    admit: () => true,
    ...over,
  };
  return { deps, usedNonces, relayed, credits };
}

describe('gasless deposit (EIP-3009)', () => {
  // Real time inside verifyEip3009Local; pin it to the same clock the deps use.
  beforeAll(() => jest.useFakeTimers({ now: NOW * 1000, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout'] }));
  afterAll(() => jest.useRealTimers());

  test('happy path: the escrow submits the owner-signed authorization, then the stake is credited once', async () => {
    const h = harness();
    const out = await gaslessDeposit(await signed(), h.deps);
    expect(out.status).toBe(201);
    expect(out.body).toMatchObject({ ok: true, sent: true, gas_paid_by: 'escrow', amount_micro_usdc: '1000000' });
    expect(h.relayed).toHaveLength(1);
    expect(h.credits).toEqual([[owner.address, 1_000_000n, '0x' + 'ab'.repeat(32)]]);
  });

  test('REPLAY: the same authorization sent twice moves USDC once and credits once', async () => {
    const h = harness();
    const req = await signed();
    expect((await gaslessDeposit(req, h.deps)).status).toBe(201);
    const again = await gaslessDeposit(req, h.deps);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ ok: false, sent: false, code: 'authorization_used' });
    expect(h.relayed).toHaveLength(1);
    expect(h.credits).toHaveLength(1);
  });

  test('REPLAY, concurrent: two simultaneous submissions of one authorization send once', async () => {
    const h = harness();
    const req = await signed();
    const [a, b] = await Promise.all([gaslessDeposit(req, h.deps), gaslessDeposit(req, h.deps)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(h.relayed).toHaveLength(1);
    expect(h.credits).toHaveLength(1);
  });

  test('REPLAY: a nonce already used on chain (e.g. by the owner directly) is refused before any send', async () => {
    const h = harness();
    const req = await signed();
    h.usedNonces.add(`${owner.address.toLowerCase()}:${req.authorization.nonce.toLowerCase()}`);
    const out = await gaslessDeposit(req, h.deps);
    expect(out.body).toMatchObject({ code: 'authorization_used', sent: false });
    expect(h.relayed).toHaveLength(0);
  });

  test('EXPIRY: an expired authorization is refused and nothing is sent', async () => {
    const h = harness();
    const out = await gaslessDeposit(await signed({ validBefore: String(NOW - 1) }), h.deps);
    expect(out.status).toBe(400);
    expect(out.body.code).toBe('expired');
    expect(h.relayed).toHaveLength(0);
  });

  test('EXPIRY: an authorization that expires before it could be mined is refused (escrow would pay gas for a revert)', async () => {
    const h = harness();
    const out = await gaslessDeposit(await signed({ validBefore: String(NOW + MIN_WINDOW_S - 1) }), h.deps);
    expect(out.body.code).toBe('expires_too_soon');
    const ok = await gaslessDeposit(await signed({ validBefore: String(NOW + MIN_WINDOW_S) }), h.deps);
    expect(ok.status).toBe(201);
  });

  test('not yet valid (validAfter in the future) is refused', async () => {
    const h = harness();
    const out = await gaslessDeposit(await signed({ validAfter: String(NOW + 60) }), h.deps);
    expect(out.body.code).toBe('bad_signature');
    expect(h.relayed).toHaveLength(0);
  });

  test('a signature by someone other than `from` is refused', async () => {
    const h = harness();
    const out = await gaslessDeposit(await signed({}, stranger), h.deps);
    expect(out.status).toBe(400);
    expect(out.body.code).toBe('bad_signature');
    expect(h.relayed).toHaveLength(0);
  });

  test('a signature over a different amount than the one sent is refused', async () => {
    const h = harness();
    const req = await signed({ value: '1000000' });
    const out = await gaslessDeposit({ ...req, authorization: { ...req.authorization, value: '9000000' } }, h.deps);
    expect(out.body.code).toBe('bad_signature');
    expect(h.relayed).toHaveLength(0);
  });

  test('an authorization that does not pay the escrow is refused', async () => {
    const h = harness();
    const out = await gaslessDeposit(await signed({ to: stranger.address }), h.deps);
    expect(out.body.code).toBe('wrong_recipient');
    expect(h.relayed).toHaveLength(0);
  });

  test('a wallet with no account is refused before the USDC moves (nobody to credit)', async () => {
    const h = harness({ accountOf: async () => null });
    const out = await gaslessDeposit(await signed(), h.deps);
    expect(out.status).toBe(404);
    expect(h.relayed).toHaveLength(0);
  });

  test('a balance below the amount is refused before any send', async () => {
    const h = harness();
    h.deps.chain.balanceOf = async () => 999_999n;
    const out = await gaslessDeposit(await signed(), h.deps);
    expect(out.body.code).toBe('insufficient_balance');
    expect(h.relayed).toHaveLength(0);
  });

  test('an unreadable chain is "not checked", never a send', async () => {
    const h = harness();
    h.deps.chain.authorizationState = async () => { throw new Error('rpc down'); };
    const out = await gaslessDeposit(await signed(), h.deps);
    expect(out.status).toBe(503);
    expect(out.body.code).toBe('not_checked');
    expect(h.relayed).toHaveLength(0);
  });

  test('shadow mode runs every check and sends nothing', async () => {
    const h = harness({ mode: 'shadow' });
    const out = await gaslessDeposit(await signed(), h.deps);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, mode: 'shadow', sent: false, would_submit: true });
    expect(h.relayed).toHaveLength(0);
    expect(h.credits).toHaveLength(0);
    // and a bad one still fails in shadow
    expect((await gaslessDeposit(await signed({}, stranger), h.deps)).body.code).toBe('bad_signature');
  });

  test('off (the default) refuses without reading the chain', async () => {
    const h = harness({ mode: 'off' });
    h.deps.chain.authorizationState = async () => { throw new Error('must not be read'); };
    const out = await gaslessDeposit(await signed(), h.deps);
    expect(out.status).toBe(503);
    expect(out.body.code).toBe('gasless_deposit_off');
  });

  test('a broadcast with an unknown outcome reports the tx and does not credit', async () => {
    const h = harness({ relay: async () => { throw new RefundBroadcastUnconfirmed('0x' + 'cd'.repeat(32), 'timeout'); } });
    const out = await gaslessDeposit(await signed(), h.deps);
    expect(out.status).toBe(202);
    expect(out.body).toMatchObject({ code: 'sent_unconfirmed', tx_hash: '0x' + 'cd'.repeat(32), sent: 'unknown' });
    expect(h.credits).toHaveLength(0);
  });

  test('sent but the credit refused: 202 with the tx hash, so it can be claimed, never reported as credited', async () => {
    const h = harness({ credit: async () => ({ ok: false, builder_id: 'acct-owner', total_active_stake: '0', authority_after: '0', is_simulated: true, error: 'deposit verification failed: 0 confirmations' }) });
    const out = await gaslessDeposit(await signed(), h.deps);
    expect(out.status).toBe(202);
    expect(out.body).toMatchObject({ ok: false, sent: true, code: 'sent_not_credited' });
  });

  test('sent, then the credit THROWS: 202 with the tx hash, never a 500 that drops it (Grok r1 lead on #1558)', async () => {
    const h = harness({ credit: async () => { throw new Error('connection reset'); } });
    const out = await gaslessDeposit(await signed(), h.deps);
    expect(out.status).toBe(202);
    expect(out.body).toMatchObject({ ok: false, sent: true, code: 'credit_not_checked', tx_hash: '0x' + 'ab'.repeat(32) });
  });

  test('DUST: below the 1 USDC floor is refused before any send; the floor itself is accepted (Strix on #1558)', async () => {
    const h = harness();
    const dust = await gaslessDeposit(await signed({ value: String(MIN_GASLESS_DEPOSIT - 1n) }), h.deps);
    expect(dust.body.code).toBe('bad_amount');
    expect((await gaslessDeposit(await signed({ value: '1' }), h.deps)).body.code).toBe('bad_amount');
    expect(h.relayed).toHaveLength(0);
    expect((await gaslessDeposit(await signed({ value: String(MIN_GASLESS_DEPOSIT) }), h.deps)).status).toBe(201);
  });

  test('QUEUE: when the admission budget is spent, 429 and nothing is queued for the escrow (Strix on #1558)', async () => {
    const h = harness({ admit: () => false });
    const out = await gaslessDeposit(await signed(), h.deps);
    expect(out.status).toBe(429);
    expect(out.body).toMatchObject({ code: 'escrow_busy', sent: false });
    expect(h.relayed).toHaveLength(0);
  });

  test('QUEUE: shadow mode and refused deposits use no admission', async () => {
    const admit = jest.fn(() => true);
    await gaslessDeposit(await signed(), harness({ mode: 'shadow', admit }).deps);
    await gaslessDeposit(await signed({}, stranger), harness({ admit }).deps);
    expect(admit).not.toHaveBeenCalled();
  });

  test('QUEUE: a deposit the in-lock re-check refuses takes no admission slot (Grok r3 on #1558)', async () => {
    const admit = jest.fn(() => true);
    const h = harness({ admit });
    let reads = 0;
    h.deps.chain.authorizationState = async () => ++reads > 1; // unused at the pre-check, used by the re-check
    const out = await gaslessDeposit(await signed(), h.deps);
    expect(out.body.code).toBe('authorization_used');
    expect(admit).not.toHaveBeenCalled();
    expect(h.relayed).toHaveLength(0);
  });

  test('NO LEAK: a chain, relay or credit error never reaches the answer (ethers puts the RPC URL, and any key in it, in its messages)', async () => {
    const leak = 'https://rpc.example.invalid/v2/NOT-A-REAL-KEY-123';
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bodies: unknown[] = [];
      const read = harness();
      read.deps.chain.authorizationState = async () => { throw new Error(`server response 401 ${leak}`); };
      bodies.push((await gaslessDeposit(await signed(), read.deps)).body);
      const domain = harness();
      domain.deps.chain.usdcDomain = async () => { throw new Error(`missing response ${leak}`); };
      bodies.push((await gaslessDeposit(await signed(), domain.deps)).body);
      bodies.push((await gaslessDeposit(await signed(), harness({ relay: async () => { throw new Error(`could not coalesce ${leak}`); } }).deps)).body);
      bodies.push((await gaslessDeposit(await signed(), harness({ credit: async () => { throw new Error(`timeout ${leak}`); } }).deps)).body);
      bodies.push((await gaslessDeposit(await signed(), harness({ credit: async () => ({ ok: false, builder_id: 'x', total_active_stake: '0', authority_after: '0', is_simulated: true, error: `deposit verification failed: rpc error fetching receipt: ${leak}` }) }).deps)).body);
      for (const b of bodies) expect(JSON.stringify(b)).not.toMatch(/NOT-A-REAL-KEY-123|rpc\.example/);
      expect(bodies.map((b: any) => b.code)).toEqual(['not_checked', 'not_checked', 'not_sent', 'credit_not_checked', 'sent_not_credited']);
    } finally {
      spy.mockRestore();
    }
  });

  test('QUEUE, wired: a second deposit from the same wallet within the minute is 429 and is not sent', async () => {
    const h = harness({ admit: createGaslessAdmission(4, 1) });
    expect((await gaslessDeposit(await signed(), h.deps)).status).toBe(201);
    const second = await gaslessDeposit(await signed(), h.deps);
    expect(second).toMatchObject({ status: 429, body: { code: 'escrow_busy', sent: false } });
    expect(h.relayed).toHaveLength(1);
  });

  test('malformed input is refused', async () => {
    const h = harness();
    for (const body of [null, {}, { authorization: {}, signature: '0x' }, { ...(await signed()), signature: 'nope' }]) {
      expect((await gaslessDeposit(body, h.deps)).body.code).toBe('bad_authorization');
    }
    expect((await gaslessDeposit(await signed({ value: '0' }), h.deps)).body.code).toBe('bad_amount');
  });
});

describe('createGaslessAdmission', () => {
  test('admits 4 a minute, process-wide; a minute later it admits again', () => {
    const admit = createGaslessAdmission(4);
    const t0 = 1_000_000;
    expect([0, 1, 2, 3, 4].map((i) => admit(t0 + i * 1000, `0xpayer${i}`))).toEqual([true, true, true, true, false]);
    expect(admit(t0 + 59_999, '0xpayer9')).toBe(false);
    expect(admit(t0 + 60_000, '0xpayer9')).toBe(true);
  });

  test('one payer gets one slot a minute, so one wallet cannot spend the whole budget (Strix on #1558)', () => {
    const admit = createGaslessAdmission(4, 1);
    const t0 = 2_000_000;
    expect(admit(t0, '0xAbC')).toBe(true);
    expect(admit(t0 + 1, '0xabc')).toBe(false); // same wallet, any letter case
    expect(admit(t0 + 2, '0xdef')).toBe(true); // another payer still gets in
    expect(admit(t0 + 60_000, '0xabc')).toBe(true);
  });
});

describe('GASLESS_DEPOSIT_MODE', () => {
  test.each([
    [undefined, 'off'], ['', 'off'], ['off', 'off'], ['shadow', 'shadow'], ['on', 'on'], [' ON ', 'on'], ['true', 'off'], ['enforce', 'off'],
  ])('%j -> %s', (raw, want) => {
    expect(gaslessDepositMode(raw as string | undefined)).toBe(want);
  });
});
