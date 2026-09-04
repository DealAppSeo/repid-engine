/**
 * service-quality-hook.test.ts
 *
 * Pins the properties that make this hook safe to merge inert, not the HAL
 * verdict itself (that needs providers and belongs to the HAL suites).
 *
 * The load-bearing assertions here are the NEGATIVE ones: that `off` is the
 * default, that `off` performs NO I/O at all, and that a disabled or unenrolled
 * run reports `checked: false` rather than an absent verdict a reader could
 * mistake for a pass. Those are exactly the properties that decay silently —
 * nothing fails loudly when a default flips or a guard stops running.
 */

// config.ts throws without these; set before the module graph is imported.
process.env['SUPABASE_URL'] = process.env['SUPABASE_URL'] || 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] = process.env['SUPABASE_SERVICE_KEY'] || 'dummy';

const dbFrom = jest.fn();
jest.mock('../src/db', () => ({ db: { from: (...a: unknown[]) => dbFrom(...a) } }));

const halEvaluate = jest.fn();
jest.mock('../src/hal/service', () => ({ halService: { evaluate: (...a: unknown[]) => halEvaluate(...a) } }));

const runScoreEvent = jest.fn();
jest.mock('../src/scoring/pipeline', () => ({
  ...jest.requireActual('../src/scoring/pipeline'),
  runScoreEvent: (...a: unknown[]) => runScoreEvent(...a),
}));

import {
  serviceQualityConfig,
  recordServiceQuality,
  artifactText,
  DEFAULT_ENROLLED_AGENTS,
  SERVICE_TASK_DOMAIN,
} from '../src/services/service-quality-hook';
import { classifyTaskPurpose } from '../src/scoring/task-purpose';

const ENV_KEYS = ['SERVICE_QUALITY_HOOK_MODE', 'SERVICE_QUALITY_HOOK_AGENTS'] as const;

describe('service-quality-hook', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    dbFrom.mockReset();
    halEvaluate.mockReset();
    runScoreEvent.mockReset();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  });

  describe('config', () => {
    it('defaults to OFF — a merge changes no scoring behaviour', () => {
      expect(serviceQualityConfig().mode).toBe('off');
    });

    it('treats an unrecognised mode as off, never as on', () => {
      process.env['SERVICE_QUALITY_HOOK_MODE'] = 'yes-please';
      expect(serviceQualityConfig().mode).toBe('off');
    });

    it('parses shadow and enforce', () => {
      process.env['SERVICE_QUALITY_HOOK_MODE'] = 'shadow';
      expect(serviceQualityConfig().mode).toBe('shadow');
      process.env['SERVICE_QUALITY_HOOK_MODE'] = 'ENFORCE';
      expect(serviceQualityConfig().mode).toBe('enforce');
    });

    it('enrols exactly the two measured delivering agents by default — not everyone', () => {
      // The point of this assertion is the SIZE. If a later change defaults the
      // allowlist to every agent, a single flag flip would put the whole fleet's
      // reputation on a HAL verdict, which is the blast radius this guards.
      const { agents } = serviceQualityConfig();
      expect(agents.size).toBe(2);
      expect([...agents].sort()).toEqual([...DEFAULT_ENROLLED_AGENTS].sort());
    });

    it('honours an explicit allowlist', () => {
      process.env['SERVICE_QUALITY_HOOK_AGENTS'] = 'a-one, a-two ,a-three';
      expect([...serviceQualityConfig().agents].sort()).toEqual(['a-one', 'a-three', 'a-two']);
    });
  });

  describe('off means off', () => {
    it('reports NOT_CHECKED and touches neither the database nor HAL', async () => {
      const obs = await recordServiceQuality({
        contractId: 'c1',
        providerAgentId: 'p1',
        serviceType: 'verification',
        result: { answer: 'anything' },
      });

      expect(obs.mode).toBe('off');
      expect(obs.checked).toBe(false);
      expect(obs.reason).toBe('hook_disabled');
      // Not merely "no score changed" — no I/O happened at all.
      expect(dbFrom).not.toHaveBeenCalled();
      expect(halEvaluate).not.toHaveBeenCalled();
      // A disabled run must never look like a verdict.
      expect(obs.hal_decision).toBeUndefined();
      expect(obs.would_apply).toBeUndefined();
      expect(obs.applied).toBeUndefined();
    });
  });

  describe('enrolment gate', () => {
    it('declines an unenrolled agent without evaluating, and says so', async () => {
      process.env['SERVICE_QUALITY_HOOK_MODE'] = 'shadow';
      dbFrom.mockReturnValue({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { id: 'p1', agent_name: 'somebody-else', current_repid: 1000, tier: 'ESTABLISHED' },
            }),
          }),
        }),
      });

      const obs = await recordServiceQuality({
        contractId: 'c1',
        providerAgentId: 'p1',
        serviceType: 'verification',
        result: { answer: 'anything' },
      });

      expect(obs.checked).toBe(false);
      expect(obs.reason).toBe('agent_not_enrolled');
      expect(obs.agent_name).toBe('somebody-else');
      expect(halEvaluate).not.toHaveBeenCalled();
      expect(obs.would_apply).toBeUndefined();
    });

    it('reports NOT_CHECKED when the provider agent cannot be resolved', async () => {
      process.env['SERVICE_QUALITY_HOOK_MODE'] = 'shadow';
      dbFrom.mockReturnValue({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      });

      const obs = await recordServiceQuality({
        contractId: 'c1',
        providerAgentId: 'ghost',
        serviceType: 'verification',
        result: { answer: 'anything' },
      });

      expect(obs.checked).toBe(false);
      expect(obs.reason).toBe('provider_agent_not_found');
      expect(halEvaluate).not.toHaveBeenCalled();
    });
  });

  describe('enforce evaluates exactly once', () => {
    it('routes to runScoreEvent WITHOUT a second HAL call of its own', async () => {
      // runScoreEvent evaluates internally. An earlier draft also pre-evaluated
      // here, which bought two provider round-trips per contract and two
      // verdicts on one artifact that can disagree — the ledger would record one
      // and the caller would be told the other, both called "the" score.
      process.env['SERVICE_QUALITY_HOOK_MODE'] = 'enforce';
      process.env['SERVICE_QUALITY_HOOK_AGENTS'] = 'trinity-nexus';
      dbFrom.mockReturnValue({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { id: 'p1', agent_name: 'trinity-nexus', current_repid: 1792, tier: 'ESTABLISHED' },
            }),
          }),
        }),
      });
      runScoreEvent.mockResolvedValue({
        score_event_id: 42, hal_score: 0.2, hal_decision: 'clean',
        repid_delta_applied: 2, repid_delta_calculated: 2,
      });

      const obs = await recordServiceQuality({
        contractId: 'c9',
        providerAgentId: 'p1',
        serviceType: 'verification',
        result: { answer: 'delivered work' },
      });

      expect(runScoreEvent).toHaveBeenCalledTimes(1);
      expect(halEvaluate).not.toHaveBeenCalled();
      expect(obs.checked).toBe(true);
      expect(obs.applied).toBe(2);
      expect(obs.score_event_id).toBe(42);
      // enforce reports what MOVED, never a counterfactual.
      expect(obs.would_apply).toBeUndefined();

      // The task_domain is the entire point — it is what makes this deliverable.
      const passed = runScoreEvent.mock.calls[0][0] as Record<string, unknown>;
      expect(passed['task_domain']).toBe(SERVICE_TASK_DOMAIN);
      expect(passed['contract_id']).toBe('c9');
      // Idempotent per contract: a retried fulfilment must not score twice.
      expect(passed['idempotency_key']).toBe('service-quality:v1:c9');
    });
  });

  describe('never throws into fulfilment', () => {
    it('converts a thrown HAL error into NOT_CHECKED, not a rejection', async () => {
      process.env['SERVICE_QUALITY_HOOK_MODE'] = 'shadow';
      dbFrom.mockImplementation(() => { throw new Error('database on fire'); });

      // The buyer already has the artifact by the time this runs. A quality
      // probe that throws would undo a completed fulfilment.
      const obs = await recordServiceQuality({
        contractId: 'c1',
        providerAgentId: 'p1',
        serviceType: 'verification',
        result: { answer: 'anything' },
      });

      expect(obs.checked).toBe(false);
      expect(obs.reason).toMatch(/hal_error: database on fire/);
    });
  });

  describe('artifactText', () => {
    it('prefers an explicit textual field and names which one it used', () => {
      expect(artifactText({ answer: 'the answer', id: 7 })).toEqual({
        text: 'the answer', source: 'answer',
      });
      expect(artifactText({ summary: 'a summary' }).source).toBe('summary');
    });

    it('falls back to the JSON envelope and SAYS so', () => {
      // "HAL scored the answer" and "HAL scored the bookkeeping envelope" are
      // different measurements; the source label is what keeps them apart.
      const out = artifactText({ id: 1, verdict: 'PASS' });
      expect(out.source).toBe('json_envelope');
      expect(out.text).toContain('PASS');
    });

    it('ignores an empty or whitespace-only textual field', () => {
      expect(artifactText({ answer: '   ', output: 'real output' }).source).toBe('output');
    });
  });

  describe('the premise the hook rests on', () => {
    it("classifies 'service_contract' as a deliverable at full weight", () => {
      // If this ever stops holding, the hook silently scores nothing — the
      // purpose gate would zero it in both directions and the whole exercise
      // becomes a no-op that still looks wired.
      const v = classifyTaskPurpose(SERVICE_TASK_DOMAIN, null);
      expect(v.purpose).toBe('deliverable');
      expect(v.halVetoApplies).toBe(true);
      expect(v.weight).toBe(1);
    });
  });
});
