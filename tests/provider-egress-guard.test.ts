/**
 * PROVIDER EGRESS GUARD — an inventory of every place in `src/` that names an LLM provider
 * host, split by role, with the callsite list built to SHRINK.
 *
 *   MEASURED 2026-09-09: 26 files
 *   TARGET:              CALLSITES -> 0
 *   ADAPTERS / PROBES / NOISE: allowed to stay
 *
 * WHY THIS EXISTS. `LOCAL_LLM_BASE_URL` reads like an egress control — set it and every
 * openai-compat provider in the fact-check quorum is redirected. It is not one.
 * `src/services/adversarial-judge.ts` hardcodes six provider hosts and references the
 * redirect zero times. A boundary control that only some code honours fails SILENTLY and in
 * the SAFE-LOOKING direction, which is the house defect.
 *
 * THE NUMBER IS THE POINT. Reading the code found "a second path". Measuring found 26.
 * Prose describing a boundary decays, and it decays toward reassurance. A count that fails
 * the build does not.
 *
 * ── FOUR ROLES, because "may know a hostname" and "may present a bearer" are different
 * permissions and one flat list cannot express that. Roles were MEASURED, not assumed:
 *
 *   ADAPTER   src/providers/* — naming its own host IS the job. Expected to stay.
 *   PROBE     deliberately dials providers to test credentials. Names hosts AND sends
 *             `Authorization: Bearer`. Legitimate, and the one role to watch.
 *   NOISE     the host appears only in a COMMENT. `config.ts:24` and `local-llm.ts:7` are
 *             prose about the redirect, not calls. The hostname matcher is a superset and
 *             this is where that shows.
 *   CALLSITE  everything else: business logic that reached for a provider directly.
 *             THIS IS THE SHRINK LIST. Every entry removed is the win.
 *
 * ── THE DESIGN BUG THIS FIXES. The first version of this guard failed whenever ANY listed
 * file stopped matching, calling it "list rot". That punishes the exact outcome the guard
 * exists to drive: a callsite that stops naming a host because it now imports the registry
 * is PROGRESS, not decay. The check could not tell a cleanup from a stale label. It now
 * distinguishes them — same mechanism, opposite message.
 *
 * ── THE RATCHET, which is what makes the target real. A comment saying "TARGET: 0" enforces
 * nothing. `CALLSITE_CEILING` may only ever be LOWERED. That gives two independent locks:
 * adding a new direct caller fails the NEW-file check, and adding it to CALLSITES to silence
 * that fails the ratchet. You cannot paperwork your way in, which the first version's
 * "add it with a reason" honour system could not prevent.
 *
 * ── WHAT IT DETECTS, HONESTLY. A provider hostname in a source file — a SUPERSET of "makes
 * a call". Noisy beats silently blind. It does NOT detect:
 *   - a host assembled at runtime from parts
 *   - `new OpenAI({ apiKey })` and friends, where the SDK embeds its own base URL
 *   - a proxy hop
 * Those are NOT CHECKED. **Knowing a URL is not the same as presenting a bearer**, so this
 * is layer 1 of three: hostname inventory (here), import-graph guard on SDK constructors
 * (next), runtime chokepoint (`src/egress/provider-fetch.ts`, later). Do not mistake a green
 * run here for the chokepoint existing.
 *
 * ── WHAT IT IS NOT. Not a fix, and no claim that any listed file is wrong. It makes the
 * surface countable, which turns "every provider call goes through one chokepoint" from an
 * aspiration into something CI can refuse.
 */
import fs from 'fs';
import path from 'path';

const REPO = path.join(__dirname, '..');
const SRC = path.join(REPO, 'src');

/** Hostnames that mean "an LLM provider is named here". */
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

/** Naming its own provider's host is the entire purpose of the file. Expected to stay. */
const ADAPTERS: readonly string[] = [
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
];

/** Deliberately dials providers to test credentials. Names hosts AND sends bearers. */
const PROBES: readonly string[] = ['src/services/provider-key-probe.ts'];

/** Host appears only in a comment. Superset artefacts, kept visible rather than filtered. */
const NOISE: readonly string[] = ['src/config.ts', 'src/hal/local-llm.ts'];

/**
 * THE SHRINK LIST. Business logic that reached for a provider directly.
 * Removing an entry — because the file now goes through the registry or the future
 * chokepoint — is the intended motion, and must LOWER `CALLSITE_CEILING` in the same commit.
 */
const CALLSITES: readonly string[] = [
  'src/engine/badges.ts',
  'src/hal/classifier.ts',
  'src/hal/completeness.ts',
  'src/hal/crag.ts',
  'src/hal/cross-llm-client.ts',
  'src/hal/fact-check.ts',
  'src/hal/lib/clients/embedding.ts',
  'src/hal/lib/cross-llm/embedding-client.ts',
  'src/hal/lib/cross-llm/index.ts',
  'src/selfhost.ts',
  'src/services/adversarial-judge.ts',
  'src/services/pcp-validator.ts',
  'src/services/validation-repid-delta.ts',
];

/**
 * RATCHET. Lower this when a callsite is retired; never raise it.
 * Raising it means a new direct caller was admitted, which is the thing this file exists
 * to refuse — take that to review as a decision, not as a test edit.
 */
const CALLSITE_CEILING = 13;

const BASELINE: readonly string[] = [...ADAPTERS, ...PROBES, ...NOISE, ...CALLSITES];
const MAY_DISAPPEAR_QUIETLY = new Set(CALLSITES);

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

/** Files under src/ naming at least one provider host. Relative, posix, sorted. */
function measureEgressSurface(): string[] {
  const found: string[] = [];
  for (const file of walk(SRC)) {
    if (PROVIDER_HOSTS.some((h) => fs.readFileSync(file, 'utf8').includes(h))) {
      found.push(path.relative(REPO, file).split(path.sep).join('/'));
    }
  }
  return found.sort();
}

describe('provider egress surface is pinned and shrinking, not described', () => {
  const measured = measureEgressSurface();

  it('no NEW file names a provider host', () => {
    expect(measured.filter((f) => !BASELINE.includes(f))).toEqual([]);
  });

  it('the ratchet holds — a new callsite cannot be admitted by editing the list', () => {
    // Second lock. Adding a file to CALLSITES to silence the check above trips this one.
    expect(CALLSITES.length).toBeLessThanOrEqual(CALLSITE_CEILING);
  });

  it('an ADAPTER / PROBE / NOISE entry that stops matching is rot — it moved or was deleted', () => {
    const gone = BASELINE.filter((f) => !measured.includes(f) && !MAY_DISAPPEAR_QUIETLY.has(f));
    expect(gone).toEqual([]);
  });

  it('a CALLSITE that stops matching is PROGRESS — delete the line and lower the ceiling', () => {
    // Deliberately still a failure: the list must be updated or CALLSITES never actually
    // shrinks in the file and the target becomes unmeasurable. The MESSAGE is what differs
    // from rot — this one is a win to be recorded, not a regression to be fixed.
    const retired = CALLSITES.filter((f) => !measured.includes(f));
    expect(retired).toEqual([]);
  });

  it('the roles partition the surface with nothing double-counted', () => {
    expect(BASELINE.length).toBe(new Set(BASELINE).size);
    expect(measured.length).toBe(BASELINE.length);
    expect(ADAPTERS.length + PROBES.length + NOISE.length + CALLSITES.length).toBe(26);
  });

  it('the judge is a CALLSITE, which is the finding that motivated this guard', () => {
    expect(CALLSITES).toContain('src/services/adversarial-judge.ts');
    expect(measured).toContain('src/services/adversarial-judge.ts');
  });

  it('the matcher matches — non-vacuity of the detector itself', () => {
    const real = 'const e = "https://api.groq.com/openai/v1/chat/completions";';
    expect(PROVIDER_HOSTS.some((h) => real.includes(h))).toBe(true);
    expect(PROVIDER_HOSTS.some((h) => 'const e = "https://example.test/v1";'.includes(h))).toBe(
      false,
    );
  });
});
