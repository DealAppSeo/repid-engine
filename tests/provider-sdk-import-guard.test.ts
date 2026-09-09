/**
 * PROVIDER SDK IMPORT-GRAPH GUARD — layer 2 of the egress chokepoint work.
 *
 * Fails the build when an LLM provider SDK is imported or constructed OUTSIDE the two
 * directories allowed to hold provider wire code: `src/providers/` and a future
 * `src/sealer/`.
 *
 * WHY THIS IS A SEPARATE GUARD FROM THE HOSTNAME ONE. The hostname inventory
 * (`provider-egress-guard.test.ts`, layer 1) greps for `api.groq.com` and friends. It is a
 * SUPERSET of "makes a call" — but it is structurally BLIND to the one shape that is the most
 * dangerous, because it names no host at all:
 *
 *     import OpenAI from 'openai';
 *     const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });   // base URL lives
 *                                                                          // INSIDE the SDK
 *
 * That client presents `Authorization: Bearer <key>` to `api.openai.com` (or to whatever
 * `baseURL` the constructor was handed) without the string `api.openai.com` ever appearing in
 * the file. Knowing a URL is not presenting a bearer; this guard watches the bearer-presenting
 * act — constructing the client — not the URL.
 *
 * TODAY THIS REPO HAS ZERO SDK USAGE [MEASURED 2026-09-09]: no `openai` / `@anthropic-ai/sdk`
 * dependency, no import, no constructor — every provider call is a raw `fetch`. So this guard is
 * GREEN by having nothing to catch, and its whole value is preventing the regression where
 * someone `npm i openai` and news up a client in business logic. A guard that is green only
 * because it can never fire is a comment — so `scanForSdkUsage` is exercised against a planted
 * positive and a planted negative below, and the end-to-end walk was shown failing on a real
 * fixture before this landed (see the PR's non-vacuity transcript).
 *
 * ALLOWED, and why only these two:
 *   src/providers/   the adapter layer — constructing a provider client IS its job.
 *   src/sealer/      does not exist yet. Named here so the future sealer (which will hold the
 *                    credential-presentation seam) is allowed the moment it lands, without a
 *                    second edit that a reviewer has to connect back to this intent.
 */
import fs from 'fs';
import path from 'path';

const REPO = path.join(__dirname, '..');
const SRC = path.join(REPO, 'src');

/** Directories permitted to import or construct a provider SDK. Posix, trailing slash. */
const ALLOWED_DIRS = ['src/providers/', 'src/sealer/'] as const;

/**
 * Package specifiers that ARE an LLM provider SDK. An import/require of any of these is the
 * "import-graph" signal — the file has pulled an SDK into its graph.
 */
const SDK_PACKAGES = [
  'openai',
  '@anthropic-ai/sdk',
  '@mistralai/mistralai',
  'groq-sdk',
  '@cerebras/cerebras_cloud_sdk',
  '@google/generative-ai',
  'cohere-ai',
  '@azure/openai',
  'togetherai',
] as const;

/** Client classes these SDKs export. `new <Class>(` is the bearer-presenting construction. */
const SDK_CONSTRUCTORS = [
  'OpenAI',
  'AzureOpenAI',
  'Anthropic',
  'AnthropicBedrock',
  'AnthropicVertex',
  'Groq',
  'Mistral',
  'MistralClient',
  'Cerebras',
  'CerebrasClient',
  'GoogleGenerativeAI',
  'CohereClient',
  'CohereClientV2',
] as const;

// Build once. Package names are escaped for use inside a character-class-free alternation.
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const IMPORT_RE = new RegExp(
  // `import ... from 'pkg'`  OR  `require('pkg')`  OR  `import('pkg')`
  String.raw`(?:from\s*|require\(\s*|import\(\s*)['"](?:${SDK_PACKAGES.map(esc).join('|')})['"]`,
);
const CONSTRUCT_RE = new RegExp(String.raw`\bnew\s+(?:${SDK_CONSTRUCTORS.join('|')})\s*\(`);

export interface SdkHit {
  signal: 'import' | 'construct';
  match: string;
}

/** The detector, shared by the walk and the non-vacuity matcher test so they cannot diverge. */
export function scanForSdkUsage(source: string): SdkHit | null {
  const imp = source.match(IMPORT_RE);
  if (imp) return { signal: 'import', match: imp[0] };
  const ctor = source.match(CONSTRUCT_RE);
  if (ctor) return { signal: 'construct', match: ctor[0] };
  return null;
}

function isAllowed(relPosix: string): boolean {
  return ALLOWED_DIRS.some((d) => relPosix.startsWith(d));
}

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

/** Files under src/ that import or construct a provider SDK, OUTSIDE the allowed dirs. */
function findViolations(): Array<{ file: string; hit: SdkHit }> {
  const violations: Array<{ file: string; hit: SdkHit }> = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    if (isAllowed(rel)) continue;
    const hit = scanForSdkUsage(fs.readFileSync(file, 'utf8'));
    if (hit) violations.push({ file: rel, hit });
  }
  return violations;
}

describe('provider SDK clients are constructed only in the adapter/sealer layer', () => {
  it('no file outside src/providers/ or src/sealer/ imports or constructs a provider SDK', () => {
    const violations = findViolations();
    if (violations.length) {
      const lines = violations
        .map((v) => `  ${v.file}: ${v.hit.signal} — ${v.hit.match}`)
        .join('\n');
      throw new Error(
        `An LLM provider SDK is used outside src/providers/ and src/sealer/.\n` +
          `An SDK client embeds its own base URL and presents Authorization: Bearer, so the ` +
          `hostname guard cannot see it. Move the client into the adapter layer, or route the ` +
          `call through src/egress/provider-fetch.ts.\n${lines}`,
      );
    }
    expect(violations).toEqual([]);
  });

  // NON-VACUITY of the detector itself (the defect from layer 1's first run: a matcher that
  // emits nothing still reads as a pass). Same function the walk uses.
  it('the detector fires on a constructor and on an SDK import — and not on benign code', () => {
    expect(scanForSdkUsage('const c = new OpenAI({ apiKey: k });')).toEqual({
      signal: 'construct',
      match: 'new OpenAI(',
    });
    expect(scanForSdkUsage("import Anthropic from '@anthropic-ai/sdk';")?.signal).toBe('import');
    expect(scanForSdkUsage("const r = await fetch('https://api.openai.com/v1');")).toBeNull();
    expect(scanForSdkUsage('// we could use the openai sdk here but do not')).toBeNull();
  });

  it('the allowed list is exactly the adapter layer and the future sealer', () => {
    expect([...ALLOWED_DIRS]).toEqual(['src/providers/', 'src/sealer/']);
  });
});
