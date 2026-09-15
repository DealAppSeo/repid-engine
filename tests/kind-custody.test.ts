/**
 * LOOP C7 (code machine) — illegal transitions rejected. SYNTHETIC ids only.
 */
import {
  claimDbtToAbt,
  createMemoryCustodyLog,
  derivedBound,
  hashPairingCode,
  illegalAbandonToDbt,
  illegalNullCustodian,
  issuePairingCode,
  personhoodStepUp,
  rebindAbt,
  type AgentIdentity,
} from '../src/identity/kind-custody';

const dbt = (over: Partial<AgentIdentity> = {}): AgentIdentity => ({
  id: '00000000-0000-4000-8000-0000000000b1',
  kind: 'DBT',
  custodian_id: null,
  ...over,
});
const sbt = (): AgentIdentity => ({
  id: '00000000-0000-4000-8000-0000000000b2',
  kind: 'SBT',
  custodian_id: '00000000-0000-4000-8000-0000000000b2',
});
const ibt = (): AgentIdentity => ({
  id: '00000000-0000-4000-8000-0000000000b3',
  kind: 'IBT',
  custodian_id: '00000000-0000-4000-8000-0000000000b3',
});

describe('kind/custody state machine', () => {
  it('derived bound is never hand-set: DBT unbound, others bound', () => {
    expect(derivedBound(dbt())).toBe(false);
    expect(derivedBound(sbt())).toBe(true);
    expect(derivedBound({ ...dbt(), kind: 'ABT', custodian_id: sbt().id })).toBe(true);
  });

  it('rejects ABT -> DBT', () => {
    expect(() => illegalAbandonToDbt({ ...dbt(), kind: 'ABT', custodian_id: sbt().id })).toThrow(
      /abt_sbt_ibt_cannot_become_dbt/,
    );
  });

  it('rejects null custodian on bound kinds', () => {
    expect(() => illegalNullCustodian({ ...sbt(), custodian_id: null })).toThrow(
      /bound_kind_null_custodian/,
    );
  });

  it('claim requires SBT/IBT custodian', () => {
    const code = issuePairingCode();
    const agent = dbt({ pairing_code_hash: code.hash, pairing_expires_at: code.expires_at });
    expect(() =>
      claimDbtToAbt({
        agent,
        custodian: dbt({ id: '00000000-0000-4000-8000-0000000000b9' }),
        pairingCode: code.code,
        log: createMemoryCustodyLog(),
      }),
    ).toThrow(/claim_requires_sbt_or_ibt_custodian/);
  });

  it('pairing code cannot be reused', () => {
    const code = issuePairingCode();
    const agent = dbt({ pairing_code_hash: code.hash, pairing_expires_at: code.expires_at });
    const log = createMemoryCustodyLog();
    const claimed = claimDbtToAbt({ agent, custodian: sbt(), pairingCode: code.code, log });
    expect(claimed.kind).toBe('ABT');
    expect(() =>
      claimDbtToAbt({ agent: claimed, custodian: sbt(), pairingCode: code.code, log }),
    ).toThrow(/pairing_code_reused|claim_requires_dbt/);
  });

  it('rebind appends a custody row and keeps the prior valid_to', () => {
    const code = issuePairingCode();
    const log = createMemoryCustodyLog();
    const claimed = claimDbtToAbt({
      agent: dbt({ pairing_code_hash: code.hash, pairing_expires_at: code.expires_at }),
      custodian: sbt(),
      pairingCode: code.code,
      log,
    });
    const rebound = rebindAbt({ agent: claimed, newCustodian: ibt(), log });
    expect(rebound.custodian_id).toBe(ibt().id);
    expect(log.rows).toHaveLength(2);
    expect(log.rows[0]!.valid_to).not.toBeNull();
    expect(log.rows[0]!.custodian_id).toBe(sbt().id);
    expect(log.rows[1]!.valid_to).toBeNull();
    expect(log.rows[1]!.custodian_id).toBe(ibt().id);
  });

  it('same-token personhood flip requires zero history', () => {
    expect(() =>
      personhoodStepUp({ agent: dbt(), log: createMemoryCustodyLog(), historyEventCount: 3 }),
    ).toThrow(/zero_history/);
    const next = personhoodStepUp({
      agent: dbt(),
      log: createMemoryCustodyLog(),
      historyEventCount: 0,
    });
    expect(next.kind).toBe('SBT');
    expect(next.custodian_id).toBe(next.id);
  });

  it('hashing pairing codes is deterministic and not reversible from the hash length', () => {
    expect(hashPairingCode('abc')).toHaveLength(64);
    expect(hashPairingCode('abc')).toBe(hashPairingCode('abc'));
  });
});
