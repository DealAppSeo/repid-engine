/**
 * S-FIX Phase 3 — prompt-injection guard.
 *
 * Pattern-scores a user prompt for known jailbreak / injection signatures WITHOUT modifying it
 * (score only; the LLM still sees the original). Pure + deterministic → unit-testable. Callers
 * decide policy: block ≥ blockThreshold, flag ≥ flagThreshold, else allow.
 *
 * This is a cheap pre-LLM screen, not a guarantee — it complements (not replaces) HAL.
 */
export interface InjectionScan {
  injectionScore: number;       // 0..1
  matched: string[];            // names of matched patterns
  decision: 'block' | 'flag' | 'allow';
}

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'ignore_instructions', re: /ignore\s+(the\s+)?(all\s+|previous\s+|prior\s+|above\s+)+(instructions|prompts|rules)/i },
  { name: 'system_prompt', re: /(reveal|show|print|repeat|leak)\s+(your\s+)?(system\s+prompt|instructions|initial\s+prompt)/i },
  { name: 'you_are_now', re: /you\s+are\s+now\s+(a|an|the|in)\b/i },
  { name: 'act_as', re: /\bact\s+as\s+(if|though|a|an)\b/i },
  { name: 'override_safety', re: /(override|disable|bypass|turn\s+off)\s+(your\s+)?(safety|guard ?rails|filters|restrictions)/i },
  { name: 'inst_tokens', re: /\[\/?INST\]|<<\s*SYS\s*>>|<\/?SYS>>/i },
  { name: 'jailbreak', re: /\b(jailbreak|DAN\s+mode|developer\s+mode\s+enabled)\b/i },
  { name: 'no_restrictions', re: /pretend\s+you\s+(have\s+no|don'?t\s+have|are\s+free\s+of)\s+(restrictions|rules|guidelines)/i },
  { name: 'new_instructions', re: /(disregard|forget)\s+(everything|all|the\s+above|previous)/i },
  { name: 'roleplay_escape', re: /from\s+now\s+on[, ]+you\s+(will|must|are)\b/i },
];

export interface InjectionOpts { blockThreshold?: number; flagThreshold?: number; perMatch?: number }

export function scanForInjection(input: string, opts: InjectionOpts = {}): InjectionScan {
  const blockThreshold = opts.blockThreshold ?? 0.6;
  const flagThreshold = opts.flagThreshold ?? 0.3;
  // 0.35/match: one clear injection pattern flags (>=0.3), two block (>=0.6).
  const perMatch = opts.perMatch ?? 0.35;
  const text = String(input ?? '');
  const matched: string[] = [];
  for (const p of PATTERNS) if (p.re.test(text)) matched.push(p.name);
  const injectionScore = Math.min(1, matched.length * perMatch);
  const decision: InjectionScan['decision'] =
    injectionScore >= blockThreshold ? 'block' : injectionScore >= flagThreshold ? 'flag' : 'allow';
  return { injectionScore: Math.round(injectionScore * 100) / 100, matched, decision };
}
