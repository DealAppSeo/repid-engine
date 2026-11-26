#!/usr/bin/env ts-node
/**
 * For each task id: was the deliverable in the reply, in a saved artifact, and do the copies agree?
 * Reads `trinity_tasks.result` and `trinity_artifacts.content`. Read-only: every query runs inside a
 * READ ONLY transaction, so Postgres itself refuses a write.
 *
 *   npx ts-node --transpile-only scripts/t12/delivery-check.ts --task <id> [--task <id>]...
 *     [--pattern <regex> [--min-lines <n>]]     a contract for tasks whose row carries none
 *
 * Needs DATABASE_URL. Prints one JSON report per task.
 * Exit: 0 every task delivered and its copies agree · 3 a task is not delivered or its copies disagree ·
 *       2 NOT_CHECKED (no DATABASE_URL, a bad argument, or a task that could not be judged) · 1 failed.
 */
import { Pool } from 'pg';
import { assertLocalDataStore } from '../../src/selfhost/egress-guard';
import { readDelivery, type DeliveryReport } from '../../src/orchestration/t12-delivery-check';
import { specMeta } from '../../src/orchestration/t12-feed-order';

const args = (name: string): string[] => process.argv.flatMap((a, i) => (a === `--${name}` ? [process.argv[i + 1] ?? ''] : []));

function notChecked(why: string): never {
  process.stderr.write(`t12 delivery-check NOT_CHECKED: ${why}\n`);
  process.exit(2);
}

/** The exit code for a set of reports. A task that could not be judged never shares 0 with a pass. */
export function exitCodeFor(reports: readonly DeliveryReport[]): 0 | 2 | 3 {
  if (reports.some((r) => r.disagree === true || r.verdict.startsWith('NOT_DELIVERED'))) return 3;
  if (reports.length === 0 || reports.some((r) => !r.verdict.startsWith('DELIVERED'))) return 2;
  return 0;
}

async function main(): Promise<void> {
  const tasks = args('task');
  if (tasks.length === 0 || tasks.some((t) => !/^\d{1,18}$/.test(t))) notChecked('give one or more --task <numeric id>.');
  const [pattern] = args('pattern');
  const [minLines] = args('min-lines');
  if (minLines !== undefined && pattern === undefined) notChecked('--min-lines needs --pattern.');
  const given = pattern === undefined ? { meta: {}, problems: [] as string[] } : specMeta([`meta:delivery_contract.pattern=${pattern}`, ...(minLines === undefined ? [] : [`meta:delivery_contract.min_lines=${minLines}`])]);
  if (given.problems.length) notChecked(given.problems.join('; '));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) notChecked('DATABASE_URL is not set; nothing was read.');
  assertLocalDataStore(connectionString, 'DATABASE_URL');

  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 30_000, query_timeout: 30_000 });
  const client = await pool.connect();
  const reports: DeliveryReport[] = [];
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    for (const t of tasks) reports.push(await readDelivery(client, t, (given.meta as { deliveryContract?: DeliveryReport['contract'] }).deliveryContract ?? null));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await pool.end();
  }
  process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
  process.exit(exitCodeFor(reports));
}

if (require.main === module) {
  main().catch((e: unknown) => {
    process.stderr.write(`t12 delivery-check failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
