#!/usr/bin/env ts-node
/**
 * Write the day's T12 work record as JSON. Read-only against the database.
 *
 *   npx ts-node --transpile-only scripts/t12/daily-record.ts --source synthetic|real [--date YYYY-MM-DD] [--out file] [--entitlements file.json]
 *
 * Uses DATABASE_URL. Exit: 0 written, 2 NOT_CHECKED (no database or bad arguments).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { buildDailyRecord, type DailyRecord, type FreeEntitlement } from '../../src/orchestration/t12-daily-record';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
function notChecked(why: string): never {
  process.stderr.write(`daily record NOT_CHECKED: ${why}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const source = arg('source');
  if (source !== 'synthetic' && source !== 'real') notChecked('--source must be synthetic or real');
  if (!process.env.DATABASE_URL) notChecked('DATABASE_URL is not set');
  const date = arg('date') ?? new Date().toISOString().slice(0, 10);
  const entitlementsFile = arg('entitlements');
  const entitlements: FreeEntitlement[] = entitlementsFile ? JSON.parse(readFileSync(entitlementsFile, 'utf8')) : [];
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query(`SELECT metadata -> 't12' AS state FROM trinity_tasks WHERE metadata ? 't12'`);
    await client.query('COMMIT');
    const record = buildDailyRecord(rows, date, source as DailyRecord['source'], entitlements);
    const text = `${JSON.stringify(record, null, 2)}\n`;
    const out = arg('out');
    if (out) writeFileSync(out, text);
    process.stdout.write(text);
  } finally {
    await client.end();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`daily record failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
});
