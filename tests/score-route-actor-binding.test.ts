/**
 * score route actor-binding (CWE-862 / CWE-345, Strix #1341; fixed 2026-10-13).
 *
 * The scoring ACTOR must be the AUTHENTICATED PRINCIPAL (req.agent_id, set by authMiddleware for a
 * per-agent bound key), never a caller-supplied body field. This is the second, INDEPENDENT barrier
 * to the IDENTITY_FIELDS fix: even if a bound key reaches the handler with a body `agentId` that is
 * not its own principal (e.g. a future regression upstream), the route refuses rather than forward a
 * foreign agentId — including the confirmed-outcome shape {agentId:B, confirmationReceiptId} — to
 * updateRepId. So a key bound to A can never move B's score.
 *
 * NON-VACUITY: this exercises the ROUTE guard alone (updateRepId is mocked). Removing the guard in
 * src/routes/score.ts makes the attack test below forward {agentId:B} to updateRepId → RED.
 */
jest.mock('../src/engine/repid-update', () => ({ updateRepId: jest.fn() }));

import { scoreHandler } from '../src/routes/score';
import { updateRepId } from '../src/engine/repid-update';

const updateRepIdMock = updateRepId as jest.Mock;

const A = 'aaaaaaaa-1111-2222-3333-444444444444'; // authenticated principal (bound key)
const B = 'bbbbbbbb-1111-2222-3333-444444444444'; // victim

function invoke(body: Record<string, unknown>, agent_id?: string) {
  const req: any = { body, ...(agent_id !== undefined ? { agent_id } : {}) };
  const res: any = {
    statusCode: 0,
    payload: null as any,
    status(code: number) { this.statusCode = code; return this; },
    json(p: any) { this.payload = p; return this; },
  };
  return Promise.resolve(scoreHandler(req, res)).then(() => res);
}

beforeEach(() => {
  updateRepIdMock.mockReset();
  updateRepIdMock.mockResolvedValue({ delta: 0, repIdAfter: 1000 });
});

describe('a bound key cannot move another agent via a body agentId', () => {
  it('THE ATTACK: principal A + {agentId:B, confirmationReceiptId} → 403, updateRepId NEVER called', async () => {
    const res = await invoke(
      { agentId: B, eventType: 'STAKE', confirmedOutcome: { confirmationReceiptId: 'rcpt-B' } },
      A,
    );
    expect(res.statusCode).toBe(403);
    expect(res.payload.field).toBe('body.agentId');
    // The actor string never reached the engine — B's score cannot move.
    expect(updateRepIdMock).not.toHaveBeenCalled();
  });

  it('a bound key scoring ITSELF (agentId === principal) is allowed and scores', async () => {
    const res = await invoke({ agentId: A, eventType: 'STAKE' }, A);
    expect(res.statusCode).toBe(0); // handler returned res.json(...) without setting an error status
    expect(updateRepIdMock).toHaveBeenCalledTimes(1);
    expect(updateRepIdMock.mock.calls[0][0].agentId).toBe(A);
  });
});

describe('existing (non-bound) scoring behaviour is unchanged', () => {
  it('an env/operator key (no req.agent_id) may still score any agentId — behaviour unchanged', async () => {
    const res = await invoke({ agentId: B, eventType: 'STAKE' }); // no principal set
    expect(res.statusCode).toBe(0);
    expect(updateRepIdMock).toHaveBeenCalledTimes(1);
    expect(updateRepIdMock.mock.calls[0][0].agentId).toBe(B);
  });

  it('the 400 validation (missing agentId / eventType) still fires before the guard', async () => {
    const res = await invoke({ eventType: 'STAKE' }, A);
    expect(res.statusCode).toBe(400);
    expect(updateRepIdMock).not.toHaveBeenCalled();
  });
});
