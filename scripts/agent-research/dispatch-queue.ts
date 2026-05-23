/**
 * Trinity Research Queue dispatcher. Seeds agent_research_queue idempotently,
 * then runs the 23 tasks in 3 dependency waves via free-LLM fallthrough
 * (groq→cerebras→fireworks), injecting dep outputs + ERC web context. Writes
 * artifacts to E:/dev/dogfood-v3 and updates each row's status/summary/verdict.
 * Reusable for future research cycles.
 *
 *   SUPABASE_URL=.. SUPABASE_SERVICE_ROLE_KEY=.. GROQ_API_KEY=.. CEREBRAS_API_KEY=..
 *   FIREWORKS_API_KEY=.. npx tsx scripts/agent-research/dispatch-queue.ts
 */
import { TASKS, WAVE_1, WAVE_2, WAVE_3, type ResearchTask } from './tasks';
import { db } from '../../src/db';
import * as fs from 'fs';

const OUT = 'E:/dev/dogfood-v3';
fs.mkdirSync(OUT, { recursive: true });
const ERC = fs.existsSync(`${OUT}/_erc_context.md`) ? fs.readFileSync(`${OUT}/_erc_context.md`, 'utf8') : '';
const byUid: Record<string, ResearchTask> = Object.fromEntries(TASKS.map((t) => [t.uid, t]));

const PROVIDERS = [
  { name: 'groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', key: () => process.env.GROQ_API_KEY, model: 'llama-3.3-70b-versatile' },
  { name: 'cerebras', endpoint: 'https://api.cerebras.ai/v1/chat/completions', key: () => process.env.CEREBRAS_API_KEY, model: 'llama3.1-8b' },
  { name: 'fireworks', endpoint: 'https://api.fireworks.ai/inference/v1/chat/completions', key: () => process.env.FIREWORKS_API_KEY, model: 'accounts/fireworks/models/kimi-k2p5' },
];

async function freeComplete(prompt: string, maxTokens = 1500): Promise<{ ok: boolean; text?: string; provider?: string; error?: string }> {
  for (const p of PROVIDERS) {
    const k = p.key()?.trim();
    if (!k) continue;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const res = await fetch(p.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` },
        body: JSON.stringify({ model: p.model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0.4 }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) { console.warn(`  [${p.name}] HTTP ${res.status}; fallthrough`); continue; }
      const d: any = await res.json();
      const text = d?.choices?.[0]?.message?.content ?? d?.choices?.[0]?.message?.reasoning_content ?? '';
      if (!text.trim()) { console.warn(`  [${p.name}] empty; fallthrough`); continue; }
      return { ok: true, text, provider: p.name };
    } catch (e: any) {
      clearTimeout(timer);
      console.warn(`  [${p.name}] ${e?.message ?? e}; fallthrough`);
    }
  }
  return { ok: false, error: 'all free providers failed' };
}

async function exec(uid: string) {
  const task = byUid[uid];
  if (!task) return { uid, ok: false, error: 'unknown uid' };
  await db.from('agent_research_queue').update({ status: 'in_progress', claimed_at: new Date().toISOString() }).eq('task_uid', uid);
  let ctx = '';
  if (task.web) ctx += `\n\n--- ERC RESEARCH CONTEXT (use this; do not invent) ---\n${ERC}\n`;
  for (const dep of task.deps ?? []) {
    const f = byUid[dep]?.outFile;
    if (f && fs.existsSync(f)) ctx += `\n\n--- INPUT FROM ${dep} ---\n${fs.readFileSync(f, 'utf8').slice(0, 3500)}\n`;
  }
  const r = await freeComplete(task.prompt + ctx, 1600);
  const body = r.ok ? r.text! : `(LLM unavailable: ${r.error})`;
  const header = `# ${task.agent} — ${task.uid}\n_Track ${task.track} (${task.track_name}) · ${task.type} · ${new Date().toISOString()} · provider: ${r.provider ?? 'none'}_\n\n`;
  fs.writeFileSync(task.outFile, header + body + '\n');
  let verdict: string | null = null;
  if (task.type === 'verify') {
    const m = body.match(/verdict\s*[:=]?\s*\*{0,2}\s*(agree|partial_agree|disagree)/i);
    if (m) verdict = m[1].toLowerCase();
  }
  await db.from('agent_research_queue').update({
    status: r.ok ? 'complete' : 'failed',
    completed_at: new Date().toISOString(),
    output_summary: body.slice(0, 280).replace(/\s+/g, ' '),
    cross_validation_verdict: verdict,
    llm_provider_used: r.provider ?? null,
  }).eq('task_uid', uid);
  console.log(`${r.ok ? 'OK ' : 'ERR'} ${uid} via ${r.provider ?? '-'} ${body.length}c${verdict ? ' verdict=' + verdict : ''}`);
  return { uid, ok: r.ok, provider: r.provider, chars: body.length, verdict };
}

(async () => {
  // Seed (idempotent).
  const seedRows = TASKS.map((t) => ({
    task_uid: t.uid, track_number: t.track, track_name: t.track_name, task_type: t.type,
    assigned_agent_name: t.agent, assigned_agent_id: t.agentId, paired_with_task_uid: t.paired ?? null,
    task_prompt: t.prompt, expected_output_format: 'markdown', output_file_path: t.outFile, status: 'pending',
  }));
  const { error: seedErr } = await db.from('agent_research_queue').upsert(seedRows, { onConflict: 'task_uid', ignoreDuplicates: true });
  if (seedErr) console.error('seed error:', seedErr.message);
  console.log(`seeded ${seedRows.length} tasks; waves ${WAVE_1.length}/${WAVE_2.length}/${WAVE_3.length}`);

  console.log('\n== WAVE 1 (research, parallel) ==');
  await Promise.allSettled(WAVE_1.map(exec));
  console.log('\n== WAVE 2 (verify, parallel) ==');
  await Promise.allSettled(WAVE_2.map(exec));
  console.log('\n== WAVE 3 (synthesis) ==');
  await Promise.allSettled(WAVE_3.map(exec));

  const { data: rows } = await db.from('agent_research_queue').select('status, cross_validation_verdict, task_type').like('task_uid', '2026-05-23_%');
  const counts: Record<string, number> = {};
  (rows ?? []).forEach((r: any) => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const verdicts = (rows ?? []).filter((r: any) => r.cross_validation_verdict).map((r: any) => r.cross_validation_verdict);
  console.log('\n== DONE ==', JSON.stringify(counts), 'verdicts:', JSON.stringify(verdicts));
  process.exit(0);
})();
