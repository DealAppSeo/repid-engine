/**
 * CONSEQUENCE-CLASSIFIER DOGFOOD HARNESS — LOCAL ONLY (CC, 2026-06-24, round 2).
 *
 * Runnable demo of "agents' actions get governed" end-to-end, locally. Feeds real-shaped action
 * samples through the round-1 consequence classifier (spec v0.3 §3) and the shadow gate, prints the
 * T0/T1/T2 decision for each, and writes a LOCAL shadow log (JSONL) — never a prod table.
 *
 * Run:  npx ts-node scripts/dogfood/consequence-dogfood.ts
 *       (writes .shadow-logs/dogfood-consequence.jsonl, then prints it back)
 *
 * HARD STOP honored: no Supabase, no network, no Railway. Pure local classification + file sink.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { Action, classifyAction } from '../../src/services/consequence-classifier';
import { shadowClassify, fileShadowSink, ShadowRecord } from '../../src/middleware/consequence-gate';

/** Real-shaped samples — the four the brief names, plus an unmatched fail-safe demonstrator. */
const SAMPLES: Array<{ label: string; action: Action }> = [
  {
    label: 'local scratch note (reversible)',
    action: { kind: 'file_write', paths: ['scratch/notes.md'], localOnly: true, description: 'jot a TODO' },
  },
  {
    label: 'read the leaderboard',
    action: { kind: 'read', description: 'SELECT from a view' },
  },
  {
    label: 'merge a feature branch (bounded)',
    action: { kind: 'git', git: { operation: 'merge', targetRef: 'feat/cc-2026-06-24-r2' }, description: 'merge own feature branch' },
  },
  {
    label: 'non-prod preview config change (bounded)',
    action: { kind: 'platform', platform: { name: 'vercel-preview', isProd: false }, description: 'bump preview env var' },
  },
  {
    label: 'DB migration (critical/irreversible)',
    action: { kind: 'db', sql: 'ALTER TABLE repid_agents ADD COLUMN foo int', paths: ['migrations/2026-06-24-foo.sql'], description: 'schema change' },
  },
  {
    label: 'prod-config change on Trinity prod (critical)',
    action: { kind: 'platform', platform: { name: 'railway', isProd: true }, projectId: 'qnnpjhlxljtqyigedwkb', description: 'prod env mutation' },
  },
  {
    label: 'git push to main (critical)',
    action: { kind: 'git', git: { operation: 'push', targetRef: 'main' }, description: 'push to protected ref' },
  },
  {
    label: 'unrecognized action (fail-safe demo)',
    action: { kind: 'some_new_surface_we_never_enumerated', description: 'unknown → must fail to T2' },
  },
];

const ROUTE_ICON: Record<string, string> = { act: '🟢', 'adversarial-gate': '🟡', HITL: '🔴', 'no-action': '⚪' };

async function main(): Promise<void> {
  const logPath = path.join(process.cwd(), '.shadow-logs', 'dogfood-consequence.jsonl');
  // Fresh log each run so the demo output is deterministic.
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, '', 'utf8');
  const sink = fileShadowSink(logPath);

  console.log('=== CONSEQUENCE DOGFOOD (spec v0.3 §3, shadow/dry-run, LOCAL-ONLY) ===\n');
  console.log('Action                                          → TIER  (floor)  route       rules fired');
  console.log('────────────────────────────────────────────────────────────────────────────────────────');

  for (const { label, action } of SAMPLES) {
    const c = classifyAction(action);
    const rec: ShadowRecord = shadowClassify(action, { route: `dogfood:${label}` });
    await sink(rec); // LOCAL file write only

    const icon = ROUTE_ICON[rec.wouldRoute] ?? '';
    const floorNote = c.failSafe ? `${c.ruleFloor}*FAILSAFE` : c.ruleFloor;
    const ruleIds = c.hits.map((h) => h.ruleId).join(', ') || '(none → unmatched)';
    console.log(
      `${label.padEnd(46).slice(0, 46)} → ${c.tier.padEnd(4)} (${floorNote.padEnd(11)}) ${icon} ${rec.wouldRoute.padEnd(15)} ${ruleIds}`,
    );
  }

  // Read the local shadow log back to prove it was written locally (NOT to any DB).
  const written = (await fs.readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean);
  console.log(`\n=== LOCAL SHADOW LOG (${written.length} records) → ${logPath} ===`);
  for (const line of written) {
    const r = JSON.parse(line) as ShadowRecord;
    console.log(`  [${r.mode}] ${r.route}  →  ${r.classification?.tier ?? 'n/a'}  (wouldRoute=${r.wouldRoute})`);
  }

  // Sanity summary the demo asserts on, so a regression is obvious.
  const tiers = SAMPLES.map((s) => classifyAction(s.action).tier);
  const counts = tiers.reduce<Record<string, number>>((m, t) => ((m[t] = (m[t] ?? 0) + 1), m), {});
  console.log(`\nSummary: ${JSON.stringify(counts)}  (T2 includes the unmatched fail-safe)`);
  console.log('No prod write occurred. Shadow output is the local JSONL file above.');
}

main().catch((e) => {
  console.error('dogfood failed:', e);
  process.exit(1);
});
