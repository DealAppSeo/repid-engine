/**
 * TEST ONLY: runs a check on the host so lane logic can be tested where Docker is absent.
 * Production has no path to this. tests/t12-sandbox.test.ts fails if src/ ever imports it.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubbedEnv } from '../../src/orchestration/t12-lane-git';
import type { SandboxRunner } from '../../src/orchestration/t12-sandbox';

export const hostSandboxForTests: SandboxRunner = ({ dir, command, timeoutMs }) =>
  new Promise((resolve) => {
    const [, ...args] = command;
    const env = scrubbedEnv(mkdtempSync(join(tmpdir(), 't12-host-home-')));
    execFile(process.execPath, args, { cwd: dir, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const raw = err ? (err as { code?: unknown }).code : 0;
      const code = typeof raw === 'number' ? raw : null;
      resolve({ kind: 'ran', code, ranOut: code === null, reason: code === null && err ? err.message : null, output: `${stdout}\n${stderr}` });
    });
  });
