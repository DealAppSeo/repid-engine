/**
 * TrustRails CLI — govern a single action from the command line.
 *
 *   npx tsx cli.ts                          # built-in T2 demo (DROP TABLE) → ⛔ exit 1
 *   npx tsx cli.ts examples/t0-local-write.json   # ✅ exit 0
 *   npx tsx cli.ts path/to/your-action.json
 *
 * Exit code: 0 if the action is PERMITTED (ALLOW/PROCEED), 1 if STOPPED — so it drops
 * straight into a pre-commit hook or CI step as a real guard.
 */
import * as fs from 'fs';
import * as path from 'path';
import { guard, isAllowed } from './guard';
import { loadTrustRailsConfig } from './config';
import { fileTraceSink, defaultTracePath } from './trace-sink';
import { type Action } from '../src/services/consequence-classifier';

function loadAction(arg?: string): { action: Action; label: string } {
  if (arg) {
    const p = path.resolve(arg);
    return { action: JSON.parse(fs.readFileSync(p, 'utf8')) as Action, label: p };
  }
  return {
    action: { kind: 'db', sql: 'DROP TABLE repid_agents', paths: ['migrations/0001.sql'], description: 'drop the agents table' },
    label: '(built-in demo: DROP TABLE repid_agents)',
  };
}

function main(): void {
  const arg = process.argv[2];
  const cfg = loadTrustRailsConfig();
  const { action, label } = loadAction(arg);

  const result = guard(action, {
    config: cfg.classifierConfig,
    configVersion: cfg.version,
    humanSignOffTiers: cfg.humanSignOffTiers,
    repoRoot: process.cwd(),
    sink: fileTraceSink(),
  });

  const allowed = isAllowed(result);
  console.log(`\nTrustRails guard — ${label}`);
  console.log(`  tier    : ${result.tier}`);
  console.log(`  verdict : ${result.verdict}  ${allowed ? '✅ permitted' : '⛔ STOPPED — human sign-off / review required'}`);
  console.log(`  reason  : ${result.reason}`);
  if (result.log.rulesFired.length) {
    console.log(`  rules   : ${result.log.rulesFired.map((r) => r.ruleId).join(', ')}`);
  }
  if (result.log.chamber) {
    console.log(`  chamber : ${result.log.chamber.outcome} — objection scored "${result.log.chamber.objectionScore}"`);
  }
  console.log(`  trace   : ${defaultTracePath()}`);
  process.exit(allowed ? 0 : 1);
}

main();
