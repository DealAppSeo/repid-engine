/**
 * T12 audit v0, READ ONLY: per-agent capability record, live-RepID independence, and one random
 * merged-PR draw for the fenced GrokCode auditor.
 *
 *   DATABASE_URL=... npx ts-node --transpile-only scripts/t12/audit-run.ts --out <dir>
 *     [--days 7] [--parent t12-known-answer-v2] [--ledger <merge-ledger.jsonl>] [--since YYYY-MM-DD]
 *     [--seed <text> | --beacon drand --day YYYY-MM-DD]
 *
 * --seed is a fixed text, so anyone who knows it can predict the draw before the work is done.
 * --beacon drand draws from exactly one UTC day's entries, seeded with the first drand quicknet round
 * AFTER that day ends: public, unpredictable until it happens, and re-fetchable by anyone. The day is
 * the only choice the auditor makes. A free cutoff or start would let an auditor who has already seen
 * the beacon try windows until the draw lands where they want, so --since is refused with --beacon.
 * A round still in the future is NOT_CHECKED, never a fallback to a fixed seed.
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

/** Why the beacon flags cannot run as given, or null. A beacon asked for is never silently a fixed seed. */
export function beaconFlagProblem(argv: readonly string[]): string | null {
  // This parser reads `--flag value` only; `--beacon=drand` would otherwise be an unknown token, ignored.
  if (argv.some((a) => /^--(beacon|day|seed|since)=/.test(a))) return 'write --beacon drand --day YYYY-MM-DD as separate words, not with =';
  for (const f of ['--beacon', '--day']) if (argv.filter((a) => a === f).length > 1) return `${f} may appear once`;
  const at = argv.indexOf('--beacon');
  const value = at < 0 ? undefined : argv[at + 1];
  if (at >= 0 && value !== 'drand') return `--beacon must be drand, got ${value ?? 'nothing'}`;
  if (at < 0 && argv.includes('--day')) return '--day is only for --beacon drand';
  return null;
}

/** One UTC day as a closed window, or null if `day` is not a real YYYY-MM-DD date. */
export function auditDay(day: string): { startMs: number; endMs: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const startMs = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(startMs) || new Date(startMs).toISOString().slice(0, 10) !== day) return null;
  return { startMs, endMs: startMs + 24 * 60 * 60 * 1000 - 1 };
}

/** The entries of that day. Compared as times, not strings: the ledger writes `…:04Z`, toISOString `…:04.000Z`.
 *  An entry with no parseable time cannot be placed in the day, so it is left out. */
export function dayPopulation<T extends { ts?: string }>(entries: readonly T[], w: { startMs: number; endMs: number }): T[] {
  return entries.filter((e) => { const t = Date.parse(String(e.ts ?? '')); return t >= w.startMs && t <= w.endMs; });
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
  // Checked on the flag's PRESENCE, not its value: `--beacon Drand`, a typo, or a trailing `--beacon`
  // with no value must stop the run, never fall back to the fixed seed it was meant to replace.
  const beaconProblem = beaconFlagProblem(process.argv);
  if (beaconProblem) throw new Error(beaconProblem);
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
  let seed = arg('seed', `audit-${today}`)!;
  let beacon: { round: number; at: string; randomness: string } | null = null;
  let window: { day: string; startMs: number; endMs: number } | null = null;
  if (arg('beacon') === 'drand') {
    if (since || arg('seed')) throw new Error('--beacon drand takes a --day only: a free --since or --seed would let the draw be steered');
    const day = arg('day') ?? '';
    const w = auditDay(day);
    if (!w) throw new Error('--beacon drand needs --day YYYY-MM-DD (a real UTC date)');
    window = { day, ...w };
    const { round, atMs } = drandRoundAfter(w.endMs);
    if (Date.now() < atMs) throw new Error(`drand round ${round} is at ${new Date(atMs).toISOString()}, still in the future`);
    const r = await fetch(`https://api.drand.sh/${DRAND_QUICKNET.hash}/public/${round}`);
    const b = (await r.json()) as { round?: number; randomness?: string };
    if (!r.ok || b.round !== round || !/^[0-9a-f]{64}$/.test(b.randomness ?? '')) throw new Error(`drand round ${round} did not come back`);
    beacon = { round, at: new Date(atMs).toISOString(), randomness: b.randomness! };
    seed = `drand-quicknet:${round}:${b.randomness}`;
  }
  let sample: { seed: string; beacon: typeof beacon; day: string | null; pool: number; index: number; entry: unknown } | 'NOT_CHECKED: no ledger' = 'NOT_CHECKED: no ledger';
  if (ledger && existsSync(ledger)) {
    const parsed = readFileSync(ledger, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as { ts?: string; pr?: unknown }; } catch { return null; } })
      .filter((e): e is { ts?: string; pr?: unknown } => !!e && typeof e.pr !== 'undefined');
    const pool = window ? dayPopulation(parsed, window) : parsed.filter((e) => String(e.ts ?? '') >= String(since));
    const d = drawSample(pool, seed);
    if (d) sample = { seed, beacon, day: window?.day ?? null, pool: pool.length, index: d.index, entry: d.entry };
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
