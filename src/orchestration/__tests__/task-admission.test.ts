/**
 * task-admission.test.ts — the equip-or-abstain gate requires the right grounding capabilities and makes an
 * under-equipped agent ABSTAIN rather than fabricate. The headline: the three real 2026-11-03 T12 fabrications
 * would each have become an honest abstention, and a properly equipped agent is never blocked.
 */
import {
  requiredCapabilities,
  admitTask,
  admitWithCapabilities,
  ALL_CAPABILITIES,
  type TaskDescriptor,
  type Capability,
} from '../task-admission';

const task = (prompt: string, task_domain?: string): TaskDescriptor => ({ prompt, task_domain });

describe('requiredCapabilities — classify the grounding a task needs (pure)', () => {
  it('an audit that reads source needs repo_read', () => {
    expect(requiredCapabilities(task('Review the config loader at src/engine/config.js'))).toContain('repo_read');
  });

  it('a prior-art task needs web_search and NOT code_search (bare "find" must not imply code)', () => {
    const r = requiredCapabilities(task('Find prior art for the RepID scoring mechanism'));
    expect(r).toContain('web_search');
    expect(r).not.toContain('code_search');
  });

  it('a disclosure audit needs github and web_search', () => {
    const r = requiredCapabilities(task('Audit whether any public disclosures of the repid-engine exist'));
    expect(r).toEqual(expect.arrayContaining<Capability>(['github', 'web_search']));
  });

  it('a version question needs the package_registry', () => {
    expect(requiredCapabilities(task('What is the latest npm version of the trustshell package?'))).toEqual(['package_registry']);
  });

  it('a live-state question needs db_read', () => {
    expect(requiredCapabilities(task('How many agents are active in the database right now?'))).toEqual(['db_read']);
  });

  it('an on-chain claim needs chain_read', () => {
    expect(requiredCapabilities(task('Verify the ERC-8004 attestation was anchored on Base Sepolia'))).toEqual(['chain_read']);
  });

  it('a pure reasoning/generation task requires nothing (never blocked)', () => {
    expect(requiredCapabilities(task('Summarize the tradeoffs between optimistic and pessimistic locking.'))).toEqual([]);
  });

  it('task_domain alone classifies a code audit even with a bland prompt', () => {
    const r = requiredCapabilities(task('do the thing', 'security_audit'));
    expect(r).toEqual(expect.arrayContaining<Capability>(['repo_read', 'code_search']));
  });

  it('returns a stable canonical order with no duplicates', () => {
    const r = requiredCapabilities(task('Audit src/x.ts and read the repository code', 'security_audit'));
    expect(r).toEqual([...new Set(r)]);
    expect(r).toEqual(ALL_CAPABILITIES.filter((c) => r.includes(c)));
  });
});

describe('admitTask — equip-or-abstain', () => {
  it('a fully equipped agent accepts and records the equipped manifest', () => {
    const d = admitTask({ task: task('Find prior art for X'), held: ALL_CAPABILITIES });
    expect(d.accepted).toBe(true);
    expect(d.manifest).toEqual(['web_search']);
    expect(d.missing).toEqual([]);
  });

  it('an under-equipped agent abstains with the gap named, not a fabricated answer', () => {
    const d = admitTask({ task: task('Find prior art for X'), held: [] });
    expect(d.accepted).toBe(false);
    expect(d.missing).toEqual(['web_search']);
    expect(d.manifest).toEqual([]);
    expect(d.reason).toContain('abstain, do not fabricate');
  });

  it('a task needing nothing is accepted even by an empty tool-belt', () => {
    const d = admitTask({ task: task('Summarize the tradeoffs.'), held: [] });
    expect(d.accepted).toBe(true);
    expect(d.reason).toBe('no external capability required');
  });

  it('reports exactly the capabilities held are short by', () => {
    const d = admitTask({ task: task('Audit public disclosures'), held: ['web_search'] });
    expect(d.missing).toEqual(['github']);
    expect(d.accepted).toBe(false);
  });

  it('admitWithCapabilities is the pure gate a Laya-backed classifier plugs into', () => {
    const d = admitWithCapabilities({ required: ['github', 'web_search'], held: ['web_search'] });
    expect(d.accepted).toBe(false);
    expect(d.missing).toEqual(['github']);
  });
});

describe('the three real fabrications become abstentions (the measurable claim)', () => {
  const realTasks: Array<{ name: string; t: TaskDescriptor; expectMissing: Capability[] }> = [
    { name: 'SY-15 security audit', t: task('SY-15 Security Audit. Review the config loader and HAL verifier at src/hal/verifier.js.', 'security_audit'), expectMissing: ['repo_read', 'code_search'] },
    { name: 'disclosure audit', t: task('Audit whether there are any public disclosures of the repid-engine repository.', 'disclosure'), expectMissing: ['web_search', 'github'] },
    { name: 'prior-art search', t: task('Conduct a prior-art search over patents and literature for the mechanism.', 'prior_art'), expectMissing: ['web_search'] },
  ];

  it.each(realTasks)('$name: an unequipped agent abstains (does not fabricate)', ({ t, expectMissing }) => {
    const d = admitTask({ task: t, held: [] });
    expect(d.accepted).toBe(false);
    expect(d.missing.sort()).toEqual([...expectMissing].sort());
    expect(d.reason).toContain('abstain, do not fabricate');
  });

  it('an equipped agent is NOT blocked on any of the three', () => {
    for (const { t } of realTasks) {
      expect(admitTask({ task: t, held: ALL_CAPABILITIES }).accepted).toBe(true);
    }
  });
});
