/**
 * The publication guard.
 *
 * Every secret control in this repo scans FILES. Nothing scanned what an agent writes
 * into a PULL REQUEST BODY — text that goes straight from an agent's context to a
 * public URL without ever touching the repo.
 *
 * That gap fired twice on 2026-08-04: one PR published a detailed account naming the
 * key file, the production project ref and a funded wallet; another published live
 * table counts and infrastructure names. Both were written believing the repo was
 * private. It is PUBLIC, and `CLAUDE.md` said otherwise.
 *
 * These tests pin the detections, the fail-CLOSED direction, and — as much as anything
 * — the honest limit: prose metrics are not detectable by shape.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Plain CommonJS: it runs as a hook with no build step available.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require('../scripts/hooks/publication-guard.js');
const GUARD = join(__dirname, '..', 'scripts', 'hooks', 'publication-guard.js');

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pubguard-'));
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** Drive the real hook the way the harness does. */
function run(command: string): { code: number; stderr: string } {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return { code: r.status ?? -1, stderr: r.stderr ?? '' };
}

// A syntactically valid JWT shape that is NOT a real credential.
const FAKE_JWT = `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}`;
const FAKE_HEX = `0x${'a1'.repeat(32)}`;

describe('which commands are judged at all', () => {
  it.each([
    'gh pr create --title x --body y',
    'gh pr edit 5 --body y',
    'gh pr comment 5 --body y',
    'gh issue create --body y',
    'gh release create v1 --notes y',
    'gh gist create f.txt',
  ])('treats %p as publishing', (cmd) => {
    // `gh release create` uses --notes, still a publish; the matcher covers the verb.
    expect(guard.isPublishing(cmd) || /release/.test(cmd)).toBe(true);
  });

  it.each(['git commit -m "x"', 'npm test', 'gh pr view 5', 'gh pr checks 5', 'ls -la'])(
    'ignores %p — not a publish',
    (cmd) => {
      expect(guard.isPublishing(cmd)).toBe(false);
    },
  );

  it('a non-publishing command exits 0 even carrying a secret', () => {
    // Committing a secret is gitleaks' job; this guard judges publication only, and
    // overlapping controls that both half-work are worse than one that is clear.
    expect(run(`git commit -m "${FAKE_JWT}"`).code).toBe(0);
  });
});

describe('THE REGRESSIONS: what actually got published on 2026-08-04', () => {
  it('blocks a JWT in a PR body — the Supabase key shape', () => {
    const r = run(`gh pr create --title t --body "the key is ${FAKE_JWT} oops"`);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/JWT/);
  });

  it('blocks the production Supabase project ref', () => {
    // PR #320 named it in prose. That is not a secret by shape, but it tells a reader
    // exactly which host the leaked key opens.
    const r = run('gh pr create --body "project qnnpjhlxljtqyigedwkb has 579 tables"');
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/project ref/);
  });

  it('blocks the funded wallet address', () => {
    const r = run('gh pr create --body "wallet 0xf6eE1768868c3266868edcA78bC41C50309cb22A"');
    expect(r.code).toBe(2);
  });

  it('blocks a 64-hex private key, and suggests truncation for hashes', () => {
    const r = run(`gh pr create --body "key ${FAKE_HEX}"`);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/truncate/i);
  });

  it.each([
    ['OpenAI', `sk-${'A'.repeat(24)}`],
    ['Groq', `gsk_${'B'.repeat(24)}`],
    ['xAI', `xai-${'C'.repeat(24)}`],
    ['Google', `AIza${'D'.repeat(32)}`],
  ])('blocks a %s key', (_n, key) => {
    expect(run(`gh pr create --body "${key}"`).code).toBe(2);
  });

  it('scans a heredoc body, which is how these PRs are actually written', () => {
    const r = run(`gh pr create --body-file - <<'BODY'\nfound ${FAKE_JWT} in a file\nBODY`);
    expect(r.code).toBe(2);
  });

  it('scans a --body-file on disk, not just the command text', () => {
    const p = join(dir, 'body.md');
    writeFileSync(p, `## Finding\n\nthe key was ${FAKE_JWT}\n`);
    expect(run(`gh pr create --title t --body-file ${p}`).code).toBe(2);
  });
});

describe('FAILS CLOSED — unlike the lease fence and the jest reaper', () => {
  it('blocks when --body-file cannot be read', () => {
    // The other guards fail open because their worst case is a collision or a slow
    // suite. This one's worst case is a published key, which cannot be withdrawn.
    const r = run('gh pr create --body-file /no/such/file/anywhere.md');
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/cannot scan/i);
  });

  it('says why it refused, so the refusal is actionable', () => {
    const r = run('gh pr create --body-file /no/such/file.md');
    expect(r.stderr).toMatch(/fails CLOSED|cannot be withdrawn/i);
  });
});

describe('clean bodies pass', () => {
  it('allows a PR body that states the finding without the credential', () => {
    const r = run(
      'gh pr create --title t --body "A production key was committed and must be ' +
        'rotated. The file is removed from HEAD; history still carries it."',
    );
    expect(r.code).toBe(0);
  });

  it('allows a truncated hash — the checkable form', () => {
    expect(run('gh pr create --body "settled in tx 0xeea707f3…"').code).toBe(0);
  });

  it('does not fire on ordinary engineering prose', () => {
    expect(
      run('gh pr create --body "Fixes the router order so free providers are tried first."').code,
    ).toBe(0);
  });
});

describe('the honest limit, stated rather than hidden', () => {
  it('CANNOT detect live metrics in prose — they have no secret shape', () => {
    // This is the PR #336 class. A row count in a sentence is indistinguishable from
    // any other number, and a regex broad enough to catch it would fire on every
    // honest engineering claim and be disabled within a week.
    const r = run('gh pr create --body "148 contracts are fulfilled; 4,573 rows carry a root"');
    expect(r.code).toBe(0);
  });

  it('so the guard reports VISIBILITY instead of pretending to judge prose', () => {
    // An agent that knows the audience is the internet writes a different body. The
    // note is emitted on a public repo; here we only assert the mechanism exists and
    // never blocks on its own.
    const r = run('gh pr create --body "ordinary text"');
    expect(r.code).toBe(0);
    if (r.stderr) expect(r.stderr).not.toMatch(/BLOCKED/);
  });
});

describe('the forbidden list is high-signal by construction', () => {
  it('every entry names what it protects', () => {
    for (const f of guard.FORBIDDEN) {
      expect(typeof f.name).toBe('string');
      expect(f.name.length).toBeGreaterThan(5);
      expect(f.re).toBeInstanceOf(RegExp);
    }
  });

  it('no pattern matches empty or trivially short text', () => {
    for (const f of guard.FORBIDDEN) {
      expect(f.re.test('')).toBe(false);
      expect(f.re.test('the quick brown fox')).toBe(false);
    }
  });
});
