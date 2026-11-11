// TEMPORARY DIAGNOSTIC — removed before merge. Bounded stability check for the regex-budget CPU test,
// run inside a normal jest worker so it sees the same host the old test saw:
//   (1) in-process: whole-process CPU in a 600 ms window BEFORE any regex worker exists (baseline),
//       then after a budget timeout, plus a 4 x 200 ms decay profile — 5 rows;
//   (2) fresh-process: 10 clean runs and 3 intentional-leak controls through the shared helper.
// Readings go straight to stderr so jest's console buffering cannot drop them.
import { matchWithBudget } from '../src/services/regex-budget';
import { measureInFreshProcess } from './helpers/regex-budget-fresh-process';
import os from 'node:os';

const PATTERN = 'a*a*a*a*a*a*a*a*a*b';
const emit = (kind: string, data: unknown) => process.stderr.write(`REGEX_CPU_PROBE ${kind} ${JSON.stringify(data)}\n`);

const win = async (ms: number) => {
  const c0 = process.cpuUsage();
  const w0 = Date.now();
  await new Promise((r) => setTimeout(r, ms));
  const c = process.cpuUsage(c0);
  return { cpuMs: +((c.user + c.system) / 1000).toFixed(1), wallMs: Date.now() - w0 };
};

test('probe: in-process vs fresh-process CPU around a regex budget timeout', async () => {
  emit('host', { platform: process.platform, node: process.version, cpus: os.cpus().length, loadavg: os.loadavg(), pid: process.pid, heapMB: Math.round(process.memoryUsage().heapUsed / 1e6) });
  for (let i = 0; i < 5; i++) {
    const baseline = await win(600);
    const r = await matchWithBudget(PATTERN, 'i', 'a'.repeat(20_000), 200);
    const after = await win(600);
    const decay: number[] = [];
    for (let k = 0; k < 4; k++) decay.push((await win(200)).cpuMs);
    emit('inproc', { i, status: r.status, baseline, after, decay });
  }
  for (let i = 0; i < 10; i++) emit('fresh-clean', { i, ...(await measureInFreshProcess({ leak: false, pattern: PATTERN, subjectLength: 20_000, budgetMs: 200 })) });
  for (let i = 0; i < 3; i++) emit('fresh-leak', { i, ...(await measureInFreshProcess({ leak: true, pattern: PATTERN, subjectLength: 20_000, budgetMs: 200 })) });
}, 600_000);
