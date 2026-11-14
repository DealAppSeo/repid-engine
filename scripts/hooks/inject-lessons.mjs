#!/usr/bin/env node
/**
 * SessionStart hook — inject LESSONS.md into every Claude session.
 *
 * WHY. XC and GA get LESSONS.md via the dispatch preamble (run-agent.mjs). Claude
 * sessions did NOT: CLAUDE.md only said "read LESSONS.md first," a discretionary read
 * a fresh context skips every session. That is why exit-code-covers-the-last-command
 * (§2) and presence-vs-reachability (§7) were both re-learned from lessons already
 * written down. Injecting removes the discretion. Committed in-repo so cloud sessions
 * (which clone fresh and never see ~/.claude) get it too.
 *
 * Fail-open on a read error is deliberate here: a missing LESSONS.md must not block a
 * session from starting. Its absence is loud elsewhere (the dispatcher warns), and a
 * SessionStart hook that aborts the session would be worse than the gap it closes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const lessonsPath = join(here, '..', '..', 'LESSONS.md');

let lessons = '';
try {
  lessons = readFileSync(lessonsPath, 'utf8');
} catch {
  process.exit(0); // no LESSONS.md → start the session anyway
}

// The domain packs (lessons/*.md) are the long-term memory behind LESSONS.md: nothing is
// deleted to fit LESSONS' cap, the detail moves to a pack. Dispatched agents get the
// matching sections injected. A Claude session can open files, so it gets an INDEX of
// every pack and section and opens the one its task needs. Without this a session saw
// only "detail is appended during dispatch" and never knew which lessons existed (2026-11-14).
// Fail-open like the read above: a broken index must not stop a session starting.
let index = '';
try {
  const { loadPacks, packIndex } = createRequire(import.meta.url)('../dispatch/lessons-lib.js');
  const packs = loadPacks(join(here, '..', '..', 'lessons'));
  if (packs.length) {
    index =
      '\n\nDomain lesson packs, the detail behind these rules. Open the one that matches ' +
      'your task before working on it:\n' + packIndex(packs);
  }
} catch {
  index = '';
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        'Shared operating rules for this repo (LESSONS.md) — these are injected, not ' +
        'optional; read them before working. Domain detail is appended per-task from ' +
        '`lessons/` during agent dispatch.\n\n' +
        lessons +
        index,
    },
  }),
);
