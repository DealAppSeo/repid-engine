/**
 * grok-key-precedence-parity.test.ts — pins the xAI key precedence used by HAL to the one
 * declared by the dispatcher, so the two can never disagree again.
 *
 * THE DEFECT THIS EXISTS FOR — found 2026-08-14. Two surfaces resolve the same xAI credential
 * from the same two env names, in OPPOSITE order:
 *
 *   src/hal/fact-check.ts        grokApiKey()  ->  GROK_API_KEY || XAI_API_KEY
 *   scripts/dispatch/run-agent.mjs  xc.keyVars ->  ['XAI_API_KEY', 'GROK_API_KEY']
 *
 * Both accept both names, so with only one var set everything works and nothing fails. The
 * inconsistency only bites when BOTH are set to different values — then the HAL tiebreak and the
 * XC dispatcher authenticate as different principals, and the 401 surfaces on whichever one
 * nobody is watching. `HAL_ESCALATE_GROK` is default-OFF and fail-safe, so on that side the
 * symptom is not an error at all: it is zero escalations, which reads exactly like "no ties
 * occurred". A wrong key there is INVISIBLE.
 *
 * That is the same shape as the #398 rename that silently un-dispatched XC: a disagreement with
 * no failing signal. The lesson from that one was that duplication is only safe if something
 * notices when the copies diverge — the same reason `dispatch-capability-parity.test.ts` exists.
 * This is that notice for the credential.
 *
 * WHY NOT JUST SHARE A HELPER: `run-agent.mjs` deliberately duplicates rather than imports,
 * because it must run in a fresh worktree with no `npm install` and no build — `dist/` is stale
 * exactly when someone is mid-refactor, and a fence that needs a build is a fence that fails
 * OPEN. So the copies stay, and this file pins them.
 *
 * WHY XAI_API_KEY WINS: `.env.master` and Railway were canonicalised to `XAI_API_KEY` (#398),
 * which is also the standard xAI env name. `GROK_API_KEY` is the legacy fallback.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { grokApiKey } from '../src/hal/fact-check';

const RUNNER = join(__dirname, '..', 'scripts', 'dispatch', 'run-agent.mjs');
const runnerSrc = readFileSync(RUNNER, 'utf8');

/** The dispatcher's declared order — the source of truth both surfaces are pinned to. */
function dispatcherKeyVars(): string[] {
  // The `xc` agent entry is the only one whose keyVars mention XAI/GROK.
  const m = runnerSrc.match(/keyVars: \[([^\]]*(?:XAI_API_KEY|GROK_API_KEY)[^\]]*)\]/);
  if (!m || !m[1]) throw new Error('could not find the xc keyVars list in run-agent.mjs');
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/['"]/g, ''))
    .filter(Boolean);
}

describe('xAI key precedence — HAL parity with the XC dispatcher', () => {
  const saved = { grok: process.env.GROK_API_KEY, xai: process.env.XAI_API_KEY };
  afterEach(() => {
    process.env.GROK_API_KEY = saved.grok;
    process.env.XAI_API_KEY = saved.xai;
  });

  it('the dispatcher still declares both names (a rename to a single name is the #398 bug)', () => {
    expect(dispatcherKeyVars().slice().sort()).toEqual(['GROK_API_KEY', 'XAI_API_KEY']);
  });

  it('the dispatcher ranks XAI_API_KEY first (canonical per #398)', () => {
    expect(dispatcherKeyVars()[0]).toBe('XAI_API_KEY');
  });

  it('grokApiKey() resolves to the SAME var the dispatcher would pick when both are set', () => {
    // Distinct values, so "which one won" is observable rather than inferred.
    const values: Record<string, string> = {
      XAI_API_KEY: 'value-from-xai-api-key',
      GROK_API_KEY: 'value-from-grok-api-key',
    };
    process.env.XAI_API_KEY = values.XAI_API_KEY;
    process.env.GROK_API_KEY = values.GROK_API_KEY;

    const dispatcherPick = values[dispatcherKeyVars()[0]!];
    expect(grokApiKey()).toBe(dispatcherPick);
  });

  it('every name the dispatcher accepts is also resolvable by HAL on its own', () => {
    // Guards the other half: matching precedence is worthless if one surface
    // cannot read one of the names at all.
    for (const name of dispatcherKeyVars()) {
      delete process.env.XAI_API_KEY;
      delete process.env.GROK_API_KEY;
      process.env[name] = `only-${name}`;
      expect(grokApiKey()).toBe(`only-${name}`);
    }
  });
});
