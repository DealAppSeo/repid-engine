/**
 * The public receipt must be shareable AND must never leak the work.
 *
 * This endpoint is unauthenticated on purpose — "you can check this without
 * trusting us" is the entire argument, and a receipt behind an API key does not
 * make it. That makes the privacy boundary load-bearing: everything served is
 * either already on-chain and world-readable, or a fact ABOUT the exchange.
 * The contract `payload` (what someone asked) and `result` (what they paid for)
 * are neither, and must never appear.
 */
import { buildTrustReceipt } from '../src/services/trust-receipt';

const SECRET_PAYLOAD = 'CONFIDENTIAL-QUESTION-DO-NOT-PUBLISH';
const SECRET_RESULT = 'CONFIDENTIAL-ANSWER-DO-NOT-PUBLISH';

const rows: Record<string, unknown> = {
  service_contracts: {
    id: 'c1', status: 'settled', agreed_price_usdc_raw: 100000,
    buyer_agent_id: 'buyer-1', provider_agent_id: 'prov-1', settled_at: '2026-08-01T00:00:00Z',
    // Present on the real row. If a future edit widens the select, these must
    // still not reach the response.
    payload: { question: SECRET_PAYLOAD }, result: { answer: SECRET_RESULT },
  },
  repid_agents: { agent_name: 'trinity-test' },
  x402_settlements: { tx_hash: '0xsettle', is_simulated: false, status: 'settled' },
  a2a_awards: { competing_bid_count: 2, was_lowest_price: true, is_uncontested: false },
  erc8004_reputation_writes: { tx_hash: '0xonchain', repid_value: 1701 },
};

jest.mock('../src/db', () => {
  const make = (table: string) => {
    const c: any = {
      select: () => c, eq: () => c, order: () => c, limit: () => c, not: () => c,
      maybeSingle: () => Promise.resolve({ data: (rowsRef as any)[table] ?? null, error: null }),
      then: (r: any) => r({ data: table === 'repid_score_events' ? [] : [], error: null }),
    };
    return c;
  };
  const rowsRef: Record<string, unknown> = {};
  return { db: { from: (t: string) => make(t) }, __rows: rowsRef };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const dbMock = jest.requireMock('../src/db') as { __rows: Record<string, unknown> };
Object.assign(dbMock.__rows, rows);

describe('public trust receipt', () => {
  it('never contains the contract payload or result', async () => {
    const receipt = await buildTrustReceipt('c1');
    expect(receipt).not.toBeNull();
    const serialised = JSON.stringify(receipt);
    expect(serialised).not.toContain(SECRET_PAYLOAD);
    expect(serialised).not.toContain(SECRET_RESULT);
    expect(serialised).not.toContain('CONFIDENTIAL');
  });

  it('exposes only the agreed field set', async () => {
    const receipt = await buildTrustReceipt('c1');
    const allowed = new Set([
      'contract_id', 'settled_at', 'price_usdc', 'price_raw', 'buyer', 'provider',
      'negotiated', 'competing_bids', 'won_on_price', 'uncontested',
      'settlement_tx', 'settlement_url', 'is_simulated', 'reputation_events',
      'onchain_tx', 'onchain_url', 'onchain_repid', 'onchain_link_is_proven',
      'zk_proofs', 'caveats', 'paid_before_delivery',
      // ZK BIND T1. Deliberately allowed: it is a HASH over digests, never the
      // work — work-statement.test.ts proves the preimage cannot contain the
      // deliverable body. Publishing it is the point, since a third party must
      // be able to recompute and compare it.
      'work_statement_hash',

      // ── ADDED 2026-09-04, and each is a deliberate publish decision ────────
      //
      // The line above says a third party "must be able to recompute and
      // compare it". They could not. The receipt published the DIGEST and
      // withheld the PREIMAGE, so an outsider held a hash and nothing to hash.
      // A digest whose preimage is withheld is not evidence, it is an assertion
      // wearing evidence's clothes — and it is the receipt's headline property.
      //
      // `work_statement` is the agreed SPEC: deliverable, numbered acceptance
      // criteria, price, deadline — the terms both parties bound themselves to
      // and which the DB trigger froze at bind time. It is NOT the request
      // payload and NOT the delivered result; those stay in `payload`/`result`
      // and are still never published (the test above proves it, and it runs
      // against a fixture whose payload and result contain sentinels).
      'work_statement',

      // Per-criterion met/not-met. `buyer_satisfaction_score` is derived by the
      // database as round(met/total, 4) and a disagreeing client value is
      // refused — publishing the ratings is what turns that from a promise into
      // something an outsider can re-derive. A rating carries an optional free
      // -text `note`, which is a judgement about the work, not the work.
      'criterion_ratings',

      // The derived score itself, so the derivation has something to be checked
      // against. Alone it would be one more number to trust.
      'buyer_satisfaction_score',

      // ── ADDED 2026-10-14: who paid whom ─────────────────────────────────────
      // The payer and payee wallets of the settlement. Already world-readable as
      // the settlement tx's USDC Transfer from/to; published so an outsider can
      // check the transfer went between the parties this receipt names (the
      // trustshell acceptance gate could not, with no keyless route naming them).
      // The signed authorization they are read from is NOT published (below).
      'payer_wallet', 'payee_wallet',
      // Where those come from: 'settlement_record' (this route does not re-read the chain), or null.
      'wallets_source',
    ]);
    // A new field is not automatically safe to publish — this fails until
    // someone decides it is, which is the point.
    for (const k of Object.keys(receipt!)) expect(allowed.has(k)).toBe(true);
  });

  /**
   * The receipt's central claim is "paid only after verified delivery". It was
   * printed for every exchange regardless of the data, and it was false for the
   * pre-2026-08-01 rows: 18dd4e05 settled at 04:32:31.72 and was fulfilled at
   * 04:33:23.54, 52s later. A receipt that tells the flattering version is the
   * exact failure it exists to expose.
   */
  describe('pay-vs-deliver ordering is read from the row, never assumed', () => {
    const withTimes = (settleAt: string | null, fulfilledAt: string | null, deliveredAt?: string | null) => {
      Object.assign(dbMock.__rows, {
        service_contracts: { ...(rows.service_contracts as object), fulfilled_at: fulfilledAt },
        x402_settlements: {
          tx_hash: '0xsettle', is_simulated: false, status: 'settled',
          created_at: settleAt,
          // Legacy rows predate the deferred path and have no delivered_at.
          delivered_at: deliveredAt === undefined ? null : deliveredAt,
        },
      });
    };
    afterEach(() => Object.assign(dbMock.__rows, rows));

    it('flags an exchange that paid at escrow, and says how early', async () => {
      withTimes('2026-07-23T04:32:31.723Z', '2026-07-23T04:33:23.538Z');
      const r = await buildTrustReceipt('c1');
      expect(r!.paid_before_delivery).toBe(true);
      expect(r!.caveats.join(' ')).toMatch(/moved BEFORE delivery.*52s/);
    });

    it('does not flag an exchange settled after fulfilment', async () => {
      withTimes('2026-08-01T05:09:07.741Z', '2026-08-01T05:09:06.934Z');
      const r = await buildTrustReceipt('c1');
      expect(r!.paid_before_delivery).toBe(false);
      expect(r!.caveats.join(' ')).not.toMatch(/BEFORE delivery/);
    });

    it('says it cannot tell rather than guessing when a timestamp is missing', async () => {
      withTimes('2026-08-01T05:09:07.741Z', null);
      const r = await buildTrustReceipt('c1');
      expect(r!.paid_before_delivery).toBeNull();
      expect(r!.caveats.join(' ')).toMatch(/Cannot establish whether payment preceded delivery/);
    });

    // DEFERRED SETTLEMENT. The settlement row is CREATED at escrow (authorization
    // taken, nothing moved) and only BROADCAST later at satisfy. Judging by
    // created_at therefore reported pay-up-front for exactly the exchanges that
    // correctly held the money until delivery — the mirror of #299.
    // Timestamps below are the real ones from contract
    // ad357681-bbe2-40ad-82ff-d2fcd067a7fb, whose tx 0x0caffacc… mined at
    // 18:34:10, 50s after the work was delivered.
    it('does NOT flag a deferred settlement whose row was created at escrow', async () => {
      withTimes(
        '2026-08-02T18:32:53.223Z', // row created at escrow — money still still
        '2026-08-02T18:33:20.252Z', // delivered
        '2026-08-02T18:34:08.423Z', // broadcast, after delivery
      );
      const r = await buildTrustReceipt('c1');
      expect(r!.paid_before_delivery).toBe(false);
      expect(r!.caveats.join(' ')).not.toMatch(/BEFORE delivery/);
    });

    it('still flags an immediate settle, where broadcast and row creation coincide', async () => {
      withTimes(
        '2026-08-02T18:12:20.803Z',
        '2026-08-02T18:13:02.623Z',
        '2026-08-02T18:12:20.789Z', // broadcast at escrow — genuinely paid first
      );
      const r = await buildTrustReceipt('c1');
      expect(r!.paid_before_delivery).toBe(true);
      expect(r!.caveats.join(' ')).toMatch(/moved BEFORE delivery/);
    });

    it('falls back to created_at for legacy rows that have no delivered_at', async () => {
      withTimes('2026-07-23T04:32:31.723Z', '2026-07-23T04:33:23.538Z', null);
      const r = await buildTrustReceipt('c1');
      expect(r!.paid_before_delivery).toBe(true);
      expect(r!.caveats.join(' ')).toMatch(/moved BEFORE delivery.*52s/);
    });
  });

  it('returns null for an unknown contract rather than an empty shell', async () => {
    Object.assign(dbMock.__rows, { service_contracts: null });
    expect(await buildTrustReceipt('nope')).toBeNull();
    Object.assign(dbMock.__rows, rows);
  });

  /**
   * WHO PAID WHOM (2026-10-14). The wallets come from the settlement row: payer_address, and the `to` of
   * the x402 authorization the payer signed. The live row's header is the flat shape
   * {to, from, nonce, value, signature, validAfter, validBefore}, base64 [V prod 2026-10-14, keys only].
   */
  describe('payer and payee wallets', () => {
    const PAYER = '0xdf6b8215d193b11b4903d223729c3cf7a6de271d'; // lower-case in, checksummed out
    const PAYEE = '0x7b84cce5502d393daa6533285ef3e2f8d3a13261';
    // Every field of the signed authorization that is NOT a wallet gets a sentinel, so a leak of any one
    // of them (or of the whole base64 header) is caught, in the JSON and in the HTML page alike.
    const SIGNATURE_SENTINEL = '0x' + 'ab'.repeat(65);
    const NONCE_SENTINEL = '0x' + 'ce'.repeat(32);
    const VALID_AFTER_SENTINEL = '1234567891';
    const VALID_BEFORE_SENTINEL = '1987654321';
    const header = (to: string) => Buffer.from(JSON.stringify({
      to, from: PAYER, nonce: NONCE_SENTINEL, value: '100000', signature: SIGNATURE_SENTINEL,
      validAfter: VALID_AFTER_SENTINEL, validBefore: VALID_BEFORE_SENTINEL,
    })).toString('base64');
    const NEVER_PUBLISHED = (h: string) => [h, SIGNATURE_SENTINEL.slice(2), NONCE_SENTINEL.slice(2), VALID_AFTER_SENTINEL, VALID_BEFORE_SENTINEL, 'x_payment_header'];
    const withSettlement = (s: Record<string, unknown>) =>
      Object.assign(dbMock.__rows, { x402_settlements: { tx_hash: '0x' + 'cb'.repeat(32), is_simulated: false, status: 'settled', ...s } });
    const CAVEAT = /does not name both the payer and the payee wallet/;
    afterEach(() => Object.assign(dbMock.__rows, rows));

    it('publishes both, checksummed, labelled as the settlement record (no chain re-read on this route)', async () => {
      withSettlement({ payer_address: PAYER, x_payment_header: header(PAYEE) });
      const r = await buildTrustReceipt('c1');
      expect(r!.payer_wallet).toBe('0xdf6b8215D193b11B4903d223729c3CF7A6de271d');
      expect(r!.payee_wallet).toBe('0x7b84CCE5502d393DAa6533285eF3e2f8D3A13261');
      expect(r!.wallets_source).toBe('settlement_record');
      expect(r!.caveats.some((c) => CAVEAT.test(c))).toBe(false);
    });

    it('never publishes the signed authorization it reads them from: no header, signature, nonce or validity window', async () => {
      const h = header(PAYEE);
      withSettlement({ payer_address: PAYER, x_payment_header: h });
      const serialised = JSON.stringify(await buildTrustReceipt('c1'));
      for (const secret of NEVER_PUBLISHED(h)) expect(serialised).not.toContain(secret);
    });

    it.each([
      ['a simulated settlement', { is_simulated: true, payer_address: PAYER, x_payment_header: header(PAYEE) }],
      ['a legacy row missing the payee', { payer_address: PAYER, x_payment_header: null }],
      ['a legacy row missing the payer', { payer_address: null, x_payment_header: header(PAYEE) }],
      ['a NON-simulated row with no tx hash (XC1: used to publish null wallets with no caveat)', { tx_hash: null, payer_address: PAYER, x_payment_header: header(PAYEE) }],
    ])('%s: no wallets, no source, and a caveat says so instead of guessing', async (_why, row) => {
      withSettlement(row);
      const r = await buildTrustReceipt('c1');
      expect([r!.payer_wallet, r!.payee_wallet, r!.wallets_source]).toEqual([null, null, null]);
      expect(r!.caveats.some((c) => CAVEAT.test(c))).toBe(true);
    });

    it('no settlement at all: no wallets, and the caveat too', async () => {
      Object.assign(dbMock.__rows, { x402_settlements: null });
      const r = await buildTrustReceipt('c1');
      expect([r!.payer_wallet, r!.payee_wallet]).toEqual([null, null]);
      expect(r!.caveats.some((c) => CAVEAT.test(c))).toBe(true);
    });

    it('the public page labels them as the settlement RECORD, and leaks nothing of the authorization (raw or base64)', async () => {
      const h = header(PAYEE);
      withSettlement({ payer_address: PAYER, x_payment_header: h });
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const express = require('express');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const request = require('supertest');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const router = require('../src/routes/v1/receipt-public').default;
      const app = express().use('/api/v1', router);
      const res = await request(app).get('/api/v1/receipt/c1');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Recorded payer <code>0xdf6b8215D193b11B4903d223729c3CF7A6de271d</code> (trinity-test) and payee <code>0x7b84CCE5502d393DAa6533285eF3e2f8D3A13261</code> (trinity-test)');
      expect(res.text).toContain('This page does not re-read the transfer on chain');
      for (const secret of NEVER_PUBLISHED(h)) expect(res.text).not.toContain(secret);
    });
  });

  /**
   * The work statement is an OBJECT (the 2026-10-14 daily run's, verbatim). The JSON receipt must carry
   * it as one, and the HTML page must render its text, never "[object Object]". Before 2026-10-15 the
   * page showed only the hash, so "recompute it yourself" pointed at nothing on the page.
   */
  describe('work statement is readable', () => {
    const WS = {
      deadline: '2026-10-15T12:02:06.906Z',
      deliverable: 'A cross-provider factual verification verdict on the claim: "The Base Sepolia chain id is 84532."',
      agreed_price: { currency: 'USDC', amount_usdc_raw: 100000 },
      acceptance_criteria: [
        { n: 1, text: 'The verdict states explicitly whether the claim is true or false, without hedging.' },
        { n: 2, text: 'The verdict names the chain id it verified against, so the check is reproducible.' },
      ],
    };
    beforeEach(() => Object.assign(dbMock.__rows, {
      service_contracts: {
        ...(rows.service_contracts as object), work_statement_hash: '0x' + 'd9'.repeat(32), work_statement: WS,
        criterion_ratings: [{ n: 1, met: true }, { n: 2, met: false }], buyer_satisfaction_score: '0.5000',
      },
    }));
    afterEach(() => Object.assign(dbMock.__rows, rows));
    const get = (path: string) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const express = require('express');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const request = require('supertest');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const router = require('../src/routes/v1/receipt-public').default;
      return request(express().use('/api/v1', router)).get(path);
    };

    it('JSON: the statement is a structured object, not a string', async () => {
      const res = await get('/api/v1/receipt/c1.json');
      expect(res.status).toBe(200);
      expect(res.body.work_statement).toEqual(WS);
      expect(res.text).not.toContain('[object Object]');
    });

    it('HTML: renders the deliverable and each criterion with its rating', async () => {
      const res = await get('/api/v1/receipt/c1');
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('[object Object]');
      expect(res.text).toContain('A cross-provider factual verification verdict on the claim: &quot;The Base Sepolia chain id is 84532.&quot;');
      expect(res.text).toContain('The verdict states explicitly whether the claim is true or false, without hedging. <span class="muted">— met</span>');
      expect(res.text).toContain('so the check is reproducible. <span class="muted">— not met</span>');
    });
  });
});
