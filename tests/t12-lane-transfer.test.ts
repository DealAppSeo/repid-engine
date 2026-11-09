/**
 * A commit crosses between machines only as a bundle that matches the digest on the task row.
 * Real git, two real clones. Each hostile bundle carries a matching digest unless the case is about the digest,
 * so the later checks are proven to work on their own.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bundleName, exportSubmission, importSubmission } from '../src/orchestration/t12-lane-transfer';
import type { LaneSpec, Submission } from '../src/orchestration/t12-lane-store';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

describe('moving a commit between machines', () => {
  let root: string; let origin: string; let maker: string; let checker: string; let out: string; let base: string; let n = 0;
  const specFor = (id: string, paths = ['tests/a.test.mjs']): LaneSpec => ({ id, repo: 'DealAppSeo/trustshell', title: 't', prompt: 'p', paths, verify: { runner: 'node-test', target: paths[0]! }, risk: 'LOW' });

  function clone(name: string): string {
    const d = join(root, name);
    execFileSync('git', ['clone', '-q', origin, d], { stdio: 'ignore' });
    git(d, 'config', 'user.email', 't@t');
    git(d, 'config', 'user.name', 't');
    return d;
  }

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 't12-transfer-')));
    origin = join(root, 'origin.git');
    out = join(root, 'out');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    maker = clone('maker');
    git(maker, 'checkout', '-q', '-b', 'main');
    writeFileSync(join(maker, 'seed.txt'), 'seed\n');
    git(maker, 'add', '.');
    git(maker, 'commit', '-q', '-m', 'seed');
    git(maker, 'push', '-q', 'origin', 'main');
    base = git(maker, 'rev-parse', 'HEAD');
    checker = clone('checker');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** One task's commit on its own lane branch. `edit` makes the change; defaults to one new file inside the lease. */
  function submission(spec: LaneSpec, edit?: () => void, from = base): Submission {
    n += 1;
    const branch = `t12/${spec.id}-e${n}`;
    git(maker, 'checkout', '-q', '-b', branch, from);
    if (edit) edit();
    else {
      mkdirSync(dirname(join(maker, spec.paths[0]!)), { recursive: true });
      writeFileSync(join(maker, spec.paths[0]!), `// ${spec.id}\n`);
      git(maker, 'add', '.');
      git(maker, 'commit', '-q', '-m', 'work');
    }
    const commit = git(maker, 'rev-parse', 'HEAD');
    git(maker, 'checkout', '-q', 'main');
    return { branch, commit, base: from, files: spec.paths, host: null, bundle_sha256: exportSubmission(maker, out, spec, branch, from, commit) };
  }
  const commitAll = (msg = 'work') => { git(maker, 'add', '-A'); git(maker, 'commit', '-q', '-m', msg); };

  it('a good bundle arrives, and the checker gets a commit it did not have', () => {
    const spec = specFor('good');
    const sub = submission(spec);
    expect(() => git(checker, 'cat-file', '-e', `${sub.commit}^{commit}`)).toThrow();
    expect(importSubmission(checker, out, spec, sub)).toEqual({ ok: true });
    expect(git(checker, 'cat-file', '-t', sub.commit)).toBe('commit');
  });

  it('no digest on the row or no file is NOT_CHECKED, because that says nothing about the work', () => {
    const spec = specFor('nothing');
    const sub = submission(spec);
    expect(importSubmission(checker, out, spec, { ...sub, bundle_sha256: undefined })).toMatchObject({ ok: false, outcome: 'not_checked' });
    expect(importSubmission(checker, join(root, 'empty'), spec, sub)).toMatchObject({ ok: false, outcome: 'not_checked', reason: expect.stringContaining('no bundle') });
  });

  it('a changed byte fails the digest before git ever reads it', () => {
    const spec = specFor('tamper');
    const sub = submission(spec);
    const f = join(out, bundleName(spec.id, sub.commit));
    const b = readFileSync(f);
    b[b.length - 1] = b[b.length - 1]! ^ 0xff;
    writeFileSync(f, b);
    expect(importSubmission(checker, out, spec, sub)).toMatchObject({ ok: false, outcome: 'rejected', reason: expect.stringContaining('digest') });
    expect(() => git(checker, 'cat-file', '-e', `${sub.commit}^{commit}`)).toThrow();
  });

  it('something that is not a regular file is refused', () => {
    const spec = specFor('dir');
    const sub = submission(spec);
    const f = join(out, bundleName(spec.id, sub.commit));
    rmSync(f);
    mkdirSync(f);
    expect(importSubmission(checker, out, spec, sub)).toMatchObject({ ok: false, outcome: 'rejected', reason: expect.stringContaining('regular file') });
  });

  it('a base that is not on main is refused, with a matching digest', () => {
    const spec = specFor('badbase');
    git(maker, 'checkout', '-q', '-b', 'side', base);
    writeFileSync(join(maker, 'planted.txt'), 'planted\n');
    commitAll('planted');
    const side = git(maker, 'rev-parse', 'HEAD');
    // The checker really has this commit, so only the on-main rule can refuse it.
    git(maker, 'push', '-q', 'origin', 'side');
    git(checker, 'fetch', '-q', 'origin', 'side');
    git(checker, 'cat-file', '-e', `${side}^{commit}`);
    git(maker, 'checkout', '-q', 'main');
    const sub = submission(spec, undefined, side);
    expect(importSubmission(checker, out, spec, sub)).toEqual({ ok: false, outcome: 'rejected', reason: 'the base commit is not on main' });
  });

  it('a bundle claiming another commit is refused', () => {
    const spec = specFor('otherhead');
    const sub = submission(spec);
    const other = submission(specFor('otherhead2'));
    const forged = join(out, bundleName(spec.id, other.commit));
    writeFileSync(forged, readFileSync(join(out, bundleName(spec.id, sub.commit))));
    expect(importSubmission(checker, out, spec, { ...other, branch: other.branch, bundle_sha256: sha(forged) })).toMatchObject({ ok: false, outcome: 'rejected', reason: expect.stringContaining('exactly this branch') });
  });

  it('two commits on top of the base are refused', () => {
    const spec = specFor('twocommits');
    const sub = submission(spec, () => {
      mkdirSync(join(maker, 'tests'), { recursive: true });
      writeFileSync(join(maker, 'tests/a.test.mjs'), '// 1\n');
      commitAll('one');
      writeFileSync(join(maker, 'tests/a.test.mjs'), '// 2\n');
      commitAll('two');
    });
    expect(importSubmission(checker, out, spec, sub)).toMatchObject({ ok: false, outcome: 'rejected', reason: expect.stringContaining('one commit') });
  });

  it('a file outside the lease is refused', () => {
    const spec = specFor('outside');
    const sub = submission(spec, () => {
      mkdirSync(join(maker, 'tests'), { recursive: true });
      writeFileSync(join(maker, 'tests/a.test.mjs'), '// ok\n');
      writeFileSync(join(maker, '.npmrc'), 'registry=https://evil.test\n');
      commitAll();
    });
    expect(importSubmission(checker, out, spec, sub)).toMatchObject({ ok: false, outcome: 'rejected', reason: expect.stringContaining('outside the lease') });
  });

  it('a symlink is refused even inside the lease', () => {
    const spec = specFor('symlink');
    const sub = submission(spec, () => {
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: maker, input: '/etc/passwd', encoding: 'utf8' }).trim();
      git(maker, 'update-index', '--add', '--cacheinfo', `120000,${blob},tests/a.test.mjs`);
      git(maker, 'commit', '-q', '-m', 'link');
    });
    expect(importSubmission(checker, out, spec, sub)).toMatchObject({ ok: false, outcome: 'rejected', reason: expect.stringContaining('not a plain file') });
  });

  it('an executable file is refused even inside the lease', () => {
    const spec = specFor('execbit');
    const sub = submission(spec, () => {
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: maker, input: '#!/bin/sh\n', encoding: 'utf8' }).trim();
      git(maker, 'update-index', '--add', '--cacheinfo', `100755,${blob},tests/a.test.mjs`);
      git(maker, 'commit', '-q', '-m', 'exec');
    });
    expect(importSubmission(checker, out, spec, sub)).toMatchObject({ ok: false, outcome: 'rejected', reason: expect.stringContaining('not a plain file') });
  });

  it('deleting a file is refused even when it is named in the lease', () => {
    const spec = specFor('deletes', ['seed.txt']);
    const sub = submission(spec, () => { git(maker, 'rm', '-q', 'seed.txt'); git(maker, 'commit', '-q', '-m', 'gone'); });
    expect(importSubmission(checker, out, spec, sub)).toMatchObject({ ok: false, outcome: 'rejected', reason: expect.stringContaining('more than add or edit') });
  });
});
