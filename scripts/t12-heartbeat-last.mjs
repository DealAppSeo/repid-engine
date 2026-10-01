#!/usr/bin/env node
// @ts-check
/**
 * Local script that reports the last T12 heartbeat time from a local fixture,
 * or prints NOT_CHECKED when the flag is off, the fixture is missing, or the
 * read fails.
 *
 * Usage:
 *   T12_FREE_WAVE=true node scripts/t12-heartbeat-last.mjs
 *   T12_FREE_WAVE=true T12_HEARTBEAT_LAST_FIXTURE=/path/to/fixture.json node scripts/t12-heartbeat-last.mjs
 *
 * Fixture format (JSON): { "rows": [{ "last_heartbeat_at": "ISO-string" }] }
 * Rows may also be supplied as a bare array.
 *
 * No paid host call. No Anthropic. No fetch to vendors.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const DEFAULT_FIXTURE_PATH = join(here, 'fixtures', 't12-heartbeat-last.json');

function t12FreeWaveOn(env = process.env) {
  return env.T12_FREE_WAVE === 'true';
}

function readFixtureRows(fixturePath) {
  if (!existsSync(fixturePath)) return null;
  try {
    const raw = readFileSync(fixturePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.rows ?? parsed ?? null;
  } catch {
    return null;
  }
}

function probeT12Heartbeat(rows) {
  const value = rows?.[0]?.last_heartbeat_at;
  if (typeof value === 'string' && value.length > 0) {
    return { status: 'counted', last_heartbeat_at: value };
  }
  return { status: 'NOT_CHECKED', last_heartbeat_at: null };
}

function finish(code, line) {
  console.log(line);
  process.exit(code);
}

function main() {
  if (!t12FreeWaveOn()) {
    finish(2, 'NOT_CHECKED');
  }

  const fixturePath = process.env.T12_HEARTBEAT_LAST_FIXTURE || DEFAULT_FIXTURE_PATH;
  const rows = readFixtureRows(fixturePath);
  const result = probeT12Heartbeat(rows);

  if (result.status === 'counted' && result.last_heartbeat_at) {
    finish(0, result.last_heartbeat_at);
  }

  finish(2, 'NOT_CHECKED');
}

main();
