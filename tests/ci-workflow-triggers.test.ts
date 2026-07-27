/**
 * Pins the CI trigger surface open for STACKED pull requests.
 *
 * Why this test exists (2026-07-27): `ci.yml` and `crosscheck.yml` both declared
 *   on:
 *     pull_request:
 *       branches: [main]
 * which means GitHub only dispatches them for a PR whose BASE is `main`. A stacked
 * PR — base = another feature branch — matched nothing, so `test` and `crosscheck`
 * never ran on it. PR #210 (base `feat/cc-2026-07-27-pcr-p2-retrieval`) carried a
 * green tick from `gitleaks` alone, with its tests never executed by CI even once.
 * A reviewer reading "checks passed" was reading a secret scan.
 *
 * Removing the filter fixes it, and this test stops it silently coming back — a
 * one-line YAML edit is precisely the kind of change that gets re-added during an
 * unrelated cleanup ("scope the trigger, save CI minutes") with no test to object.
 *
 * NON-VACUITY IS THE WHOLE PROBLEM HERE. A hand-rolled YAML reader that simply
 * fails to find `branches:` anywhere would make every assertion below pass while
 * proving nothing — the same species of defect the test is guarding against. So
 * the reader is pinned three ways:
 *   1. against a synthetic fixture that DOES restrict `pull_request` (must detect it),
 *   2. against the real `push:` trigger, which legitimately keeps `branches: [main]`
 *      (so we prove the reader sees a real filter in the real files), and
 *   3. by asserting the `pull_request` key is PRESENT (not merely unrestricted —
 *      deleting the trigger entirely would otherwise read as a pass).
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows');

/** Workflows that must run on every PR regardless of base branch. */
const PR_GATES = ['ci.yml', 'crosscheck.yml'] as const;

interface TriggerInfo {
  /** the event key appears under `on:` at all */
  present: boolean;
  /** the event declares a `branches:` filter */
  hasBranchFilter: boolean;
  /** raw value of that filter, for message quality */
  branchFilter: string | null;
}

/**
 * Minimal, deliberately narrow reader for the `on:` block of a GitHub workflow.
 *
 * Not a general YAML parser and not trying to be: it walks the `on:` mapping by
 * indentation and reports, for one event key, whether a `branches:` filter is
 * declared beneath it. Handles the two forms these files use — a flow sequence
 * (`branches: [main]`) and a block sequence (`branches:` / `  - main`). Comment
 * and blank lines are skipped; a `#` comment mentioning "branches" is not a filter.
 */
export function readTrigger(yaml: string, event: string): TriggerInfo {
  const lines = yaml.split(/\r?\n/);

  // Locate the top-level `on:` key (column 0). Bare `on:` only — the `on: [push]`
  // flow form is not used here and would need different handling, so we do not
  // pretend to support it.
  let i = lines.findIndex((l) => /^on:\s*(#.*)?$/.test(l));
  if (i === -1) return { present: false, hasBranchFilter: false, branchFilter: null };

  let eventIndent: number | null = null;
  let found = false;
  let hasBranchFilter = false;
  let branchFilter: string | null = null;

  for (i = i + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    if (/^\s*(#.*)?$/.test(line)) continue; // blank or comment-only

    const indent = line.length - line.trimStart().length;
    if (indent === 0) break; // dedented back to a top-level key → `on:` block is over

    const trimmed = line.trim();

    if (eventIndent === null || indent <= eventIndent) {
      // a sibling event key (e.g. `push:`) — stop if we already had our event
      if (found) break;
      if (trimmed === `${event}:` || trimmed.startsWith(`${event}:`)) {
        found = true;
        eventIndent = indent;
      } else if (eventIndent === null) {
        eventIndent = indent; // first event key sets the sibling depth
      }
      continue;
    }

    // strictly more indented than our event key → a property of it
    if (found) {
      const m = /^branches:\s*(.*)$/.exec(trimmed);
      if (m) {
        hasBranchFilter = true;
        const inline = (m[1] ?? '').trim();
        if (inline) {
          branchFilter = inline;
        } else {
          // block sequence: collect the following `- item` lines
          const items: string[] = [];
          for (let j = i + 1; j < lines.length; j++) {
            const next = lines[j];
            if (next === undefined) break;
            if (/^\s*(#.*)?$/.test(next)) continue;
            const nIndent = next.length - next.trimStart().length;
            if (nIndent <= indent || !next.trim().startsWith('- ')) break;
            items.push(next.trim().slice(2).trim());
          }
          branchFilter = `[${items.join(', ')}]`;
        }
      }
    }
  }

  return { present: found, hasBranchFilter, branchFilter };
}

describe('readTrigger — the reader itself, before it is trusted (non-vacuity)', () => {
  const RESTRICTED = [
    'name: X',
    '',
    'on:',
    '  pull_request:',
    '    branches: [main]',
    '  push:',
    '    branches: [main]',
    '',
    'jobs: {}',
  ].join('\n');

  it('DETECTS a pull_request branch filter in flow form', () => {
    const t = readTrigger(RESTRICTED, 'pull_request');
    expect(t.present).toBe(true);
    expect(t.hasBranchFilter).toBe(true);
    expect(t.branchFilter).toBe('[main]');
  });

  it('DETECTS a pull_request branch filter in block-sequence form', () => {
    const yaml = ['on:', '  pull_request:', '    branches:', '      - main', '      - release', 'jobs: {}'].join('\n');
    const t = readTrigger(yaml, 'pull_request');
    expect(t.hasBranchFilter).toBe(true);
    expect(t.branchFilter).toBe('[main, release]');
  });

  it('reports an unrestricted pull_request as present-but-unfiltered', () => {
    const yaml = ['on:', '  pull_request:', '  push:', '    branches: [main]', 'jobs: {}'].join('\n');
    const t = readTrigger(yaml, 'pull_request');
    expect(t.present).toBe(true);
    expect(t.hasBranchFilter).toBe(false);
  });

  it('does not attribute a SIBLING event’s filter to pull_request', () => {
    // The bug this guards: naive scanning finds `branches:` under `push:` and
    // wrongly reports pull_request as filtered (or vice versa).
    const yaml = ['on:', '  pull_request:', '  push:', '    branches: [main]', 'jobs: {}'].join('\n');
    expect(readTrigger(yaml, 'pull_request').hasBranchFilter).toBe(false);
    expect(readTrigger(yaml, 'push').hasBranchFilter).toBe(true);
  });

  it('reports a missing event as absent', () => {
    const yaml = ['on:', '  push:', '    branches: [main]', 'jobs: {}'].join('\n');
    expect(readTrigger(yaml, 'pull_request').present).toBe(false);
  });

  it('ignores a comment that merely mentions branches', () => {
    const yaml = ['on:', '  pull_request:', '    # branches: [main]  <- deliberately not set', 'jobs: {}'].join('\n');
    const t = readTrigger(yaml, 'pull_request');
    expect(t.present).toBe(true);
    expect(t.hasBranchFilter).toBe(false);
  });
});

describe('CI PR gates must run on every PR, including stacked ones', () => {
  for (const file of PR_GATES) {
    describe(file, () => {
      const yaml = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');

      it('declares a pull_request trigger', () => {
        // Deleting the trigger would leave "no branch filter" trivially true.
        expect(readTrigger(yaml, 'pull_request').present).toBe(true);
      });

      it('does NOT restrict pull_request to specific base branches', () => {
        const t = readTrigger(yaml, 'pull_request');
        expect(t.hasBranchFilter).toBe(false);
        // If this fails, the filter value is in the message:
        expect(t.branchFilter).toBeNull();
      });

      it('still keeps push scoped to main (proves the reader sees real filters here)', () => {
        // This is the load-bearing non-vacuity assertion against the REAL file:
        // a reader that could not find `branches:` in this document would fail here.
        const t = readTrigger(yaml, 'push');
        expect(t.present).toBe(true);
        expect(t.hasBranchFilter).toBe(true);
        expect(t.branchFilter).toBe('[main]');
      });
    });
  }
});

// Throwaway commit to prove the widened trigger fires on a STACKED PR.
// This branch and its PR are deleted immediately after the observation.
