/**
 * The lane fence and the handoff gate.
 *
 * Each block below names the real incident it exists to prevent. A test that cannot
 * name what it protects tends to be the test that gets "fixed" to match a regression.
 */

import {
  LANES,
  laneById,
  canAssign,
  cheapestCapableLane,
  eligibleVerifiers,
  missingCapabilities,
} from '../src/orchestration/lane-registry';
import {
  checkOutput,
  classifyDecision,
  evaluateHandoff,
  isPlaceholder,
  resolveVerification,
  MIN_PROSE_CHARS,
  type RequiredOutput,
} from '../src/orchestration/handoff-gate';

// ---------------------------------------------------------------------------
// Registry invariants
// ---------------------------------------------------------------------------

describe('lane registry invariants', () => {
  it('no lane hands work to itself — self-review is the failure being designed against', () => {
    for (const lane of LANES) {
      expect(lane.handsTo).not.toContain(lane.id);
    }
  });

  it('every lane states its source — a capability claim without a reason is unauditable', () => {
    for (const lane of LANES) {
      expect(lane.source.length).toBeGreaterThan(40);
    }
  });

  it('every lane can reason; reasoning alone is the floor, not a licence', () => {
    for (const lane of LANES) {
      expect(lane.capabilities).toContain('reasoning');
    }
  });

  it('only SEAN may merge, send a transaction, or touch infra', () => {
    for (const cap of ['merge', 'chain_send', 'infra'] as const) {
      const holders = LANES.filter((l) => l.capabilities.includes(cap)).map((l) => l.id);
      expect(holders).toEqual(['SEAN']);
    }
  });

  it('CC may write the database; GA and XC may not (single-writer discipline)', () => {
    expect(laneById('CC')!.capabilities).toContain('db_write');
    expect(laneById('GA')!.capabilities).not.toContain('db_write');
    expect(laneById('XC')!.capabilities).not.toContain('db_write');
  });

  it('XC cannot read the database either — it is DB-blind, so its DB claims are unsourceable', () => {
    expect(laneById('XC')!.capabilities).not.toContain('db_read');
  });
});

// ---------------------------------------------------------------------------
// The capability fence
// ---------------------------------------------------------------------------

describe('THE FENCE: T12 is never asked for something it cannot obtain', () => {
  it('T12 has reasoning and nothing else', () => {
    expect(laneById('T12')!.capabilities).toEqual(['reasoning']);
  });

  it('refuses to route a task needing http to T12, and says why', () => {
    const a = canAssign('T12', ['reasoning', 'http']);
    expect(a.assignable).toBe(false);
    expect(a.missing).toEqual(['http']);
    // The refusal must explain the failure mode, not just deny.
    expect(a.reason).toMatch(/fabricated/);
  });

  it('THE REGRESSION: a measurement task is not assignable to T12', () => {
    // 18/18 nightly smoke reports contained 0 real measurements because tasks needing
    // a live probe were routed to a lane with no HTTP client.
    expect(canAssign('T12', ['http', 'db_read']).assignable).toBe(false);
  });

  it('still routes prompt-only reasoning work to T12 — the fence narrows, it does not disable', () => {
    expect(canAssign('T12', ['reasoning']).assignable).toBe(true);
  });

  it('names every missing capability at once rather than one per round-trip', () => {
    expect(missingCapabilities(laneById('T12')!, ['reasoning', 'http', 'db_write'])).toEqual([
      'http',
      'db_write',
    ]);
  });

  it('an unknown lane is refused, not treated as permissive', () => {
    // Cast: the point is behaviour when a bad id arrives from a DB row at runtime,
    // where the type system is not present to help.
    const a = canAssign('NOPE' as never, ['reasoning']);
    expect(a.assignable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Free-first routing
// ---------------------------------------------------------------------------

describe('free-first routing — cheapest lane that can actually do it', () => {
  it('prompt-only work goes to the free tier', () => {
    expect(cheapestCapableLane(['reasoning'])!.id).toBe('T12');
  });

  it('work needing http skips T12 to the cheap CLI tier, not straight to CC', () => {
    // The cost cascade exists to keep expensive lanes for work that needs them.
    //
    // CHANGED 2026-08-05 from 'GA' to 'XC', and the reason matters more than the
    // edit. This assertion did not break — it was ALWAYS WRONG and only became
    // visible when GA's capabilities were corrected against a real measurement.
    // GA's `http` was sourced to "`gemini -p` runs", which is a claim about the
    // process starting, not about what it can reach; its own stderr shows
    // `web_fetch` -> "not available to this agent". So http work routed to GA
    // would have come back fabricated, at the cheapest tier, invisibly.
    //
    // Both are costTier 1, so the cascade's intent — never jump to CC for work a
    // cheap CLI can do — is preserved. Only the identity of the cheap CLI that can
    // actually do it changed.
    expect(cheapestCapableLane(['reasoning', 'http'])!.id).toBe('XC');
  });

  it('GA is not offered http work — the capability was measured absent', () => {
    // Pins the correction so a future edit cannot quietly restore it. If GA gains
    // a real web_fetch, this test should fail and be updated WITH the measurement.
    const ga = LANES.find((l) => l.id === 'GA')!;
    expect(ga.capabilities).not.toContain('http');
    expect(ga.source).toMatch(/MEASURED 2026-08-05/);
    expect(canAssign('GA', ['http']).assignable).toBe(false);
  });

  it('a prod DB write reaches CC — and stops there rather than escalating to Sean', () => {
    expect(cheapestCapableLane(['db_write'])!.id).toBe('CC');
  });

  it('a merge or a transaction is the only thing that reaches Sean', () => {
    expect(cheapestCapableLane(['merge'])!.id).toBe('SEAN');
    expect(cheapestCapableLane(['chain_send'])!.id).toBe('SEAN');
  });

  it('honours exclusions so a lane that already failed is not re-picked', () => {
    expect(cheapestCapableLane(['reasoning'], { exclude: ['T12'] })!.id).toBe('GA');
  });

  it('returns undefined when nothing can do it — a gap to close, not a task to dispatch', () => {
    expect(cheapestCapableLane(['reasoning', 'nonexistent' as never])).toBeUndefined();
  });
});

describe('eligible verifiers must be able to reach the evidence', () => {
  it('never proposes the producer as its own verifier', () => {
    expect(eligibleVerifiers('CC').map((l) => l.id)).not.toContain('CC');
  });

  it('excludes XC from verifying a database claim, however good its reasoning', () => {
    const ids = eligibleVerifiers('CC', ['db_read']).map((l) => l.id);
    expect(ids).not.toContain('XC');
    expect(ids).not.toContain('T12');
    expect(ids).toContain('GA');
  });

  it('a signature on evidence the signer never saw is worse than no signature', () => {
    // T12 can verify nothing that needs a tool — so it is eligible only for
    // reasoning-only checks, e.g. reviewing an argument supplied in the prompt.
    expect(eligibleVerifiers('GA', ['reasoning']).map((l) => l.id)).toContain('T12');
    expect(eligibleVerifiers('GA', ['http']).map((l) => l.id)).not.toContain('T12');
  });
});

// ---------------------------------------------------------------------------
// Output contents
// ---------------------------------------------------------------------------

describe('placeholders that look like answers', () => {
  it.each([
    'TBD',
    'N/A',
    'no issues found',
    'LGTM',
    'looks good',
    'done',
    'verified',
    'see above',
    '-',
    '',
    '   ',
    'Complete.',
  ])('rejects %p', (s) => {
    expect(isPlaceholder(s)).toBe(true);
  });

  it.each(['0 rows returned', 'The queue is empty because the consumer stopped on 2026-06-16'])(
    'accepts genuine short content %p',
    (s) => {
      expect(isPlaceholder(s)).toBe(false);
    },
  );
});

describe('a measurement must carry its ruler (CLAUDE_RULES 24)', () => {
  const req: RequiredOutput = { key: 'f1', kind: 'measurement', description: 'HAL F1' };

  it('THE REGRESSION: a bare number is refused', () => {
    // "F1 = 0.886" is unusable: 0.34 / 0.74 / 0.886 / 0.890 are four different rulers,
    // so a bare figure cannot be trended or called progress.
    const p = checkOutput(req, 0.886);
    expect(p).not.toBeNull();
    expect(p!.problem).toMatch(/ruler/);
  });

  it('accepts a value with its corpus and configuration', () => {
    expect(
      checkOutput(req, { value: 0.886, corpus: 'corpus v1 @ 9f2c1a', config: '5 families' }),
    ).toBeNull();
  });

  it('refuses a ruler that is itself a placeholder', () => {
    expect(checkOutput(req, { value: 0.886, corpus: 'N/A', config: 'N/A' })).not.toBeNull();
  });

  it('refuses NaN dressed up as a measurement', () => {
    expect(checkOutput(req, { value: NaN, corpus: 'corpus v1', config: '5 families' })).not.toBeNull();
  });

  it('refuses a stringified number — the ruler is not optional because it is inconvenient', () => {
    expect(checkOutput(req, '0.886')).not.toBeNull();
  });
});

describe('prose outputs', () => {
  const req: RequiredOutput = { key: 'finding', kind: 'prose', description: 'what you examined' };

  it('refuses "no issues found" with nothing behind it', () => {
    expect(checkOutput(req, 'No issues found')).not.toBeNull();
  });

  it('accepts a real finding of the same verdict', () => {
    expect(
      checkOutput(
        req,
        'Examined all seven score-event writers; four set repid_delta_applied and three ' +
          'rely on the trigger. No double-application found.',
      ),
    ).toBeNull();
  });

  it(`refuses anything under ${MIN_PROSE_CHARS} characters`, () => {
    expect(checkOutput(req, 'checked it, fine')).not.toBeNull();
  });

  it('refuses a missing key outright', () => {
    expect(checkOutput(req, undefined)!.problem).toMatch(/missing entirely/);
  });
});

// ---------------------------------------------------------------------------
// Verification status
// ---------------------------------------------------------------------------

describe('silence is not assent', () => {
  it('THE REGRESSION: voices that did not report yield UNVERIFIED, never CONFIRMED', () => {
    // The HAL quorum shrank when a provider key died and still reported agreement.
    expect(
      resolveVerification('CC', [
        { lane: 'GA', agrees: null },
        { lane: 'XC', agrees: null },
      ]),
    ).toBe('UNVERIFIED');
  });

  it('no voices at all is UNVERIFIED', () => {
    expect(resolveVerification('CC', [])).toBe('UNVERIFIED');
  });

  it('a producer signing itself is SELF_SIGNED, not CONFIRMED', () => {
    expect(resolveVerification('CC', [{ lane: 'CC', agrees: true }])).toBe('SELF_SIGNED');
  });

  it('one real external agreement is CONFIRMED', () => {
    expect(resolveVerification('CC', [{ lane: 'GA', agrees: true }])).toBe('CONFIRMED');
  });

  it('a single dissent outranks a majority — agreement can be a shared blind spot', () => {
    expect(
      resolveVerification('CC', [
        { lane: 'GA', agrees: true },
        { lane: 'SEAN', agrees: true },
        { lane: 'XC', agrees: false },
      ]),
    ).toBe('DISPUTED');
  });

  it('the producer‘s own vote cannot rescue an otherwise silent review', () => {
    expect(
      resolveVerification('GA', [
        { lane: 'GA', agrees: true },
        { lane: 'CC', agrees: null },
      ]),
    ).toBe('SELF_SIGNED');
  });
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('evaluateHandoff — fail-closed', () => {
  const outputs: readonly RequiredOutput[] = [
    { key: 'finding', kind: 'prose', description: 'what you examined' },
    { key: 'f1', kind: 'measurement', description: 'the number' },
    { key: 'report', kind: 'artifact', description: 'path to the written report' },
  ];
  const good = {
    finding:
      'Probed all five provider families directly; four answered, huggingface returned 401 ' +
      'on a present key.',
    f1: { value: 0.89, corpus: 'corpus v1 @ 9f2c1a', config: '5 families' },
    report: 'reports/2026-08-03/PROBE.md',
  };

  it('THE HEADLINE CASE: an artifact URL with an empty report does not advance', () => {
    const d = evaluateHandoff({
      taskId: 1,
      producer: 'T12',
      requiredOutputs: outputs,
      reported: { finding: 'No issues found', f1: 0.89, report: 'reports/x.md' },
      voices: [{ lane: 'CC', agrees: true }],
      touchesLiveState: false,
    });
    expect(d.advance).toBe(false);
    expect(d.problems.map((p) => p.key).sort()).toEqual(['f1', 'finding']);
  });

  it('advances inert work with complete outputs and one real voice', () => {
    const d = evaluateHandoff({
      taskId: 2,
      producer: 'GA',
      requiredOutputs: outputs,
      reported: good,
      voices: [{ lane: 'CC', agrees: true }],
      touchesLiveState: false,
    });
    expect(d.advance).toBe(true);
    expect(d.verification).toBe('CONFIRMED');
  });

  it('advances inert work even UNVERIFIED — an unreviewed branch costs nothing', () => {
    const d = evaluateHandoff({
      taskId: 3,
      producer: 'GA',
      requiredOutputs: outputs,
      reported: good,
      voices: [],
      touchesLiveState: false,
    });
    expect(d.advance).toBe(true);
    expect(d.verification).toBe('UNVERIFIED');
  });

  it('THE LOAD-BEARING CASE: live-state work does NOT advance unverified', () => {
    const d = evaluateHandoff({
      taskId: 4,
      producer: 'CC',
      requiredOutputs: outputs,
      reported: good,
      voices: [{ lane: 'GA', agrees: null }],
      touchesLiveState: true,
    });
    expect(d.advance).toBe(false);
    expect(d.reason).toMatch(/Silence is not assent/);
  });

  it('never advances a dispute, however many others agree', () => {
    const d = evaluateHandoff({
      taskId: 5,
      producer: 'CC',
      requiredOutputs: outputs,
      reported: good,
      voices: [
        { lane: 'GA', agrees: true },
        { lane: 'XC', agrees: false },
      ],
      touchesLiveState: false,
    });
    expect(d.advance).toBe(false);
    expect(d.reason).toMatch(/do not out-vote/);
  });

  it('never advances on a self-signature', () => {
    const d = evaluateHandoff({
      taskId: 6,
      producer: 'CC',
      requiredOutputs: outputs,
      reported: good,
      voices: [{ lane: 'CC', agrees: true }],
      touchesLiveState: false,
    });
    expect(d.advance).toBe(false);
    expect(d.verification).toBe('SELF_SIGNED');
  });

  it('reports missing outputs before discussing verification — the cheaper fix first', () => {
    const d = evaluateHandoff({
      taskId: 7,
      producer: 'CC',
      requiredOutputs: outputs,
      reported: { finding: good.finding, f1: good.f1 }, // artifact absent
      voices: [{ lane: 'CC', agrees: true }], // also self-signed
      touchesLiveState: true,
    });
    expect(d.advance).toBe(false);
    expect(d.reason).toMatch(/required\s+outputs unusable/);
  });

  it('a task declaring no outputs cannot launder its way through the gate', () => {
    // Zero outputs is vacuously complete, so verification must still be enforced.
    const d = evaluateHandoff({
      taskId: 8,
      producer: 'CC',
      requiredOutputs: [],
      reported: {},
      voices: [],
      touchesLiveState: true,
    });
    expect(d.advance).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Decision classification
// ---------------------------------------------------------------------------

describe('the third category D-054 is missing', () => {
  it('MECHANICAL: one defensible answer, models agree → decide silently', () => {
    const c = classifyDecision({
      modelsAgree: true,
      contradictsStatedDirection: false,
      singleDefensibleAnswer: true,
    });
    expect(c.klass).toBe('MECHANICAL');
    expect(c.autoDecidable).toBe(true);
  });

  it('TASTE: several viable options → decide, but surface the choice', () => {
    const c = classifyDecision({
      modelsAgree: true,
      contradictsStatedDirection: false,
      singleDefensibleAnswer: false,
    });
    expect(c.klass).toBe('TASTE');
    expect(c.autoDecidable).toBe(true);
  });

  it('THE MISSING RUNG: models agreeing that Sean is wrong is NEVER auto-decidable', () => {
    const c = classifyDecision({
      modelsAgree: true,
      contradictsStatedDirection: true,
      singleDefensibleAnswer: true,
    });
    expect(c.klass).toBe('USER_CHALLENGE');
    expect(c.autoDecidable).toBe(false);
    expect(c.reason).toMatch(/default/);
  });

  it('"obviously right" does not exempt a user challenge — that is what makes it dangerous', () => {
    for (const agree of [true, false]) {
      for (const single of [true, false]) {
        const c = classifyDecision({
          modelsAgree: agree,
          contradictsStatedDirection: true,
          singleDefensibleAnswer: single,
        });
        expect(c.klass).toBe('USER_CHALLENGE');
        expect(c.autoDecidable).toBe(false);
      }
    }
  });

  it('model disagreement without a challenge is still decidable — disagreement is not a stop', () => {
    const c = classifyDecision({
      modelsAgree: false,
      contradictsStatedDirection: false,
      singleDefensibleAnswer: false,
    });
    expect(c.klass).toBe('TASTE');
    expect(c.autoDecidable).toBe(true);
  });
});
