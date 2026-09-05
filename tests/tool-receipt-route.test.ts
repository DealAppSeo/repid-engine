/**
 * tool-receipt-route.test.ts — POST /api/v1/tool-receipt.
 * Verifies it mints via the RPC (never a direct insert), validates the body, and
 * maps failures to honest status codes. db is mocked; no network, no DB.
 */
import express from 'express';
import request from 'supertest';

const rpc = jest.fn();
jest.mock('../src/db', () => ({ db: { rpc: (...a: any[]) => rpc(...a) } }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
import toolReceiptRouter from '../src/routes/v1/tool-receipt';

const app = express();
app.use(express.json());
app.use('/api/v1/tool-receipt', toolReceiptRouter);

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const good = { agent_id: 'trinity-x', tool_name: 'hal-evaluate', input_hash: HEX_A, output_hash: HEX_B };

beforeEach(() => rpc.mockReset());

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
