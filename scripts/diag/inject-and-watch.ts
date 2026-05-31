/**
 * S-DIAG1 TASK 4 — inject test tasks + watch whether the swarm claims them.
 *
 * Proves empirically whether agents CAN claim work when tasks exist: inserts 3 clearly-marked
 * probe tasks into trinity_tasks (pending, auto BIGSERIAL id, INTEGER priority, valid status),
 * then polls every 5s for 60s and reports each task's claim (by whom) + status transitions.
 *
 *   ts-node scripts/diag/inject-and-watch.ts            # inject 3 probes + watch 60s
 *   ts-node scripts/diag/inject-and-watch.ts --cleanup  # delete leftover [S-DIAG1-PROBE] tasks
 *
 * Probes are marked '[S-DIAG1-PROBE]' in description + task_type='diag_probe' so they're trivially
 * identifiable and removable. Reads/writes via supabase-js service-role.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const MARKER = '[S-DIAG1-PROBE]';
const POLL_MS = 5000, DURATION_MS = 60000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function loadEnv() {
  const p = join(process.cwd(), '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = (m[2] ?? '').replace(/^["']|["']$/g, '');
  }
}
function getDb(): SupabaseClient {
  loadEnv();
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('needs SUPABASE_URL + SUPABASE_SERVICE_KEY'); process.exit(2); }
  return createClient(url, key, { auth: { persistSession: false } });
}

async function cleanup(db: SupabaseClient) {
  const { data, error } = await db.from('trinity_tasks').delete().like('description', `${MARKER}%`).select('id');
  if (error) { console.error('cleanup failed:', error.message); process.exit(2); }
  console.log(`cleanup: removed ${data?.length ?? 0} probe task(s).`);
}

async function main() {
  const db = getDb();
  if (process.argv.includes('--cleanup')) { await cleanup(db); return; }

  // 1. inject 3 probes — pending, INTEGER priority, auto BIGSERIAL id, valid status.
  const stamp = new Date().toISOString();
  const rows = [1, 2, 3].map(n => ({
    description: `${MARKER} liveness probe ${n} @ ${stamp} — safe to reject/ignore`,
    title: `${MARKER} probe ${n}`,
    task_type: 'diag_probe',
    status: 'pending',
    priority: 90, // high so it's eligible quickly; agents claim by status='pending'
  }));
  const { data: inserted, error: insErr } = await db.from('trinity_tasks').insert(rows).select('id, status, created_at');
  if (insErr || !inserted?.length) { console.error('inject failed:', insErr?.message); process.exit(2); }
  const ids = (inserted as any[]).map(r => Number(r.id));
  console.log(`\n[inject] 3 probe tasks created: id ${ids.join(', ')} (status=pending, priority=90)`);
  console.log(`[watch] polling every ${POLL_MS / 1000}s for ${DURATION_MS / 1000}s …\n`);

  // 2. poll + track transitions
  const lastStatus: Record<number, string> = {};
  const claimedBy: Record<number, string | null> = {};
  const firstClaimMs: Record<number, number> = {};
  const t0 = Date.now();
  while (Date.now() - t0 < DURATION_MS) {
    const { data, error } = await db.from('trinity_tasks').select('id, status, claimed_by, updated_at').in('id', ids);
    if (error) { console.error('poll failed:', error.message); break; }
    const elapsed = Math.round((Date.now() - t0) / 1000);
    for (const r of (data as any[])) {
      const id = Number(r.id), st = r.status, cb = r.claimed_by ?? null;
      if (lastStatus[id] !== st) {
        console.log(`  +${String(elapsed).padStart(2)}s  task ${id}: ${lastStatus[id] ?? 'pending'} → ${st}${cb ? `  (claimed_by=${cb})` : ''}`);
        lastStatus[id] = st;
      }
      if (cb && claimedBy[id] == null) { claimedBy[id] = cb; firstClaimMs[id] = Date.now() - t0; }
    }
    await sleep(POLL_MS);
  }

  // 3. verdict
  const claimedIds = ids.filter(id => claimedBy[id] != null);
  console.log(`\n=== VERDICT ===`);
  console.log(`  injected: ${ids.length}   claimed: ${claimedIds.length}   final status: ${ids.map(id => `${id}=${lastStatus[id] ?? 'pending'}`).join(', ')}`);
  for (const id of ids) {
    if (claimedBy[id] != null) console.log(`  ✅ task ${id} CLAIMED by ${claimedBy[id]} after ${Math.round((firstClaimMs[id] ?? 0) / 1000)}s → final ${lastStatus[id]}`);
    else console.log(`  ⚠️  task ${id} NOT claimed within ${DURATION_MS / 1000}s (still ${lastStatus[id] ?? 'pending'})`);
  }
  console.log(claimedIds.length > 0
    ? `\n  → Agents CAN claim work: ${claimedIds.length}/${ids.length} probes claimed. The swarm-claim path is functional.`
    : `\n  → NO probe claimed in 60s — the claim path may be stalled (investigate workers, not the queue).`);
  console.log(`\n  cleanup leftover probes: ts-node scripts/diag/inject-and-watch.ts --cleanup`);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
