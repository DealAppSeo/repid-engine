import { runPCP, selectWeightedValidators, eligibleValidators, poolIntegrityExclusions } from '../../src/services/pcp-validator';
import { db } from '../../src/db';

jest.mock('../../src/db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue({
      data: [
        { agent_name: 'Alpha', current_repid: 1000, lifecycle_status: 'active' },
        { agent_name: 'Beta', current_repid: 800, lifecycle_status: 'active' },
        { agent_name: 'Gamma', current_repid: 600, lifecycle_status: 'active' },
        { agent_name: 'Delta', current_repid: 200, lifecycle_status: 'active' }, // too low repid
        { agent_name: 'ClaimerBot', current_repid: 900, lifecycle_status: 'active' } // claimer
      ],
      error: null
    })
  }
}));

// Mock global fetch
global.fetch = jest.fn();

describe('pcp-validator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GROQ_API_KEY = 'test-key';
  });

  describe('selectWeightedValidators', () => {
    it('selects exactly the requested number of validators if available', () => {
      const agents = [
        { agent_name: 'A', current_repid: 1000 },
        { agent_name: 'B', current_repid: 800 },
        { agent_name: 'C', current_repid: 600 }
      ];
      const selected = selectWeightedValidators(agents, 2);
      expect(selected.length).toBe(2);
      expect(selected[0].agent_name).not.toBe(selected[1].agent_name);
    });

    it('returns all available if requested count exceeds pool size', () => {
      const agents = [
        { agent_name: 'A', current_repid: 1000 }
      ];
      const selected = selectWeightedValidators(agents, 3);
      expect(selected.length).toBe(1);
    });

    it('favors higher repid agents (probabilistic but bounded)', () => {
      const agents = [
        { agent_name: 'High', current_repid: 1000000 },
        { agent_name: 'Low', current_repid: 1 }
      ];
      const selected = selectWeightedValidators(agents, 1);
      // It's almost guaranteed to pick 'High', though it's stochastic
      expect(selected[0].agent_name).toBe('High');
    });
  });

  describe('runPCP', () => {
    it('filters out the claimer and agents with repid < 500', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        json: jest.fn().mockResolvedValue({
          choices: [{ message: { content: '{"validity": 0.9, "confidence": 0.95, "justification": "Looks good"}' } }]
        })
      });

      const taskData = { claimed_by: 'ClaimerBot', title: 'Test Task', description: 'Desc', result: 'Res' };
      const res = await runPCP(taskData);

      expect(res.validators).not.toContain('ClaimerBot');
      expect(res.validators).not.toContain('Delta');
      expect(res.score).toBeGreaterThan(0);
    });

    it('handles LLM JSON parsing failures gracefully', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        json: jest.fn().mockResolvedValue({
          choices: [{ message: { content: 'I am a bad AI and I output no JSON' } }]
        })
      });

      const taskData = { claimed_by: 'ClaimerBot', title: 'Test Task', description: 'Desc', result: 'Res' };
      const res = await runPCP(taskData);

      expect(res.score).toBe(0);
      expect(res.confidence).toBe(0);

      // The audit trail this line originally protected is INTACT — it just moved to a
      // field that says what it means. `attemptedValidators` is who was asked;
      // `validators` is who answered. They used to be one list, and conflating them is
      // what let three silent validators read as three damning zeroes.
      expect(res.attemptedValidators.length).toBeGreaterThan(0);
      expect(res.validators.length).toBe(0);
      expect(res.checked).toBe(false);
    });

    it('an unparseable validator is NOT_CHECKED, never a zero score', async () => {
      // Pins the inversion directly: unparseable output must not be aggregated as
      // validity 0. If someone restores `parsed = { validity: 0, confidence: 0 }` into
      // the responder set, `checked` flips true and this goes red.
      const taskData = { claimed_by: 'ClaimerBot', title: 'T', description: 'D', result: 'R' };
      const res = await runPCP(taskData);
      expect(res.checked).toBe(false);
      expect(res.respondedCount).toBe(0);
      expect(res.attemptedCount).toBeGreaterThan(0);
    });

    it('a failed agent fetch is checked:false with a named reason, logged loud, never a quiet zero', async () => {
      const loud = jest.spyOn(console, 'error').mockImplementation(() => {});
      (db as any).select.mockResolvedValueOnce({ data: null, error: { message: 'connection reset' } });
      const res = await runPCP({ claimed_by: 'ClaimerBot', title: 'T', description: 'D', result: 'R' });
      expect(res).toMatchObject({ checked: false, reason: 'validator_fetch_failed', score: 0, validators: [], attemptedCount: 0 });
      expect(loud).toHaveBeenCalledWith(expect.stringMatching(/NOT_CHECKED \(validator_fetch_failed\): could not read repid_agents: connection reset/));
      loud.mockRestore();
    });

    it('an empty eligible pool is checked:false with a named reason, logged loud', async () => {
      const loud = jest.spyOn(console, 'error').mockImplementation(() => {});
      (db as any).select.mockResolvedValueOnce({ data: [{ agent_name: 'Solo', current_repid: 900, lifecycle_status: 'test_only' }], error: null });
      const res = await runPCP({ claimed_by: 'ClaimerBot', title: 'T', description: 'D', result: 'R' });
      expect(res).toMatchObject({ checked: false, reason: 'no_eligible_validators', score: 0, validators: [] });
      expect(loud).toHaveBeenCalledWith(expect.stringMatching(/NOT_CHECKED \(no_eligible_validators\): 0 of 1 agent/));
      expect(global.fetch).not.toHaveBeenCalled();
      loud.mockRestore();
    });

    it('aggregates scores correctly based on confidence weighting', async () => {
      // Mock fetch to return specific scores depending on the prompt or just cycle them
      let callCount = 0;
      (global.fetch as jest.Mock).mockImplementation(() => {
        callCount++;
        let validity = 0.5;
        let confidence = 0.5;
        
        if (callCount === 1) {
          validity = 1.0;
          confidence = 1.0;
        } else if (callCount === 2) {
          validity = 0.0;
          confidence = 0.5;
        } else {
          validity = 0.8;
          confidence = 0.8;
        }

        return Promise.resolve({
          json: () => Promise.resolve({
            choices: [{ message: { content: `{"validity": ${validity}, "confidence": ${confidence}, "justification": "ok"}` } }]
          })
        });
      });

      const taskData = { claimed_by: 'ClaimerBot', title: 'Test Task', description: 'Desc', result: 'Res' };
      const res = await runPCP(taskData);

      // (1.0*1.0 + 0.0*0.5 + 0.8*0.8) / (1.0 + 0.5 + 0.8)
      // (1.0 + 0 + 0.64) / 2.3 = 1.64 / 2.3 = 0.713
      expect(res.score).toBeCloseTo(1.64 / 2.3);
      expect(res.confidence).toBeCloseTo(2.3 / 3);
    });
  });
});

// Every PCP "validator" is the same model call; the drawn agent is who it is recorded under and paid
// (VALIDATOR_REWARD). Measured 2026-10-15: mock fixtures and human rows were being drawn.
describe('eligibleValidators: who may be named as a validator', () => {
  const ok = { id: 'a1', agent_name: 'trinity-veritas', current_repid: 1800, lifecycle_status: 'active' };

  it('keeps an active agent with enough RepID', () => {
    expect(eligibleValidators([ok], 'someone-else')).toEqual([ok]);
  });

  it('drops a human row: a person did not give this LLM verdict', () => {
    expect(eligibleValidators([{ ...ok, agent_name: 'SEAN', is_human: true }], 'x')).toEqual([]);
  });

  it('drops a mock-harness fixture by its own mark (JSON true or text "true")', () => {
    expect(eligibleValidators([{ ...ok, agent_name: 'trinity-mock-it-seller-1', mock: true }], 'x')).toEqual([]);
    expect(eligibleValidators([{ ...ok, agent_name: 'trinity-mock-it-buyer-1', mock: 'true' }], 'x')).toEqual([]);
  });

  it('keeps the original rules: not the claimer by id or name, repid >= 500, lifecycle active', () => {
    expect(eligibleValidators([ok], 'trinity-veritas')).toEqual([]);
    expect(eligibleValidators([ok], 'a1')).toEqual([]);
    expect(eligibleValidators([{ ...ok, current_repid: 499 }], 'x')).toEqual([]);
    expect(eligibleValidators([{ ...ok, lifecycle_status: 'test_only' }], 'x')).toEqual([]);
  });

  it('lifecycle must be exactly active: deprecated, archived, null and missing are all out (XC1 on #1396)', () => {
    for (const lifecycle_status of ['deprecated', 'archived', null, undefined, 'ACTIVE']) {
      expect(eligibleValidators([{ ...ok, lifecycle_status }], 'x')).toEqual([]);
    }
  });

  it('drops a harness fixture by its enforced name even when the JSON mark was omitted', () => {
    expect(eligibleValidators([{ ...ok, agent_name: 'trinity-mock-it-seller-9' }], 'x')).toEqual([]);
    expect(eligibleValidators([{ ...ok, agent_name: 'mock-buyer-2' }], 'x')).toEqual([]);
    // Not a prefix match on any "mock" substring: a real agent may carry the word.
    expect(eligibleValidators([{ ...ok, agent_name: 'trinity-mockingbird-auditor' }], 'x')).toHaveLength(1);
  });

  it('a row with no is_human / mock fields (older selects) is not excluded by them', () => {
    expect(eligibleValidators([{ ...ok, is_human: false, mock: null }], 'x')).toHaveLength(1);
  });
});

// VALIDATOR_POOL_INTEGRITY. Mirrors contract 02ed66b1 (settled 2026-10-16 12:04Z) [V prod]: buyer
// trinity-nexus, provider trinity-chesed, voters orch + trinity-redteam-synth-subject (a red-team
// fixture inserted active by scripts/redteam/synthetic-round.ts) + gcm (same builder as both parties).
describe('VALIDATOR_POOL_INTEGRITY: test agents and same-owner voters', () => {
  const B = 'd8e47f71-61b6-45ef-af16-bc5de20b1234';
  const row = (agent_name: string, builder_id: string | null, current_repid = 1000) =>
    ({ id: `u-${agent_name}`, agent_name, builder_id, current_repid, lifecycle_status: 'active' });
  // Pool order matters: with Math.random() = 0 the draw takes the first three eligible rows, which
  // are exactly the three the rule flags. So OFF must draw them and ON must not.
  const ROWS = [
    row('trinity-nexus', B), // buyer
    row('trinity-chesed', B), // provider
    row('trinity-gcm', B),
    row('trinity-redteam-synth-subject', null, 580),
    row('trinity-orch', null),
    row('trinity-w3c', null),
    row('trinity-apm', '44cebb64-f4f2-46d1-8782-d83c5bf23202'),
  ];
  const task = { claimed_by: 'u-trinity-nexus', counterparties: ['u-trinity-chesed'], contract_id: '02ed66b1', title: 'T', description: 'D', result: 'R' };
  const answer = { json: () => Promise.resolve({ choices: [{ message: { content: '{"validity": 1, "confidence": 0.9}' } }] }) };
  let log: jest.SpyInstance;
  let rnd: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GROQ_API_KEY = 'test-key';
    (global.fetch as jest.Mock).mockResolvedValue(answer);
    rnd = jest.spyOn(Math, 'random').mockReturnValue(0);
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.VALIDATOR_POOL_INTEGRITY;
    rnd.mockRestore();
    log.mockRestore();
  });
  const shadowLines = () => log.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('validator_pool_shadow')).map((s) => JSON.parse(s));

  it('classifies: fixture by name, the provider itself, a shared builder_id; a null builder is never "same"', () => {
    const eligible = eligibleValidators(ROWS, task.claimed_by);
    const flagged = poolIntegrityExclusions(eligible, ROWS, [task.claimed_by, ...task.counterparties]);
    expect(Object.fromEntries([...flagged].map(([a, r]) => [a.agent_name, r]))).toEqual({
      'trinity-chesed': 'counterparty',
      'trinity-gcm': 'same_builder',
      'trinity-redteam-synth-subject': 'test_agent_name',
    });
  });

  it('the name stopgap matches whole tokens only', () => {
    const names = ['trinity-t12-e2e', 'trinity-dry_run_agent_1780476000151', 'test-agent-v11', 'trinity-redteam-synth-finder', 'fixture.1',
      'trinity-attestor', 'trinity-mockingbird-auditor', 'CONTESTED', 'synthesis-bot'];
    const rows = names.map((n) => row(n, null));
    expect([...poolIntegrityExclusions(rows, rows, [])].map(([a]) => a.agent_name))
      .toEqual(['trinity-t12-e2e', 'trinity-dry_run_agent_1780476000151', 'test-agent-v11', 'trinity-redteam-synth-finder', 'fixture.1']);
  });

  it('OFF: the draw and the result are byte-identical to the unfiltered draw; the shadow line names the tainted voters', async () => {
    (db as any).select.mockResolvedValueOnce({ data: ROWS, error: null });
    const res = await runPCP(task);
    // What main draws: the same eligible pool, the same RNG, no integrity filter.
    const drawn = selectWeightedValidators(eligibleValidators(ROWS, task.claimed_by), 3).map((a) => a.agent_name);
    expect(drawn).toEqual(['trinity-chesed', 'trinity-gcm', 'trinity-redteam-synth-subject']);
    expect(JSON.stringify(res)).toBe(JSON.stringify({
      score: 1, confidence: 0.9, checked: true, respondedCount: 3, attemptedCount: 3,
      validators: drawn, attemptedValidators: drawn, validatorBeliefs: [0.9, 0.9, 0.9],
    }));
    expect(shadowLines()).toEqual([{
      event: 'validator_pool_shadow', contract_id: '02ed66b1',
      excluded: [
        { agent: 'trinity-chesed', reason: 'counterparty' },
        { agent: 'trinity-gcm', reason: 'same_builder' },
        { agent: 'trinity-redteam-synth-subject', reason: 'test_agent_name' },
      ],
      independent_pool: 3,
    }]);
  });

  it('OFF includes an ignored value: only the exact string "true" turns it on', async () => {
    process.env.VALIDATOR_POOL_INTEGRITY = 'TRUE';
    (db as any).select.mockResolvedValueOnce({ data: ROWS, error: null });
    const res = await runPCP(task);
    expect(res.validators).toEqual(['trinity-chesed', 'trinity-gcm', 'trinity-redteam-synth-subject']);
  });

  it('ON: flagged agents are never drawn; the independent three vote; no shadow line', async () => {
    process.env.VALIDATOR_POOL_INTEGRITY = 'true';
    (db as any).select.mockResolvedValueOnce({ data: ROWS, error: null });
    const res = await runPCP(task);
    expect(res.checked).toBe(true);
    expect(res.validators).toEqual(['trinity-orch', 'trinity-w3c', 'trinity-apm']);
    expect(shadowLines()).toEqual([]);
  });

  it('ON, fewer than 3 independent validators: NOT_CHECKED (insufficient_independent_validators), no vote on fewer', async () => {
    process.env.VALIDATOR_POOL_INTEGRITY = 'true';
    const loud = jest.spyOn(console, 'error').mockImplementation(() => {});
    const short = ROWS.filter((a) => a.agent_name !== 'trinity-w3c' && a.agent_name !== 'trinity-apm');
    (db as any).select.mockResolvedValueOnce({ data: short, error: null });
    const res = await runPCP(task);
    expect(res).toMatchObject({ checked: false, reason: 'insufficient_independent_validators', score: 0, confidence: 0, validators: [] });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(loud).toHaveBeenCalledWith(expect.stringMatching(/1 independent validator\(s\), 3 required; excluded .*trinity-redteam-synth-subject:test_agent_name/));
    loud.mockRestore();
  });
});
