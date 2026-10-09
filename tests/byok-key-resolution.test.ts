/**
 * byok-key-resolution — the consumption half of BYOK custody.
 *
 * The property that matters is NOT the happy path. It is that a stored key is
 * spent ONLY on a call by an agent its owner PROVED they own, and never on the
 * strength of an unsigned administrative link. Owner A's key must never reach
 * owner B's (or an unproven agent's) call. These tests pin exactly that.
 *
 * byok-custody and agent-owner-resolver are mocked so the suite is deterministic
 * and offline: `resolveKeysForRouting` stands in as an OWNER-SCOPED store, and
 * `resolveOwner` returns canned resolutions. We are testing the gate and the
 * owner→key mapping, not re-testing those two (each has its own suite).
 */

// `mock`-prefixed names are the only closure vars jest.mock factories may touch.
let mockFlag = true;
const mockResolveKeys = jest.fn();
const mockResolveOwner = jest.fn();

jest.mock('../src/services/byok-custody', () => ({
  __esModule: true,
  // Getter, so flipping the flag between tests is seen at call time.
  get BYOK_CUSTODY_ENABLED() {
    return mockFlag;
  },
  resolveKeysForRouting: (...args: unknown[]) => mockResolveKeys(...args),
}));

jest.mock('../src/services/agent-owner-resolver', () => ({
  __esModule: true,
  resolveOwner: (...args: unknown[]) => mockResolveOwner(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveOwnerStoredKeys, mergeEffectiveKeys, keyOwnerFromClaim } =
  require('../src/services/byok-key-resolution');

// --- canned owner resolutions ---------------------------------------------

const resolution = (owner: Record<string, unknown> | null) => ({
  status: owner ? 'resolved' : 'none',
  agentId: 'agent-x',
  owner,
  claims: owner ? [owner] : [],
  conflicts: [],
  reason: null,
  probes: [],
});

const claim = (ownerKeyKind: string, ownerKey: string | null, assurance: string) => ({
  source: 'human_agent_bindings',
  assurance,
  ownerKey,
  ownerKeyKind,
  capUsdcPerTx: null,
  capUsdcTotal: null,
});

// A store keyed by "kind:id" — a stand-in for user_provider_keys, which only ever
// holds rows written under a proven account's {owner_kind, owner_id}.
const STORE: Record<string, Record<string, string>> = {
  'builder:A': { openai: 'sk-A-openai', groq: 'gsk-A-groq' },
  'human_sbt:H': { anthropic: 'sk-ant-H' },
};

beforeEach(() => {
  mockFlag = true;
  mockResolveKeys.mockReset();
  mockResolveOwner.mockReset();
  mockResolveKeys.mockImplementation(async (owner: { kind: string; id: string }) => ({
    ...(STORE[`${owner.kind}:${owner.id}`] ?? {}),
  }));
});

describe('mergeEffectiveKeys — body wins, stored fills (the chosen precedence)', () => {
  it('fills a provider the body did not supply from stored', () => {
    expect(mergeEffectiveKeys({ openai: 'STORED' }, {})).toEqual({ openai: 'STORED' });
  });

  it('lets a body key OVERRIDE a stored key for the same provider', () => {
    expect(mergeEffectiveKeys({ openai: 'STORED' }, { openai: 'BODY' })).toEqual({ openai: 'BODY' });
  });

  it('combines: body for one provider, stored fills the other', () => {
    expect(mergeEffectiveKeys({ openai: 'STORED' }, { anthropic: 'BODY' })).toEqual({
      openai: 'STORED',
      anthropic: 'BODY',
    });
  });

  it('treats a blank body value as NOT supplied, so stored still fills it', () => {
    expect(mergeEffectiveKeys({ openai: 'STORED' }, { openai: '   ' })).toEqual({ openai: 'STORED' });
  });

  it('is defensive about non-object / missing inputs', () => {
    expect(mergeEffectiveKeys({}, undefined)).toEqual({});
    expect(mergeEffectiveKeys(undefined, { openai: 'BODY' })).toEqual({ openai: 'BODY' });
    expect(mergeEffectiveKeys({ openai: 'STORED' }, 'not-an-object')).toEqual({ openai: 'STORED' });
    expect(mergeEffectiveKeys({ openai: 'STORED' }, ['x'])).toEqual({ openai: 'STORED' });
    // only string values survive the normalisation
    expect(mergeEffectiveKeys({ openai: 'STORED' }, { anthropic: 123 })).toEqual({ openai: 'STORED' });
  });
});

describe('keyOwnerFromClaim — only concrete custody namespaces, never a guess', () => {
  it('maps a proven-human SBT claim to the human_sbt custody owner', () => {
    expect(keyOwnerFromClaim(claim('human_sbt_token', 'H', 'proven_human'))).toEqual({
      kind: 'human_sbt',
      id: 'H',
    });
  });

  it('maps a proven-wallet builder claim to the builder custody owner', () => {
    expect(keyOwnerFromClaim(claim('builder_id', 'A', 'proven_wallet'))).toEqual({
      kind: 'builder',
      id: 'A',
    });
  });

  it('refuses a wallet / opaque / null-keyed claim — no custody row could match', () => {
    expect(keyOwnerFromClaim(claim('wallet', '0xabc', 'attested_unverified'))).toBeNull();
    expect(keyOwnerFromClaim(claim('opaque', 'tier-2', 'declared'))).toBeNull();
    expect(keyOwnerFromClaim(claim('builder_id', null, 'proven_wallet'))).toBeNull();
  });
});

describe('resolveOwnerStoredKeys — the trust boundary', () => {
  it('is INERT when custody is off: no owner lookup, no key read, empty result', async () => {
    mockFlag = false;
    const out = await resolveOwnerStoredKeys('agent-x');
    expect(out).toEqual({});
    expect(mockResolveOwner).not.toHaveBeenCalled();
    expect(mockResolveKeys).not.toHaveBeenCalled();
  });

  it('returns nothing when no agent id is supplied', async () => {
    expect(await resolveOwnerStoredKeys(undefined)).toEqual({});
    expect(await resolveOwnerStoredKeys('')).toEqual({});
    expect(mockResolveKeys).not.toHaveBeenCalled();
  });

  it('returns the PROVEN owner\'s stored keys, fetched under exactly that owner', async () => {
    mockResolveOwner.mockResolvedValue(resolution(claim('builder_id', 'A', 'proven_wallet')));
    const out = await resolveOwnerStoredKeys('agent-x');
    expect(out).toEqual({ openai: 'sk-A-openai', groq: 'gsk-A-groq' });
    expect(mockResolveKeys).toHaveBeenCalledTimes(1);
    expect(mockResolveKeys).toHaveBeenCalledWith({ kind: 'builder', id: 'A' });
  });

  it('resolves a proven-human owner to the human_sbt custody namespace', async () => {
    mockResolveOwner.mockResolvedValue(resolution(claim('human_sbt_token', 'H', 'proven_human')));
    const out = await resolveOwnerStoredKeys('agent-x');
    expect(out).toEqual({ anthropic: 'sk-ant-H' });
    expect(mockResolveKeys).toHaveBeenCalledWith({ kind: 'human_sbt', id: 'H' });
  });

  // THE ANTI-LEAK GATE. An agent merely LINKED to builder A by the unsigned
  // repid_agents.builder_id FK must NOT be handed A's custodied key.
  it('REFUSES an administrative (unsigned) owner — never fetches a key', async () => {
    mockResolveOwner.mockResolvedValue(resolution(claim('builder_id', 'A', 'administrative')));
    const out = await resolveOwnerStoredKeys('agent-x');
    expect(out).toEqual({});
    expect(mockResolveKeys).not.toHaveBeenCalled();
  });

  it('REFUSES attested_unverified and declared owners too (only a signature is enough)', async () => {
    for (const assurance of ['attested_unverified', 'declared']) {
      mockResolveKeys.mockClear();
      mockResolveOwner.mockResolvedValue(resolution(claim('builder_id', 'A', assurance)));
      expect(await resolveOwnerStoredKeys('agent-x')).toEqual({});
      expect(mockResolveKeys).not.toHaveBeenCalled();
    }
  });

  it('returns nothing on status none / unknown', async () => {
    mockResolveOwner.mockResolvedValue(resolution(null)); // none
    expect(await resolveOwnerStoredKeys('agent-x')).toEqual({});
    mockResolveOwner.mockResolvedValue({
      status: 'unknown',
      agentId: null,
      owner: null,
      claims: [],
      conflicts: [],
      reason: 'ambiguous_agent_name',
      probes: [],
    });
    expect(await resolveOwnerStoredKeys('agent-x')).toEqual({});
    expect(mockResolveKeys).not.toHaveBeenCalled();
  });

  // OWNER ISOLATION. B's agent, proven, gets B's keys — which are none. It never
  // receives A's key, even though A has one in the same store.
  it("never hands owner A's key to owner B's proven agent", async () => {
    mockResolveOwner.mockResolvedValue(resolution(claim('builder_id', 'B', 'proven_wallet')));
    const out = await resolveOwnerStoredKeys('agent-of-B');
    expect(out).toEqual({});
    expect(mockResolveKeys).toHaveBeenCalledWith({ kind: 'builder', id: 'B' });
    // the only key fetch was scoped to B; A's row was never read for B's call
    expect(mockResolveKeys).not.toHaveBeenCalledWith({ kind: 'builder', id: 'A' });
    expect(JSON.stringify(out)).not.toContain('sk-A-openai');
  });

  it('survives a resolver that throws by returning no stored keys (fail-closed)', async () => {
    mockResolveOwner.mockRejectedValue(new Error('db down'));
    expect(await resolveOwnerStoredKeys('agent-x')).toEqual({});
    expect(mockResolveKeys).not.toHaveBeenCalled();
  });
});
