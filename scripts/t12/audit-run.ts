/**
 * T12 audit v0, READ ONLY: per-agent capability record, live-RepID independence, and one random
 * merged-PR draw for the fenced GrokCode auditor.
 *
 *   DATABASE_URL=... npx ts-node --transpile-only scripts/t12/audit-run.ts --out <dir>
 *     [--days 7] [--parent t12-known-answer-v2] [--ledger <merge-ledger.jsonl>] [--since YYYY-MM-DD]
 *     [--seed <text> | --beacon drand --cutoff <ISO time>]
 *
 * --seed is a fixed text, so anyone who knows it can predict the draw before the work is done.
 * --beacon drand closes the population at --cutoff and seeds the draw with the first drand quicknet
 * round AFTER the cutoff: public, unpredictable until it happens, and re-fetchable by anyone. A round
 * still in the future is NOT_CHECKED, never a fallback to a fixed seed.
 *
 * Exit 0 = report written. Exit 2 = NOT_CHECKED (no DATABASE_URL, or a query failed); nothing is written then.
 * Every query runs inside BEGIN READ ONLY and the transaction is rolled back. This script cannot move RepID.
 * The merged-PR sample is only DRAWN here (seeded, so anyone can redraw it); the audit itself runs through
 * the fenced reviewer, which keeps an answer only when GrokCode had read tools alone.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';

const SQL_DIR = resolve(__dirname, '..', '..', 'ops', 't12', 'audit');

/** Seeded draw: the same seed and the same entries always give the same index. */
export function drawSample<T>(entries: readonly T[], seed: string): { index: number; entry: T } | null {
  if (entries.length === 0) return null;
  const index = createHash('sha256').update(seed).digest().readUInt32BE(0) % entries.length;
  return { index, entry: entries[index]! };
}

/** drand quicknet, read from https://api.drand.sh/<hash>/info on 2026-11-11. */
export const DRAND_QUICKNET = { hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971', genesis: 1692803367, period: 3 } as const;

/** The first quicknet round whose time is strictly after the cutoff, and that time in ms. */
export function drandRoundAfter(cutoffMs: number): { round: number; atMs: number } {
  const { genesis, period } = DRAND_QUICKNET;
  const round = Math.floor((Math.floor(cutoffMs / 1000) - genesis) / period) + 2;
  return { round, atMs: (genesis + (round - 1) * period) * 1000 };
}

/** The entries the draw may pick: on or after `since`, and no later than the cutoff that closes the population. */
export function closedPopulation<T extends { ts?: string }>(entries: readonly T[], since: string, cutoffMs?: number): T[] {
  // Compared as times, not strings: the ledger writes `…:04Z` and toISOString writes `…:04.000Z`. An entry
  // with no parseable time cannot be shown to precede the cutoff, so a closed population leaves it out.
  return entries.filter((e) => String(e.ts ?? '') >= since && (cutoffMs === undefined || Date.parse(String(e.ts ?? '')) <= cutoffMs));
}

const arg = (name: string, dflt?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};

const table = (rows: Record<string, unknown>[]): string => {
  if (rows.length === 0) return '_no rows_\n';
  const cols = Object.keys(rows[0]!);
  return [`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${cols.map((c) => String(r[c] ?? '')).join(' | ')} |`)].join('\n') + '\n';
};

async function main(): Promise<void> {
  const out = arg('out');
  const days = Number(arg('days', '7'));
  const parent = arg('parent', 't12-known-answer-v2')!;
  const today = new Date().toISOString().slice(0, 10);
  if (!out) throw new Error('--out <dir> is required');
  if (!process.env.DATABASE_URL) {
    console.error('NOT_CHECKED: DATABASE_URL is not set, so nothing was read.');
    process.exit(2);
  }

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  let capability: Record<string, unknown>[];
  let independence: Record<string, unknown>[];
  try {
    await db.query('BEGIN READ ONLY');
    capability = (await db.query(readFileSync(join(SQL_DIR, 'capability-record.sql'), 'utf8'), [parent, days])).rows;
    independence = (await db.query(readFileSync(join(SQL_DIR, 'live-repid-independence.sql'), 'utf8'), [days])).rows;
  } finally {
    await db.query('ROLLBACK').catch(() => undefined);
    await db.end();
  }

  const ledger = arg('ledger');
  const since = arg('since', '');
  const cutoff = arg('cutoff');
  let seed = arg('seed', `audit-${today}`)!;
  let beacon: { round: number; at: string; randomness: string } | null = null;
  if (arg('beacon') === 'drand') {
    if (!cutoff || Number.isNaN(Date.parse(cutoff))) throw new Error('--beacon drand needs --cutoff <ISO time>');
    const { round, atMs } = drandRoundAfter(Date.parse(cutoff));
    if (Date.now() < atMs) throw new Error(`drand round ${round} is at ${new Date(atMs).toISOString()}, still in the future`);
    const r = await fetch(`https://api.drand.sh/${DRAND_QUICKNET.hash}/public/${round}`);
    const b = (await r.json()) as { round?: number; randomness?: string };
    if (!r.ok || b.round !== round || !/^[0-9a-f]{64}$/.test(b.randomness ?? '')) throw new Error(`drand round ${round} did not come back`);
    beacon = { round, at: new Date(atMs).toISOString(), randomness: b.randomness! };
    seed = `drand-quicknet:${round}:${b.randomness}`;
  }
  let sample: { seed: string; beacon: typeof beacon; cutoff: string | null; pool: number; index: number; entry: unknown } | 'NOT_CHECKED: no ledger' = 'NOT_CHECKED: no ledger';
  if (ledger && existsSync(ledger)) {
    const parsed = readFileSync(ledger, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as { ts?: string; pr?: unknown }; } catch { return null; } })
      .filter((e): e is { ts?: string; pr?: unknown } => !!e && typeof e.pr !== 'undefined');
    const pool = closedPopulation(parsed, String(since), beacon ? Date.parse(cutoff!) : undefined);
    const d = drawSample(pool, seed);
    if (d) sample = { seed, beacon, cutoff: beacon ? cutoff! : null, pool: pool.length, index: d.index, entry: d.entry };
  }

  mkdirSync(out, { recursive: true });
  const report = { generated_at: new Date().toISOString(), window_days: days, parent, capability, independence, sample };
  writeFileSync(join(out, `T12_AUDIT_${today}.json`), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(out, `T12_AUDIT_${today}.md`),
    `# T12 audit, ${today} (read only, last ${days} days)\n\n## Capability record (parent ${parent})\n${table(capability)}\n` +
    `## Live RepID by owner independence\n${table(independence)}\n## Random merged-PR draw\n\`\`\`json\n${JSON.stringify(sample, null, 2)}\n\`\`\`\n`);
  console.log(`written: ${join(out, `T12_AUDIT_${today}.md`)}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`NOT_CHECKED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  });
}
