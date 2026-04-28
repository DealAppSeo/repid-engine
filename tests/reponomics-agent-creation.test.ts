/**
 * Reponomics — builder-owned agent creation tests.
 */

let inserted: any = null;
let builderRow: any = { id: 'b1', agent_count: 0 };
let updateRow: any = null;

jest.mock('../src/db', () => {
  const tbl: any = {
    select: () => tbl,
    eq: () => tbl,
    insert: (row: any) => {
      inserted = row;
      return {
        select: () => ({
          single: async () => ({ data: { id: 'agent-uuid-1' }, error: null }),
        }),
      };
    },
    update: (row: any) => {
      updateRow = row;
      return { eq: async () => ({ data: null, error: null }) };
    },
    maybeSingle: async () => ({ data: builderRow, error: null }),
    single: async () => ({ data: builderRow, error: null }),
  };
  return {
    db: {
      from: () => tbl,
      rpc: async () => ({ data: { id: 1, current_entry_hash: 'mock' }, error: null }),
    },
  };
});

import { createBuilderAgent, deriveAgentAddress } from '../src/services/agent-creation';

beforeEach(() => {
  inserted = null;
  updateRow = null;
  builderRow = { id: 'b1', agent_count: 0 };
});

describe('agent-creation — deriveAgentAddress', () => {
  it('starts with 0xAGENT_ marker', () => {
    expect(deriveAgentAddress('A', 'b1').startsWith('0xAGENT_')).toBe(true);
  });
});

describe('agent-creation — createBuilderAgent', () => {
  it('rejects bad agent name', async () => {
    const r = await createBuilderAgent({ builderId: 'b1', agentName: 'x' });
    expect(r.ok).toBe(false);
  });

  it('inserts with builder_id, current_repid=1000, wisdom_score=1000, character_score=1000', async () => {
    const r = await createBuilderAgent({ builderId: 'b1', agentName: 'SwingTrader' });
    expect(r.ok).toBe(true);
    expect(r.agent_id).toBe('agent-uuid-1');
    expect(r.initial_repid).toBe(1000);
    expect(r.agent_address).toMatch(/^0xAGENT_/);
    expect(inserted).toBeTruthy();
    expect(inserted.builder_id).toBe('b1');
    expect(inserted.current_repid).toBe(1000);
    expect(inserted.wisdom_score).toBe(1000);
    expect(inserted.character_score).toBe(1000);
  });

  it('increments builder.agent_count', async () => {
    builderRow = { id: 'b1', agent_count: 4 };
    await createBuilderAgent({ builderId: 'b1', agentName: 'NewOne' });
    expect(updateRow).toBeTruthy();
    expect(updateRow.agent_count).toBe(5);
  });

  it('returns error when builder not found', async () => {
    builderRow = null as any;
    const r = await createBuilderAgent({ builderId: 'missing', agentName: 'ValidName' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });
});
