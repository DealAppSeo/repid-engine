/**
 * dispatch-capability-parity.test.ts — pins the dispatcher's duplicated capability
 * model to the canonical one, and pins the refusal behaviour that model exists for.
 *
 * `scripts/dispatch/run-agent.mjs` duplicates the capability check from
 * `src/orchestration/lane-registry.ts` rather than importing it, for the same
 * reason `scripts/hooks/lane-write-guard.js` duplicates its lease logic: the
 * dispatcher must run in a fresh worktree with no `npm install` and no build,
 * because `dist/` is stale exactly when someone is mid-refactor. A fence that
 * needs a build is a fence that fails OPEN.
 *
 * Duplication is only safe if something notices when the copies diverge. That is
 * this file.
 *
 * WHY ANY OF THIS EXISTS — 2026-08-05. GA was dispatched to review a PR in another
 * repository and returned a report containing fabricated test output with invented
 * line numbers. Its own stderr showed it never read the file and never ran
 * anything: `run_shell_command` unavailable, `read_file` blocked as outside
 * workspace. It was asked for something it had no instrument to obtain, and that
 * reliably produces a well-formed wrong answer rather than a failure.
 *
 * `canAssign()` — the mechanism that prevents precisely this — already existed,
 * fully built and tested, with ZERO CALLERS. The bug was never a missing
 * mechanism. It was an unwired one, which is worse than an absent one because it
 * reads as coverage.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { canAssign, LANES } from '../src/orchestration/lane-registry';

const RUNNER = join(__dirname, '..', 'scripts', 'dispatch', 'run-agent.mjs');
const src = readFileSync(RUNNER, 'utf8');

describe('dispatch runner — capability model parity with lane-registry', () => {
  it('every capability the runner knows about is a real Capability in the registry', () => {
    const m = src.match(/const KNOWN_CAPABILITIES = \[([^\]]+)\]/);
    expect(m).not.toBeNull();
    const runnerCaps = m![1]!.split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
    expect(runnerCaps.length).toBeGreaterThan(0);

    // The registry's own capability vocabulary, taken from the lanes themselves so
    // this cannot drift by editing a list in two places.
    const registryCaps = new Set(LANES.flatMap((l) => [...l.capabilities]));
    const unknown = runnerCaps.filter((c) => !registryCaps.has(c as never) && c !== 'cross_repo_read');
    expect(unknown).toEqual([]);
  });

  it('the registry still refuses an assignment for a missing capability', () => {
    // If this ever stops refusing, the runner's port is enforcing a contract the
    // canonical implementation has abandoned — and the duplication has become a lie.
    const t12 = LANES.find((l) => !l.capabilities.includes('http' as never));
    expect(t12).toBeDefined();
    const verdict = canAssign(t12!.id, ['http'] as never);
    expect(verdict.assignable).toBe(false);
    expect(verdict.missing).toContain('http');
    // The reason must explain the CONSEQUENCE, not just the fact. "lacks http" is
    // a status; "yields a fabricated answer" is why anyone should care.
    expect(verdict.reason).toMatch(/fabricat/i);
  });
});

describe('dispatch runner — the refusal that would have prevented the fabricated review', () => {
  it('declares capabilities as MEASURED, with evidence, and fails closed', () => {
    // Every capability list must be accompanied by a [V ...] verification note.
    // An unmeasured capability is a guess, and a guess here re-creates the bug.
    const agentBlocks = src.match(/capabilities: \[[^\]]*\]/g) ?? [];
    expect(agentBlocks.length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/\[V 2026-08-05\]/);

    // `shell` must NOT be claimed for either agent: it was never demonstrated for
    // grok, and was explicitly refused for gemini ("not available to this agent").
    for (const block of agentBlocks) {
      expect(block).not.toMatch(/'shell'/);
    }
  });

  it('refuses rather than warns — the dispatch must not proceed', () => {
    // A warning that still runs the agent produces the transcript that gets cited.
    expect(src).toMatch(/REFUSED/);
    expect(src).toMatch(/process\.exit\(65\)/);
    // And the refusal must fire BEFORE the key is read / the agent is spawned.
    const refuseAt = src.indexOf('capabilityRefusal(agentKey');
    const spawnAt = src.indexOf('spawnSync(bin.cmd');
    expect(refuseAt).toBeGreaterThan(-1);
    expect(spawnAt).toBeGreaterThan(-1);
    expect(refuseAt).toBeLessThan(spawnAt);
  });

  it('an empty or failed run can never read as a passing review', () => {
    // The GA transcript existed, was 0 seconds, was empty, and therefore LOOKED
    // like a result. An absent review is more dangerous than a negative one,
    // because the PR then carries a signature it never earned.
    expect(src).toMatch(/NO REVIEW WAS PRODUCED/);
    expect(src).toMatch(/!out\.trim\(\)/);
  });
});
