/**
 * BYOK custody + human↔agent binding.
 *
 * The two properties worth testing here are not the happy paths. They are:
 *   1. a stored key can never come back out, and
 *   2. an identity can never be CLAIMED — only proven.
 *
 * (2) is the one this repo has already got wrong once, in the f2-authz OR-chain
 * bypass. Wallet addresses are public, so any design that reads identity from a
 * header hands someone else's provider keys to whoever reads a block explorer.
 */
import { Wallet } from 'ethers';
import express from 'express';
import request from 'supertest';

const mockRows: Record<string, any> = {};
const mockInserted: any[] = [];
const mockUpdates: any[] = [];

jest.mock('../src/db', () => {
  const chain = (table: string) => {
    const c: any = {
      _filters: {} as Record<string, unknown>,
      select: () => c,
      eq: (k: string, v: unknown) => { c._filters[k] = v; return c; },
      ilike: (k: string, v: unknown) => { c._filters[k] = v; return c; },
      is: () => c,
      not: () => c,
      order: () => c,
      limit: () => Promise.resolve({ data: mockRows[table] ? [mockRows[table]] : [], error: null }),
      maybeSingle: () => Promise.resolve({ data: mockRows[table] ?? null, error: null }),
      insert: (row: any) => {
        mockInserted.push({ table, row });
        const err = mockRows.__insertError ?? null;
        return {
          select: () => ({
            maybeSingle: () => Promise.resolve({ data: err ? null : { ...row, bound_at: 'T', created_at: 'T' }, error: err }),
          }),
        };
      },
      update: (row: any) => { mockUpdates.push({ table, row }); return c; },
      then: (r: any) => r({ data: [], error: null }),
    };
    return c;
  };
  return { db: { from: (t: string) => chain(t) } };
});

// Encryption needs a master key; any ≥32-char string is accepted (sha256'd).
process.env.AGENT_KEY_MASTER = 'test-master-key-for-byok-custody-suite-0123456789';
process.env.BYOK_CUSTODY_ENABLED = 'true';
process.env.HUMAN_AGENT_BIND_ENABLED = 'true';

// The agent's own key — the second side of a bind. Keys are hashed in agent_api_keys; here a key
// is valid for exactly the agent named after 'key-for-'.
jest.mock('../src/auth/api-keys', () => {
  const actual = jest.requireActual('../src/auth/api-keys');
  return {
    ...actual,
    validateAgentApiKey: jest.fn(async (key: string) =>
      key.startsWith('key-for-') ? { agent_id: key.slice('key-for-'.length), scopes: [] } : null,
    ),
  };
});

// Probe is network I/O — stubbed so the suite is deterministic and offline.
jest.mock('../src/services/provider-key-probe', () => {
  const actual = jest.requireActual('../src/services/provider-key-probe');
  return { ...actual, probeProviderKey: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const probeMod = jest.requireMock('../src/services/provider-key-probe');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const custody = require('../src/services/byok-custody');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const byokRouter = require('../src/routes/v1/byok').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { authMessage } = require('../src/routes/v1/byok');

const OWNER = { kind: 'human_sbt' as const, id: 'human-1' };
const SECRET_KEY = 'sk-THIS-MUST-NEVER-APPEAR-IN-ANY-RESPONSE';

beforeEach(() => {
  mockInserted.length = 0;
  mockUpdates.length = 0;
  for (const k of Object.keys(mockRows)) delete mockRows[k];
  probeMod.probeProviderKey.mockReset();
});

describe('a key is verified before it is stored, never after', () => {
  it('refuses a key the provider rejects', async () => {
    probeMod.probeProviderKey.mockResolvedValue({ status: 'DEAD', detail: 'HTTP 401 — credential rejected' });
    const r = await custody.storeProviderKey(OWNER, 'groq', SECRET_KEY);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('probe_failed');
    expect(mockInserted).toHaveLength(0); // nothing written
  });

  it('refuses — but does NOT condemn — a key it could not reach', async () => {
    // Storing optimistically records "this works" on evidence that does not say
    // so. Reporting DEAD sends someone to rotate a good key. Neither is right.
    probeMod.probeProviderKey.mockResolvedValue({ status: 'INCONCLUSIVE', detail: 'timeout 12000ms' });
    const r = await custody.storeProviderKey(OWNER, 'groq', SECRET_KEY);
    expect(r.reason).toBe('probe_inconclusive');
    expect(r.detail).toMatch(/NOT treated as dead/i);
    expect(mockInserted).toHaveLength(0);
  });

  it('stores only after a LIVE probe, and encrypts the value', async () => {
    probeMod.probeProviderKey.mockResolvedValue({ status: 'LIVE', detail: 'HTTP 200' });
    const r = await custody.storeProviderKey(OWNER, 'groq', SECRET_KEY);
    expect(r.ok).toBe(true);
    expect(mockInserted).toHaveLength(1);
    const written = JSON.stringify(mockInserted[0].row);
    expect(written).not.toContain(SECRET_KEY); // ciphertext, not plaintext
    expect(mockInserted[0].row.encrypted_key).toHaveProperty('ciphertext');
    expect(mockInserted[0].row.verify_status).toBe('LIVE');
  });

  it('never returns the key, on success or failure', async () => {
    probeMod.probeProviderKey.mockResolvedValue({ status: 'LIVE', detail: 'HTTP 200' });
    const ok = await custody.storeProviderKey(OWNER, 'groq', SECRET_KEY);
    probeMod.probeProviderKey.mockResolvedValue({ status: 'DEAD', detail: 'HTTP 401' });
    const bad = await custody.storeProviderKey(OWNER, 'groq', SECRET_KEY);
    for (const r of [ok, bad]) {
      const s = JSON.stringify(r);
      expect(s).not.toContain(SECRET_KEY);
      // Not even a fragment — a "safe" prefix still narrows a brute force.
      expect(s).not.toContain(SECRET_KEY.slice(0, 8));
    }
  });

  it('is inert when the flag is off', async () => {
    const prev = process.env.BYOK_CUSTODY_ENABLED;
    process.env.BYOK_CUSTODY_ENABLED = 'false';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fresh = require('../src/services/byok-custody');
    const r = await fresh.storeProviderKey(OWNER, 'groq', SECRET_KEY);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('disabled');
    process.env.BYOK_CUSTODY_ENABLED = prev;
    jest.resetModules();
  });
});

describe('identity is proven, never claimed', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', byokRouter);

  it('rejects a request that just asserts a wallet in a header', async () => {
    // This is the attack: wallet addresses are public. If a header were trusted,
    // reading a block explorer would be enough to list someone's keys.
    const res = await request(app).get('/api/v1/byok/keys').set('x-hd-wallet', '0xVictimWalletAddress');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('signature_required');
  });

  it('rejects a signature that recovers to a different wallet', async () => {
    const attacker = Wallet.createRandom();
    const victim = '0x000000000000000000000000000000000000dEaD';
    const ts = new Date().toISOString();
    // Attacker signs the victim's statement — recovery will not match.
    const sig = await attacker.signMessage(authMessage('GET', '/api/v1/byok/keys', victim, ts));
    const res = await request(app)
      .get('/api/v1/byok/keys')
      .set('x-hd-wallet', victim).set('x-hd-timestamp', ts).set('x-hd-signature', sig);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('bad_signature');
  });

  it('rejects a valid signature replayed onto a different route', async () => {
    const w = Wallet.createRandom();
    const ts = new Date().toISOString();
    // Signed for a harmless read...
    const sig = await w.signMessage(authMessage('GET', '/api/v1/byok/keys', w.address, ts));
    // ...replayed at a destructive write. The path is inside the signed text.
    const res = await request(app)
      .delete('/api/v1/byok/keys/groq')
      .set('x-hd-wallet', w.address).set('x-hd-timestamp', ts).set('x-hd-signature', sig);
    expect(res.status).toBe(401);
  });

  it('rejects a stale signature', async () => {
    const w = Wallet.createRandom();
    const ts = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const sig = await w.signMessage(authMessage('GET', '/api/v1/byok/keys', w.address, ts));
    const res = await request(app)
      .get('/api/v1/byok/keys')
      .set('x-hd-wallet', w.address).set('x-hd-timestamp', ts).set('x-hd-signature', sig);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('stale_signature');
  });

  it('a proven wallet with no account here still gets nothing', async () => {
    const w = Wallet.createRandom();
    const ts = new Date().toISOString();
    const sig = await w.signMessage(authMessage('GET', '/api/v1/byok/keys', w.address, ts));
    // human_sbt_registry lookup returns nothing.
    const res = await request(app)
      .get('/api/v1/byok/keys')
      .set('x-hd-wallet', w.address).set('x-hd-timestamp', ts).set('x-hd-signature', sig);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('no_account');
  });
});

describe('getting an account is self-serve, but not a faucet', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', byokRouter);

  it('is inert until deliberately enabled — a new PUBLIC write surface does not ship on by merging', async () => {
    const res = await request(app).post('/api/v1/account/connect').send({ display_name: 'x' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('disabled');
  });

  it('checks the flag BEFORE doing any work, so a disabled endpoint is not a free oracle', async () => {
    // Answering "no account here" to an unauthenticated caller would leak
    // whether a wallet is registered. Disabled means disabled.
    const res = await request(app)
      .post('/api/v1/account/connect')
      .set('x-hd-wallet', '0x000000000000000000000000000000000000dEaD')
      .send({});
    expect(res.status).toBe(503);
  });
});

describe('binding proves ownership rather than asserting it', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bind = require('../src/services/human-agent-binding');

  it('puts the agent id inside the signed message, so a signature cannot be moved', () => {
    const a = bind.bindingMessage({ wallet: '0xabc', agentId: 'agent-1', scope: 'ownership' });
    const b = bind.bindingMessage({ wallet: '0xabc', agentId: 'agent-2', scope: 'ownership' });
    expect(a).not.toEqual(b);
    expect(a).toContain('agent-1');
  });

  it('refuses a binding whose signature does not match the registered wallet', async () => {
    mockRows.human_sbt_registry = { token_id: 'h1', wallet_address: '0x000000000000000000000000000000000000dEaD' };
    mockRows.repid_agents = { id: 'agent-1', agent_name: 'test' };
    const wrong = await Wallet.createRandom().signMessage('something else entirely');
    const r = await bind.bindOwnerToAgent({ owner: { kind: 'human_sbt', id: 'h1' }, agentId: 'agent-1', signature: wrong, agentKey: 'key-for-agent-1' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad_signature');
  });

  it('accepts a correct signature over the exact agent and scope', async () => {
    const w = Wallet.createRandom();
    mockRows.human_sbt_registry = { token_id: 'h1', wallet_address: w.address };
    mockRows.repid_agents = { id: 'agent-1', agent_name: 'test' };
    const sig = await w.signMessage(bind.bindingMessage({ wallet: w.address, agentId: 'agent-1', scope: 'ownership' }));
    const r = await bind.bindOwnerToAgent({ owner: { kind: 'human_sbt', id: 'h1' }, agentId: 'agent-1', signature: sig, agentKey: 'key-for-agent-1' });
    expect(r.ok).toBe(true);
  });

  it('reports a second live owner as a rule, not as a database error', async () => {
    const w = Wallet.createRandom();
    mockRows.human_sbt_registry = { token_id: 'h1', wallet_address: w.address };
    mockRows.repid_agents = { id: 'agent-1', agent_name: 'test' };
    mockRows.__insertError = { message: 'duplicate key value violates unique constraint (23505)' };
    const sig = await w.signMessage(bind.bindingMessage({ wallet: w.address, agentId: 'agent-1', scope: 'ownership' }));
    const r = await bind.bindOwnerToAgent({ owner: { kind: 'human_sbt', id: 'h1' }, agentId: 'agent-1', signature: sig, agentKey: 'key-for-agent-1' });
    expect(r.reason).toBe('already_bound');
    expect(r.detail).toMatch(/already has a live owner/i);
    delete mockRows.__insertError;
  });

  /**
   * The first version required a proof-of-human SBT. Live counts said that was
   * wrong: 73 builders (all wallet-bearing) against 5 SBT humans, so ownership
   * was unreachable for ~94% of real accounts — including every viewer who
   * follows the video. The fix must widen WHO can own without weakening WHAT a
   * proof-of-human means.
   */
  it('lets a builder — the identity almost everyone actually has — own an agent', async () => {
    const w = Wallet.createRandom();
    mockRows.builders = { id: 'b1', address: w.address };
    mockRows.repid_agents = { id: 'agent-1', agent_name: 'test' };
    const sig = await w.signMessage(bind.bindingMessage({ wallet: w.address, agentId: 'agent-1', scope: 'ownership' }));
    const r = await bind.bindOwnerToAgent({ owner: { kind: 'builder', id: 'b1' }, agentId: 'agent-1', signature: sig, agentKey: 'key-for-agent-1' });
    expect(r.ok).toBe(true);
    const row = mockInserted.find((i) => i.table === 'human_agent_bindings')!.row;
    expect(row.owner_kind).toBe('builder');
    expect(row.builder_id).toBe('b1');
    // The CHECK constraint permits exactly one owner reference.
    expect(row.human_token_id).toBeNull();
  });

  it('takes the wallet from the ACCOUNT, not from the caller', async () => {
    // Otherwise anyone could bind on someone else's account by naming a wallet
    // they happen to control.
    const attacker = Wallet.createRandom();
    mockRows.builders = { id: 'b1', address: '0x000000000000000000000000000000000000dEaD' };
    mockRows.repid_agents = { id: 'agent-1', agent_name: 'test' };
    const sig = await attacker.signMessage(
      bind.bindingMessage({ wallet: attacker.address, agentId: 'agent-1', scope: 'ownership' }),
    );
    const r = await bind.bindOwnerToAgent({ owner: { kind: 'builder', id: 'b1' }, agentId: 'agent-1', signature: sig, agentKey: 'key-for-agent-1' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad_signature');
  });

  /**
   * THE HOLE THIS CLOSES [2026-10-07]. A bind used to prove only the wallet: the agent check was
   * "does it exist". So any account could claim anyone's unclaimed agent with its own wallet, and
   * the one-live-owner index then locked the creator out. A valid wallet signature must no longer
   * be enough on its own.
   */
  describe('two sides: the wallet AND the agent', () => {
    function setup() {
      const w = Wallet.createRandom();
      mockRows.builders = { id: 'b1', address: w.address };
      mockRows.repid_agents = { id: 'agent-1', agent_name: 'test' };
      return w;
    }
    const sign = (w: Wallet) => w.signMessage(bind.bindingMessage({ wallet: w.address, agentId: 'agent-1', scope: 'ownership' }));

    it('a perfect wallet signature without the agent key binds nothing', async () => {
      const w = setup();
      const r = await bind.bindOwnerToAgent({ owner: { kind: 'builder', id: 'b1' }, agentId: 'agent-1', signature: await sign(w) });
      expect(r).toMatchObject({ ok: false, reason: 'agent_key_required' });
      expect(mockInserted.some((i) => i.table === 'human_agent_bindings')).toBe(false);
    });

    it("another agent's key binds nothing — holding A does not prove you hold B", async () => {
      const w = setup();
      const r = await bind.bindOwnerToAgent({ owner: { kind: 'builder', id: 'b1' }, agentId: 'agent-1', signature: await sign(w), agentKey: 'key-for-agent-2' });
      expect(r).toMatchObject({ ok: false, reason: 'agent_key_mismatch' });
      expect(mockInserted.some((i) => i.table === 'human_agent_bindings')).toBe(false);
    });

    it('an unknown or revoked key binds nothing', async () => {
      const w = setup();
      const r = await bind.bindOwnerToAgent({ owner: { kind: 'builder', id: 'b1' }, agentId: 'agent-1', signature: await sign(w), agentKey: 'made-up' });
      expect(r).toMatchObject({ ok: false, reason: 'agent_key_mismatch' });
    });

    it('the agent key alone binds nothing either — the wallet must still sign', async () => {
      setup();
      const r = await bind.bindOwnerToAgent({ owner: { kind: 'builder', id: 'b1' }, agentId: 'agent-1', agentKey: 'key-for-agent-1' });
      expect(r).toMatchObject({ ok: false, reason: 'bad_signature' });
    });

    it('both together bind', async () => {
      const w = setup();
      const r = await bind.bindOwnerToAgent({ owner: { kind: 'builder', id: 'b1' }, agentId: 'agent-1', signature: await sign(w), agentKey: 'key-for-agent-1' });
      expect(r.ok).toBe(true);
    });

    it('the route takes the key from the x-agent-key header and never echoes it', async () => {
      const w = setup();
      const app = express();
      app.use(express.json());
      app.use('/api/v1', byokRouter);
      const ts = new Date().toISOString();
      const headers = (agentKey?: string) => {
        const h: Record<string, string> = { 'x-hd-wallet': w.address, 'x-hd-timestamp': ts };
        if (agentKey) h['x-agent-key'] = agentKey;
        return h;
      };
      const authSig = await w.signMessage(authMessage('POST', '/api/v1/human/bind', w.address, ts));
      const body = { agent_id: 'agent-1', signature: await sign(w) };

      const without = await request(app).post('/api/v1/human/bind').set(headers()).set('x-hd-signature', authSig).send(body);
      expect(without.status).toBe(400);
      expect(without.body.reason).toBe('agent_key_required');

      const wrong = await request(app).post('/api/v1/human/bind').set(headers('key-for-agent-2')).set('x-hd-signature', authSig).send(body);
      expect(wrong.status).toBe(403);
      expect(JSON.stringify(wrong.body)).not.toContain('key-for-agent-2');

      const right = await request(app).post('/api/v1/human/bind').set(headers('key-for-agent-1')).set('x-hd-signature', authSig).send(body);
      expect(right.status).toBe(201);
      expect(JSON.stringify(right.body)).not.toContain('key-for-agent-1');
    });
  });

  describe('smart wallets', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sig = require('../src/services/wallet-signature');
    afterEach(() => sig.__setDefaultSignatureChain({ getCode: async () => '0x', call: async () => { throw new Error('offline'); } }));

    it('a smart-wallet signature the chain accepts binds (ERC-1271)', async () => {
      const contractWallet = '0x00000000000000000000000000000000000000aa';
      mockRows.builders = { id: 'b1', address: contractWallet };
      mockRows.repid_agents = { id: 'agent-1', agent_name: 'test' };
      const { Interface } = jest.requireActual('ethers');
      const iface = new Interface(['function isValidSignature(bytes32,bytes) view returns (bytes4)']);
      sig.__setDefaultSignatureChain({
        getCode: async () => '0x6080',
        call: async () => iface.encodeFunctionResult('isValidSignature', ['0x1626ba7e']),
      });
      const r = await bind.bindOwnerToAgent({ owner: { kind: 'builder', id: 'b1' }, agentId: 'agent-1', signature: '0x' + '11'.repeat(65), agentKey: 'key-for-agent-1' });
      expect(r.ok).toBe(true);
    });

    it('when the chain cannot be reached the answer is NOT CHECKED, not a bad signature', async () => {
      mockRows.builders = { id: 'b1', address: '0x00000000000000000000000000000000000000aa' };
      mockRows.repid_agents = { id: 'agent-1', agent_name: 'test' };
      sig.__setDefaultSignatureChain({ getCode: async () => { throw new Error('ECONNREFUSED'); }, call: async () => '0x' });
      const r = await bind.bindOwnerToAgent({ owner: { kind: 'builder', id: 'b1' }, agentId: 'agent-1', signature: '0x' + '11'.repeat(65), agentKey: 'key-for-agent-1' });
      expect(r).toMatchObject({ ok: false, reason: 'signature_not_checked' });
      expect(mockInserted.some((i) => i.table === 'human_agent_bindings')).toBe(false);
    });
  });

  it('never dresses a wallet proof up as proof of humanity', () => {
    const builder = bind.assuranceOf('builder');
    const human = bind.assuranceOf('human_sbt');
    expect(builder.label).toBe('wallet-proven');
    expect(builder.means).toMatch(/not a proof they are a distinct human/i);
    expect(human.label).toBe('proof-of-human');
    // The two levels must stay distinguishable — collapsing them into
    // "verified" is how a weak claim gets read as a strong one.
    expect(builder.level).not.toEqual(human.level);
  });

  it('carries scope and domain so the ZK ownership proof can land without reshaping rows', async () => {
    const w = Wallet.createRandom();
    mockRows.human_sbt_registry = { token_id: 'h1', wallet_address: w.address };
    mockRows.repid_agents = { id: 'agent-1', agent_name: 'test' };
    const sig = await w.signMessage(bind.bindingMessage({ wallet: w.address, agentId: 'agent-1', scope: 'ownership' }));
    await bind.bindOwnerToAgent({ owner: { kind: 'human_sbt', id: 'h1' }, agentId: 'agent-1', signature: sig, agentKey: 'key-for-agent-1' });
    const row = mockInserted.find((i) => i.table === 'human_agent_bindings')!.row;
    // ZKP invariants 2/3/6 — scope is a parameter, domain is namespaced.
    expect(row.scope).toBe('ownership');
    expect(row.domain).toBe('identity');
  });
});
