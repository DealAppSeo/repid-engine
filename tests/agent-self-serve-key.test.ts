/**
 * An agent earns its own key — and cannot mint one it did not earn.
 *
 * Discovery already worked (/.well-known/agent.json, ai-plugin.json,
 * openapi.json are all live and keyless). What did not work was acting on it:
 * every write needed a key, and the only route to one was a request a human
 * approved. This closes that, so the proof has to be worth something.
 *
 * The failure modes that matter:
 *   · signing once and minting keys forever (replay)
 *   · signing for one agent and getting a key for another
 *   · a wrong signature burning a legitimate agent's challenge
 *   · quietly handing out 'admin'
 */

import { Wallet } from 'ethers';

interface DbState {
  agent: any;
  inserts: Array<{ table: string; row: any }>;
  updates: Array<{ table: string; patch: any }>;
  insertError: any;
}
const dbState: DbState = { agent: null, inserts: [], updates: [], insertError: null };

function makeQuery(table: string) {
  const q: any = {};
  let pendingPatch: any = null;
  q.select = () => q;
  q.eq = () => q;
  q.is = () => q;
  q.maybeSingle = async () => ({ data: dbState.agent, error: null });
  q.single = q.maybeSingle;
  q.update = (patch: any) => {
    pendingPatch = patch;
    return q;
  };
  q.insert = async (row: any) => {
    dbState.inserts.push({ table, row });
    return { data: null, error: dbState.insertError };
  };
  q.then = (resolve: any) => {
    if (pendingPatch) {
      dbState.updates.push({ table, patch: pendingPatch });
      pendingPatch = null;
    }
    return resolve({ data: null, error: null });
  };
  return q;
}

jest.mock('../src/db', () => ({ db: { from: (t: string) => makeQuery(t) } }));

const AGENT_WALLET = new Wallet('0x'.padEnd(66, '3'));
const IMPOSTOR = new Wallet('0x'.padEnd(66, '4'));
const AGENT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

const ORIGINAL_ENV = { ...process.env };

function load() {
  let mod: typeof import('../src/services/agent-self-serve-key');
  jest.isolateModules(() => {
    mod = require('../src/services/agent-self-serve-key');
  });
  return mod!;
}

beforeEach(() => {
  dbState.agent = { id: AGENT_ID, wallet_address: AGENT_WALLET.address };
  dbState.inserts = [];
  dbState.updates = [];
  dbState.insertError = null;
  process.env = { ...ORIGINAL_ENV };
  process.env.AGENT_SELF_SERVE_KEYS_ENABLED = 'true';
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

async function fullIssue(mod: ReturnType<typeof load>, signer = AGENT_WALLET) {
  const ch = await mod.createKeyChallenge(AGENT_ID);
  const signature = await signer.signMessage(ch.message!);
  return { ch, result: await mod.issueSelfServeKey({ nonce: ch.nonce!, signature }) };
}

// ===========================================================================
describe('flag discipline', () => {
  it('is inert by default', async () => {
    delete process.env.AGENT_SELF_SERVE_KEYS_ENABLED;
    const mod = load();
    expect(mod.AGENT_SELF_SERVE_KEYS_ENABLED).toBe(false);
    const ch = await mod.createKeyChallenge(AGENT_ID);
    expect(ch.ok).toBe(false);
    expect(ch.reason).toBe('disabled');
    const iss = await mod.issueSelfServeKey({ nonce: 'x', signature: 'y' });
    expect(iss.reason).toBe('disabled');
    expect(dbState.inserts).toHaveLength(0);
  });
});

// ===========================================================================
describe('the happy path an agent actually walks', () => {
  it('challenge → sign → key, bound to that agent', async () => {
    const mod = load();
    const { ch, result } = await fullIssue(mod);
    expect(ch.ok).toBe(true);
    expect(ch.message).toContain(AGENT_ID);
    expect(ch.message).toContain(ch.nonce!);
    expect(result.ok).toBe(true);
    expect(result.key).toMatch(/^ts_live_[0-9a-f]{32}$/);
    expect(result.agent_id).toBe(AGENT_ID);
  });

  it('stores only a hash, never the key', async () => {
    const mod = load();
    const { result } = await fullIssue(mod);
    const row = dbState.inserts.find((i) => i.table === 'agent_api_keys')!.row;
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(result.key!);
  });

  it('NEVER grants admin', async () => {
    const mod = load();
    await fullIssue(mod);
    const row = dbState.inserts.find((i) => i.table === 'agent_api_keys')!.row;
    expect(row.scopes).toEqual(['score_event', 'llm_complete', 'read_card']);
    expect(row.scopes).not.toContain('admin');
  });

  it('revokes the previous self-serve key rather than accumulating them', async () => {
    const mod = load();
    await fullIssue(mod);
    const revoke = dbState.updates.find((u) => u.table === 'agent_api_keys');
    expect(revoke).toBeDefined();
    expect(revoke!.patch.revoked_at).toBeDefined();
  });
});

// ===========================================================================
describe('replay — sign once must not mean mint forever', () => {
  it('a nonce is single-use', async () => {
    const mod = load();
    const ch = await mod.createKeyChallenge(AGENT_ID);
    const signature = await AGENT_WALLET.signMessage(ch.message!);

    const first = await mod.issueSelfServeKey({ nonce: ch.nonce!, signature });
    expect(first.ok).toBe(true);

    const replay = await mod.issueSelfServeKey({ nonce: ch.nonce!, signature });
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe('unknown_nonce');
    expect(dbState.inserts.filter((i) => i.table === 'agent_api_keys')).toHaveLength(1);
  });

  it('a signature from one challenge cannot redeem another', async () => {
    const mod = load();
    const chA = await mod.createKeyChallenge(AGENT_ID);
    const chB = await mod.createKeyChallenge(AGENT_ID);
    const sigForA = await AGENT_WALLET.signMessage(chA.message!);

    const cross = await mod.issueSelfServeKey({ nonce: chB.nonce!, signature: sigForA });
    expect(cross.ok).toBe(false);
    expect(cross.reason).toBe('bad_signature');
  });

  it('rejects an unknown nonce outright', async () => {
    const mod = load();
    const r = await mod.issueSelfServeKey({ nonce: 'never-issued', signature: '0xdead' });
    expect(r.reason).toBe('unknown_nonce');
  });
});

// ===========================================================================
describe('impersonation', () => {
  it('a signature from the wrong wallet is refused', async () => {
    const mod = load();
    const { result } = await fullIssue(mod, IMPOSTOR);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad_signature');
    expect(dbState.inserts).toHaveLength(0);
  });

  it('a wrong attempt does NOT burn the challenge — the real agent can still use it', async () => {
    const mod = load();
    const ch = await mod.createKeyChallenge(AGENT_ID);
    const bad = await IMPOSTOR.signMessage(ch.message!);
    expect((await mod.issueSelfServeKey({ nonce: ch.nonce!, signature: bad })).ok).toBe(false);

    const good = await AGENT_WALLET.signMessage(ch.message!);
    expect((await mod.issueSelfServeKey({ nonce: ch.nonce!, signature: good })).ok).toBe(true);
  });

  it('garbage in the signature field does not throw', async () => {
    const mod = load();
    const ch = await mod.createKeyChallenge(AGENT_ID);
    const r = await mod.issueSelfServeKey({ nonce: ch.nonce!, signature: 'not-a-signature' });
    expect(r.reason).toBe('bad_signature');
  });
});

// ===========================================================================
describe('preconditions', () => {
  it('an unknown agent gets agent_not_found, not a challenge', async () => {
    dbState.agent = null;
    const mod = load();
    const r = await mod.createKeyChallenge('nope');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('agent_not_found');
  });

  it('an agent with no registered wallet has nothing to prove', async () => {
    dbState.agent = { id: AGENT_ID, wallet_address: null };
    const mod = load();
    const r = await mod.createKeyChallenge(AGENT_ID);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_wallet');
  });

  it('rate-limits repeated issuance for one agent', async () => {
    const mod = load();
    for (let i = 0; i < 5; i++) await fullIssue(mod);
    const blocked = await mod.createKeyChallenge(AGENT_ID);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe('rate_limited');
  });

  it('surfaces a write failure instead of returning a key that does not exist', async () => {
    const mod = load();
    dbState.insertError = { message: 'db down' };
    const { result } = await fullIssue(mod);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('write_failed');
    expect(result.key).toBeUndefined();
  });
});
