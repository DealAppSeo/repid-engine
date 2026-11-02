/**
 * bridge-known-answer-shadow.test.ts — TRINITY_BRIDGE_KNOWN_ANSWER_MODE.
 *
 * Known-answer (T12) tasks carry metadata.case_id. In `shadow` mode the bridge still runs HAL and
 * still writes the HAL_SCORE_EVENT row (provider-health telemetry continues), but the row is
 * is_shadow: it moves no RepID, never touches repid_agents directly, queues no proof, and queues no
 * peer verification. Unset / 'canonical' is today's behaviour byte for byte (D-124).
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
              eq: () => ({
                maybeSingle: async () => ({ data: { id: st().agent.id }, error: null }),
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
async function tick(metadata: Record<string, unknown>) {
  const st = {
    tasks: [task(metadata)],
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
  test.each([undefined, '', '  ', 'canonical', 'CANONICAL', ' Canonical '])('%p → canonical, recognised', (raw) => {
    expect(resolveKnownAnswerMode(raw)).toEqual({ mode: 'canonical', recognised: true });
  });
  test.each(['shadow', 'SHADOW', ' shadow '])('%p → shadow, recognised', (raw) => {
    expect(resolveKnownAnswerMode(raw)).toEqual({ mode: 'shadow', recognised: true });
  });
  test.each(['enfroce', 'off', 'true', '1'])('%p → shadow, NOT recognised (fail toward not moving RepID)', (raw) => {
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

describe('bridge: canonical is today, exactly (witness for every shadow absence below)', () => {
  test('unset: row is a live event, repid_agents is updated, proof and peer-verify are queued', async () => {
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

  test("'canonical' and unset and a no-case_id task in shadow mode all write the identical row", async () => {
    const unset = await tick({ case_id: 'ka-001' });
    process.env[ENV] = 'canonical';
    const explicit = await tick({ case_id: 'ka-001' });
    process.env[ENV] = 'shadow';
    const noCase = await tick({ topic: 'ordinary swarm task' });
    // zk_proof_id is a fresh random uuid per event; everything else must match exactly.
    const norm = (row: any) => ({ ...row, zk_proof_id: expect.any(String) });
    expect(explicit.inserts[0]).toEqual(norm(unset.inserts[0]));
    expect(noCase.inserts[0]).toEqual(norm(unset.inserts[0]));
    // ...and the side effects are the live ones in all three.
    for (const r of [unset, explicit, noCase]) {
      expect(r.agentUpdates).toHaveLength(1);
      expect(r.proofQueue).toHaveLength(1);
      expect(r.peerEnqueues).toBe(1);
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
    delete process.env[ENV];
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
