/**
 * Mocked unit tests for agent-wallet-manager.
 * db is mocked so no network/Supabase is touched. AGENT_KEY_MASTER is set so
 * the real AES-GCM crypto path runs (round-trip verifies decrypt matches).
 */

// --- chainable supabase-style db mock --------------------------------------
const insertMock = jest.fn().mockResolvedValue({ error: null });
const updateEqMock = jest.fn().mockResolvedValue({ error: null });
const updateMock = jest.fn().mockReturnValue({ eq: updateEqMock });

// select().eq().order().limit().maybeSingle() chain for getDecryptedPrivateKey
let secretRow: any = null;
const maybeSingleMock = jest.fn().mockImplementation(() => Promise.resolve({ data: secretRow, error: null }));
const limitMock = jest.fn().mockReturnValue({ maybeSingle: maybeSingleMock });
const orderMock = jest.fn().mockReturnValue({ limit: limitMock });
const selectEqMock = jest.fn().mockReturnValue({ order: orderMock });
const selectMock = jest.fn().mockReturnValue({ eq: selectEqMock });

const fromMock = jest.fn().mockImplementation(() => ({
  insert: insertMock,
  update: updateMock,
  select: selectMock,
}));

jest.mock('../src/db', () => ({ db: { from: (...a: any[]) => fromMock(...a) } }));

import {
  provisionWallet,
  persistProvisionedWallet,
  getDecryptedPrivateKey,
  fundWithTestnetETH,
} from '../src/services/agent-wallet-manager';
import { encryptPrivateKey } from '../src/services/agent-key-crypto';

const AGENT_ID = '11111111-1111-1111-1111-111111111111';

describe('agent-wallet-manager', () => {
  const originalMaster = process.env.AGENT_KEY_MASTER;

  beforeEach(() => {
    process.env.AGENT_KEY_MASTER = 'c'.repeat(64);
    jest.clearAllMocks();
    secretRow = null;
  });

  afterAll(() => {
    if (originalMaster === undefined) delete process.env.AGENT_KEY_MASTER;
    else process.env.AGENT_KEY_MASTER = originalMaster;
  });

  it('provisions a random wallet with a valid address and encrypted key', () => {
    const p = provisionWallet();
    expect(p.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(p.keyVersion).toBe(1);
    expect(p.encrypted.ciphertext).toBeTruthy();
  });

  it('persists wallet: inserts agent_secrets and updates wallet_address', async () => {
    const p = provisionWallet();
    const res = await persistProvisionedWallet(AGENT_ID, p);
    expect(res.ok).toBe(true);
    expect(res.address).toBe(p.address);

    expect(fromMock).toHaveBeenCalledWith('agent_secrets');
    expect(fromMock).toHaveBeenCalledWith('repid_agents');
    const insertArg = insertMock.mock.calls[0][0];
    expect(insertArg.agent_id).toBe(AGENT_ID);
    expect(insertArg.key_version).toBe(1);
    const updateArg = updateMock.mock.calls[0][0];
    expect(updateArg.wallet_address).toBe(p.address);
  });

  it('surfaces an agent_secrets insert error without throwing', async () => {
    insertMock.mockResolvedValueOnce({ error: { message: 'boom' } });
    const res = await persistProvisionedWallet(AGENT_ID, provisionWallet());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('boom');
  });

  it('getDecryptedPrivateKey returns null when no secret row', async () => {
    secretRow = null;
    const pk = await getDecryptedPrivateKey(AGENT_ID);
    expect(pk).toBeNull();
  });

  it('getDecryptedPrivateKey decrypts a stored blob round-trip', async () => {
    const realPk = '0x' + '7'.repeat(64);
    secretRow = { encrypted_private_key: encryptPrivateKey(realPk), key_version: 1 };
    const pk = await getDecryptedPrivateKey(AGENT_ID);
    expect(pk).toBe(realPk);
  });

  it('fundWithTestnetETH is a flagged stub (does not fund, does not throw)', async () => {
    const p = provisionWallet();
    const res = await fundWithTestnetETH(p.address);
    expect(res.funded).toBe(false);
    expect(res.stub).toBe(true);
  });

  it('fundWithTestnetETH rejects an invalid address', async () => {
    const res = await fundWithTestnetETH('not-an-address');
    expect(res.funded).toBe(false);
    expect(res.note).toContain('invalid address');
  });
});
