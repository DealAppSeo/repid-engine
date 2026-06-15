/**
 * SBFA v0.2 consensus — unit tests.
 * Spec: E:\dev\living-docs\04_security\SBFA_CONTENTION_AND_DEFERRAL_v0.2.md
 */
import {
  sbfaConsensus,
  votesFromVerdicts,
  ConstantReliabilityOracle,
  MapReliabilityOracle,
  type ValidatorVote,
  type SbfaInput,
} from '../src/hal/sbfa-consensus';

const oracle = new ConstantReliabilityOracle(0.8, 6);

function vote(belief: number, confidence: number, validator = 'v', family = 'f'): ValidatorVote {
  return { validator, modelVersion: `${validator}-1`, belief, confidence, familyKey: family };
}

function run(votes: ValidatorVote[], over: Partial<SbfaInput> = {}) {
  return sbfaConsensus({ votes, stakes: 'medium', action: 'punitive', category: 'factual', oracle, ...over });
}

describe('SBFA v0.2 — DST invariants', () => {
  test('masses are a valid bpa (sum to 1, non-negative)', () => {
    const v = run([vote(0.9, 0.9, 'a', 'fa'), vote(0.1, 0.8, 'b', 'fb'), vote(0.5, 0.4, 'c', 'fc')]);
    const sum = v.belief_act + v.belief_not + v.ignorance_mass;
    expect(sum).toBeCloseTo(1, 6);
    expect(v.belief_act).toBeGreaterThanOrEqual(0);
    expect(v.belief_not).toBeGreaterThanOrEqual(0);
    expect(v.ignorance_mass).toBeGreaterThanOrEqual(0);
  });

  test('low confidence / low reliability routes mass to IGNORANCE, not a decisive side (Yager)', () => {
    const weak = new ConstantReliabilityOracle(0.2, 3);
    const v = sbfaConsensus({
      votes: [vote(0.9, 0.2, 'a', 'fa'), vote(0.85, 0.2, 'b', 'fb')],
      stakes: 'medium', action: 'punitive', category: 'factual', oracle: weak,
    });
    expect(v.ignorance_mass).toBeGreaterThan(0.5);
    expect(v.decision).not.toBe('act'); // too unsure to act
  });
});

describe('SBFA v0.2 — §2.2 weighted supermajority to act', () => {
  test('strong cross-family agreement that the claim is FALSE → act', () => {
    const v = run([vote(0.95, 0.95, 'a', 'fa'), vote(0.92, 0.9, 'b', 'fb'), vote(0.9, 0.88, 'c', 'fc')], {
      action: 'punitive', stakes: 'medium',
    });
    expect(v.decision).toBe('act');
    expect(v.belief_act).toBeGreaterThanOrEqual(v.act_threshold);
  });

  test('irreversible stakes demand a near-unanimity bar — a bare majority does NOT act', () => {
    const v = run([vote(0.8, 0.8, 'a', 'fa'), vote(0.75, 0.7, 'b', 'fb'), vote(0.2, 0.7, 'c', 'fc')], {
      action: 'punitive', stakes: 'irreversible',
    });
    expect(v.decision).not.toBe('act');
    expect(v.escalate_to).toBe('contested_bft');
  });
});

describe('SBFA v0.2 — §1/§2.3 deadlock never forces irreversible action', () => {
  test('genuine 1-1 split at high confidence → does NOT act; low stakes abstains', () => {
    const v = run([vote(0.95, 0.95, 'a', 'fa'), vote(0.05, 0.95, 'b', 'fb')], {
      action: 'punitive', stakes: 'low',
    });
    expect(v.decision).toBe('abstain');
    expect(v.escalate_to).toBeNull();
  });

  test('genuine split at HIGH stakes → escalate to contested_bft (not decide)', () => {
    const v = run([vote(0.9, 0.9, 'a', 'fa'), vote(0.1, 0.9, 'b', 'fb'), vote(0.85, 0.4, 'c', 'fc')], {
      action: 'punitive', stakes: 'high',
    });
    expect(v.decision).toBe('escalate');
    expect(v.escalate_to).toBe('contested_bft');
  });
});

describe('SBFA v0.2 — §1 protective vs punitive asymmetry', () => {
  test('protective hold fires on a LOW bar where a punitive slash would defer', () => {
    const votes = [vote(0.6, 0.7, 'a', 'fa'), vote(0.55, 0.6, 'b', 'fb')];
    const punitive = run(votes, { action: 'punitive', stakes: 'medium' });
    const protect = run(votes, { action: 'protective', stakes: 'medium' });
    expect(punitive.decision).not.toBe('act');
    expect(protect.decision).toBe('hold');
  });
});

describe('SBFA v0.2 — §2.3/P-003 coordinated-dissonance conservative signal', () => {
  test('tight consistent split at high belief, punitive → declines to auto-punish (defers)', () => {
    // 3 validators all at ~0.9 with spread < comma gap (0.0136): coordinated dissonance.
    const v = run([vote(0.9, 0.95, 'a', 'fa'), vote(0.905, 0.95, 'b', 'fb'), vote(0.908, 0.95, 'c', 'fc')], {
      action: 'punitive', stakes: 'high',
    });
    expect(v.comma_conservative).toBe(true);
    expect(v.decision).toBe('escalate'); // high stakes → escalate rather than auto-act
  });
});

describe('SBFA v0.2 — §5 correlated/common-mode heuristic', () => {
  test('one-sided panel from too few independent families → correlated_warning', () => {
    const v = run([
      vote(0.9, 0.9, 'a', 'llama'), vote(0.9, 0.9, 'b', 'llama'),
      vote(0.9, 0.9, 'c', 'llama'), vote(0.9, 0.9, 'd', 'llama'),
    ], { action: 'punitive', stakes: 'medium' });
    expect(v.correlated_warning).toBe(true);
  });

  test('the same one-sided panel across many families does NOT warn', () => {
    const v = run([
      vote(0.9, 0.9, 'a', 'llama'), vote(0.9, 0.9, 'b', 'gemini'),
      vote(0.9, 0.9, 'c', 'mistral'), vote(0.9, 0.9, 'd', 'qwen'),
    ], { action: 'punitive', stakes: 'medium' });
    expect(v.correlated_warning).toBe(false);
  });
});

describe('SBFA v0.2 — §5 chronic-near-deadlock accumulator', () => {
  test('repeated ambiguous calls accumulate and eventually force escalation', () => {
    const split = [vote(0.55, 0.6, 'a', 'fa'), vote(0.45, 0.6, 'b', 'fb')];
    let count = 0;
    let last;
    for (let i = 0; i < 4; i++) {
      last = run(split, { action: 'punitive', stakes: 'low', nearDeadlockCount: count });
      count = last.near_deadlock_count;
    }
    expect(count).toBeGreaterThanOrEqual(4);
    expect(last!.near_deadlock_triggered).toBe(true);
    expect(last!.decision).toBe('escalate'); // accumulator overrides a quiet abstain
    expect(last!.escalate_to).toBe('contested_bft');
  });

  test('a decisive resolution decays the counter', () => {
    const v = run([vote(0.96, 0.96, 'a', 'fa'), vote(0.95, 0.95, 'b', 'fb'), vote(0.93, 0.93, 'c', 'fc')], {
      action: 'punitive', stakes: 'medium', nearDeadlockCount: 3,
    });
    expect(v.decision).toBe('act');
    expect(v.near_deadlock_count).toBe(2); // decayed from 3
  });
});

describe('SBFA v0.2 — degenerate + oracle', () => {
  test('no votes → maximal ignorance → defer', () => {
    const v = run([], { stakes: 'low' });
    expect(v.ignorance_mass).toBe(1);
    expect(v.decision).toBe('abstain');
  });

  test('reliability source is surfaced (auditability / anti-reflexivity provenance)', () => {
    const v = run([vote(0.9, 0.9)]);
    expect(v.reliability_source).toContain('constant-placeholder');
  });

  test('MapReliabilityOracle keys per (validator, version, category) with a fallback', () => {
    const m = new MapReliabilityOracle(
      { 'groq|groq-llama-3.1|factual': { alpha: 9, beta: 1 } },
      'gold-labels@test',
      0.5
    );
    expect(m.getWeight('groq', 'groq-llama-3.1', 'factual')).toEqual({ alpha: 9, beta: 1 });
    expect(m.getWeight('unknown', 'x', 'y').alpha).toBeCloseTo(1, 6); // fallback mean 0.5, strength 2
    expect(m.source).toBe('gold-labels@test');
  });
});

describe('SBFA v0.2 — votesFromVerdicts adapter', () => {
  test('FALSE→high belief, TRUE→low belief, UNCERTAIN→0.5/low-conf, ERROR dropped', () => {
    const votes = votesFromVerdicts([
      { provider: 'groq', verdict: 'FALSE', confidence: 90, family: 'llama' },
      { provider: 'gemini', verdict: 'TRUE', confidence: 80, family: 'gemini' },
      { provider: 'mistral', verdict: 'UNCERTAIN', confidence: 50, family: 'mistral' },
      { provider: 'dead', verdict: 'ERROR', confidence: 0 },
    ]);
    expect(votes).toHaveLength(3); // ERROR dropped
    expect(votes[0]!.belief).toBeGreaterThan(0.9);
    expect(votes[1]!.belief).toBeLessThan(0.1);
    expect(votes[2]!.belief).toBeCloseTo(0.5, 6);
    expect(votes[2]!.confidence).toBeLessThanOrEqual(0.3);
  });

  test('end-to-end: 2 FALSE vs 1 TRUE across distinct families resolves toward act', () => {
    const votes = votesFromVerdicts([
      { provider: 'groq', model: 'llama-3.1', verdict: 'FALSE', confidence: 92, family: 'llama' },
      { provider: 'gemini', model: 'gemini-2.0', verdict: 'FALSE', confidence: 88, family: 'gemini' },
      { provider: 'mistral', model: 'mistral-small', verdict: 'TRUE', confidence: 60, family: 'mistral' },
    ]);
    const v = sbfaConsensus({ votes, stakes: 'medium', action: 'punitive', category: 'factual', oracle });
    expect(v.belief_act).toBeGreaterThan(v.belief_not);
  });
});
