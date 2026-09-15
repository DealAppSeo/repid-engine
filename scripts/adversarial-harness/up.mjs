#!/usr/bin/env node
/**
 * Bring up the X8 adversarial harness: scratch LOCAL_MODE store + optional anvil fork.
 * One command. Free. Local. No prod credentials.
 */
'use strict';

const { spawn } = require('node:child_process');
const { mkdirSync, writeFileSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const pin = require('./pin.json');

const ROOT = resolve(__dirname, '../..');
const HARNESS = join(ROOT, '.harness');
const STORE = join(HARNESS, 'store.db');
const PID = join(HARNESS, 'anvil.pid');
const ENV = join(HARNESS, 'env.json');

function findAnvil() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
    'anvil',
    join(home, '.foundry', 'bin', 'anvil.exe'),
    join(home, '.foundry', 'bin', 'anvil'),
  ];
  for (const c of candidates) {
    if (c === 'anvil') continue;
    if (existsSync(c)) return c;
  }
  return process.env.ANVIL_BIN || 'anvil';
}

function main() {
  mkdirSync(HARNESS, { recursive: true });
  const env = {
    LOCAL_MODE: 'true',
    LOCAL_STORE_PATH: STORE,
    GROUNDING_MODE: 'shadow',
    DECAY_BOUND_MODE: 'shadow',
    ONLY_ATTESTATIONS_LEAVE: 'true',
    FORK_BLOCK: String(pin.forkBlock),
    ANVIL_PORT: process.env.ANVIL_PORT || '8545',
    SYNTHETIC: 'true',
  };
  delete env.SUPABASE_URL;
  writeFileSync(
    ENV,
    JSON.stringify(
      {
        ...env,
        SUPABASE_URL: null,
        SUPABASE_SECRET_KEY: null,
        note: 'SYNTHETIC harness. Prod keys deliberately absent.',
      },
      null,
      2,
    ),
  );

  const anvilBin = findAnvil();
  const port = env.ANVIL_PORT;
  let anvilStarted = false;
  try {
    const child = spawn(
      anvilBin,
      [
        '--fork-url',
        pin.rpc,
        '--fork-block-number',
        String(pin.forkBlock),
        '--port',
        String(port),
        '--silent',
      ],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
    if (child.pid) {
      writeFileSync(PID, String(child.pid));
      anvilStarted = true;
    }
  } catch (e) {
    writeFileSync(
      join(HARNESS, 'anvil.skipped'),
      `anvil not started: ${e instanceof Error ? e.message : String(e)}\nA1–A6 still run against LOCAL_MODE. A7 on-chain path is NOT_CHECKED.\n`,
    );
  }

  console.log(
    [
      '[harness] up',
      `  store     ${STORE}`,
      `  fork      Base Sepolia @ ${pin.forkBlock}`,
      `  anvil     ${anvilStarted ? `127.0.0.1:${port} pid=${existsSync(PID) ? require('node:fs').readFileSync(PID, 'utf8') : '?'}` : 'SKIPPED (probes A1–A6 still run)'}`,
      '  supabase  unset (isolation)',
    ].join('\n'),
  );
}

main();
