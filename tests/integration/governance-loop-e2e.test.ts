/**
 * Wired governance loop E2E — spec v0.3 §3 + §4.
 * action → CC classifier → if T1, adversarial chamber → verdict.
 * Synthetic only; no live LLM, no prod.
 */
import path from 'path';
import { runGovernanceLoop } from '../../src/services/governance-loop';
import { consequenceClassifierAdapter } from '../../src/services/adversarial-router';

const REPO_ROOT = path.resolve(__dirname, '../..');

const proposer = {
  agentId: 'cc',
  provider: 'anthropic',
  lineageProvider: 'anthropic',
  contextHash: 'ctx-proposer',
};

const adversary = {
  agentId: 'xc',
  provider: 'groq',
  lineageProvider: 'groq',
  contextHash: 'ctx-adversary',
};

describe('governance loop wired e2e', () => {
  it('T0 read → auto-proceed, chamber not invoked', () => {
    const v = runGovernanceLoop({
      action: { kind: 'read', description: 'query leaderboard' },
      proposer,
      adversary,
      objection: { summary: 'n/a', citations: [] },
    });
    expect(v.tier).toBe('T0');
    expect(v.gate).toBe('auto-proceed');
    if (v.gate !== 'auto-proceed') return;
    expect(v.classification.tier).toBe('T0');
  });

  it('T2 prod project → HITL, adversary cannot downgrade', () => {
    const v = runGovernanceLoop({
      action: {
        kind: 'db',
        projectId: 'qnnpjhlxljtqyigedwkb',
        sql: 'select 1',
        description: 'prod query',
      },
      proposer,
      adversary,
      objection: {
        summary: 'Looks fine to me honestly',
        citations: [{ kind: 'ci_run_id', value: '28080981450' }],
      },
    });
    expect(v.tier).toBe('T2');
    expect(v.gate).toBe('hitl');
    if (v.gate !== 'hitl') return;
    expect(v.classification.hits.map((h) => h.ruleId)).toContain('T2_PROD_PROJECT');
  });

  it('T2 git merge to main → HITL (ethical-hacker demo: cannot pass gate)', () => {
    const v = runGovernanceLoop({
      action: {
        kind: 'git',
        git: { operation: 'merge', targetRef: 'main' },
        paths: ['src/routes/v1/controller.ts'],
        description: 'merge feature to main',
      },
      proposer,
      adversary,
      objection: {
        summary: 'minor concern',
        citations: [{ kind: 'ci_run_id', value: '28080981450' }],
      },
    });
    expect(v.tier).toBe('T2');
    expect(v.gate).toBe('hitl');
  });

  it('T2 critical path migrations → HITL', () => {
    const v = runGovernanceLoop({
      action: {
        kind: 'file_write',
        paths: ['migrations/2026-06-24-drop-users.sql'],
        description: 'apply migration',
      },
      proposer,
      adversary,
      objection: { summary: 'ship it', citations: [{ kind: 'ci_run_id', value: '12345678' }] },
    });
    expect(v.tier).toBe('T2');
    expect(v.gate).toBe('hitl');
  });

  it('T2 unmatched action → fail-safe HITL', () => {
    const v = runGovernanceLoop({
      action: { kind: 'unknown_surface_xyz' },
      proposer,
      adversary,
      objection: { summary: 'trust me', citations: [{ kind: 'ci_run_id', value: '12345678' }] },
    });
    expect(v.tier).toBe('T2');
    expect(v.gate).toBe('hitl');
    if (v.gate !== 'hitl') return;
    expect(v.classification.failSafe).toBe(true);
  });

  it('T1 feature merge + weak verified objection → chamber proceed', () => {
    const v = runGovernanceLoop(
      {
        action: {
          kind: 'git',
          git: { operation: 'merge', targetRef: 'feat/xc-integration' },
          paths: ['src/routes/v1/controller.ts'],
          description: 'merge integration branch',
        },
        proposer,
        adversary,
        objection: {
          summary: 'minor',
          citations: [{ kind: 'ci_run_id', value: '28080981450' }],
        },
      },
      { repoRoot: REPO_ROOT }
    );
    expect(v.tier).toBe('T1');
    expect(v.gate).toBe('chamber');
    if (v.gate !== 'chamber') return;
    expect(v.proposed.actionClass).toBe('merge');
    expect(v.decision.outcome).toBe('proceed');
    expect(v.decision.templateId).toBe('merge-regression-v1');
  });

  it('T1 feature merge + substantive verified objection → chamber escalate', () => {
    const v = runGovernanceLoop(
      {
        action: {
          kind: 'git',
          git: { operation: 'merge', targetRef: 'feat/xc-integration' },
          paths: ['src/routes/v1/controller.ts'],
        },
        proposer,
        adversary,
        objection: {
          summary: 'Regression risk on controller wake path',
          citations: [{ kind: 'failing_test_name', value: 'tests/controller.test.ts' }],
        },
      },
      { repoRoot: REPO_ROOT }
    );
    expect(v.tier).toBe('T1');
    if (v.gate !== 'chamber') return;
    expect(v.decision.outcome).toBe('escalate');
  });

  it('T1 bounded spend → spend template in chamber', () => {
    const v = runGovernanceLoop({
      action: { kind: 'spend', costUsd: 0.25, description: 'API credits' },
      proposer,
      adversary,
      objection: {
        summary: 'minor',
        citations: [{ kind: 'ci_run_id', value: '28080981450' }],
      },
    });
    expect(v.tier).toBe('T1');
    if (v.gate !== 'chamber') return;
    expect(v.proposed.actionClass).toBe('spend');
    expect(v.decision.templateId).toBe('spend-cap-v1');
  });

  it('adapter: ProposedAction merge classifies T1 via real classifier', () => {
    expect(
      consequenceClassifierAdapter.classifyAction({
        id: 'x',
        actionClass: 'merge',
        artifactSummary: 'feature merge',
        artifactRefs: ['src/foo.ts'],
      })
    ).toBe('T1');
  });

  it('adapter: prod-config ProposedAction classifies T1', () => {
    expect(
      consequenceClassifierAdapter.classifyAction({
        id: 'x',
        actionClass: 'prod-config',
        artifactSummary: 'staging env tweak',
      })
    ).toBe('T1');
  });
});