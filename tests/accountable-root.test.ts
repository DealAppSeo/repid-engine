/**
 * F1 — one accountable root (src/services/accountable-root.ts), and the grant-chain walk it rests on
 * (walkAncestors in src/services/principal-grants.ts).
 *
 * What matters is that every way the walk can go wrong is a REFUSAL with its own name, and that a
 * read that fails is NOT CHECKED rather than "nobody owns it". The old walk stopped quietly on an
 * empty read, so a missing ancestor made a chain look complete and live.
 */
import { resolveAccountableRoot, anchorOf, rootRefusalStatus, type RootReader } from '../src/services/accountable-root';
import { walkAncestors, isWidening, type GrantRow } from '../src/services/principal-grants';

const PAI = 'aaaaaaaa-1111-2222-3333-444444444444';
const CMO = 'bbbbbbbb-1111-2222-3333-444444444444';
const SUB = 'cccccccc-1111-2222-3333-444444444444';
const HOUSE = 'dddddddd-1111-2222-3333-444444444444';
const STRANGER = 'eeeeeeee-1111-2222-3333-444444444444';
const OWNER_WALLET = '0x00000000000000000000000000000000000000a1';
const CUSTODIAN = '0x00000000000000000000000000000000000000c1';

const FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

function grant(over: Partial<GrantRow> & { id: string; grantor_agent_id: string; grantee_agent_id: string }): GrantRow {
  return {
    parent_grant_id: null,
    depth: 0,
    grant_class: 'cold',
    capabilities: ['read:tool:github'],
    caveats: [],
    role: null,
    audit_for: null,
    not_before: PAST,
    expires_at: FUTURE,
    revoked_at: null,
    revoked_by: null,
    mint_reason: 'test',
    created_at: PAST,
    idempotency_key: null,
    grantor_signature: null,
    grantor_wallet_address_used: null,
    signature_status: null,
    ...over,
  };
}

interface World {
  names?: Record<string, string[]>;
  bindings?: Record<string, { wallet: string | null; kind: 'human_sbt' | 'builder' }>;
  custodians?: Record<string, string>;
  grants?: Record<string, GrantRow>;
  failOn?: Partial<Record<keyof RootReader, true>>;
}

function reader(w: World): RootReader {
  const boom = (k: keyof RootReader) => {
    if (w.failOn?.[k]) throw new Error(`${k} read failed`);
  };
  return {
    async idsOf(ref) {
      boom('idsOf');
      if (w.names?.[ref]) return w.names[ref]!;
      return /^[0-9a-f-]{36}$/.test(ref) ? [ref] : [];
    },
    async bindingOf(id) {
      boom('bindingOf');
      return w.bindings?.[id] ?? null;
    },
    async custodianOf(id) {
      boom('custodianOf');
      return w.custodians?.[id] ?? null;
    },
    async grant(id) {
      boom('grant');
      return w.grants?.[id] ?? null;
    },
  };
}

// PAI (owned) -> CMO (g1) -> SUB (g2)
const g1 = grant({ id: 'g1', grantor_agent_id: PAI, grantee_agent_id: CMO, depth: 0 });
const g2 = grant({ id: 'g2', grantor_agent_id: CMO, grantee_agent_id: SUB, depth: 1, parent_grant_id: 'g1' });
const ownedChain: World = { bindings: { [PAI]: { wallet: OWNER_WALLET, kind: 'builder' } }, grants: { g1, g2 } };

describe('who answers for one agent', () => {
  it('a bound owner answers, and a wallet proof is never called proof-of-human', async () => {
    const r = await resolveAccountableRoot(PAI, { reader: reader(ownedChain) });
    expect(r).toMatchObject({ ok: true, root: { kind: 'owner', wallet: OWNER_WALLET, via: 'own-binding', assurance: 'wallet-proven' } });
  });

  it('a proof-of-human binding is labelled as one', async () => {
    const r = await resolveAccountableRoot(PAI, { reader: reader({ bindings: { [PAI]: { wallet: OWNER_WALLET, kind: 'human_sbt' } } }) });
    expect(r).toMatchObject({ ok: true, root: { assurance: 'proof-of-human' } });
  });

  it("the operator's custodian answers for a house agent, and says it is operator-assigned", async () => {
    const r = await resolveAccountableRoot(HOUSE, { reader: reader({ custodians: { [HOUSE]: CUSTODIAN } }) });
    expect(r).toMatchObject({ ok: true, root: { kind: 'custodian', wallet: CUSTODIAN, via: 'own-custodian', assurance: 'operator-assigned' } });
  });

  it('a signed binding outranks the custodian', async () => {
    const r = await resolveAccountableRoot(HOUSE, {
      reader: reader({ bindings: { [HOUSE]: { wallet: OWNER_WALLET, kind: 'builder' } }, custodians: { [HOUSE]: CUSTODIAN } }),
    });
    expect(r).toMatchObject({ ok: true, root: { kind: 'owner', wallet: OWNER_WALLET } });
  });

  it('nobody: no_root, which the routes answer with 403', async () => {
    const r = await resolveAccountableRoot(STRANGER, { reader: reader({}) });
    expect(r).toMatchObject({ ok: false, code: 'no_root' });
    if (!r.ok) expect(rootRefusalStatus(r)).toBe(403);
  });

  it('a binding with no wallet on record cannot answer: no_root', async () => {
    const r = await resolveAccountableRoot(PAI, { reader: reader({ bindings: { [PAI]: { wallet: null, kind: 'human_sbt' } } }) });
    expect(r).toMatchObject({ ok: false, code: 'no_root' });
  });
});

describe('a failed read is NOT CHECKED, never "nobody owns it"', () => {
  // The custodian is read only when there is no binding, so that case asks about an unbound agent.
  for (const k of ['idsOf', 'bindingOf', 'custodianOf'] as const) {
    it(`${k} fails -> not_checked (503)`, async () => {
      const subject = k === 'custodianOf' ? STRANGER : PAI;
      const r = await resolveAccountableRoot(subject, { reader: reader({ ...ownedChain, failOn: { [k]: true } }) });
      expect(r).toMatchObject({ ok: false, code: 'not_checked' });
      if (!r.ok) expect(rootRefusalStatus(r)).toBe(503);
    });
  }

  it('anchorOf alone: a failing custodian read after "no binding" is still not_checked', async () => {
    const r = await anchorOf(STRANGER, reader({ failOn: { custodianOf: true } }));
    expect(r).toMatchObject({ ok: false, code: 'not_checked' });
  });
});

describe('names', () => {
  it('a name that matches two agents must be given as an id', async () => {
    const r = await resolveAccountableRoot('my-pai', { reader: reader({ names: { 'my-pai': [PAI, STRANGER] } }) });
    expect(r).toMatchObject({ ok: false, code: 'ambiguous' });
  });
  it('an unknown name is not_found', async () => {
    expect(await resolveAccountableRoot('nobody', { reader: reader({}) })).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('through a grant chain', () => {
  it('an unclaimed agent acting under a live chain answers to the owner at its top', async () => {
    const r = await resolveAccountableRoot(SUB, { viaGrantId: 'g2', reader: reader(ownedChain) });
    expect(r).toMatchObject({ ok: true, root: { kind: 'owner', wallet: OWNER_WALLET, agentId: PAI, subjectId: SUB, via: 'grant-chain', grantPath: ['g2', 'g1'] } });
  });

  it('without naming the grant it acts under, it has no root', async () => {
    expect(await resolveAccountableRoot(SUB, { reader: reader(ownedChain) })).toMatchObject({ ok: false, code: 'no_root' });
  });

  it('a grant that names someone else as grantee is refused', async () => {
    const r = await resolveAccountableRoot(STRANGER, { viaGrantId: 'g2', reader: reader(ownedChain) });
    expect(r).toMatchObject({ ok: false, code: 'not_grantee' });
  });

  it('THE UNBIND CUT: the same chain, after the owner unbinds, answers to nobody', async () => {
    const before = await resolveAccountableRoot(SUB, { viaGrantId: 'g2', reader: reader(ownedChain) });
    expect(before.ok).toBe(true);
    const after = await resolveAccountableRoot(SUB, { viaGrantId: 'g2', reader: reader({ grants: { g1, g2 } }) });
    expect(after).toMatchObject({ ok: false, code: 'no_root' });
    if (!after.ok) expect(after.message).toMatch(new RegExp(PAI));
  });

  it('a revoked link anywhere above is chain_dead', async () => {
    const w = { ...ownedChain, grants: { g1: { ...g1, revoked_at: PAST, revoked_by: PAI }, g2 } };
    expect(await resolveAccountableRoot(SUB, { viaGrantId: 'g2', reader: reader(w) })).toMatchObject({ ok: false, code: 'chain_dead' });
  });

  it('an expired link anywhere above is chain_dead', async () => {
    const w = { ...ownedChain, grants: { g1: { ...g1, expires_at: PAST }, g2 } };
    expect(await resolveAccountableRoot(SUB, { viaGrantId: 'g2', reader: reader(w) })).toMatchObject({ ok: false, code: 'chain_dead' });
  });

  it('a chain rooted at a house agent answers to the custodian', async () => {
    const h1 = grant({ id: 'h1', grantor_agent_id: HOUSE, grantee_agent_id: CMO });
    const r = await resolveAccountableRoot(CMO, { viaGrantId: 'h1', reader: reader({ custodians: { [HOUSE]: CUSTODIAN }, grants: { h1 } }) });
    expect(r).toMatchObject({ ok: true, root: { kind: 'custodian', wallet: CUSTODIAN, via: 'grant-chain' } });
  });
});

describe('walkAncestors fails closed', () => {
  const read = (grants: Record<string, GrantRow>, fail = false) => async (id: string) => {
    if (fail) throw new Error('db down');
    return grants[id] ?? null;
  };

  it('a whole, connected chain walks to depth 0, nearest first', async () => {
    expect(await walkAncestors(g2, read({ g1 }))).toEqual({ ok: true, ancestors: [g1] });
  });

  it('a missing ancestor is chain_dead (the old walk stopped here and called the chain live)', async () => {
    expect(await walkAncestors(g2, read({}))).toMatchObject({ ok: false, code: 'chain_dead' });
  });

  it('a row that claims depth 0 but points at a parent that is gone is still chain_dead', async () => {
    // The depth checks cannot catch this one: the row's own depth is what a top should have.
    // Only the missing-ancestor check stands between it and "live".
    const orphan = grant({ id: 'o', grantor_agent_id: CMO, grantee_agent_id: SUB, depth: 0, parent_grant_id: 'gone' });
    const r = await walkAncestors(orphan, read({}));
    expect(r).toMatchObject({ ok: false, code: 'chain_dead' });
    if (!r.ok) expect(r.reason).toMatch(/does not exist/);
  });

  it('an ancestor that cannot be read is not_checked', async () => {
    expect(await walkAncestors(g2, read({ g1 }, true))).toMatchObject({ ok: false, code: 'not_checked' });
  });

  it('a child hung under someone ELSE\'s grant does not connect: chain_dead', async () => {
    const stolen = grant({ id: 'x', grantor_agent_id: STRANGER, grantee_agent_id: SUB, depth: 1, parent_grant_id: 'g1' });
    const r = await walkAncestors(stolen, read({ g1 }));
    expect(r).toMatchObject({ ok: false, code: 'chain_dead' });
    if (!r.ok) expect(r.reason).toMatch(/granted by/);
  });

  it('a cycle is refused', async () => {
    const a = grant({ id: 'a', grantor_agent_id: CMO, grantee_agent_id: SUB, depth: 1, parent_grant_id: 'b' });
    const b = grant({ id: 'b', grantor_agent_id: SUB, grantee_agent_id: CMO, depth: 0, parent_grant_id: 'a' });
    expect(await walkAncestors(a, read({ a, b }))).toMatchObject({ ok: false, code: 'cycle' });
  });

  it('more links than MAX_GRANT_DEPTH is too_deep', async () => {
    const agents = Array.from({ length: 7 }, (_, i) => `ffffffff-0000-0000-0000-00000000000${i}`);
    const rows: Record<string, GrantRow> = {};
    for (let i = 0; i < 6; i++) {
      rows[`d${i}`] = grant({
        id: `d${i}`,
        grantor_agent_id: agents[i]!,
        grantee_agent_id: agents[i + 1]!,
        depth: i,
        parent_grant_id: i === 0 ? null : `d${i - 1}`,
      });
    }
    expect(await walkAncestors(rows['d5']!, read(rows))).toMatchObject({ ok: false, code: 'too_deep' });
  });

  it('a depth that does not step by one is refused: the stored depth is what the cap reads', async () => {
    const forged = grant({ id: 'f', grantor_agent_id: CMO, grantee_agent_id: SUB, depth: 0, parent_grant_id: 'g1' });
    expect(await walkAncestors(forged, read({ g1 }))).toMatchObject({ ok: false, code: 'chain_dead' });
  });

  it('a top that claims a depth other than 0 is refused', async () => {
    const lying = grant({ id: 't', grantor_agent_id: PAI, grantee_agent_id: CMO, depth: 1 });
    expect(await walkAncestors(lying, read({}))).toMatchObject({ ok: false, code: 'chain_dead' });
  });
});

describe('isWidening: the one predicate every gate shares', () => {
  it('a read-only cold grant does not widen', () => expect(isWidening({ grant_class: 'cold', capabilities: ['read:tool:x'] })).toBe(false));
  it('any non-read capability widens', () => expect(isWidening({ grant_class: 'cold', capabilities: ['read:a', 'write:b'] })).toBe(true));
  it('any class above cold widens', () => expect(isWidening({ grant_class: 'warm', capabilities: ['read:a'] })).toBe(true));
});
