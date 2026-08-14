/**
 * dispatch-runner-seams.test.ts — executes the dispatcher's safety predicates.
 *
 * WHY THIS FILE EXISTS. `scripts/dispatch/run-agent.mjs` rests on five pure functions:
 * `auditClaims` (the fabrication detector), `evidenceRefusal` (the command fence), `readKey`
 * (the rename-tolerant lookup), `capabilityRefusal` (seam 1) and `argAll` (the repeatable-flag
 * reader). Before 2026-08-14 only `auditClaims` and `capabilityRefusal` were exercised at all —
 * by `dispatch-capability-parity.test.ts`, which slices the function bodies out of the file as
 * TEXT and evals them with `new Function`. The rest were asserted on by regex over the source,
 * which cannot tell a working predicate from a plausible-looking one.
 *
 * That distinction is not academic here. `auditClaims`'s first version was written, reviewed,
 * shipped, and then measured against the real fabricated transcript it missed completely. The
 * disarm fixed today (one evidence command switching the detector off wholesale) then survived
 * in its replacement, under a test that asserted the disarm was correct on purpose.
 *
 * These cases import the real module instead of re-evaluating a slice of it, so they cannot pass
 * against a file that no longer parses, and they do not silently stop covering anything if
 * someone reorders the functions. The slice-and-eval suite is left alone: it holds the verbatim
 * 2026-08-05 fixture, which is worth more than the mechanism it uses to run it.
 *
 * HOW IT RUNS. The dispatcher is ESM; ts-jest compiles this file to CommonJS and jest's VM
 * sandbox refuses a real dynamic `import()` without `--experimental-vm-modules`. So each case
 * runs in a real Node process — the same idiom as `demo-leaf-bin.test.ts`, and the same lesson
 * `resolveBin` exists for: test the CALL PATH, not the thing next to it.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const RUNNER = path.resolve(__dirname, '../scripts/dispatch/run-agent.mjs').replace(/\\/g, '/');

function call(fnBody: string, env: Record<string, string> = {}, cwd?: string): any {
  const src = `
    import * as api from '${RUNNER}';
    const out = (${fnBody})(api);
    process.stdout.write(JSON.stringify(out ?? null));`;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', src], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      ...(cwd ? { cwd } : {}),
    }),
  );
}

/** Shorthand: run auditClaims with a JSON-safe input and get its verdict back. */
const audit = (input: Record<string, unknown>) =>
  call(`({auditClaims}) => auditClaims(${JSON.stringify(input)})`);

const NO_SHELL = ['reasoning', 'repo_read'];
const STACK_FRAME = 'AssertionError: expected true\n    at file:///repo/tests/x.test.mjs:42:12';

describe('auditClaims — the fabrication detector', () => {
  it('flags execution artifacts when the agent had no shell and no evidence', () => {
    const r = audit({ output: STACK_FRAME, capabilities: NO_SHELL, evidenceCount: 0 });
    expect(r.unsupported).toBe(true);
    expect(r.maxGrade).toBe('R');
  });

  it('says nothing about a reasoning-only report with no artifacts', () => {
    const r = audit({
      output: 'INTEGRITY_TYPES uses exact match; a prefix would be safer. [R]',
      capabilities: NO_SHELL,
      evidenceCount: 0,
    });
    expect(r.unsupported).toBe(false);
    expect(r.hasArtifacts).toBe(false);
  });

  // ── THE DISARM. This is the case the old predicate could not see. ──
  it('flags an invented artifact even when evidence WAS supplied (the 2026-08-14 disarm)', () => {
    // One cheap, always-passing, allowlisted command used to set couldExecute=true and
    // switch the whole detector off. The jest output below appears nowhere in it.
    const r = audit({
      output: `Ran the suite.\n${STACK_FRAME}\nTests: 3 failed`,
      capabilities: NO_SHELL,
      evidenceCount: 1,
      evidenceText: '$ git log --oneline -1\n[exit 0]\nc207e8c docs(providers): correct a claim',
    });
    expect(r.unsupported).toBe(true);
    expect(r.ungroundedCount).toBeGreaterThan(0);
    expect(r.groundedCount).toBe(0);
    expect(r.ungroundedSamples.join(' ')).toContain('x.test.mjs:42');
  });

  it('does NOT flag an artifact the agent was actually shown', () => {
    const r = audit({
      output: `The suite is red: ${STACK_FRAME}`,
      capabilities: NO_SHELL,
      evidenceCount: 1,
      evidenceText: `$ npm test\n[exit 1]\n${STACK_FRAME}`,
    });
    expect(r.unsupported).toBe(false);
    expect(r.groundedCount).toBeGreaterThan(0);
    expect(r.ungroundedCount).toBe(0);
  });

  it('treats a reformatted quote of real evidence as grounded, not invented', () => {
    // Conservative by design: a false positive trains people to ignore the banner.
    const r = audit({
      output: 'It fails at    file:///repo/tests/x.test.mjs:42:12   (reflowed)',
      capabilities: NO_SHELL,
      evidenceCount: 1,
      evidenceText: `$ npm test\n[exit 1]\n${STACK_FRAME}`,
    });
    expect(r.unsupported).toBe(false);
  });

  it('never flags an agent that actually holds shell', () => {
    const r = audit({
      output: STACK_FRAME,
      capabilities: ['reasoning', 'repo_read', 'shell'],
      evidenceCount: 0,
    });
    expect(r.unsupported).toBe(false);
    expect(r.maxGrade).toBe('V');
  });

  it('caps the grade at [R] without shell or evidence, and allows [V] with evidence', () => {
    const bare = audit({ output: 'ok', capabilities: NO_SHELL, evidenceCount: 0 });
    const shown = audit({ output: 'ok', capabilities: NO_SHELL, evidenceCount: 1, evidenceText: '$ npm test\n[exit 0]' });
    expect(bare.maxGrade).toBe('R');
    expect(shown.maxGrade).toBe('V');
  });
});

describe('evidenceRefusal — the command fence', () => {
  const refuse = (cmd: string) => call(`({evidenceRefusal}) => evidenceRefusal(${JSON.stringify(cmd)})`);

  it.each([
    'npm test',
    'npx jest --config jest.config.js tests/repid-score.test.ts',
    'npx tsc --noEmit',
    'git status --porcelain',
  ])('permits the allowlisted shape: %s', (cmd) => {
    expect(refuse(cmd)).toBeNull();
  });

  it.each([
    ['chained command', 'npm test && rm -rf /'],
    ['piped command', 'npm test | tee out.txt'],
    ['subshell', 'npm test $(whoami)'],
    ['redirect', 'npm test > /dev/null'],
    ['semicolon', 'npm test; curl evil.example'],
  ])('refuses a %s so a permitted prefix cannot smuggle a second', (_label, cmd) => {
    expect(refuse(cmd)).toMatch(/metacharacters/);
  });

  it('refuses an unlisted command outright', () => {
    expect(refuse('curl https://example.com')).toMatch(/not on the evidence allowlist/);
  });
});

describe('argAll — repeatable flags', () => {
  /** argAll reads the real process.argv, so give a child process the flags. `--` keeps node from claiming them. */
  const argvFlags = (...args: string[]): string[] => {
    const src = `
      import { argAll } from '${RUNNER}';
      process.stdout.write(JSON.stringify(argAll('evidence')));`;
    return JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', src, '--', ...args], { encoding: 'utf8' }),
    );
  };

  it('collects EVERY occurrence, not just the first (the silent-truncation bug)', () => {
    expect(argvFlags('--evidence', 'npm test', '--evidence', 'npx tsc --noEmit')).toEqual([
      'npm test',
      'npx tsc --noEmit',
    ]);
  });

  it('returns an empty list when the flag is absent, rather than a stray truthy', () => {
    expect(argvFlags('--agent', 'xc')).toEqual([]);
  });

  it('ignores a value-less trailing flag instead of capturing the next flag as its value', () => {
    expect(argvFlags('--evidence', '--dry-run')).toEqual([]);
  });
});

describe('readKey — rename-tolerant lookup', () => {
  const withEnvMaster = (contents: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dispatch-key-'));
    const file = path.join(dir, '.env.master');
    writeFileSync(file, contents, 'utf8');
    return file;
  };

  it('prefers the first-listed name and reports WHICH one answered', () => {
    const file = withEnvMaster('GROK_API_KEY=legacy-value\nXAI_API_KEY=canonical-value\n');
    const r = call(`({readKey}) => readKey(['XAI_API_KEY','GROK_API_KEY'])`, { TRUSTKEYS_ENV_MASTER: file });
    expect(r).toEqual({ name: 'XAI_API_KEY', value: 'canonical-value' });
  });

  it('falls back to the legacy name — the rename that un-dispatched XC (#398)', () => {
    const file = withEnvMaster('GROK_API_KEY=legacy-value\n');
    const r = call(`({readKey}) => readKey(['XAI_API_KEY','GROK_API_KEY'])`, { TRUSTKEYS_ENV_MASTER: file });
    expect(r).toEqual({ name: 'GROK_API_KEY', value: 'legacy-value' });
  });

  it('returns null when no accepted name is present, rather than an empty key', () => {
    const file = withEnvMaster('SOMETHING_ELSE=x\n');
    const r = call(`({readKey}) => readKey(['XAI_API_KEY','GROK_API_KEY'])`, { TRUSTKEYS_ENV_MASTER: file });
    expect(r).toBeNull();
  });
});

describe('secret containment — the child env and the transcript', () => {
  // reports/ is committed to a repo CLAUDE.md states is PUBLIC, so a secret that reaches
  // a transcript is published permanently. Before 2026-08-14 the child received the whole
  // of process.env and the scrubber covered exactly one value.
  const INVENTORY = [
    'XAI_API_KEY=xai-this-agents-own-key',
    'ANTHROPIC_API_KEY=sk-ant-some-other-credential',
    'AGENT_KEY_MASTER=master-that-decrypts-every-agent-wallet',
    'SHORT=abc',
    '# a comment, and a blank line follow',
    '',
  ].join('\n');

  const withInventory = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dispatch-secrets-'));
    const file = path.join(dir, '.env.master');
    writeFileSync(file, INVENTORY, 'utf8');
    return file;
  };

  describe('buildChildEnv', () => {
    const built = (parent: Record<string, string>) =>
      call(
        `({buildChildEnv, readAllSecrets}) => buildChildEnv(${JSON.stringify(parent)}, readAllSecrets().keys(), ['XAI_API_KEY','GROK_API_KEY'], 'xai-this-agents-own-key')`,
        { TRUSTKEYS_ENV_MASTER: withInventory() },
      );

    it('strips other inventory secrets the operator shell happened to export', () => {
      const env = built({
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'sk-ant-some-other-credential',
        AGENT_KEY_MASTER: 'master-that-decrypts-every-agent-wallet',
      });
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.AGENT_KEY_MASTER).toBeUndefined();
    });

    it("keeps the agent's own key, under every alias it accepts", () => {
      const env = built({ PATH: '/usr/bin' });
      expect(env.XAI_API_KEY).toBe('xai-this-agents-own-key');
      expect(env.GROK_API_KEY).toBe('xai-this-agents-own-key');
    });

    it('preserves the platform variables the CLI needs to run at all', () => {
      // A prune that breaks dispatch is not a security win. This is why the prune is
      // keyed on known-secret NAMES rather than an allow-list of "what a CLI needs".
      const env = built({ PATH: '/usr/bin', HOME: '/home/x', LANG: 'en_US.UTF-8', TEMP: '/tmp' });
      expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/x', LANG: 'en_US.UTF-8', TEMP: '/tmp' });
    });
  });

  describe('makeScrubber', () => {
    const scrub = (values: string[], text: string) =>
      call(`({makeScrubber}) => makeScrubber(${JSON.stringify(values)})(${JSON.stringify(text)})`);

    it('redacts a secret that is NOT the provider key (the whole point)', () => {
      const out = scrub(
        ['xai-this-agents-own-key', 'sk-ant-some-other-credential'],
        'I found ANTHROPIC_API_KEY=sk-ant-some-other-credential in the environment.',
      );
      expect(out).not.toContain('sk-ant-some-other-credential');
      expect(out).toContain('<redacted>');
    });

    it('still redacts the provider key itself', () => {
      expect(scrub(['xai-this-agents-own-key'], 'key is xai-this-agents-own-key')).toBe('key is <redacted>');
    });

    it('redacts the longer of two overlapping secrets without leaving its tail', () => {
      const out = scrub(['secret-prefix', 'secret-prefix-and-more'], 'value: secret-prefix-and-more');
      expect(out).toBe('value: <redacted>');
      expect(out).not.toContain('and-more');
    });

    it('ignores values under the length floor, so prose stays readable', () => {
      // A 3-char secret would redact ordinary words; an unreadable transcript is not
      // reviewed, and an unreviewed transcript is the failure the harness exists to stop.
      expect(scrub(['abc'], 'the abc of it')).toBe('the abc of it');
    });

    it('is a no-op on text containing no secret', () => {
      expect(scrub(['xai-this-agents-own-key'], 'nothing sensitive here')).toBe('nothing sensitive here');
    });
  });

  describe('readAllSecrets', () => {
    it('reads every assignment, skipping comments and blanks', () => {
      const names = call(`({readAllSecrets}) => [...readAllSecrets().keys()]`, {
        TRUSTKEYS_ENV_MASTER: withInventory(),
      });
      expect(names).toEqual(['XAI_API_KEY', 'ANTHROPIC_API_KEY', 'AGENT_KEY_MASTER', 'SHORT']);
    });

    it('returns empty rather than throwing when the inventory is absent', () => {
      const names = call(`({readAllSecrets}) => [...readAllSecrets().keys()]`, {
        TRUSTKEYS_ENV_MASTER: path.join(tmpdir(), 'definitely-not-here', '.env.master'),
      });
      expect(names).toEqual([]);
    });
  });
});

describe('inbox resolution — --inbox and DISPATCH_HANDOFF_DIR', () => {
  const inboxPath = (explicit?: string, env: Record<string, string> = {}) =>
    String(
      call(
        `({inboxPathFor, AGENTS}) => inboxPathFor(AGENTS.xc, ${explicit === undefined ? 'undefined' : JSON.stringify(explicit)})`,
        env,
      ),
    ).replace(/\\/g, '/');

  it('honours an explicit --inbox path (it used to be parsed and discarded)', () => {
    // The defect: `arg('inbox')` returned the path, the call site read the hardcoded one,
    // so --inbox ./MY_TASK.md silently dispatched from a different file entirely.
    expect(inboxPath('/tmp/some/INBOX_TEST.md')).toBe('/tmp/some/INBOX_TEST.md');
  });

  it('falls back to DISPATCH_HANDOFF_DIR when no path is given', () => {
    expect(inboxPath(undefined, { DISPATCH_HANDOFF_DIR: '/srv/handoffs' })).toBe('/srv/handoffs/INBOX_XC.md');
  });

  it('keeps the historical default so the original machine is unaffected', () => {
    expect(inboxPath(undefined)).toBe('E:/dev/handoffs/INBOX_XC.md');
  });

  it('prefers an explicit path over the env override', () => {
    expect(inboxPath('/tmp/explicit.md', { DISPATCH_HANDOFF_DIR: '/srv/handoffs' })).toBe('/tmp/explicit.md');
  });

  it('treats a blank explicit path as absent rather than resolving to the cwd', () => {
    expect(inboxPath('   ', { DISPATCH_HANDOFF_DIR: '/srv/handoffs' })).toBe('/srv/handoffs/INBOX_XC.md');
  });

  it('resolves each agent against its own filename', () => {
    const ga = String(
      call(`({inboxPathFor, AGENTS}) => inboxPathFor(AGENTS.ga, undefined)`, { DISPATCH_HANDOFF_DIR: '/srv/h' }),
    ).replace(/\\/g, '/');
    expect(ga).toBe('/srv/h/INBOX_GA.md');
  });

  it('reads the newest "## " entry from a real file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dispatch-inbox-'));
    const file = path.join(dir, 'INBOX_XC.md');
    writeFileSync(file, '## newest\n\ndo this\n\n## older\n\ndo not pick this\n', 'utf8');
    const entry = call(`({newestInboxEntry}) => newestInboxEntry(${JSON.stringify(file)})`);
    expect(entry).toContain('do this');
    expect(entry).not.toContain('do not pick this');
  });

  it('returns null for a missing file instead of throwing', () => {
    const missing = path.join(tmpdir(), 'definitely-not-here', 'INBOX_XC.md');
    expect(call(`({newestInboxEntry}) => newestInboxEntry(${JSON.stringify(missing)})`)).toBeNull();
  });
});

describe('capabilityRefusal — seam 1', () => {
  it('refuses a task needing shell, naming what is missing', () => {
    const r = call(
      `({capabilityRefusal, AGENTS}) => capabilityRefusal('xc', AGENTS.xc, ['reasoning','shell'])`,
    );
    expect(r).toMatch(/lacks \[shell\]/);
    expect(r).toMatch(/FABRICATED/);
  });

  it('assigns a task the agent can actually satisfy', () => {
    const r = call(
      `({capabilityRefusal, AGENTS}) => capabilityRefusal('xc', AGENTS.xc, ['reasoning','repo_read'])`,
    );
    expect(r).toBeNull();
  });
});

describe('LESSONS_PATH — resolved from the file, not the cwd', () => {
  // The bug: `join(process.cwd(), 'LESSONS.md')` under a comment claiming repo-root
  // resolution. Dispatching from src/ dropped the entire shared-lessons block — the only
  // channel that reaches XC and GA — leaving one warning line as the whole trace.
  //
  // The cwd must be set on the CHILD PROCESS. An earlier version of this test passed a PWD
  // env var instead, which does not move `process.cwd()`; it passed against the buggy code
  // too, and the mutation run is what exposed it.
  const REPO = path.resolve(__dirname, '..');
  const lessonsPathFrom = (cwd: string): string =>
    String(call(`({LESSONS_PATH}) => LESSONS_PATH`, {}, cwd)).replace(/\\/g, '/');

  it('resolves to the repo root when invoked from the repo root', () => {
    expect(lessonsPathFrom(REPO)).toBe(`${REPO.replace(/\\/g, '/')}/LESSONS.md`);
  });

  it('resolves to the SAME path when invoked from a subdirectory', () => {
    expect(lessonsPathFrom(path.join(REPO, 'src'))).toBe(lessonsPathFrom(REPO));
  });

  it('never points inside the subdirectory it happened to be invoked from', () => {
    expect(lessonsPathFrom(path.join(REPO, 'src'))).not.toMatch(/\/src\/LESSONS\.md$/);
  });
});
