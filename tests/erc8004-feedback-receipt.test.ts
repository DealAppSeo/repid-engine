/**
 * Milestone 2 (Sean GO, 2026-10-06): one ERC-8004 reputation write a stranger can verify from the
 * chain and the public file alone. No network, no database: the chain reads are fixtures, the
 * database is an in-memory fake.
 *
 * The finding this answers, measured 2026-10-06 on the live write of 2026-10-05
 * (0x3566fca1…53f3): feedbackHash was bytes32(0) and feedbackURI pointed at trustrepid.dev, which
 * answered 404. The first describe block pins that from the raw event, so the "before" is not prose.
 */
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';

// ── in-memory fake of the parts of supabase-js the worker helper and the route use ──
type Row = Record<string, any>;
const tables: Record<string, Row[]> = {};
const updates: Array<{ table: string; patch: Row; id: string }> = [];
let failUpdate = false;
function from(table: string) {
  const filters: Array<[string, unknown]> = [];
  const q: any = {
    select: () => q,
    eq: (col: string, val: unknown) => {
      filters.push([col, val]);
      return q;
    },
    // PostgREST sends every filter as text, so a BIGINT id matches the string '1630' from a URL.
    maybeSingle: async () => ({ data: (tables[table] ?? []).find((r) => filters.every(([c, v]) => String(r[c]) === String(v))) ?? null, error: null }),
    update: (patch: Row) => ({
      eq: async (_col: string, id: string) => {
        if (failUpdate) return { error: { message: 'simulated write failure' } };
        updates.push({ table, patch, id });
        const row = (tables[table] ?? []).find((r) => r.id === id);
        if (row) Object.assign(row, patch);
        return { error: null };
      },
    }),
  };
  return q;
}
const fakeDb = { from };
jest.mock('../src/db', () => ({ db: { from: (t: string) => from(t) } }));
jest.mock('../src/db/direct-pg', () => ({ pgQuery: jest.fn() }));

import { buildFeedbackFile, feedbackHashOf, feedbackFileUrl, payeeFromPaymentHeader, proofOfPaymentFrom } from '../src/services/erc8004-feedback-file';
import { assessFields, assessFile, assessIdentity, assessPayment, assessWrite, exitCodeOf, fetchTargetProblem, isPublicAddress, overall, type DecodedFeedback } from '../src/services/erc8004-feedback-verify';
import { prepareFeedbackFile } from '../src/workers/feedback-loop-worker';
import { createAgentsReputationRouter } from '../src/routes/agents-reputation';
import reputationAbiRaw from '../src/contracts/ReputationRegistry.abi.json';

const IDENTITY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
const OPERATOR = '0xb24268884472e7613aa58d38c8813f7af1667382';
const PAYER = '0x1111111111111111111111111111111111111111';
const PAYEE = '0x2222222222222222222222222222222222222222';
const AGENT = 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271';
// repid_events.id is a BIGINT. A UUID here is what let the route and the auth bypass both demand a
// UUID and pass every test, while the first real write's URI (.../feedback/1630.json) answered 401.
const EVENT = 1630;
const PAY_TX = '0x' + 'ab'.repeat(32);
const header = (to: string) =>
  Buffer.from(JSON.stringify({ x402Version: 1, payload: { authorization: { from: PAYER, to, value: '10000', validAfter: '0', validBefore: '9999999999' } } })).toString('base64');

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  updates.length = 0;
  failUpdate = false;
});

describe('the live write of 2026-10-05, read from its raw event', () => {
  // Log data of tx 0x3566fca1bb42506a81685666dd6b7c37ca5077598f73a266341a17ee79f453f3 (Base Sepolia),
  // read 2026-10-06 through eth_getTransactionReceipt.
  const topics = [
    '0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc',
    '0x0000000000000000000000000000000000000000000000000000000000000ea3',
    '0x000000000000000000000000b24268884472e7613aa58d38c8813f7af1667382',
    '0xba5a93d572a22314cdb64ad7a5378fa53a5713c48d7aa04baa2685327a3cd78c',
  ];
  const data =
    '0x0000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000054f000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000002200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e68797065726461675f72657069640000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010746965723a45535441424c495348454400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006168747470733a2f2f747275737472657069642e6465762f6170692f76312f6167656e74732f66336566306266382d356364632d346661642d626365382d3531343466303164633237312f72657075746174696f6e2f7061796c6f61642e6a736f6e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006168747470733a2f2f747275737472657069642e6465762f6170692f76312f6167656e74732f66336566306266382d356364632d346661642d626365382d3531343466303164633237312f72657075746174696f6e2f7061796c6f61642e6a736f6e00000000000000000000000000000000000000000000000000000000000000';
  const iface = new ethers.Interface(((reputationAbiRaw as any).abi ?? reputationAbiRaw) as ethers.InterfaceAbi);
  const ev = iface.parseLog({ topics, data })!;

  it('committed to no hash and to a URI on a host that does not serve it', () => {
    expect(ev.name).toBe('NewFeedback');
    expect(ev.args.agentId.toString()).toBe('3747');
    expect(ev.args.value.toString()).toBe('1359');
    expect(ev.args.feedbackHash).toBe(ethers.ZeroHash);
    expect(ev.args.feedbackURI).toBe(`https://trustrepid.dev/api/v1/agents/${AGENT}/reputation/payload.json`);
  });

  it('so the verifier calls its file leg NOT_CHECKED and the whole write never VERIFIED', () => {
    const leg = assessFile(ev.args.feedbackHash, { status: 404, body: new Uint8Array() });
    expect(leg.outcome).toBe('NOT_CHECKED');
    expect(overall([{ leg: 'write', outcome: 'VERIFIED', detail: '' }, leg])).toBe('NOT_CHECKED');
  });
});

describe('the feedback file: built once, exact bytes, spec fields', () => {
  const input = {
    chainId: 84532,
    identityRegistry: IDENTITY,
    agentTokenId: '3747',
    clientAddress: OPERATOR,
    createdAt: '2026-10-06T12:00:00.000Z',
    value: 1359,
    valueDecimals: 0,
    tag1: 'hyperdag_repid',
    tag2: 'tier:ESTABLISHED',
    endpoint: 'https://example.invalid/feedback.json',
    proofOfPayment: null,
  };

  it('carries the MUST fields, CAIP-10 client address, and is the same bytes every time', () => {
    const a = buildFeedbackFile(input);
    expect(a).toBe(buildFeedbackFile(input));
    const parsed = JSON.parse(a);
    expect(parsed).toMatchObject({
      agentRegistry: `eip155:84532:${IDENTITY}`,
      agentId: 3747,
      clientAddress: `eip155:84532:${OPERATOR}`,
      createdAt: input.createdAt,
      value: 1359,
      valueDecimals: 0,
    });
    expect(Object.keys(parsed).slice(0, 6)).toEqual(['agentRegistry', 'agentId', 'clientAddress', 'createdAt', 'value', 'valueDecimals']);
    expect(parsed.proofOfPayment).toBeUndefined();
  });

  it('the hash is keccak256 of the exact UTF-8 bytes', () => {
    const f = buildFeedbackFile(input);
    expect(feedbackHashOf(f)).toBe(ethers.keccak256(ethers.toUtf8Bytes(f)));
    expect(feedbackHashOf(f)).not.toBe(feedbackHashOf(f.replace('1359', '1360')));
  });

  it('refuses a malformed address or token id rather than writing a file that cannot verify', () => {
    expect(() => buildFeedbackFile({ ...input, clientAddress: '0x0' })).toThrow();
    expect(() => buildFeedbackFile({ ...input, agentTokenId: 'abc' })).toThrow();
  });

  it('serves under the engine host, one file per event', () => {
    expect(feedbackFileUrl('https://h.example/', AGENT, EVENT)).toBe(`https://h.example/api/v1/agents/${AGENT}/reputation/feedback/${EVENT}.json`);
  });
});

describe('proofOfPayment only from a settlement that moved real money', () => {
  const real = { tx_hash: PAY_TX, payer_address: PAYER, x_payment_header: header(PAYEE), is_simulated: false };
  it('reads payer from the row and payee from the signed authorization', () => {
    expect(proofOfPaymentFrom(real, 84532)).toEqual({ fromAddress: PAYER, toAddress: PAYEE, chainId: '84532', txHash: PAY_TX });
    expect(payeeFromPaymentHeader(header(PAYEE))).toBe(PAYEE);
  });
  it.each([
    ['simulated', { ...real, is_simulated: true }],
    ['simulated unknown', { ...real, is_simulated: null }],
    ['no tx hash (authorized, never broadcast)', { ...real, tx_hash: null }],
    ['a short hash', { ...real, tx_hash: '0xmock_1' }],
    ['no payer', { ...real, payer_address: null }],
    ['unreadable header', { ...real, x_payment_header: 'not base64 json' }],
    ['no row', null],
  ])('%s → omitted, never guessed', (_why, row) => {
    expect(proofOfPaymentFrom(row as never, 84532)).toBeNull();
  });
});

describe('the worker stores the file before it writes, and reuses it on a retry', () => {
  const writer = { getOperatorAddress: async () => OPERATOR, chainId: 84532 };
  const agent = { id: AGENT, agent_name: 'trinity-x', current_repid: 1359.4, tier: 'ESTABLISHED', erc8004_token_id: '3747' };

  it('builds the file with proofOfPayment, stores it on the event row, and hashes those bytes', async () => {
    tables.x402_settlements = [{ id: 'pay-1', tx_hash: PAY_TX, payer_address: PAYER, x_payment_header: header(PAYEE), is_simulated: false }];
    tables.repid_events = [{ id: EVENT, subject_id: AGENT, event_data: { contract_id: 'c1', metadata: { x402_payment_id: 'pay-1' } } }];
    const out = await prepareFeedbackFile({ id: EVENT, event_data: tables.repid_events[0]!.event_data }, agent, writer);
    expect(out).not.toBeNull();
    expect(out!.uri).toBe(`https://repid-engine-production.up.railway.app/api/v1/agents/${AGENT}/reputation/feedback/${EVENT}.json`);
    expect(out!.hash).toBe(ethers.keccak256(ethers.toUtf8Bytes(out!.file)));
    expect(out!.value).toBe(1359);
    const stored = updates.find((u) => u.table === 'repid_events')!.patch.event_data;
    expect(stored.feedback_file).toBe(out!.file);
    expect(stored.contract_id).toBe('c1'); // nothing else on the row is lost
    expect(JSON.parse(out!.file).proofOfPayment).toEqual({ fromAddress: PAYER, toAddress: PAYEE, chainId: '84532', txHash: PAY_TX });
  });

  it('a row that already has a file reuses it, value and tier included, so a retried write commits to the same bytes', async () => {
    const earlier = buildFeedbackFile({
      chainId: 84532, identityRegistry: IDENTITY, agentTokenId: '3747', clientAddress: OPERATOR,
      createdAt: '2026-10-06T12:00:00.000Z', value: 1300, valueDecimals: 0, tag1: 'hyperdag_repid', tag2: 'tier:EARNING', endpoint: 'x', proofOfPayment: null,
    });
    const out = await prepareFeedbackFile({ id: EVENT, event_data: { feedback_file: earlier } }, agent, writer);
    expect(out).toEqual({ file: earlier, uri: expect.any(String), hash: feedbackHashOf(earlier), value: 1300, tier: 'EARNING' });
    expect(updates).toHaveLength(0);
  });

  it('when the file cannot be stored, no write is made (null), so the URI never 404s for a landed write', async () => {
    failUpdate = true;
    const out = await prepareFeedbackFile({ id: EVENT, event_data: {} }, agent, writer);
    expect(out).toBeNull();
  });
});

describe('GET /api/v1/agents/:id/reputation/feedback/:eventId.json', () => {
  const app = express();
  app.use('/api/v1', createAgentsReputationRouter(fakeDb as never));
  // Not canonical on purpose (spaces): a route that parsed and re-serialised would change the bytes.
  const file = '{"agentRegistry": "eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e", "agentId": 3747}';

  it('serves the stored string byte for byte, immutable, and its keccak256 is the hash', async () => {
    tables.repid_events = [{ id: EVENT, subject_id: AGENT, event_data: { feedback_file: file } }];
    const res = await request(app).get(`/api/v1/agents/${AGENT}/reputation/feedback/${EVENT}.json`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toContain('immutable');
    expect((res.body as Buffer).toString('utf8')).toBe(file);
    expect(ethers.keccak256(res.body as Buffer)).toBe(feedbackHashOf(file));
  });

  it.each([
    ['no file on the row', { id: EVENT, subject_id: AGENT, event_data: {} }, AGENT],
    ['the event belongs to another agent', { id: EVENT, subject_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', event_data: { feedback_file: file } }, AGENT],
  ])('404 when %s', async (_why, row, agentId) => {
    tables.repid_events = [row];
    const res = await request(app).get(`/api/v1/agents/${agentId}/reputation/feedback/${EVENT}.json`);
    expect(res.status).toBe(404);
  });

  it.each([
    ['an event id that is not a number', `/api/v1/agents/${AGENT}/reputation/feedback/not-a-number.json`],
    ['an event id that is a UUID', `/api/v1/agents/${AGENT}/reputation/feedback/0b6a1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3.json`],
    ['an agent id that is not a UUID', `/api/v1/agents/not-a-uuid/reputation/feedback/${EVENT}.json`],
  ])('404 for %s, without a query', async (_why, path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(404);
  });
});

describe('the verifier, leg by leg', () => {
  const ev: DecodedFeedback = {
    agentId: '3747', clientAddress: OPERATOR, value: '1359', valueDecimals: 0,
    tag1: 'hyperdag_repid', tag2: 'tier:ESTABLISHED', endpoint: 'x', feedbackURI: 'x', feedbackHash: '',
  };
  const file = buildFeedbackFile({
    chainId: 84532, identityRegistry: IDENTITY, agentTokenId: '3747', clientAddress: OPERATOR,
    createdAt: '2026-10-06T12:00:00.000Z', value: 1359, valueDecimals: 0, tag1: 'hyperdag_repid', tag2: 'tier:ESTABLISHED', endpoint: 'x',
    proofOfPayment: { fromAddress: PAYER, toAddress: PAYEE, chainId: '84532', txHash: PAY_TX },
  });
  const bytes = ethers.toUtf8Bytes(file);
  const transfer = (from: string, to: string) => ({
    address: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    topics: [ethers.id('Transfer(address,address,uint256)'), ethers.zeroPadValue(from, 32), ethers.zeroPadValue(to, 32)],
  });

  it('write: succeeded, to the registry, with NewFeedback', () => {
    expect(assessWrite({ status: 1, to: REGISTRY }, REGISTRY, ev).outcome).toBe('VERIFIED');
    expect(assessWrite({ status: 0, to: REGISTRY }, REGISTRY, ev).outcome).toBe('FAILED');
    expect(assessWrite({ status: 1, to: PAYEE }, REGISTRY, ev).outcome).toBe('FAILED');
    expect(assessWrite(null, REGISTRY, null).outcome).toBe('NOT_CHECKED');
  });

  it('identity: an owner is VERIFIED, none is FAILED, an unreadable call is NOT_CHECKED', () => {
    expect(assessIdentity(OPERATOR, null).outcome).toBe('VERIFIED');
    expect(assessIdentity(null, null).outcome).toBe('FAILED');
    expect(assessIdentity(null, 'timeout').outcome).toBe('NOT_CHECKED');
  });

  it('file: hash over the served bytes; a changed byte fails; a 404 fails; unreachable is NOT_CHECKED', () => {
    const h = ethers.keccak256(bytes);
    expect(assessFile(h, { status: 200, body: bytes }).outcome).toBe('VERIFIED');
    expect(assessFile(h, { status: 200, body: ethers.toUtf8Bytes(file + ' ') }).outcome).toBe('FAILED');
    expect(assessFile(h, { status: 404, body: new Uint8Array() }).outcome).toBe('FAILED');
    expect(assessFile(h, { error: 'CONNECT 403' }).outcome).toBe('NOT_CHECKED');
  });

  it('fields: the file must agree with the event', () => {
    const parsed = JSON.parse(file);
    expect(assessFields(parsed, ev, 84532, IDENTITY).outcome).toBe('VERIFIED');
    expect(assessFields({ ...parsed, value: 1400 }, ev, 84532, IDENTITY)).toMatchObject({ outcome: 'FAILED', detail: expect.stringContaining('value') });
    expect(assessFields({ ...parsed, clientAddress: `eip155:84532:${PAYER}` }, ev, 84532, IDENTITY).outcome).toBe('FAILED');
    expect(assessFields(null, ev, 84532, IDENTITY).outcome).toBe('NOT_CHECKED');
  });

  it('payment: matched on the Transfer log (payer → payee), not on the facilitator that sent the tx', () => {
    const proof = JSON.parse(file).proofOfPayment;
    expect(assessPayment(proof, { status: 1, logs: [transfer(PAYER, PAYEE)] }, 84532).outcome).toBe('VERIFIED');
    expect(assessPayment(proof, { status: 1, logs: [transfer(PAYER, OPERATOR)] }, 84532).outcome).toBe('FAILED');
    expect(assessPayment(proof, null, 84532).outcome).toBe('FAILED');
    expect(assessPayment(proof, { error: 'rpc down' }, 84532).outcome).toBe('NOT_CHECKED');
    expect(assessPayment(null, null, 84532).outcome).toBe('NOT_CHECKED');
  });

  it('VERIFIED only when every leg is; exit codes 0 / 2 / 1', () => {
    const v = { leg: 'write' as const, outcome: 'VERIFIED' as const, detail: '' };
    expect(overall([v, v])).toBe('VERIFIED');
    expect(overall([v, { ...v, outcome: 'NOT_CHECKED' }])).toBe('NOT_CHECKED');
    expect(overall([v, { ...v, outcome: 'NOT_CHECKED' }, { ...v, outcome: 'FAILED' }])).toBe('FAILED');
    expect([exitCodeOf('VERIFIED'), exitCodeOf('NOT_CHECKED'), exitCodeOf('FAILED')]).toEqual([0, 2, 1]);
  });
});

describe('the verifier never fetches an attacker-chosen destination (Strix on #1225, CWE-918)', () => {
  it('fetches our own feedback URL', () => {
    expect(fetchTargetProblem(`https://repid-engine-production.up.railway.app/api/v1/agents/${AGENT}/reputation/feedback/${EVENT}.json`)).toBeNull();
  });
  it.each([
    'http://example.com/f.json',
    'ipfs://bafy/f.json',
    'file:///etc/passwd',
    'https://user:pw@example.com/f.json',
    'https://localhost/f.json',
    'https://api.localhost/f.json',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://169.254.169.254/latest/meta-data/',
    'https://127.0.0.1/f.json',
    'https://10.0.0.5/f.json',
    'https://172.16.1.1/f.json',
    'https://192.168.1.1/f.json',
    'https://100.64.0.1/f.json',
    'https://[::1]/f.json',
    'https://[fd00::1]/f.json',
    'https://[fe80::1]/f.json',
    'https://[::ffff:127.0.0.1]/f.json',
    'https://[::ffff:a9fe:a9fe]/f.json',
    'https://[64:ff9b::a9fe:a9fe]/f.json',
    'not a url',
  ])('refuses %s', (url) => {
    expect(fetchTargetProblem(url)).not.toBeNull();
  });
  it('classifies resolved addresses: only globally routable ones are public', () => {
    expect(isPublicAddress('104.18.1.1')).toBe(true);
    expect(isPublicAddress('2606:4700::1111')).toBe(true);
    expect(isPublicAddress('::ffff:6812:101')).toBe(true); // 104.18.1.1, hex-mapped
    for (const a of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.0.1', '0.0.0.0', '::1', 'fd12::1', 'fe80::1', '::ffff:10.0.0.1', '224.0.0.1']) {
      expect(isPublicAddress(a)).toBe(false);
    }
  });
});
