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

const here = dirname(fileURLToPath(import.meta.url));
const lessonsPath = join(here, '..', '..', 'LESSONS.md');

let lessons = '';
try {
  lessons = readFileSync(lessonsPath, 'utf8');
} catch {
  process.exit(0); // no LESSONS.md → start the session anyway
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        'Shared operating rules for this repo (LESSONS.md) — these are injected, not ' +
        'optional; read them before working. Domain detail is appended per-task from ' +
        '`lessons/` during agent dispatch.\n\n' +
        lessons,
    },
  }),
);
