import {
  batchFetchBuilders,
  latestRoundsForBuilder,
  canonicalWriteStatus,
  tradeCountByAgent,
} from '../../src/db/query-helpers';

/**
 * Mock-DB tests verifying call-count math: each helper issues exactly the
 * documented number of queries. The mock chains record every method call
 * and return whatever the test sets up via .reply() or .replies().
 */

interface QueryRecord {
  table: string;
  ops: Array<{ name: string; args: any[] }>;
}

function makeMockDb() {
  const queries: QueryRecord[] = [];
  const dataMap = new Map<string, any>();

  // Each from() returns a chainable builder. Awaiting the builder
  // returns { data, error }. The "key" used to look up the prepared
  // reply is the table name + the first filter value, joined by '|'.
  function makeChain(table: string): any {
    const record: QueryRecord = { table, ops: [] };
    queries.push(record);
    let resolveKey = `${table}|`;

    const chain: any = {
      select: (..._args: any[]) => {
        record.ops.push({ name: 'select', args: _args });
        return chain;
      },
      eq: (col: string, val: any) => {
        record.ops.push({ name: 'eq', args: [col, val] });
        resolveKey = `${table}|${col}=${val}`;
        return chain;
      },
      in: (col: string, vals: any[]) => {
        record.ops.push({ name: 'in', args: [col, [...vals]] });
        resolveKey = `${table}|${col}=in(${[...vals].sort().join(',')})`;
        return chain;
      },
      or: (filter: string) => {
        record.ops.push({ name: 'or', args: [filter] });
        resolveKey = `${table}|or`;
        return chain;
      },
      order: (..._args: any[]) => {
        record.ops.push({ name: 'order', args: _args });
        return chain;
      },
      limit: (n: number) => {
        record.ops.push({ name: 'limit', args: [n] });
        return chain;
      },
      maybeSingle: () => {
        const reply = dataMap.get(resolveKey) ?? dataMap.get(table);
        return Promise.resolve(reply ?? { data: null, error: null });
      },
      then: (resolve: (v: any) => void, reject?: (e: any) => void) => {
        const reply = dataMap.get(resolveKey) ?? dataMap.get(table);
        return Promise.resolve(reply ?? { data: [], error: null }).then(resolve, reject);
      },
    };
    return chain;
  }

  return {
    from: (table: string) => makeChain(table),
    _queries: queries,
    setReply: (key: string, value: any) => dataMap.set(key, value),
  };
}

describe('batchFetchBuilders', () => {
  it('issues exactly one query for N ids', async () => {
    const db = makeMockDb();
    db.setReply('builders|id=in(b1,b2,b3)', {
      data: [
        { id: 'b1', address: '0xb1', current_repid: 100, agent_count: 1 },
        { id: 'b2', address: '0xb2', current_repid: 200, agent_count: 0 },
        { id: 'b3', address: '0xb3', current_repid: 300, agent_count: 2 },
      ],
      error: null,
    });
    const rows = await batchFetchBuilders(db as any, ['b1', 'b2', 'b3']);
    expect(db._queries.length).toBe(1);
    expect(db._queries[0]!.table).toBe('builders');
    expect(rows.length).toBe(3);
    expect(rows.map((r: { id: string }) => r.id)).toEqual(['b1', 'b2', 'b3']);
  });

  it('preserves request order even if DB returns differently', async () => {
    const db = makeMockDb();
    db.setReply('builders|id=in(a,b,c)', {
      data: [
        { id: 'c', address: '0xc' },
        { id: 'a', address: '0xa' },
      ],
      error: null,
    });
    const rows = await batchFetchBuilders(db as any, ['a', 'b', 'c']);
    expect(rows.map((r: { id: string }) => r.id)).toEqual(['a', 'c']); // 'b' missing → dropped, but a before c
  });

  it('returns empty array for empty input without querying', async () => {
    const db = makeMockDb();
    const rows = await batchFetchBuilders(db as any, []);
    expect(rows).toEqual([]);
    expect(db._queries.length).toBe(0);
  });

  it('deduplicates input ids before querying', async () => {
    const db = makeMockDb();
    db.setReply('builders|id=in(b1,b2)', {
      data: [{ id: 'b1' }, { id: 'b2' }],
      error: null,
    });
    await batchFetchBuilders(db as any, ['b1', 'b2', 'b1', 'b2']);
    const inOp = db._queries[0]!.ops.find((o) => o.name === 'in');
    expect(inOp).toBeDefined();
    expect(inOp!.args[1]).toEqual(['b1', 'b2']);
  });
});

describe('latestRoundsForBuilder', () => {
  it('issues 3 queries: agents, bets, rounds', async () => {
    const db = makeMockDb();
    db.setReply('repid_agents|builder_id=b1', {
      data: [{ id: 'a1' }, { id: 'a2' }],
      error: null,
    });
    db.setReply('linked_bets|agent_id=in(a1,a2)', {
      data: [{ id: 'bet-1' }, { id: 'bet-2' }],
      error: null,
    });
    db.setReply('trading_rounds|or', {
      data: [
        { id: 'r1', status: 'resolved', apm_bet_id: 'bet-1', veritas_bet_id: 'bet-2' },
      ],
      error: null,
    });

    const rounds = await latestRoundsForBuilder(db as any, 'b1', 10);
    expect(db._queries.length).toBe(3);
    expect(db._queries[0]!.table).toBe('repid_agents');
    expect(db._queries[1]!.table).toBe('linked_bets');
    expect(db._queries[2]!.table).toBe('trading_rounds');
    expect(rounds.length).toBe(1);
    expect(rounds[0]!.id).toBe('r1');
  });

  it('short-circuits when builder has no agents (1 query)', async () => {
    const db = makeMockDb();
    db.setReply('repid_agents|builder_id=b-empty', { data: [], error: null });
    const rounds = await latestRoundsForBuilder(db as any, 'b-empty');
    expect(rounds).toEqual([]);
    expect(db._queries.length).toBe(1);
  });

  it('short-circuits when agents have no bets (2 queries)', async () => {
    const db = makeMockDb();
    db.setReply('repid_agents|builder_id=b1', { data: [{ id: 'a1' }], error: null });
    db.setReply('linked_bets|agent_id=in(a1)', { data: [], error: null });
    const rounds = await latestRoundsForBuilder(db as any, 'b1');
    expect(rounds).toEqual([]);
    expect(db._queries.length).toBe(2);
  });

  it('returns empty for missing builderId without querying', async () => {
    const db = makeMockDb();
    expect(await latestRoundsForBuilder(db as any, '')).toEqual([]);
    expect(db._queries.length).toBe(0);
  });
});

describe('canonicalWriteStatus', () => {
  it('issues exactly one query', async () => {
    const db = makeMockDb();
    db.setReply('builders|id=b1', {
      data: {
        id: 'b1',
        last_canonical_tx: '0xabc',
        last_canonical_status: 'success',
        agent_count: 3,
      },
      error: null,
    });
    const status = await canonicalWriteStatus(db as any, 'b1');
    expect(db._queries.length).toBe(1);
    expect(status).toEqual({
      builder_id: 'b1',
      last_canonical_tx: '0xabc',
      last_canonical_status: 'success',
      agent_count: 3,
    });
  });

  it('returns null for missing builder', async () => {
    const db = makeMockDb();
    db.setReply('builders|id=nope', { data: null, error: null });
    const status = await canonicalWriteStatus(db as any, 'nope');
    expect(status).toBeNull();
  });

  it('returns null without querying when builderId empty', async () => {
    const db = makeMockDb();
    expect(await canonicalWriteStatus(db as any, '')).toBeNull();
    expect(db._queries.length).toBe(0);
  });
});

describe('tradeCountByAgent', () => {
  it('issues exactly one query for N agent ids', async () => {
    const db = makeMockDb();
    db.setReply('paper_trade_orders|agent_id=in(a1,a2,a3)', {
      data: [
        { agent_id: 'a1' },
        { agent_id: 'a1' },
        { agent_id: 'a2' },
      ],
      error: null,
    });
    const counts = await tradeCountByAgent(db as any, ['a1', 'a2', 'a3']);
    expect(db._queries.length).toBe(1);
    expect(counts.get('a1')).toBe(2);
    expect(counts.get('a2')).toBe(1);
    expect(counts.get('a3')).toBe(0);
  });

  it('returns empty map for empty input without querying', async () => {
    const db = makeMockDb();
    expect((await tradeCountByAgent(db as any, [])).size).toBe(0);
    expect(db._queries.length).toBe(0);
  });

  it('deduplicates agent ids', async () => {
    const db = makeMockDb();
    db.setReply('paper_trade_orders|agent_id=in(a1,a2)', {
      data: [{ agent_id: 'a1' }],
      error: null,
    });
    const counts = await tradeCountByAgent(db as any, ['a1', 'a2', 'a1']);
    expect(counts.size).toBe(2);
    const inOp = db._queries[0]!.ops.find((o) => o.name === 'in');
    expect(inOp!.args[1]).toEqual(['a1', 'a2']);
  });
});
