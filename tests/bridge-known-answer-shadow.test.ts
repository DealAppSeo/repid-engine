/**
 * bridge-known-answer-shadow.test.ts — TRINITY_BRIDGE_KNOWN_ANSWER_MODE.
 *
 * Known-answer (T12) tasks carry metadata.case_id. In `shadow` mode the bridge still runs HAL and
 * still writes the HAL_SCORE_EVENT row (provider-health telemetry continues), but the row is
 * is_shadow: it moves no RepID, never touches repid_agents directly, queues no proof, and queues no
 * peer verification. The switch FAILS CLOSED: only 'canonical' moves RepID for these rows; unset,
 * empty and unrecognised values are all shadow. (Until 2026-11-20 unset meant canonical, and this
 * file asserted it; those assertions were changed with the default.) A task with no case_id never
 * consults the switch.
 *
 * Ruler: the REAL bridge and the REAL runScoreEvent, with only src/db mocked. The assertions are on
 * the exact payload handed to repid_score_events.insert and on which other tables were touched.
 * Each "shadow wrote nothing" assertion has a canonical witness run in the same file, so an absence
 * cannot pass vacuously (e.g. because the proof path was never reachable).
 */

(global as any).__ka = null;

jest.mock('../src/db', () => {
  const st = () => (global as any).__ka;
  return {
    db: {
      from: (table: string) => {
        if (table === 'trinity_tasks') {
          const chain: any = {
            in: () => chain,
            or: () => chain,
            order: () => chain,
            limit: () => chain,
            then: (resolve: any) => resolve({ data: st().tasks, error: null }),
          };
          return {
            select: () => chain,
            update: (payload: any) => ({
              eq: (_c: string, id: unknown) => {
                st().taskUpdates.push({ id, payload });
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        }
        if (table === 'repid_agents') {
          return {
            select: () => ({
              eq: (_col: string, val: unknown) => ({
                // knownNames unset: every name lookup hits (the original behaviour of this double).
                maybeSingle: async () => ({
                  data: !st().knownNames || st().knownNames.includes(val) ? { id: st().agent.id } : null,
                  error: null,
                }),
                single: async () => ({ data: st().agent, error: null }),
              }),
            }),
            update: (payload: any) => ({
              eq: () => {
                st().agentUpdates.push(payload);
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        }
        if (table === 'repid_score_events') {
          return {
            select: (_cols?: string, opts?: any) => ({
              eq: () => ({
                limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
                then: (resolve: any) =>
                  resolve({ data: null, error: null, count: opts && opts.head ? st().eventCount : null }),
              }),
            }),
            insert: (payload: any) => ({
              select: () => ({
                single: async () => {
                  st().inserts.push(payload);
                  return { data: { id: 777 }, error: null };
                },
              }),
            }),
          };
        }
        if (table === 'repid_proof_queue') {
          return {
            insert: (payload: any) => {
              st().proofQueue.push(payload);
              return Promise.resolve({ data: null, error: null });
            },
          };
        }
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
          insert: () => Promise.resolve({ data: null, error: null }),
          update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
        };
      },
      rpc: async () => ({ data: null, error: null }),
    },
  };
});

// The offline HAL has no provider evidence, so its reward is "unearned" and every delta is 0 - which
// would make "shadow moved nothing" vacuous. Pin the delta the pipeline computes at +12 so the
// canonical witness really moves 1000 -> 1012 and the shadow row has something to NOT apply.
jest.mock('../src/scoring/repid-delta', () => {
  const actual = jest.requireActual('../src/scoring/repid-delta');
  return {
    ...actual,
    computeDelta: (...a: unknown[]) => ({
      ...(actual.computeDelta as (...x: unknown[]) => object)(...a),
      delta_calculated: 12,
      delta_applied: 12,
    }),
  };
});

jest.mock('../src/services/emergency-halt', () => ({ shouldParkForHalt: async () => false }));
jest.mock('../src/services/peer-verification-writer', () => ({
  enqueueVerification: jest.fn(async () => ({ id: 'pv-1' })),
}));

import {
  isKnownAnswerTask,
  pollCompletedTasks,
  resolveKnownAnswerMode,
  startTrinityTaskBridge,
} from '../src/services/trinity-task-bridge';
import { enqueueVerification } from '../src/services/peer-verification-writer';
import { checkRow } from '../src/scoring/delta-conformance';

const AGENT_ID = '11111111-2222-4333-8444-555555555555';
const ENV = 'TRINITY_BRIDGE_KNOWN_ANSWER_MODE';

function task(metadata: Record<string, unknown>) {
  return {
    id: 9001,
    agent_assigned: 'veritas',
    status: 'done',
    result: 'The capital of France is Paris.',
    certainty: 0.9,
    title: 'known answer',
    description: 'What is the capital of France?',
    task_type: 'factual',
    metadata,
    verification_required: true,
  };
}

/** Run one bridge tick over one task and return everything the tick wrote. */
async function tick(metadata: Record<string, unknown>, opts: { agent?: string; knownNames?: string[] } = {}) {
  const st = {
    tasks: [{ ...task(metadata), ...(opts.agent ? { agent_assigned: opts.agent } : {}) }],
    knownNames: opts.knownNames,
    agent: { id: AGENT_ID, current_repid: 1000, tier: 'ESTABLISHED', vesting_cliff_ends_at: null },
    // count BEFORE the insert is 9, so (9 + 1) % 10 === 0: the every-10th-event proof trigger fires.
    eventCount: 9,
    inserts: [] as any[],
    agentUpdates: [] as any[],
    proofQueue: [] as any[],
    taskUpdates: [] as any[],
  };
  (global as any).__ka = st;
  (enqueueVerification as jest.Mock).mockClear();
  await pollCompletedTasks();
  return { ...st, peerEnqueues: (enqueueVerification as jest.Mock).mock.calls.length };
}

let savedEnv: string | undefined;
let errSpy: jest.SpyInstance;
beforeEach(() => {
  savedEnv = process.env[ENV];
  delete process.env[ENV];
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  jest.restoreAllMocks();
});

describe('resolveKnownAnswerMode', () => {
  // Case and surrounding whitespace are ignored, as they always were; nothing else spells canonical.
  test.each(['canonical', 'CANONICAL', ' Canonical '])('%p → canonical, recognised', (raw) => {
    expect(resolveKnownAnswerMode(raw)).toEqual({ mode: 'canonical', recognised: true });
  });
  test.each([undefined, '', '  ', '\t\n'])('%p (unset / empty / whitespace) → shadow, NOT recognised', (raw) => {
    expect(resolveKnownAnswerMode(raw)).toEqual({ mode: 'shadow', recognised: false });
  });
  test('with no argument it reads the environment, and an absent variable is shadow', () => {
    delete process.env[ENV];
    expect(resolveKnownAnswerMode()).toEqual({ mode: 'shadow', recognised: false });
  });
  test.each(['shadow', 'SHADOW', ' shadow '])('%p → shadow, recognised', (raw) => {
    expect(resolveKnownAnswerMode(raw)).toEqual({ mode: 'shadow', recognised: true });
  });
  test.each(['enfroce', 'off', 'true', '1', 'canonical!', 'canon', 'live'])('%p → shadow, NOT recognised (fail toward not moving RepID)', (raw) => {
    expect(resolveKnownAnswerMode(raw)).toEqual({ mode: 'shadow', recognised: false });
  });
});

describe('isKnownAnswerTask', () => {
  test('metadata.case_id marks a known-answer task', () => {
    expect(isKnownAnswerTask({ case_id: 'ka-001' })).toBe(true);
    expect(isKnownAnswerTask({ case_id: 7 })).toBe(true);
  });
  test.each([{}, { case_id: null }, { case_id: '' }, { case_id: '  ' }, { other: 1 }])('%j is not', (m) => {
    expect(isKnownAnswerTask(m)).toBe(false);
  });
});

describe("bridge: 'canonical' is the live path (witness for every shadow absence below)", () => {
  beforeEach(() => {
    process.env[ENV] = 'canonical';
  });

  test("'canonical': row is a live event, repid_agents is updated, proof and peer-verify are queued", async () => {
    const r = await tick({ case_id: 'ka-001' });
    expect(r.inserts).toHaveLength(1);
    expect('is_shadow' in r.inserts[0]).toBe(false);
    expect(r.inserts[0].event_type).toBe('HAL_SCORE_EVENT');
    expect(r.inserts[0]).toMatchObject({ delta: 12, repid_delta_applied: 12, repid_before: 1000, repid_after: 1012 });
    expect(r.agentUpdates).toHaveLength(1);
    expect(r.agentUpdates[0].current_repid).toBe(1012);
    expect(r.proofQueue).toHaveLength(1);
    expect(r.peerEnqueues).toBe(1);
    expect(r.taskUpdates).toHaveLength(1);
  });

  test('a task recorded as trinity-foo is scored to the agent now named plain "foo"', async () => {
    // trinity_tasks still prefixes every name; since 2026-11-16 only the 12 originals keep it in repid_agents.
    const r = await tick({ case_id: 'ka-002' }, { agent: 'trinity-foo', knownNames: ['foo'] });
    expect(r.inserts).toHaveLength(1);
    expect(r.agentUpdates).toHaveLength(1);
  });

  test('an original is still found by its trinity- name, not by a bare slug', async () => {
    const r = await tick({ case_id: 'ka-003' }, { agent: 'veritas', knownNames: ['trinity-veritas'] });
    expect(r.inserts).toHaveLength(1);
  });

  test.each([['unset', undefined], ['empty', ''], ['whitespace', '  '], ['unrecognised', 'enfroce'], ['shadow', 'shadow'], ['canonical', 'canonical'], ['CANONICAL', 'CANONICAL']])(
    'a task WITHOUT a case_id is scored live and identically when the switch is %s',
    async (_label, value) => {
      const witness = await tick({ case_id: 'ka-001' }); // canonical known-answer row, from beforeEach
      if (value === undefined) delete process.env[ENV];
      else process.env[ENV] = value;
      const noCase = await tick({ topic: 'ordinary swarm task' });
      // zk_proof_id is a fresh random uuid per event; everything else must match exactly.
      expect(noCase.inserts[0]).toEqual({ ...witness.inserts[0], zk_proof_id: expect.any(String) });
      expect('is_shadow' in noCase.inserts[0]).toBe(false);
      expect(noCase.agentUpdates).toHaveLength(1);
      expect(noCase.proofQueue).toHaveLength(1);
      expect(noCase.peerEnqueues).toBe(1);
      // The switch is not consulted for such a row, so there is nothing to warn about.
      expect(errSpy.mock.calls.filter((c) => String(c[0]).includes(ENV))).toHaveLength(0);
    },
  );
});

describe('bridge: the switch fails closed', () => {
  test.each([['unset', undefined], ['empty', ''], ['whitespace', '   ']])(
    '%s: a known-answer task is a shadow row, nothing is applied, and the log says so',
    async (_label, value) => {
      if (value === undefined) delete process.env[ENV];
      else process.env[ENV] = value;
      const r = await tick({ case_id: 'ka-001' });
      expect(r.inserts).toHaveLength(1);
      expect(r.inserts[0].is_shadow).toBe(true);
      expect(r.inserts[0].delta).toBe(0);
      expect(r.inserts[0].repid_delta_applied).toBe(0);
      expect(r.inserts[0].repid_after).toBe(r.inserts[0].repid_before);
      expect(r.agentUpdates).toHaveLength(0);
      expect(r.proofQueue).toHaveLength(0);
      expect(r.peerEnqueues).toBe(0);
      const said = (console.log as unknown as jest.Mock).mock.calls.map((c) => String(c[0]));
      expect(said.some((l) => l.includes('known-answer: SHADOW, no RepID movement'))).toBe(true);
    },
  );

  test('unset: the bridge start line names the mode and the unset-or-unrecognised warning is printed once', async () => {
    delete process.env[ENV];
    jest.useFakeTimers();
    (global as any).__ka = { tasks: [], inserts: [], agentUpdates: [], proofQueue: [], taskUpdates: [] };
    try {
      // The warning is printed once per process per value, so load a fresh copy of the module.
      await jest.isolateModulesAsync(async () => {
        const fresh = require('../src/services/trinity-task-bridge');
        await fresh.startTrinityTaskBridge();
        await fresh.startTrinityTaskBridge();
      });
      const lines = (console.log as unknown as jest.Mock).mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes(`known-answer mode: shadow (${ENV})`))).toBe(true);
      const warned = errSpy.mock.calls.filter((c) => String(c[0]).includes(ENV) && String(c[0]).includes('unset or not recognised'));
      expect(warned).toHaveLength(1);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});

describe("bridge: TRINITY_BRIDGE_KNOWN_ANSWER_MODE='shadow'", () => {
  test('known-answer task: is_shadow row, nothing applied, no repid_agents update, no proof job, no peer-verify', async () => {
    process.env[ENV] = 'shadow';
    const r = await tick({ case_id: 'ka-001' });

    expect(r.inserts).toHaveLength(1);
    const row = r.inserts[0];
    expect(row.event_type).toBe('HAL_SCORE_EVENT'); // provider-health telemetry keeps flowing
    expect(row.is_shadow).toBe(true);
    expect(row.repid_delta_applied).toBe(0);
    expect(row.repid_after).toBe(row.repid_before);
    expect(row.repid_before).toBe(1000);
    expect(row.delta).toBe(0); // repid-sync-aggregator sums `delta`; a shadow row must contribute 0
    expect(row.zk_proof_triggered).toBe(false);
    expect(row.zk_proof_id).toBeNull();
    expect(row.idempotency_key).toBe('trinity_task_bridge_9001');
    expect(typeof row.hal_score).toBe('number'); // HAL still ran
    expect(row.hal_decision).toBeDefined();
    expect(row.repid_delta_calculated).toBe(12); // what it WOULD have earned, kept where nothing applies it
    expect(row.metadata.shadow).toEqual({
      reason: 'known_answer_task',
      counterfactual_delta: 12,
      counterfactual_applied: 12,
      counterfactual_after: 1012,
    });
    expect(row.metadata.applied).toBeUndefined(); // no "applied" block claiming a movement

    // The ledger's own conformance check (SHADOW_INERT) accepts the row as written.
    expect(checkRow({ id: 777, ...row }).map((v) => [v.check, v.status])).toEqual([['SHADOW_INERT', 'CONFORMS']]);

    expect(r.agentUpdates).toHaveLength(0);
    expect(r.proofQueue).toHaveLength(0);
    expect(r.peerEnqueues).toBe(0);
    expect(r.taskUpdates).toHaveLength(1); // still marked bridged, so it is not re-polled
  });

  test('the counterfactual delta survives in repid_delta_calculated, not in anything that applies', async () => {
    process.env[ENV] = 'shadow';
    const shadow = await tick({ case_id: 'ka-001' });
    process.env[ENV] = 'canonical';
    const live = await tick({ case_id: 'ka-001' });
    expect(shadow.inserts[0].repid_delta_calculated).toBe(live.inserts[0].repid_delta_calculated);
    expect(shadow.inserts[0].metadata.shadow.counterfactual_delta).toBe(live.inserts[0].delta);
    expect(shadow.inserts[0].metadata.shadow.counterfactual_after).toBe(live.inserts[0].repid_after);
  });

  test('unknown value: behaves as shadow and says so loudly, once', async () => {
    process.env[ENV] = 'enfroce';
    const first = await tick({ case_id: 'ka-001' });
    const second = await tick({ case_id: 'ka-002' });
    for (const r of [first, second]) {
      expect(r.inserts[0].is_shadow).toBe(true);
      expect(r.agentUpdates).toHaveLength(0);
      expect(r.proofQueue).toHaveLength(0);
    }
    const loud = errSpy.mock.calls.filter((c) => String(c[0]).includes(ENV));
    expect(loud).toHaveLength(1);
    expect(String(loud[0][0])).toContain('enfroce');
  });
});

describe('bridge start', () => {
  test('logs the resolved mode', async () => {
    process.env[ENV] = 'shadow';
    jest.useFakeTimers();
    (global as any).__ka = { tasks: [], inserts: [], agentUpdates: [], proofQueue: [], taskUpdates: [] };
    try {
      await startTrinityTaskBridge();
      const lines = (console.log as unknown as jest.Mock).mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes(`known-answer mode: shadow (${ENV})`))).toBe(true);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});
