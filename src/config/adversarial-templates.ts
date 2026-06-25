/**
 * Standing adversarial challenge templates — governance spec v0.3 §4.
 * Router selects template by action class; proposer never picks its own challenge.
 */
export type ActionClass = 'merge' | 'prod-config' | 'spend';

export type EvidenceKind = 'ci_run_id' | 'failing_test_name' | 'schema_query_result' | 'git_diff_ref';

export interface AdversarialTemplate {
  id: string;
  version: string;
  actionClass: ActionClass;
  /** System-authored challenge — not agent chain-of-thought. */
  challengePrompt: string;
  requiredEvidenceKinds: EvidenceKind[];
}

export const TEMPLATE_LIBRARY_VERSION = '0.1.0';

export const ADVERSARIAL_TEMPLATES: Record<ActionClass, AdversarialTemplate> = {
  merge: {
    id: 'merge-regression-v1',
    version: '1.0.0',
    actionClass: 'merge',
    challengePrompt:
      'Argue this change introduces a regression, breaks main, or cannot be cleanly reverted. ' +
      'Cite machine-checkable evidence only (failing test name, CI run id, or git diff ref). ' +
      'Prose without artifacts does not count.',
    requiredEvidenceKinds: ['failing_test_name', 'ci_run_id', 'git_diff_ref'],
  },
  'prod-config': {
    id: 'prod-config-blast-v1',
    version: '1.0.0',
    actionClass: 'prod-config',
    challengePrompt:
      'Argue this change is irreversible, has prod blast radius, or lacks rollback. ' +
      'Cite schema query results, CI evidence, or git diff refs — not opinion.',
    requiredEvidenceKinds: ['schema_query_result', 'git_diff_ref', 'ci_run_id'],
  },
  spend: {
    id: 'spend-cap-v1',
    version: '1.0.0',
    actionClass: 'spend',
    challengePrompt:
      'Argue this spend exceeds policy caps, duplicates recent spend, or lacks budget attestation. ' +
      'Attach verifiable CI or schema evidence.',
    requiredEvidenceKinds: ['ci_run_id', 'schema_query_result'],
  },
};

/** Lineage registry — agent-uneditable config (spec §10.4). */
export interface LineageEntry {
  provider: string;
  family: string;
  trainingCutoff?: string;
}

export const LINEAGE_REGISTRY: LineageEntry[] = [
  { provider: 'groq', family: 'meta-llama', trainingCutoff: '2024-10' },
  { provider: 'cerebras', family: 'meta-llama', trainingCutoff: '2024-06' },
  { provider: 'anthropic', family: 'claude', trainingCutoff: '2025-01' },
  { provider: 'openai', family: 'gpt', trainingCutoff: '2024-10' },
  { provider: 'google', family: 'gemini', trainingCutoff: '2024-11' },
  { provider: 'xai', family: 'grok', trainingCutoff: '2025-01' },
  { provider: 'fireworks', family: 'mixed', trainingCutoff: '2024-09' },
];

export function getTemplateForActionClass(actionClass: ActionClass): AdversarialTemplate {
  return ADVERSARIAL_TEMPLATES[actionClass];
}

export function resolveLineage(provider: string): LineageEntry | undefined {
  const key = provider.toLowerCase().trim();
  return LINEAGE_REGISTRY.find((e) => e.provider === key);
}

export function lineagesAreDiverse(a: string, b: string): boolean {
  const la = resolveLineage(a);
  const lb = resolveLineage(b);
  if (!la || !lb) return a.toLowerCase() !== b.toLowerCase();
  return la.provider !== lb.provider && la.family !== lb.family;
}