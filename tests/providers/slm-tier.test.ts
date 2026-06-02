import {
  selectSlmRoute, estimateSlmSavings,
  SLM_PRIMARY, SLM_BACKUP, SLM_BASELINE_LLM, SLM_CONFIDENCE_THRESHOLD,
} from '../../src/providers/slm-tier';

const allAvailable = () => true;
const noneAvailable = () => false;

describe('SLM tier routing decision', () => {
  it('classification + low confidence → SLM primary (Phase 2.3 case 1)', () => {
    const d = selectSlmRoute('classification', 0.3, allAvailable);
    expect(d).not.toBeNull();
    expect(d!.tier).toBe('0a');
    expect(d!.provider).toBe(SLM_PRIMARY.provider);
    expect(d!.model).toBe(SLM_PRIMARY.model);
  });

  it.each(['classification', 'routing_decision', 'quick_check'])(
    'eligible task %s with confidence_required just under threshold → SLM',
    (task) => {
      const d = selectSlmRoute(task, SLM_CONFIDENCE_THRESHOLD - 0.01, allAvailable);
      expect(d?.tier).toBe('0a');
    },
  );

  it('high-confidence-required task → LLM tier even if classification (Phase 2.3 case 2)', () => {
    expect(selectSlmRoute('classification', SLM_CONFIDENCE_THRESHOLD, allAvailable)).toBeNull();
    expect(selectSlmRoute('classification', 0.9, allAvailable)).toBeNull();
  });

  it('confidence_required unspecified → assumes high bar → LLM tier (no SLM)', () => {
    expect(selectSlmRoute('classification', undefined, allAvailable)).toBeNull();
  });

  it('ineligible task type → LLM tier even at low confidence', () => {
    expect(selectSlmRoute('code_review', 0.2, allAvailable)).toBeNull();
    expect(selectSlmRoute('research', 0.1, allAvailable)).toBeNull();
    expect(selectSlmRoute(undefined, 0.1, allAvailable)).toBeNull();
  });

  it('SLM primary unavailable → falls to backup SLM', () => {
    const onlyBackup = (m: { provider: string }) => m.provider === SLM_BACKUP.provider;
    const d = selectSlmRoute('quick_check', 0.4, onlyBackup);
    expect(d?.provider).toBe(SLM_BACKUP.provider);
  });

  it('SLM unavailable → null so caller falls back to cheapest LLM (Phase 2.3 case 3, not a failure)', () => {
    expect(selectSlmRoute('classification', 0.3, noneAvailable)).toBeNull();
  });
});

describe('SLM cost savings', () => {
  it('SLM is cheaper than the cheap-LLM baseline → positive savings', () => {
    const s = estimateSlmSavings(1000, 200);
    expect(s.slm_cost_usd).toBeLessThan(s.baseline_cost_usd);
    expect(s.saved_usd).toBeGreaterThan(0);
    expect(s.baseline).toEqual(SLM_BASELINE_LLM);
    expect(s.saved_usd).toBeCloseTo(s.baseline_cost_usd - s.slm_cost_usd, 9);
  });

  it('savings clamp at 0 (never negative)', () => {
    // baseline == slm → 0 saved, not negative
    const s = estimateSlmSavings(1000, 200, SLM_PRIMARY, SLM_PRIMARY);
    expect(s.saved_usd).toBe(0);
  });
});
