#!/usr/bin/env ts-node
/**
 * Is the T12 supervisor really running? Asks GitHub, not the supervisor. No token needed on a public repo.
 *
 *   npx ts-node --transpile-only scripts/t12/missed-run.ts --armed true|false [--repo owner/name] [--workflow file.yml] [--max-age-min 150]
 *
 * Exit: 0 OK or NOT_ARMED, 1 MISSED or FAILING, 2 NOT_CHECKED.
 */
import { judgeRuns, type RunRow } from '../../src/orchestration/t12-missed-run';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function readRuns(repo: string, workflow: string): Promise<RunRow[] | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?per_page=20`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 't12-missed-run' },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 404) return [];
    if (!res.ok) return null;
    return ((await res.json()) as { workflow_runs: RunRow[] }).workflow_runs;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const armed = arg('armed');
  if (armed !== 'true' && armed !== 'false') {
    process.stderr.write('--armed must be true or false\n');
    process.exit(2);
  }
  const report = judgeRuns(await readRuns(arg('repo') ?? 'DealAppSeo/repid-engine', arg('workflow') ?? 't12-supervisor.yml'), Date.now(), Number(arg('max-age-min') ?? 150), armed === 'true');
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(report.exit);
}

void main();
