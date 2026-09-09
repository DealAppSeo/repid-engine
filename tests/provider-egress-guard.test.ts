/**
 * PROVIDER EGRESS GUARD — pins how many places in `src/` can reach an LLM provider
 * directly, so a NEW one cannot appear silently.
 *
 * WHY THIS EXISTS. `LOCAL_LLM_BASE_URL` reads like an egress control: set it and every
 * openai-compat provider in the fact-check quorum is redirected. It is not one.
 * `src/services/adversarial-judge.ts` hardcodes six provider hosts and references the
 * redirect zero times, so setting the variable moves the quorum and leaves the judge
 * dialling out. A boundary control that only some code honours fails SILENTLY and in the
 * SAFE-LOOKING direction — the house defect.
 *
 * THE NUMBER IS THE POINT. Reading the code found "a second path". Measuring found
 * **26 files** [MEASURED 2026-09-09]. That gap is the whole argument for a guard: prose
 * describing a boundary decays, and it decays toward reassurance. A count that fails the
 * build does not.
 *
 * WHAT IT DETECTS, HONESTLY. A provider hostname appearing in a source file. That is a
 * SUPERSET of "makes a direct call" — a host in a comment, a default, or a registry entry
 * matches too. A superset is the correct bias for a guard: it can be noisy, it cannot be
 * silently blind. It does NOT detect a host assembled at runtime from parts, an egress via
 * an SDK that embeds its own base URL, or a proxy hop. Those are NOT CHECKED here and this
 * file must not be read as proving their absence.
 *
 * WHAT IT IS NOT. Not a fix, and not a judgement that these 26 are wrong — most are
 * legitimate provider adapters. It is the inventory that makes "every provider call goes
 * through one chokepoint" a checkable claim instead of an aspiration. Whether to route them
 * through a single egress point is a decision about production traffic, not a cleanup.
 *
 * FAILS IN BOTH DIRECTIONS, deliberately:
 *   - a file NOT in the baseline gains a provider host  -> fail (the point)
 *   - a file IN the baseline no longer has one          -> fail (the list cannot rot)
 * The second half is the lesson from every stale negative finding in this repo: a list
 * nobody re-derives becomes an old measurement wearing a permanent label.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');

/** Hostnames that mean "an LLM provider is reachable from here". */
const PROVIDER_HOSTS = [
  'api.anthropic.com',
  'api.groq.com',
  'api.openai.com',
  'api.deepseek.com',
  'api.cerebras.ai',
  'api.mistral.ai',
  'api.fireworks.ai',
  'openrouter.ai',
  'generativelanguage.googleapis.com',
  'integrate.api.nvidia.com',
  'api.z.ai',
  'dashscope-intl.aliyuncs.com',
] as const;

/**
 * The measured baseline, 2026-09-09. Re-derived by this test on every run.
 * Adding a file here is a deliberate act: you are recording that a new place in the
 * codebase can reach a provider directly. Do it in the same commit that adds the call,
 * with a reason, or the guard has been defeated by paperwork.
 */
const BASELINE: readonly string[] = [
  'src/config.ts',
  'src/engine/badges.ts',
  'src/hal/classifier.ts',
  'src/hal/completeness.ts',
  'src/hal/crag.ts',
  'src/hal/cross-llm-client.ts',
  'src/hal/fact-check.ts',
  'src/hal/lib/clients/embedding.ts',
  'src/hal/lib/cross-llm/embedding-client.ts',
  'src/hal/lib/cross-llm/index.ts',
  'src/hal/local-llm.ts',
  'src/providers/anthropic.ts',
  'src/providers/cerebras.ts',
  'src/providers/deepseek.ts',
  'src/providers/gemini.ts',
  'src/providers/groq.ts',
  'src/providers/openai.ts',
  'src/providers/openrouter.ts',
  'src/providers/resilient-llm.ts',
  'src/providers/slm.ts',
  'src/providers/zai.ts',
  'src/selfhost.ts',
  'src/services/adversarial-judge.ts',
  'src/services/pcp-validator.ts',
  'src/services/provider-key-probe.ts',
  'src/services/validation-repid-delta.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Files under src/ that name at least one provider host. Relative, posix, sorted. */
function measureDirectEgress(): string[] {
  const found: string[] = [];
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    if (PROVIDER_HOSTS.some((h) => text.includes(h))) {
      found.push(path.relative(path.join(__dirname, '..'), file).split(path.sep).join('/'));
    }
  }
  return found.sort();
}

describe('provider egress surface is pinned, not described', () => {
  const measured = measureDirectEgress();

  it('no NEW file reaches a provider directly', () => {
    const added = measured.filter((f) => !BASELINE.includes(f));
    expect(added).toEqual([]);
  });

  it('every baselined file still reaches one — the list cannot rot', () => {
    const gone = BASELINE.filter((f) => !measured.includes(f));
    expect(gone).toEqual([]);
  });

  it('the count is what the docs claim [MEASURED 2026-09-09: 26]', () => {
    expect(measured.length).toBe(BASELINE.length);
    expect(BASELINE.length).toBe(26);
  });

  it('the judge is in the surface, which is the finding that motivated this guard', () => {
    expect(measured).toContain('src/services/adversarial-judge.ts');
  });

  it('detects a host anywhere in a file, so it cannot be blinded by indirection in the call', () => {
    // Non-vacuity: prove the matcher actually matches rather than trusting the sweep above.
    const sample = 'const e = "https://api.groq.com/openai/v1/chat/completions";';
    expect(PROVIDER_HOSTS.some((h) => sample.includes(h))).toBe(true);
    expect(PROVIDER_HOSTS.some((h) => 'const e = "https://example.test/v1";'.includes(h))).toBe(
      false,
    );
  });
});
