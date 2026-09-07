/**
 * tool-receipt-route.test.ts — POST /api/v1/tool-receipt (mint) + GET /verified (feed).
 * Mint goes via the RPC (never a direct insert); the verified feed returns only
 * cryptographically-verified rows + the verdict headline. db is mocked; no network.
 */
import express from 'express';
import request from 'supertest';

const rpc = jest.fn();
const from = jest.fn();
jest.mock('../src/db', () => ({ db: { rpc: (...a: any[]) => rpc(...a), from: (...a: any[]) => from(...a) } }));

import toolReceiptRouter from '../src/routes/v1/tool-receipt';

const app = express();
app.use(express.json());
app.use('/api/v1/tool-receipt', toolReceiptRouter);

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const good = { agent_id: 'trinity-x', tool_name: 'hal-evaluate', input_hash: HEX_A, output_hash: HEX_B };

beforeEach(() => { rpc.mockReset(); from.mockReset(); });

describe('POST /api/v1/tool-receipt', () => {
  it('mints via write_tool_receipt RPC and returns 201 + receipt_id', async () => {
    rpc.mockResolvedValue({ data: 'rcpt-uuid', error: null });
    const res = await request(app).post('/api/v1/tool-receipt').send(good);
    expect(res.status).toBe(201);
    expect(res.body.receipt_id).toBe('rcpt-uuid');
    expect(rpc).toHaveBeenCalledWith(
      'write_tool_receipt',
      expect.objectContaining({ p_input_hash: HEX_A, p_output_hash: HEX_B, p_agent_id: 'trinity-x', p_tool_name: 'hal-evaluate' }),
    );
  });

  it('400 on missing agent_id/tool_name — RPC never called', async () => {
    const res = await request(app).post('/api/v1/tool-receipt').send({ input_hash: HEX_A, output_hash: HEX_B });
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('400 on a malformed hash — RPC never called', async () => {
    const res = await request(app).post('/api/v1/tool-receipt').send({ ...good, input_hash: 'not-hex' });
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('502 when the mint fails (e.g. unprovisioned signing key)', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'RECEIPT_SIGNING_KEY_UNPROVISIONED' } });
    const res = await request(app).post('/api/v1/tool-receipt').send(good);
    expect(res.status).toBe(502);
  });
});

describe('GET /api/v1/tool-receipt/verified', () => {
  it('returns ONLY verified receipts + a verdict headline (quarantined counted, not shown)', async () => {
    const rows = [
      { verified: true, quarantine_reason: null, tool_name: 'trustshell.mvp.selftest' },
      { verified: false, quarantine_reason: 'legacy_sig_v1' },
      { verified: false, quarantine_reason: 'legacy_sig_v1' },
      { verified: false, quarantine_reason: 'no_minter_direct_insert' },
    ];
    const allRows = { data: rows, error: null };                                   // verifiedReceiptStats: await select()
    const verifiedOnly = { data: [{ tool_name: 'trustshell.mvp.selftest' }], error: null }; // listVerifiedReceipts: await limit()
    const q: any = { eq: () => q, order: () => q, limit: () => Promise.resolve(verifiedOnly), then: (r: any) => r(allRows) };
    from.mockReturnValue({ select: () => q });

    const res = await request(app).get('/api/v1/tool-receipt/verified');
    expect(res.status).toBe(200);
    expect(res.body.stats.total).toBe(4);
    expect(res.body.stats.verified).toBe(1);
    expect(res.body.stats.quarantined).toBe(3);
    expect(res.body.stats.by_reason.legacy_sig_v1).toBe(2);
    expect(res.body.stats.by_reason.no_minter_direct_insert).toBe(1);
    expect(res.body.count).toBe(1);
    expect(res.body.receipts).toHaveLength(1);
  });
});
