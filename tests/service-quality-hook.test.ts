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
  serviceQualityStatus,
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

  describe('serviceQualityStatus — the flag has to be readable from outside', () => {
    it('reports off/default when nothing is set, and never a secret value', () => {
      // The whole point: "is the flag set?" must be answerable without dashboard
      // access. It previously was not, and the work stopped on the guess.
      expect(serviceQualityStatus()).toEqual({
        mode: 'off', enrolled_count: 2, allowlist: 'default',
      });
    });

    it('distinguishes an env-supplied allowlist from the compiled default', () => {
      // This is the half that fails silently: an env var set on the WRONG
      // service leaves the process on its compiled default while the operator
      // believes it took. Same count, different provenance — so report both.
      process.env['SERVICE_QUALITY_HOOK_MODE'] = 'shadow';
      process.env['SERVICE_QUALITY_HOOK_AGENTS'] = 'one, two';
      expect(serviceQualityStatus()).toEqual({
        mode: 'shadow', enrolled_count: 2, allowlist: 'env',
      });
    });

    it('does not report an allowlist as env-supplied when the var is empty', () => {
      process.env['SERVICE_QUALITY_HOOK_AGENTS'] = '   ';
      expect(serviceQualityStatus().allowlist).toBe('default');
    });

    it('tracks serviceQualityConfig rather than re-reading the environment', () => {
      // If these two ever disagree, /health becomes a confident lie about what
      // the hook is doing — worse than reporting nothing at all.
      process.env['SERVICE_QUALITY_HOOK_MODE'] = 'enforce';
      expect(serviceQualityStatus().mode).toBe(serviceQualityConfig().mode);
      expect(serviceQualityStatus().enrolled_count).toBe(serviceQualityConfig().agents.size);
    });
  });

  describe('the gate reads the PROVIDER, which is the mistake this list already made', () => {
    it('resolves the enrolled agent by providerAgentId — never the buyer', async () => {
      // WHY THIS IS PINNED. The default allowlist originally named the most
      // active agent on service_contracts, which was the most active BUYER. The
      // hook keys on the provider, so that agent could never match: every
      // fulfilment would have reported `agent_not_enrolled` forever while the
      // hook looked correctly wired. The lookup key is the thing that makes
      // "who is enrolled" answerable, so it is asserted rather than assumed.
      process.env['SERVICE_QUALITY_HOOK_MODE'] = 'shadow';
      const eqCalls: Array<[string, unknown]> = [];
      const tables: string[] = [];
      dbFrom.mockImplementation((t: string) => {
        tables.push(t);
        return {
          select: () => ({
            eq: (col: string, val: unknown) => {
              eqCalls.push([col, val]);
              return { maybeSingle: async () => ({ data: null }) };
            },
          }),
        };
      });

      await recordServiceQuality({
        contractId: 'c1',
        providerAgentId: 'THE-PROVIDER',
        serviceType: 'verification',
        result: { answer: 'anything' },
      });

      expect(tables).toContain('repid_agents');
      expect(eqCalls).toContainEqual(['id', 'THE-PROVIDER']);
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

  describe('a degraded HAL run is NOT_CHECKED, whatever its decision', () => {
    // THE BUG THIS PINS, found 2026-09-04 one day after the hook was written.
    // The guard checked `reward_suppressed` alone. applyProviderEvidenceGuard
    // sets that ONLY for a `clean` decision — a zero-provider `vetoed` gets
    // `veto_suppressed`, and a zero-provider `flagged` gets NEITHER. So two of
    // the three zero-provider outcomes were recorded as `checked: true` with a
    // hal_decision, indistinguishable from a real cross-LLM verdict, when what
    // actually ran was the style-extractor (measured AUC ~0.375 — below chance).
    // The mock must serve BOTH tables the shadow path touches: the repid_agents
    // read AND the service_contracts write. An earlier version omitted .update()
    // and the provider-backed case reported NOT_CHECKED for a reason that had
    // nothing to do with the guard under test — a red that would have been easy
    // to "fix" by loosening the assertion instead of the mock.
    const writes: Array<Record<string, unknown>> = [];
    const enrolled = () => {
      process.env['SERVICE_QUALITY_HOOK_MODE'] = 'shadow';
      process.env['SERVICE_QUALITY_HOOK_AGENTS'] = 'trinity-shofet';
      writes.length = 0;
      dbFrom.mockImplementation((table: string) => {
        if (table === 'repid_agents') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: 'p1', agent_name: 'trinity-shofet', current_repid: 1500, tier: 'ESTABLISHED' },
                }),
              }),
            }),
          };
        }
        return {
          update: (payload: Record<string, unknown>) => {
            writes.push(payload);
            return { eq: async () => ({ error: null }) };
          },
        };
      });
    };
    const run = () => recordServiceQuality({
      contractId: 'c1', providerAgentId: 'p1', serviceType: 'verification',
      result: { answer: 'delivered work' },
    });

    // Each case is a zero-provider extractor fallback. Only the first was caught
    // before; the other two are the regression.
    it.each([
      ['clean   (was caught — reward_suppressed set)', { decision: 'clean', reward_suppressed: { reason_code: 'NO_PROVIDER_EVIDENCE' } }],
      ['vetoed  (was NOT caught — veto_suppressed only)', { decision: 'flagged', veto_suppressed: { reason_code: 'NO_PROVIDER_EVIDENCE' } }],
      ['flagged (was NOT caught — no marker at all)', { decision: 'flagged' }],
    ])('reports NOT_CHECKED for a degraded %s', async (_label, extra) => {
      enrolled();
      halEvaluate.mockResolvedValue({
        hal_score: 0.42,
        mode: 'extractor-fallback',
        degraded_mode: true,
        degraded_reason: 'strictness-2 requested but fact-check quorum unavailable',
        ...(extra as object),
      });

      const obs = await run();

      expect(obs.checked).toBe(false);
      expect(obs.reason).toMatch(/not_provider_backed|no_provider_evidence/);
      // The decisive assertion: no verdict may be reported for work nobody checked.
      expect(obs.hal_decision).toBeUndefined();
      expect(obs.would_apply).toBeUndefined();
      // And nothing is stored beside the artifact — a NOT_CHECKED observation
      // must not leave a row a later reader could mistake for a verdict.
      expect(writes).toHaveLength(0);
    });

    it('carries HAL\'s own reason through, so the stored observation says WHY', async () => {
      enrolled();
      halEvaluate.mockResolvedValue({
        hal_score: 0.42, mode: 'extractor-fallback', degraded_mode: true,
        degraded_reason: 'fact-check quorum unavailable (0 provider(s) configured)',
        decision: 'flagged',
      });
      const obs = await run();
      expect(obs.degraded_reason).toContain('quorum unavailable');
    });

    it('still records a verdict when the run WAS provider-backed', async () => {
      // The guard must not swallow the real path — a check that reports
      // NOT_CHECKED for everything is not a check.
      enrolled();
      halEvaluate.mockResolvedValue({ hal_score: 0.1, mode: 'fact-check', decision: 'clean' });
      const obs = await run();
      expect(obs.checked).toBe(true);
      expect(obs.hal_decision).toBeDefined();
      expect(writes).toHaveLength(1);
    });
  });

  describe('the shadow must predict ENFORCE, not something adjacent to it', () => {
    // runScoreEvent does not feed HAL's raw decision to computeDelta. Below two
    // independent FAMILIES it substitutes 'flagged' first (pipeline.ts,
    // `decisionNeutralized`/`scoringDecision`), which computes to zero. A shadow
    // that skipped that step would forecast a reward enforce never pays — and
    // these observations exist to be read when deciding whether to switch
    // enforcement on, so an inflated forecast corrupts exactly that decision.
    const writes2: Array<Record<string, unknown>> = [];
    const shadowOn = () => {
      process.env['SERVICE_QUALITY_HOOK_MODE'] = 'shadow';
      process.env['SERVICE_QUALITY_HOOK_AGENTS'] = 'trinity-shofet';
      writes2.length = 0;
      dbFrom.mockImplementation((table: string) => table === 'repid_agents'
        ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({
            data: { id: 'p1', agent_name: 'trinity-shofet', current_repid: 1500, tier: 'ESTABLISHED' },
          }) }) }) }
        : { update: (payload: Record<string, unknown>) => {
            writes2.push(payload); return { eq: async () => ({ error: null }) };
          } });
    };
    const run = () => recordServiceQuality({
      contractId: 'c1', providerAgentId: 'p1', serviceType: 'verification',
      result: { answer: 'delivered work' },
    });
    // hal_score below 0.40 → deriveHalDecision returns 'clean', the branch that pays.
    const cleanAt = (signals: Record<string, unknown>) => ({
      hal_score: 0.1, mode: 'fact-check', decision: 'clean', signals,
    });

    it('pays nothing when only ONE family voted, even on a clean verdict', async () => {
      shadowOn();
      halEvaluate.mockResolvedValue(cleanAt({ providers_used: 2, families_used: 1 }));

      const obs = await run();

      expect(obs.checked).toBe(true);            // it WAS checked — this is not NOT_CHECKED
      expect(obs.hal_decision).toBe('clean');    // what HAL said
      expect(obs.scoring_decision).toBe('flagged'); // what the delta came from
      expect(obs.quorum_met).toBe(false);
      expect(obs.would_apply).toBe(0);
    });

    it('two HOSTS running one model is still one family, and still pays nothing', async () => {
      // The distinction that makes families the quorum unit: N families behind
      // one host are N opinions that vanish in a single outage.
      shadowOn();
      halEvaluate.mockResolvedValue(cleanAt({ providers_used: 2, families_used: 1 }));
      const obs = await run();
      expect(obs.families_used).toBe(1);
      expect(obs.would_apply).toBe(0);
    });

    it('pays when two independent families agreed', async () => {
      // The guard must not zero everything — a forecast that is always 0 is not
      // a forecast.
      shadowOn();
      halEvaluate.mockResolvedValue(cleanAt({ providers_used: 2, families_used: 2 }));

      const obs = await run();

      expect(obs.quorum_met).toBe(true);
      expect(obs.scoring_decision).toBe('clean');
      expect(obs.would_apply).toBeGreaterThan(0);
    });

    it('stores both decisions, so a neutralized verdict cannot later read as a real one', async () => {
      shadowOn();
      halEvaluate.mockResolvedValue(cleanAt({ providers_used: 1, families_used: 1 }));
      await run();
      const stored = (writes2[0] as any).metadata.hal_quality_shadow;
      expect(stored.hal_decision).toBe('clean');
      expect(stored.scoring_decision).toBe('flagged');
      expect(stored.quorum_met).toBe(false);
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
