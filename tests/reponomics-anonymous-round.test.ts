/**
 * Reponomics — anonymous round runner tests.
 *
 * Exercises runRoundAnonymous against mocked DB + mocked startTradingRound
 * + mocked resolveOpenRounds. The wrapper is mostly orchestration —
 * we verify it (1) snapshots before/after, (2) computes the deltas,
 * (3) emits an audit row, (4) returns is_simulated:true.
 */

jest.mock('../src/db', () => {
  // Minimal db shim with a "before/after" toggle the test controls.
  let phase: 'before' | 'after' = 'before';
  const apmRow = {
    before: { id: 'apm-uuid', agent_name: 'APM', current_repid: 7000, wisdom_score: 1500, character_score: 1700 },
    after:  { id: 'apm-uuid', agent_name: 'APM', current_repid: 7065, wisdom_score: 1502, character_score: 1705 },
  };
  const veritasRow = {
    before: { id: 'veritas-uuid', agent_name: 'VERITAS', current_repid: 5500, wisdom_score: 1100, character_score: 1100 },
    after:  { id: 'veritas-uuid', agent_name: 'VERITAS', current_repid: 5435, wisdom_score: 1098, character_score: 1100 },
  };

  const auditRows = [
    { id: 100, source_table: 'trading_rounds', event_payload: { event_type: 'round_started' }, created_at: new Date().toISOString() },
    { id: 101, source_table: 'linked_bets',    event_payload: { event_type: 'bet_placed' },    created_at: new Date().toISOString() },
    { id: 102, source_table: 'linked_bets',    event_payload: { event_type: 'bet_placed' },    created_at: new Date().toISOString() },
    { id: 103, source_table: 'linked_bets',    event_payload: { event_type: 'bet_resolved' },  created_at: new Date().toISOString() },
    { id: 104, source_table: 'linked_bets',    event_payload: { event_type: 'bet_resolved' },  created_at: new Date().toISOString() },
  ];

  const builder: any = {
    _name: '',
    select() { return this; },
    update() { return this; },
    eq(field: string, value: any) {
      this._name = field === 'agent_name' ? String(value) : this._name;
      return this;
    },
    gte() { return this; },
    order() { return this; },
    limit() { return this; },
    insert() { return ({ select: () => ({ single: async () => ({ data: { id: 'new' }, error: null }) }) }); },
    async maybeSingle() {
      if (this._name === 'APM') return { data: phase === 'before' ? apmRow.before : apmRow.after, error: null };
      if (this._name === 'VERITAS') return { data: phase === 'before' ? veritasRow.before : veritasRow.after, error: null };
      return { data: null, error: null };
    },
    async single() {
      return this.maybeSingle();
    },
    // For the audit-chain fetch and updates
    then(resolve: any) { resolve({ data: null, error: null }); },
  };

  // Override `select('id, source_table, event_payload, created_at')` to return audit list
  // when called with .gte().order().limit().
  const auditChainBuilder: any = {
    select() { return this; },
    eq() { return this; },
    gte() { return this; },
    order() { return this; },
    limit: async () => ({ data: auditRows, error: null }),
  };

  return {
    db: {
      from(table: string) {
        if (table === 'hal_audit_chain') return auditChainBuilder;
        return builder;
      },
      rpc: async () => ({ data: { id: 1 }, error: null }),
    },
    _setPhase: (p: 'before' | 'after') => { phase = p; },
  };
});

// agent-trader has its own DB-touching internals; mock them at the
// module level so runRoundAnonymous's calls into them succeed.
jest.mock('../src/services/agent-trader', () => ({
  APM_AGENT_NAME: 'APM',
  VERITAS_AGENT_NAME: 'VERITAS',
  startTradingRound: jest.fn(async () => {
    const dbMod: any = require('../src/db');
    dbMod._setPhase('before');
    return { ok: true, round_id: 'round_test_1', apm_bet: 'bet_a', veritas_bet: 'bet_v', game: { id: 'g1' }, is_simulated: true };
  }),
  resolveOpenRounds: jest.fn(async () => {
    const dbMod: any = require('../src/db');
    dbMod._setPhase('after');
    return { resolved: 1, details: [] };
  }),
}));

import { runRoundAnonymous } from '../src/services/anonymous-round-runner';

describe('anonymous-round-runner', () => {
  beforeEach(() => {
    // Reset the mock db's before/after toggle so each test starts at 'before'.
    const dbMod: any = require('../src/db');
    dbMod._setPhase('before');
  });

  it('returns ok=true and is_simulated=true on the happy path', async () => {
    const r = await runRoundAnonymous({ waitMs: 0 });
    expect(r.ok).toBe(true);
    expect(r.is_simulated).toBe(true);
    expect(r.round_id).toBe('round_test_1');
  });

  it('captures APM repid before/after with delta', async () => {
    const r = await runRoundAnonymous({ waitMs: 0 });
    expect(r.apm).not.toBeNull();
    expect(r.apm!.repid_before).toBe(7000);
    expect(r.apm!.repid_after).toBe(7065);
    expect(r.apm!.delta).toBe(65);
  });

  it('captures VERITAS repid before/after with delta', async () => {
    const r = await runRoundAnonymous({ waitMs: 0 });
    expect(r.veritas).not.toBeNull();
    expect(r.veritas!.repid_before).toBe(5500);
    expect(r.veritas!.repid_after).toBe(5435);
    expect(r.veritas!.delta).toBe(-65);
  });

  it('returns audit_entries from the round window', async () => {
    const r = await runRoundAnonymous({ waitMs: 0 });
    expect(Array.isArray(r.audit_entries)).toBe(true);
    expect(r.audit_entries.length).toBeGreaterThan(0);
    const types = r.audit_entries.map(e => e.event_type);
    expect(types).toContain('round_started');
    expect(types).toContain('bet_placed');
    expect(types).toContain('bet_resolved');
  });

  it('notes contains SIMULATED indicator', async () => {
    const r = await runRoundAnonymous({ waitMs: 0 });
    expect(r.notes).toMatch(/SIMULATED/i);
  });
});
