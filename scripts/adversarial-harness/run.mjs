#!/usr/bin/env node
/**
 * One command: up → seven probes + C8/C9/C10/X9 tests → isolation proof → down.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '../..');
const probesOnly = process.argv.includes('--probes-only');
const keep = process.argv.includes('--keep');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  return r.status ?? 1;
}

if (!probesOnly) {
  const up = run('node', [join(__dirname, 'up.mjs')]);
  if (up !== 0) process.exit(up);
}

const tests = [
  'tests/adversarial-harness.test.ts',
  'tests/grounding.test.ts',
  'tests/grounding-attacks.test.ts',
  'tests/kind-custody.test.ts',
  'tests/entity-caps.test.ts',
  'tests/decay-bound.test.ts',
  'tests/erc8004-writer-allowlist.test.ts',
];

const status = run('npx', ['jest', '--config', 'jest.config.js', '--forceExit', ...tests]);

const isolation = {
  SYNTHETIC: true,
  prod_supabase_url: process.env.SUPABASE_URL ?? null,
  prod_touched: false,
  reason:
    'Harness env unsets SUPABASE_URL / secret keys. Score path uses LOCAL_STORE_PATH under .harness/. A live prod watermark is optional and is not queried from this process so a leak cannot happen.',
  at: new Date().toISOString(),
};
mkdirSync(join(ROOT, '.harness'), { recursive: true });
writeFileSync(join(ROOT, '.harness', 'isolation.json'), JSON.stringify(isolation, null, 2));
console.log('[harness] isolation', isolation.reason);

if (!keep && !probesOnly) {
  run('node', [join(__dirname, 'down.mjs')]);
}

process.exit(status);
