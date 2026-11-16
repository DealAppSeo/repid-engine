/**
 * x402 v2 conformance for the live 402 challenge, POST /api/v1/x402/:uuid/trade-analysis
 * (src/routes/x402-inbound.ts), driven by the OFFICIAL client: @x402/fetch + @x402/evm, pinned in
 * devDependencies. The spec this checks against is coinbase/x402 `specs/x402-specification-v2.md`
 * and `specs/transports-v2/http.md` (sha256 cb66bdef… for the core spec, read 2026-11-16).
 *
 * WHY THE OFFICIAL CLIENT AND NOT A HAND-WRITTEN SHAPE. On 2026-11-16 a hands-on eval found the
 * challenge was a hybrid: body `x402Version: 2` with v1 entries (`maxAmountRequired`, per-entry
 * `resource`), no `PAYMENT-REQUIRED` header, no EIP-712 `extra`, and only `X-PAYMENT` read on the
 * retry. A test written from our own reading of the spec would have inherited our reading. The
 * official client reads the header, refuses to sign without `extra.name`/`extra.version`, and sends
 * `PAYMENT-SIGNATURE`; if it can pay the route end to end, an x402 builder can.
 *
 * Nothing leaves the machine. The database and the attestation service are stubbed; every request to
 * the x402.org facilitator is answered here and recorded, and any other non-local URL fails the test.
 * The buyer key is generated per run and holds nothing. No transaction is broadcast.
 */
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import request from 'supertest';
import { ethers } from 'ethers';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { wrapFetchWithPayment, x402Client, x402HTTPClient, decodePaymentResponseHeader } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { PaymentRequiredV2Schema, PaymentPayloadV2Schema } from '@x402/core/schemas';
import app from '../src/index';
import { db } from '../src/db';
import { CORS_ALLOWED_HEADERS, CORS_EXPOSED_HEADERS } from '../src/config/cors-headers';

jest.mock('../src/db', () => ({
  db: { from: jest.fn(), rpc: jest.fn().mockResolvedValue({ data: null, error: null }) },
}));

jest.mock('../src/services/repid-attestation', () => ({
  repIdAttestationService: {
    generateAttestation: jest.fn(async () => ({ agent_id: 'stub', repid: 0, tier: 'STUB' })),
    verifyAttestation: jest.fn(async () => ({ valid: true })),
  },
}));

// The facilitator reads the token's EIP-712 domain from chain. Offline here; the values are the
// ones read on chain for Base Sepolia USDC (src/config/network.ts).
jest.mock('../src/services/x402-outbound-client', () => ({
  ...jest.requireActual('../src/services/x402-outbound-client'),
  resolveAndVerifyDomain: jest.fn(async (asset: string, chainId: number) => ({
    name: 'USDC',
    version: '2',
    chainId,
    verifyingContract: asset,
    domainSeparator: '0x',
    verifiedAt: Date.now(),
  })),
}));
jest.mock('../src/clients/rpc-with-failover', () => ({
  ...jest.requireActual('../src/clients/rpc-with-failover'),
  getProvider: jest.fn(() => ({})),
}));

jest.setTimeout(60_000);

const AGENT_ID = '11111111-2222-3333-4444-555555555555';
const PAYEE = '0x2222222222222222222222222222222222222222';
const USDC_BASE_SEPOLIA = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const PRICE = '10000'; // 0.01 USDC, the route's price on main. Must not move.
const NETWORK = 'eip155:84532';
const FACILITATOR = 'https://x402.org/facilitator';
const SETTLE_TX = '0x' + 'ab'.repeat(32);

const ROUTE = `/api/v1/x402/${AGENT_ID}/trade-analysis`;

const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);
let facilitatorCalls: Array<{ path: string; body: any }> = [];
let server: Server;
let baseUrl: string;

function mockDb() {
  (db.from as jest.Mock).mockImplementation((table: string) => {
    const chain: any = {
      select: jest.fn(() => chain),
      eq: jest.fn(() => chain),
      insert: jest.fn(() => chain),
      update: jest.fn(() => chain),
      upsert: jest.fn(async () => ({ data: null, error: null })),
      order: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      single: jest.fn(async () => ({ data: null, error: null })),
      maybeSingle: jest.fn(async () => ({
        data:
          table === 'repid_agents'
            ? { id: AGENT_ID, agent_name: 'SOPHIA', wallet_address: PAYEE, current_repid: 1299, tier: 'ESTABLISHED' }
            : null,
        error: null,
      })),
      then: (r: any) => r({ data: [], error: null, count: 0 }),
    };
    return chain;
  });
}

/** Server-side fetch: answer the facilitator, pass localhost through, refuse everything else. */
function installFacilitatorStub() {
  globalThis.fetch = jest.fn(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(FACILITATOR)) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const path = url.slice(FACILITATOR.length);
      facilitatorCalls.push({ path, body });
      const payer = body?.paymentPayload?.payload?.authorization?.from ?? '';
      const reply = path === '/verify'
        ? { isValid: true, payer }
        : { success: true, transaction: SETTLE_TX, network: NETWORK, payer };
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return realFetch(input, init);
    throw new Error(`x402-v2-conformance: unexpected outbound request to ${url}`);
  }) as any;
}

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  jest.clearAllMocks();
  facilitatorCalls = [];
  delete process.env.X402_DEMO_ANALYSIS;
  mockDb();
  installFacilitatorStub();
});

function decodeB64Json(v: string | null | undefined): any {
  if (!v) return undefined;
  return JSON.parse(Buffer.from(v, 'base64').toString('utf8'));
}

/** One signed v2 PaymentPayload from the official scheme client, for the header-shape tests. */
async function officialPaymentPayload(accept: any, resource: any) {
  const account = privateKeyToAccount(generatePrivateKey());
  const partial = await new ExactEvmScheme(account).createPaymentPayload(2, accept);
  return {
    account,
    v2: { x402Version: 2, resource, accepted: accept, payload: partial.payload } as any,
  };
}

async function challenge() {
  const res = await request(app).post(ROUTE).send({ query: 'BTC' });
  return { res, header: res.headers['payment-required'] as string | undefined };
}

// ===========================================================================
describe('the official @x402/fetch client pays the route end to end', () => {
  it('reads the challenge, signs EIP-3009, retries with PAYMENT-SIGNATURE, and gets a 200 with PAYMENT-RESPONSE', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const sent: Array<Record<string, string>> = [];
    const recordingFetch: typeof fetch = async (input: any, init?: any) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const h: Record<string, string> = {};
      req.headers.forEach((v, k) => { h[k] = v; });
      sent.push(h);
      return realFetch(req);
    };
    const client = new x402Client().register('eip155:*', new ExactEvmScheme(account));
    const payFetch = wrapFetchWithPayment(recordingFetch, client);

    const res = await payFetch(`${baseUrl}${ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'BTC' }),
    });

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[1]!['payment-signature']).toBeDefined();
    expect(sent[1]!['x-payment']).toBeUndefined();

    // What the client sent is a spec PaymentPayload, and it agreed to OUR terms.
    const sentPayload = decodeB64Json(sent[1]!['payment-signature']);
    expect(PaymentPayloadV2Schema.safeParse(sentPayload).success).toBe(true);
    expect(sentPayload.accepted).toMatchObject({ scheme: 'exact', network: NETWORK, amount: PRICE, payTo: PAYEE });

    // The settlement result is readable by the official decoder.
    const settle = decodePaymentResponseHeader(res.headers.get('payment-response')!);
    expect(settle).toMatchObject({ success: true, transaction: SETTLE_TX, network: NETWORK, payer: account.address });

    // The facilitator saw the client's own signature and authorization, against OUR amount and payee.
    expect(facilitatorCalls.map((c) => c.path)).toEqual(['/verify', '/settle']);
    for (const call of facilitatorCalls) {
      expect(call.body.paymentRequirements).toMatchObject({ amount: PRICE, payTo: PAYEE, asset: USDC_BASE_SEPOLIA, network: NETWORK });
      expect(call.body.paymentPayload.payload.signature).toBe(sentPayload.payload.signature);
      expect(call.body.paymentPayload.payload.authorization).toEqual(sentPayload.payload.authorization);
    }

    // The EIP-712 domain we advertised is the one the chain verifies against: the signature recovers
    // to the payer under {name "USDC", version "2", chainId 84532, verifyingContract USDC}.
    const auth = sentPayload.payload.authorization;
    const recovered = ethers.verifyTypedData(
      { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC_BASE_SEPOLIA },
      {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      auth,
      sentPayload.payload.signature,
    );
    expect(recovered).toBe(account.address);
  });
});

// ===========================================================================
describe('the PAYMENT-REQUIRED header is a strict v2 PaymentRequired', () => {
  it('is present, base64, and parses with the official client and the official schema', async () => {
    const { res, header } = await challenge();
    expect(res.status).toBe(402);
    expect(header).toBeDefined();
    expect(header).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);

    const parsed = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse((n) => res.headers[n.toLowerCase()] as string);
    expect(parsed.x402Version).toBe(2);
    expect(PaymentRequiredV2Schema.safeParse(decodeB64Json(header)).success).toBe(true);
  });

  it('carries exactly the spec fields (no v1 leftovers) with amount and payee unchanged', async () => {
    const { header } = await challenge();
    const pr = decodeB64Json(header);
    // Spec §5.1.2 field tables. A v1 field here is the hybrid the eval caught.
    expect(Object.keys(pr).sort()).toEqual(['accepts', 'error', 'resource', 'x402Version']);
    expect(Object.keys(pr.resource).sort()).toEqual(['description', 'mimeType', 'url']);
    expect(pr.resource.url).toMatch(new RegExp(`${ROUTE}$`));
    expect(pr.accepts).toHaveLength(1);
    const a = pr.accepts[0];
    expect(Object.keys(a).sort()).toEqual(['amount', 'asset', 'extra', 'maxTimeoutSeconds', 'network', 'payTo', 'scheme']);
    expect(a).toEqual({
      scheme: 'exact',
      network: NETWORK,
      amount: PRICE,
      asset: USDC_BASE_SEPOLIA,
      payTo: PAYEE,
      maxTimeoutSeconds: 3600,
      extra: { name: 'USDC', version: '2' },
    });
  });
});

// ===========================================================================
// These two must pass on main AND on this branch. A "still works" test that only passes after the
// change cannot show that nothing changed; run it on main to see it is green there too.
describe('current (v1-shaped) clients keep working: identical on main and on this branch', () => {
  it('the body still carries maxAmountRequired, payTo, asset and the per-entry resource string', async () => {
    const { res } = await challenge();
    expect(res.status).toBe(402);
    const a = res.body.accepts[0];
    expect(res.body.x402Version).toBe(2);
    expect(res.body.error).toBe('Payment required');
    expect(a.scheme).toBe('exact');
    expect(a.maxAmountRequired).toBe(PRICE);
    expect(a.payTo).toBe(PAYEE);
    expect(a.asset).toBe(USDC_BASE_SEPOLIA);
    expect(a.network).toBe(NETWORK);
    expect(a.maxTimeoutSeconds).toBe(3600);
    expect(typeof a.resource).toBe('string');
    expect(a.resource).toMatch(new RegExp(`${ROUTE}$`));
    expect(a.mimeType).toBe('application/json');
  });

  it('a flat X-PAYMENT (what trustshell sends) settles, and the facilitator request is exactly this', async () => {
    // Deterministic buyer (derived from a label, holds nothing) and a fixed window and nonce, so the
    // facilitator request is the same bytes on every run and on both sides of this change.
    const wallet = new ethers.Wallet(ethers.id('x402-v2-conformance deterministic test buyer'));
    const auth = {
      from: wallet.address,
      to: PAYEE,
      value: PRICE,
      validAfter: 0,
      validBefore: 4102444800, // 2100-01-01, so the fixture never expires
      nonce: ethers.id('x402-v2-conformance fixed nonce'),
    };
    const signature = await wallet.signTypedData(
      { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC_BASE_SEPOLIA },
      {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      auth,
    );
    const res = await request(app).post(ROUTE)
      .set('X-PAYMENT', Buffer.from(JSON.stringify({ ...auth, signature })).toString('base64'))
      .send({ query: 'BTC' });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.headers['x-payment-response'])).toEqual({ status: 'settled', txHash: SETTLE_TX });
    const accepted = {
      scheme: 'exact',
      network: NETWORK,
      amount: PRICE,
      asset: USDC_BASE_SEPOLIA,
      payTo: PAYEE,
      maxTimeoutSeconds: 3600,
      extra: { assetTransferMethod: 'eip3009', name: 'USDC', version: '2' },
    };
    const expected = {
      x402Version: 2,
      paymentPayload: {
        x402Version: 2,
        accepted,
        payload: {
          signature,
          authorization: { ...auth, validAfter: '0', validBefore: '4102444800' },
        },
      },
      paymentRequirements: accepted,
    };
    expect(facilitatorCalls).toEqual([
      { path: '/verify', body: expected },
      { path: '/settle', body: expected },
    ]);
  });
});

describe('current clients and v2 clients reach the same settlement', () => {
  it('the body also parses as v2, so a v2 client that reads the body is not left out', async () => {
    const { res } = await challenge();
    expect(PaymentRequiredV2Schema.safeParse(res.body).success).toBe(true);
  });

  it('a flat X-PAYMENT (the shape trustshell sends) reaches the facilitator exactly as the v2 header does', async () => {
    const { header } = await challenge();
    const pr = decodeB64Json(header);
    const { v2 } = await officialPaymentPayload(pr.accepts[0], pr.resource);
    const auth = v2.payload.authorization;
    // trustshell's buildX402PaymentHeader: flat, numeric window.
    const flat = {
      from: auth.from, to: auth.to, value: auth.value,
      validAfter: Number(auth.validAfter), validBefore: Number(auth.validBefore),
      nonce: auth.nonce, signature: v2.payload.signature,
    };

    const legacy = await request(app).post(ROUTE)
      .set('X-PAYMENT', Buffer.from(JSON.stringify(flat)).toString('base64')).send({ query: 'BTC' });
    expect(legacy.status).toBe(200);
    // The v1 settlement header is unchanged.
    expect(JSON.parse(legacy.headers['x-payment-response'])).toEqual({ status: 'settled', txHash: SETTLE_TX });
    const legacyCalls = facilitatorCalls;

    facilitatorCalls = [];
    const modern = await request(app).post(ROUTE)
      .set('PAYMENT-SIGNATURE', Buffer.from(JSON.stringify(v2)).toString('base64')).send({ query: 'BTC' });
    expect(modern.status).toBe(200);

    // Same authorization, two wire shapes, one facilitator request: settlement is not changed.
    expect(facilitatorCalls).toEqual(legacyCalls);
    expect(legacyCalls).toHaveLength(2);
  });
});

// ===========================================================================
describe('the retry refuses what it cannot settle honestly', () => {
  it('refuses two payment headers that disagree (400) and calls no facilitator', async () => {
    const res = await request(app).post(ROUTE)
      .set('PAYMENT-SIGNATURE', Buffer.from('{"a":1}').toString('base64'))
      .set('X-PAYMENT', Buffer.from('{"b":2}').toString('base64'))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('conflicting_payment_headers');
    expect(facilitatorCalls).toHaveLength(0);
  });

  it.each([
    ['amount', '1'],
    ['payTo', '0x3333333333333333333333333333333333333333'],
    ['network', 'eip155:8453'],
  ])('refuses a v2 payload whose accepted %s differs from what was advertised (402, with the challenge)', async (field, value) => {
    const { header } = await challenge();
    const pr = decodeB64Json(header);
    const { v2 } = await officialPaymentPayload(pr.accepts[0], pr.resource);
    v2.accepted = { ...v2.accepted, [field]: value };

    const res = await request(app).post(ROUTE)
      .set('PAYMENT-SIGNATURE', Buffer.from(JSON.stringify(v2)).toString('base64')).send({});
    expect(res.status).toBe(402);
    expect(res.body.reason).toMatch(/^accepted_requirements_mismatch/);
    expect(res.headers['payment-required']).toBeDefined();
    expect(facilitatorCalls).toHaveLength(0);
  });

  it('a failed settlement answers 402 with a v2 PAYMENT-RESPONSE that says so', async () => {
    globalThis.fetch = jest.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      facilitatorCalls.push({ path: url.slice(FACILITATOR.length), body: JSON.parse(String(init?.body ?? '{}')) });
      const reply = url.endsWith('/verify') ? { isValid: true, payer: '0xpayer' } : { success: false, errorReason: 'insufficient_funds' };
      return new Response(JSON.stringify(reply), { status: 200 });
    }) as any;
    const { header } = await challenge();
    const pr = decodeB64Json(header);
    const { v2 } = await officialPaymentPayload(pr.accepts[0], pr.resource);

    const res = await request(app).post(ROUTE)
      .set('PAYMENT-SIGNATURE', Buffer.from(JSON.stringify(v2)).toString('base64')).send({});
    expect(res.status).toBe(402);
    expect(decodeB64Json(res.headers['payment-response'])).toMatchObject({ success: false, transaction: '', network: NETWORK });
    expect(res.headers['payment-required']).toBeDefined();
  });
});

// ===========================================================================
describe('a browser x402 client can use the headers', () => {
  // tests/cors-headers.test.ts scans only `x-` names, so it cannot see these three.
  it('allows PAYMENT-SIGNATURE and exposes PAYMENT-REQUIRED and PAYMENT-RESPONSE', () => {
    const allowed = CORS_ALLOWED_HEADERS.map((h) => h.toLowerCase());
    const exposed = CORS_EXPOSED_HEADERS.map((h) => h.toLowerCase());
    expect(allowed).toContain('payment-signature');
    expect(exposed).toEqual(expect.arrayContaining(['payment-required', 'payment-response']));
  });
});
