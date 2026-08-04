#!/usr/bin/env node
/**
 * lane-report.ts — the CLI that finally CALLS the handoff gate.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR
 * ════════════════════════════════════════════════════════════════════════════════
 * Eight lane reports were graded by a human reading prose, while `evaluateHandoff`
 * sat in `src/orchestration/` with 63 tests and no callers. This is the caller.
 *
 *   # before touching anything, in YOUR checkout
 *   npx jest --config jest.config.js --json --outputFile /tmp/before.json
 *   ts-node scripts/lane-report.ts record before --jest-json /tmp/before.json
 *
 *   # ...do the work, commit it...
 *   npx jest --config jest.config.js --json --outputFile /tmp/after.json
 *   ts-node scripts/lane-report.ts record after --jest-json /tmp/after.json
 *
 *   ts-node scripts/lane-report.ts certify          # prints the runs block + the ruler
 *   ts-node scripts/lane-report.ts grade report.json
 *   # exit 0 advance · 1 hold · 2 could-not-run
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THIS FILE IS A SHELL. THE JUDGEMENT IS NOT IN IT.
 * ════════════════════════════════════════════════════════════════════════════════
 * Every rule lives in `src/orchestration/lane-report-gate.ts` and
 * `src/orchestration/baseline-ledger.ts`, where it is unit-tested in-process in
 * milliseconds. The first attempt at this put the rules HERE and tested them by
 * spawning `npx ts-node` per case; that suite did not finish in ten minutes. A gate
 * that makes the suite unrunnable gets deleted, same as an un-wired gate, just louder.
 *
 * So this file does exactly four things — read files, ask git questions, print, and
 * return an exit code — and `runCli` is exported so a test can drive it in-process
 * without spawning anything.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THE LEDGER LIVES IN THE WORKTREE'S OWN GIT DIR
 * ════════════════════════════════════════════════════════════════════════════════
 * `git rev-parse --absolute-git-dir` resolves to THIS worktree's git directory, not
 * the shared one. That is deliberate and it is the whole point: a checkout with its
 * own `node_modules` is the unit that diverges (294 suites in one, 328 in another), so
 * a baseline must not leak across worktrees. A lane that records `before` in one
 * worktree and `after` in another finds no baseline, which is the correct outcome
 * rather than a silently wrong subtraction. Being inside `.git` also means it can
 * never be committed or picked up by a stray `git add -A`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  certifyDelta,
  collectedSuiteDelta,
  environmentId,
  isCollectedSuite,
  latestRun,
  putRun,
  readLedger,
  summariseJestRun,
  writeLedger,
  type CollectionConfig,
  type Phase,
  type RunMeasurement,
} from '../src/orchestration/baseline-ledger';
import {
  DEFAULT_SPEC_ID,
  EXIT_COULD_NOT_RUN,
  EXIT_HOLD,
  SPECS,
  formatGateResult,
  gradeLaneReport,
} from '../src/orchestration/lane-report-gate';

const LEDGER_FILENAME = 'hyperdag-lane-baselines.json';

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

const consoleIo: CliIo = {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
};

const git = (args: string[]): string =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

/**
 * Read the collection rules out of the jest config jest actually uses.
 *
 * A second hardcoded copy of `roots` would drift and then certify the wrong thing —
 * the same class of bug as a stale generated type file claiming a column that is not
 * there.
 */
export function collectionConfigFromJest(cfg: {
  roots?: unknown;
  testMatch?: unknown;
  testPathIgnorePatterns?: unknown;
}): CollectionConfig {
  const strip = (s: string) => s.replace(/^<rootDir>\//, '').replace(/\\/g, '/');

  const roots = Array.isArray(cfg.roots)
    ? cfg.roots.filter((r): r is string => typeof r === 'string').map(strip)
    : ['tests'];

  const ignorePrefixes = (
    Array.isArray(cfg.testPathIgnorePatterns) ? cfg.testPathIgnorePatterns : []
  )
    .filter((p): p is string => typeof p === 'string' && p.startsWith('<rootDir>/'))
    .map(strip);

  const first = Array.isArray(cfg.testMatch) ? cfg.testMatch[0] : undefined;
  const m = typeof first === 'string' ? /\*\*\/\*(\.[^*]+)$/.exec(first) : null;

  return { roots, ignorePrefixes, suffix: m?.[1] ?? '.test.ts' };
}

interface Env {
  repoRoot: string;
  gitDir: string;
  ledgerPath: string;
  envId: string;
  head: string;
  collection: CollectionConfig;
}

function resolveEnv(): Env {
  const repoRoot = git(['rev-parse', '--show-toplevel']);
  const gitDir = git(['rev-parse', '--absolute-git-dir']);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jestCfg = require(join(repoRoot, 'jest.config.js')) as Record<string, unknown>;
  return {
    repoRoot,
    gitDir,
    ledgerPath: join(gitDir, LEDGER_FILENAME),
    envId: environmentId({
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
      checkoutPath: repoRoot,
    }),
    head: git(['rev-parse', 'HEAD']),
    collection: collectionConfigFromJest(jestCfg),
  };
}

/** Files added / deleted between two commits, as git reports them. */
function changedFiles(from: string, to: string): { added: string[]; deleted: string[] } {
  const out = git(['diff', '--name-status', '--no-renames', from, to]);
  const added: string[] = [];
  const deleted: string[] = [];
  for (const line of out.split('\n')) {
    const parts = line.split('\t');
    const status = parts[0];
    const path = parts[1];
    if (!status || !path) continue;
    if (status.startsWith('A')) added.push(path);
    else if (status.startsWith('D')) deleted.push(path);
  }
  return { added, deleted };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdRecord(argv: string[], io: CliIo): number {
  const phase = argv[1];
  if (phase !== 'before' && phase !== 'after') {
    io.err('usage: lane-report record <before|after> --jest-json <path>');
    return EXIT_COULD_NOT_RUN;
  }
  const jsonPath = flag(argv, '--jest-json');
  if (!jsonPath || !existsSync(jsonPath)) {
    io.err(
      `no jest json at ${jsonPath ?? '(missing --jest-json)'}. Produce it with:\n` +
        '  npx jest --config jest.config.js --json --outputFile <path>',
    );
    return EXIT_COULD_NOT_RUN;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    io.err(`could not parse ${jsonPath}: ${(e as Error).message}`);
    return EXIT_COULD_NOT_RUN;
  }

  const summary = summariseJestRun(raw);
  if (!summary.ok) {
    io.err(summary.error);
    return EXIT_COULD_NOT_RUN;
  }

  const env = resolveEnv();
  const run: RunMeasurement = {
    phase: phase as Phase,
    commit: flag(argv, '--commit') ?? env.head,
    ...summary.value,
    environmentId: env.envId,
    recordedAt: new Date().toISOString(),
  };

  const ledger = readLedger(env.ledgerPath);
  writeLedger(env.ledgerPath, putRun(ledger, run));

  io.out(
    `recorded ${phase}: ${run.suites} suites, ${run.passedTests}/${run.tests} passing ` +
      `@ ${run.commit.slice(0, 7)} (env ${run.environmentId})`,
  );
  if (!run.complete) {
    io.err('WARNING: that run was interrupted. Its counts are a floor and will not certify.');
  }
  if (phase === 'after') {
    const before = latestRun(ledger, 'before', env.envId);
    if (before && before.commit === run.commit) {
      io.err(
        'WARNING: the after-run is at the same commit as the baseline. Commit your work first — ' +
          'a delta has to be attributable to a recorded change.',
      );
    }
  }
  io.out(`ledger: ${env.ledgerPath}`);
  return 0;
}

function cmdCertify(argv: string[], io: CliIo): number {
  const env = resolveEnv();
  const ledger = readLedger(env.ledgerPath);
  const before = latestRun(ledger, 'before', env.envId);
  const after = latestRun(ledger, 'after', env.envId);

  if (!before || !after) {
    io.err(
      `no ${!before ? 'before' : 'after'}-run recorded for this environment (${env.envId}).\n` +
        'A baseline is per-checkout: record your own, do not borrow one.',
    );
    return EXIT_COULD_NOT_RUN;
  }

  const override = flag(argv, '--expected-suite-delta');
  let expectedSuiteDelta: number;
  if (override !== undefined) {
    expectedSuiteDelta = Number(override);
    if (!Number.isInteger(expectedSuiteDelta)) {
      io.err('--expected-suite-delta must be an integer');
      return EXIT_COULD_NOT_RUN;
    }
  } else {
    try {
      expectedSuiteDelta = collectedSuiteDelta(
        changedFiles(before.commit, after.commit),
        env.collection,
      );
    } catch (e) {
      io.err(`could not diff ${before.commit}..${after.commit}: ${(e as Error).message}`);
      return EXIT_COULD_NOT_RUN;
    }
    // Uncommitted suite files were measured by the after-run but are invisible to the
    // diff, so the counts would disagree for a reason that is not a real divergence.
    const dirty = git(['status', '--porcelain'])
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter((p) => p && isCollectedSuite(p, env.collection));
    if (dirty.length > 0) {
      io.err(
        `WARNING: ${dirty.length} uncommitted test file(s) — the after-run collected them but ` +
          `the diff cannot see them. Commit before certifying: ${dirty.join(', ')}`,
      );
    }
  }

  const cert = certifyDelta(before, after, { expectedSuiteDelta });
  if (!cert.certified) {
    io.err(`REFUSED to certify: ${cert.reason}`);
    return EXIT_HOLD;
  }

  io.out(`delta ${cert.delta.value} on ${cert.delta.corpus}`);
  io.out(`ruler: ${cert.delta.config}`);
  io.out(`caveat: ${cert.note}`);
  io.out('');
  io.out('paste into your report:');
  io.out(
    JSON.stringify(
      { outputs: { delta: cert.delta }, runs: { before, after, expectedSuiteDelta } },
      null,
      2,
    ),
  );
  return 0;
}

function cmdGrade(argv: string[], io: CliIo): number {
  const path = argv[1];
  if (!path) {
    io.err('usage: lane-report grade <report.json> [--spec <id>]');
    return EXIT_COULD_NOT_RUN;
  }
  if (!existsSync(path)) {
    io.err(`no report at ${path}`);
    return EXIT_COULD_NOT_RUN;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    io.err(`could not parse ${path}: ${(e as Error).message}`);
    return EXIT_COULD_NOT_RUN;
  }

  const specId = flag(argv, '--spec');
  const result = gradeLaneReport(raw, specId ? { specId } : {});
  (result.exit === 0 ? io.out : io.err)(formatGateResult(result));
  return result.exit;
}

function cmdSpec(argv: string[], io: CliIo): number {
  const spec = SPECS[argv[1] ?? DEFAULT_SPEC_ID];
  if (!spec) {
    io.err(`unknown spec. Known: ${Object.keys(SPECS).join(', ')}`);
    return EXIT_COULD_NOT_RUN;
  }
  io.out(`${spec.id} — ${spec.description}`);
  io.out(`needs capabilities: ${spec.requiredCapabilities.join(', ')}`);
  io.out(`a co-signer needs:  ${spec.evidenceNeeds.join(', ')}`);
  io.out('required outputs:');
  for (const o of spec.requiredOutputs) io.out(`  ${o.key.padEnd(9)} ${o.kind.padEnd(12)} ${o.description}`);
  if (spec.requireCertifiedDelta) {
    io.out('the delta must be backed by two recorded runs this gate can certify.');
  }
  return 0;
}

const USAGE = [
  'usage: lane-report <command>',
  '',
  '  record <before|after> --jest-json <path> [--commit <sha>]',
  '  certify [--expected-suite-delta <n>]',
  '  grade <report.json> [--spec <id>]',
  '  spec [<id>]',
  '',
  'exit codes: 0 advance · 1 hold · 2 could-not-run',
].join('\n');

export function runCli(argv: string[], io: CliIo = consoleIo): number {
  switch (argv[0]) {
    case 'record':
      return cmdRecord(argv, io);
    case 'certify':
      return cmdCertify(argv, io);
    case 'grade':
      return cmdGrade(argv, io);
    case 'spec':
      return cmdSpec(argv, io);
    default:
      io.err(USAGE);
      return EXIT_COULD_NOT_RUN;
  }
}

if (require.main === module) {
  process.exit(runCli(process.argv.slice(2)));
}
