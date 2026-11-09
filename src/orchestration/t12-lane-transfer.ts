/**
 * t12-lane-transfer.ts — how a maker's commit reaches a checker or integrator on another machine.
 *
 * Roles run in separate jobs on separate machines, so a commit travels as a git bundle in a file. The
 * bundle is the model's output and is treated as hostile. Its SHA-256 is written to the task row when
 * the work is submitted, and the receiver trusts that row, not anything that came with the file.
 *
 * The receiver checks, in order: the digest; that the base is on the repository's main; that the bundle
 * holds exactly this task's branch at this commit; that git's object checks pass; that it is exactly one
 * commit on top of the base; and that it only adds or edits plain files inside the lease. A problem
 * with the work is `rejected`. A file that never arrived says nothing about the work, so it is `not_checked`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LaneSpec, Submission } from './t12-lane-store';

const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).trim();

export const bundleName = (specId: string, commit: string) => `${specId}-${commit}.bundle`;
const fileSha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Write one task's commit as a bundle and return its digest, which goes on the task row. */
export function exportSubmission(canon: string, outDir: string, spec: LaneSpec, branch: string, base: string, commit: string): string {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, bundleName(spec.id, commit));
  git(canon, 'bundle', 'create', '-q', file, `refs/heads/${branch}`, `^${base}`);
  return fileSha256(file);
}

export type ImportResult = { ok: true } | { ok: false; outcome: 'rejected' | 'not_checked'; reason: string };

/** Bring a bundle into this clone, or say why not. Nothing in it runs. */
export function importSubmission(canon: string, inDir: string, spec: LaneSpec, sub: Submission): ImportResult {
  const notChecked = (reason: string): ImportResult => ({ ok: false, outcome: 'not_checked', reason });
  const rejected = (reason: string): ImportResult => ({ ok: false, outcome: 'rejected', reason });

  if (!sub.bundle_sha256 || !SHA256.test(sub.bundle_sha256)) return notChecked('the task row records no bundle digest');
  const file = join(inDir, bundleName(spec.id, sub.commit));
  if (!existsSync(file)) return notChecked(`no bundle arrived for commit ${sub.commit}`);
  const stat = lstatSync(file);
  if (!stat.isFile()) return rejected('the bundle is not a regular file');
  if (stat.size > MAX_BUNDLE_BYTES) return rejected('the bundle is too large');
  if (fileSha256(file) !== sub.bundle_sha256) return rejected('the bundle does not match the digest on the task row');

  try {
    git(canon, 'fetch', '-q', 'origin', 'main');
    git(canon, 'merge-base', '--is-ancestor', sub.base, 'origin/main');
  } catch {
    return rejected('the base commit is not on main');
  }

  const expectedRef = `refs/heads/${sub.branch}`;
  const imported = `refs/t12-import/${sub.commit}`;
  try {
    git(canon, 'bundle', 'verify', '-q', file);
    const heads = git(canon, 'bundle', 'list-heads', file).split('\n').filter(Boolean);
    if (heads.length !== 1 || heads[0] !== `${sub.commit} ${expectedRef}`) return rejected('the bundle does not hold exactly this branch at this commit');
    git(canon, '-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true', 'fetch', '-q', '--no-tags', file, `+${expectedRef}:${imported}`);
  } catch (e) {
    return rejected(`the bundle failed its checks: ${String((e as Error).message).slice(0, 200)}`);
  }
  if (git(canon, 'rev-parse', imported) !== sub.commit) return rejected('the imported ref is not the submitted commit');
  if (git(canon, 'rev-list', '--parents', '-n', '1', sub.commit) !== `${sub.commit} ${sub.base}`) return rejected('the bundle is not exactly one commit on top of the base');

  for (const line of git(canon, 'diff-tree', '-r', '--no-renames', '--raw', sub.base, sub.commit).split('\n').filter(Boolean)) {
    const [meta, path] = line.split('\t') as [string, string];
    const [, newMode, , , status] = meta.split(' ');
    if (status !== 'A' && status !== 'M') return rejected(`the bundle does more than add or edit files: ${status} ${path}`);
    if (newMode !== '100644') return rejected(`the bundle is not a plain file: ${newMode} ${path}`);
    if (!spec.paths.includes(path)) return rejected(`the bundle writes outside the lease: ${path}`);
  }
  return { ok: true };
}
