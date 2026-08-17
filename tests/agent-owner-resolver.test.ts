/**
 * The owner resolver's judgment, tested where it is decidable: the precedence
 * order, and the refusal to guess.
 *
 * Everything here is pure — probes are injected — so these assertions hold
 * without a database and cannot be satisfied by a lucky row. The DB probes
 * themselves are NOT covered here; they are exercised against production data by
 * the measurement in the report, and this file does not pretend otherwise.
 */
import {
  ASSURANCE_RANK,
  isKeySafeForFilter,
  normalizeAgentKey,
  ownerPerTxCap,
  reconcileOwner,
  sameOwner,
  type OwnerAssurance,
  type OwnerClaim,
  type SourceProbe,
} from '../src/services/agent-owner-resolver';

function claim(over: Partial<OwnerClaim> & { assurance: OwnerAssurance }): OwnerClaim {
  return {
    source: 'repid_agents.builder_id',
    ownerKey: 'owner-a',
    ownerKeyKind: 'builder_id',
    capUsdcPerTx: null,
    capUsdcTotal: null,
    ...over,
  };
}

const claimProbe = (c: OwnerClaim): SourceProbe => ({ source: c.source, status: 'claim', claim: c });

describe('precedence — evidence outranks population', () => {
  it('ranks a signed proof-of-human binding above every unsigned source', () => {
    const res = reconcileOwner([
      claimProbe(claim({ assurance: 'administrative', ownerKey: 'admin-fk' })),
      claimProbe(claim({ assurance: 'declared', ownerKey: 'declared-tier' })),
      claimProbe(claim({ assurance: 'proven_human', ownerKey: 'sbt-1', ownerKeyKind: 'human_sbt_token' })),
    ]);
    expect(res.status).toBe('resolved');
    expect(res.owner?.assurance).toBe('proven_human');
  });

  it('does NOT let a lower-ranked source overturn a higher one, but reports the disagreement', () => {
    const res = reconcileOwner([
      claimProbe(claim({ assurance: 'proven_wallet', ownerKey: 'builder-1' })),
      claimProbe(claim({ assurance: 'administrative', ownerKey: 'builder-2' })),
    ]);
    expect(res.owner?.ownerKey).toBe('builder-1');
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]?.ownerKey).toBe('builder-2');
  });

  it('reports no conflict when the sources agree on the same owner', () => {
    const res = reconcileOwner([
      claimProbe(claim({ assurance: 'proven_wallet', ownerKey: 'BUILDER-1' })),
      claimProbe(claim({ assurance: 'administrative', ownerKey: 'builder-1' })),
    ]);
    expect(res.conflicts).toHaveLength(0);
  });

  it('never treats identical ids in different namespaces as the same owner', () => {
    const a = claim({ assurance: 'proven_human', ownerKey: 'x', ownerKeyKind: 'human_sbt_token' });
    const b = claim({ assurance: 'administrative', ownerKey: 'x', ownerKeyKind: 'builder_id' });
    expect(sameOwner(a, b)).toBe(false);
    expect(reconcileOwner([claimProbe(a), claimProbe(b)]).conflicts).toHaveLength(1);
  });

  it('orders the assurance levels signed > attested > declared > administrative', () => {
    expect(ASSURANCE_RANK.proven_human).toBeGreaterThan(ASSURANCE_RANK.proven_wallet);
    expect(ASSURANCE_RANK.proven_wallet).toBeGreaterThan(ASSURANCE_RANK.attested_unverified);
    expect(ASSURANCE_RANK.attested_unverified).toBeGreaterThan(ASSURANCE_RANK.declared);
    expect(ASSURANCE_RANK.declared).toBeGreaterThan(ASSURANCE_RANK.administrative);
  });
});

describe('unknown is not "no owner" — the v_fleet_truth rule', () => {
  it('returns unknown, not none, when a source could not be consulted', () => {
    const res = reconcileOwner([
      { source: 'repid_agents.builder_id', status: 'empty' },
      { source: 'agent_kya_registry', status: 'indeterminate', reason: 'ambiguous_agent_name_for_delegation' },
    ]);
    expect(res.status).toBe('unknown');
    expect(res.status).not.toBe('none');
    expect(res.reason).toBe('ambiguous_agent_name_for_delegation');
  });

  it('returns none only when every consulted source was actually read and empty', () => {
    const res = reconcileOwner([
      { source: 'human_agent_bindings', status: 'empty' },
      { source: 'agent_delegations', status: 'empty' },
      { source: 'agent_custodianship_links', status: 'not_applicable', reason: 'agent_has_no_onchain_token_id' },
      { source: 'repid_agents.builder_id', status: 'empty' },
    ]);
    expect(res.status).toBe('none');
    expect(res.owner).toBeNull();
  });

  it('consulting nothing is unknown, never none', () => {
    const res = reconcileOwner([]);
    expect(res.status).toBe('unknown');
    expect(res.reason).toBe('no_sources_consulted');
  });

  it('a claim still wins even when another source failed — evidence present beats evidence missing', () => {
    const res = reconcileOwner([
      claimProbe(claim({ assurance: 'proven_human', ownerKey: 'sbt-1', ownerKeyKind: 'human_sbt_token' })),
      { source: 'agent_kya_registry', status: 'indeterminate', reason: 'kya_read_failed:boom' },
    ]);
    expect(res.status).toBe('resolved');
  });
});

describe('spending caps are collected across sources, not taken from the winner', () => {
  it('uses a cap from a weaker source when the winning identity claim states none', () => {
    // This is the shape of the real system: the binding proves WHO, the
    // delegation states HOW MUCH. Reading only the winner would discard every
    // ceiling anyone has signed.
    const res = reconcileOwner([
      claimProbe(claim({ assurance: 'proven_human', ownerKey: 'sbt-1', ownerKeyKind: 'human_sbt_token' })),
      claimProbe(claim({ assurance: 'attested_unverified', source: 'agent_delegations', capUsdcPerTx: 25 })),
    ]);
    expect(res.owner?.assurance).toBe('proven_human');
    expect(ownerPerTxCap(res)).toBe(25);
  });

  it('takes the TIGHTEST cap when two sources state different ones', () => {
    const res = reconcileOwner([
      claimProbe(claim({ assurance: 'attested_unverified', source: 'agent_delegations', capUsdcPerTx: 500 })),
      claimProbe(claim({ assurance: 'declared', source: 'agent_kya_registry', capUsdcPerTx: 40 })),
    ]);
    expect(ownerPerTxCap(res)).toBe(40);
  });

  it('returns null — not zero — when no source states a cap', () => {
    const res = reconcileOwner([claimProbe(claim({ assurance: 'administrative' }))]);
    expect(ownerPerTxCap(res)).toBeNull();
  });

  it('ignores a non-finite cap rather than propagating NaN into a ceiling', () => {
    const res = reconcileOwner([
      claimProbe(claim({ assurance: 'declared', capUsdcPerTx: Number.NaN })),
      claimProbe(claim({ assurance: 'administrative', capUsdcPerTx: 10 })),
    ]);
    expect(ownerPerTxCap(res)).toBe(10);
  });
});

describe('key handling — the ambiguity is the finding', () => {
  it('normalises case and the trinity- prefix to the same key', () => {
    expect(normalizeAgentKey('trinity-sophia')).toBe(normalizeAgentKey('SOPHIA'));
    expect(normalizeAgentKey('Trinity-Veritas')).toBe('VERITAS');
  });

  it('normalisation MERGES distinct names — it widens ambiguity, so it can never disambiguate', () => {
    // Measured consequence: 8 exactly-colliding names became 7 normalised buckets
    // over the same 39 rows. Two names that differ only by prefix/case become one.
    expect(normalizeAgentKey('sophia')).toBe(normalizeAgentKey('trinity-SOPHIA'));
  });

  it('rejects names that would be parsed as PostgREST filter syntax instead of guessing an escape', () => {
    expect(isKeySafeForFilter('trinity-sophia')).toBe(true);
    expect(isKeySafeForFilter('agent,other')).toBe(false);
    expect(isKeySafeForFilter('agent(1)')).toBe(false);
    expect(isKeySafeForFilter('agent*')).toBe(false);
    expect(isKeySafeForFilter('')).toBe(false);
  });
});
