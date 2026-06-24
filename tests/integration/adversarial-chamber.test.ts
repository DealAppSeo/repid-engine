/**
 * Adversarial chamber — synthetic e2e (no live LLM, no prod).
 * Governance spec v0.3 §4.
 */
import {
  AdversarialRouter,
  stubConsequenceClassifier,
  verifyCitation,
  scoreAttack,
} from '../../src/services/adversarial-router';
import { lineagesAreDiverse } from '../../src/config/adversarial-templates';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

describe('adversarial chamber e2e', () => {
  const router = new AdversarialRouter({
    classifier: stubConsequenceClassifier,
    repoRoot: REPO_ROOT,
  });

  const action = {
    id: 'act-1',
    actionClass: 'merge' as const,
    artifactSummary: 'feat/xc branch merge to main',
    artifactRefs: ['src/routes/v1/controller.ts'],
  };

  const proposer = {
    agentId: 'xc',
    provider: 'anthropic',
    lineageProvider: 'anthropic',
    contextHash: 'ctx-proposer',
  };

  const adversaryGroq = {
    agentId: 'ga',
    provider: 'groq',
    lineageProvider: 'groq',
    contextHash: 'ctx-adversary',
  };

  it('router selects merge template (not proposer)', () => {
    const t = router.selectTemplate(action);
    expect(t.id).toBe('merge-regression-v1');
    expect(t.actionClass).toBe('merge');
  });

  it('enforces lineage diversity', () => {
    expect(lineagesAreDiverse('anthropic', 'groq')).toBe(true);
    expect(() =>
      router.enforceLineageDiversity(proposer, { ...adversaryGroq, lineageProvider: 'anthropic' })
    ).toThrow(/lineage diversity/);
  });

  it('A1 tripwire: identical context-hash escalates via enforce throw', () => {
    expect(() =>
      router.enforceLineageDiversity(proposer, { ...adversaryGroq, contextHash: 'ctx-proposer' })
    ).toThrow(/context-hash/);
  });

  it('verified substantive objection → escalate', () => {
    const decision = router.decideT1(action, proposer, adversaryGroq, {
      summary: 'Regression risk on controller wake path',
      citations: [{ kind: 'failing_test_name', value: 'tests/controller.test.ts' }],
    });
    expect(decision.outcome).toBe('escalate');
  });

  it('weak verified attack → proceed', () => {
    const decision = router.decideT1(action, proposer, adversaryGroq, {
      summary: 'minor',
      citations: [{ kind: 'ci_run_id', value: '28080981450' }],
    });
    expect(decision.outcome).toBe('proceed');
  });

  it('unverified citation → escalate (never launder)', () => {
    const decision = router.decideT1(action, proposer, adversaryGroq, {
      summary: 'Looks risky but no proof',
      citations: [{ kind: 'failing_test_name', value: 'tests/no-such-file.test.ts' }],
    });
    expect(decision.outcome).toBe('escalate');
    expect(scoreAttack({
      summary: 'x',
      citations: [{ kind: 'failing_test_name', value: 'tests/no-such-file.test.ts' }],
    }, REPO_ROOT)).toBe('unverified');
  });

  it('adversary agrees wrong → tie-break third lineage', () => {
    const decision = router.decideT1(action, proposer, adversaryGroq, {
      summary: 'action should not ship',
      citations: [{ kind: 'ci_run_id', value: '12345678' }],
      agreesActionIsWrong: true,
    });
    expect(decision.outcome).toBe('tie-break');
    if (decision.outcome === 'tie-break') expect(decision.thirdLineageRequired).toBe(true);
  });

  it('full runChamber returns T1 decision path', () => {
    const result = router.runChamber(action, proposer, adversaryGroq, {
      summary: 'weak',
      citations: [{ kind: 'ci_run_id', value: '28080981450' }],
    });
    expect(result.tier).toBe('T1');
    expect(result.decision?.outcome).toBe('proceed');
  });

  it('evidence verifier confirms real test file', () => {
    const v = verifyCitation({ kind: 'failing_test_name', value: 'tests/controller.test.ts' }, REPO_ROOT);
    expect(v.verified).toBe(true);
  });
});