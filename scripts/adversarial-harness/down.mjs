#!/usr/bin/env node
'use strict';

const { readFileSync, existsSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '../..');
const HARNESS = join(ROOT, '.harness');
const PID = join(HARNESS, 'anvil.pid');

function killPid(pid) {
  try {
    if (process.platform === 'win32') {
      require('node:child_process').execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(Number(pid), 'SIGTERM');
    }
  } catch {
    /* already gone */
  }
}

if (existsSync(PID)) {
  const pid = readFileSync(PID, 'utf8').trim();
  if (pid) killPid(pid);
}

rmSync(HARNESS, { recursive: true, force: true });
console.log('[harness] down — scratch store and anvil pid removed');
