import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * Measure, in a NEW Node process, what the regex-budget module leaves running after a budget timeout.
 *
 * Why a fresh process: `process.cpuUsage()` is the OS's accounting for the whole process. Inside a
 * jest worker that includes everything the worker ran before (leftover threads, GC of a large heap),
 * which is not evidence about this module. A child that loads only the module measures only it,
 * worker thread included, and the module still cannot fabricate the number.
 *
 * `leak: true` is the control: the child disables `Worker.prototype.terminate` before loading the real
 * module, so the promise resolves and the worker keeps burning a core. The instrument must see it.
 *
 * The PARENT ends the child. After the reading arrives it waits up to `graceMs` for the child to exit
 * on its own (a clean module leaves nothing alive), then SIGKILLs it. A child that never reports is
 * killed at `deadlineMs`. The promise settles only after the child has actually exited, so a leaked
 * worker cannot outlive the test or hang CI.
 */
export interface FreshProcessReading {
  status: string;
  cpuMs: number;
  wallMs: number;
  platform: string;
  node: string;
  cpus: number;
  loadavg1: number;
  /** Did the child exit on its own after reporting, or did the parent have to kill it? */
  exitedOnItsOwn: boolean;
  exit: { code: number | null; signal: string | null };
}

const MODULE = join(__dirname, '../../src/services/regex-budget.ts');

export function measureInFreshProcess(
  opts: { leak: boolean; pattern: string; subjectLength: number; budgetMs: number },
  limits: { graceMs?: number; deadlineMs?: number } = {},
): Promise<FreshProcessReading> {
  const graceMs = limits.graceMs ?? 5_000;
  const deadlineMs = limits.deadlineMs ?? 25_000;
  // ts-node is registered in the script, not with `-r`: a worker inherits the parent's execArgv, and the
  // match worker runs with an empty env, so a preloaded ts-node there wrote its compile cache to
  // ./undefined/temp. A clean execArgv keeps the worker as production runs it.
  const script = `
    require('ts-node').register({ transpileOnly: true });
    ${opts.leak ? "require('worker_threads').Worker.prototype.terminate = function () { return Promise.resolve(0); };" : ''}
    const os = require('os');
    const { matchWithBudget } = require(${JSON.stringify(MODULE)});
    matchWithBudget(${JSON.stringify(opts.pattern)}, 'i', 'a'.repeat(${opts.subjectLength}), ${opts.budgetMs}).then(async (r) => {
      const cpuBefore = process.cpuUsage();
      const wallBefore = Date.now();
      await new Promise((res) => setTimeout(res, 600));
      const cpu = process.cpuUsage(cpuBefore);
      process.stdout.write(JSON.stringify({
        status: r.status, cpuMs: (cpu.user + cpu.system) / 1000, wallMs: Date.now() - wallBefore,
        platform: process.platform, node: process.version, cpus: os.cpus().length, loadavg1: os.loadavg()[0],
      }) + '\\n');
    });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { cwd: join(__dirname, '../..'), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let reading: Omit<FreshProcessReading, 'exitedOnItsOwn' | 'exit'> | undefined;
    let killedByParent = false;
    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) {
        killedByParent = true;
        child.kill('SIGKILL');
      }
    };
    const deadline = setTimeout(kill, deadlineMs);
    let grace: NodeJS.Timeout | undefined;
    child.stdout.on('data', (d) => {
      out += d;
      const nl = out.indexOf('\n');
      if (reading === undefined && nl !== -1) {
        try {
          reading = JSON.parse(out.slice(0, nl));
        } catch (e) {
          kill();
          return;
        }
        grace = setTimeout(kill, graceMs);
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(deadline); clearTimeout(grace); reject(e); });
    child.on('exit', (code, signal) => {
      clearTimeout(deadline);
      clearTimeout(grace);
      if (reading === undefined) {
        reject(new Error(`child exited (code ${code}, signal ${signal}) without a reading: ${err.slice(-500)}`));
        return;
      }
      resolve({ ...reading, exitedOnItsOwn: !killedByParent, exit: { code, signal } });
    });
  });
}
