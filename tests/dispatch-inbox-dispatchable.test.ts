/**
 * Every INBOX brief must actually REACH the agent it was written for.
 *
 * THE BUG THIS EXISTS TO PREVENT, measured 2026-08-21
 * ---------------------------------------------------
 * `scripts/dispatch/run-agent.mjs` does not send an INBOX file. It sends
 * `newestInboxEntry(path)`, which returns the slice from the FIRST `## ` heading to
 * the NEXT `## ` heading — because INBOX files were designed as append-a-section-per-
 * task queues, newest on top.
 *
 * Four briefs were written as ordinary documents, with `## ` for every section. So
 * each one dispatched only its opening section and silently discarded the rest:
 *
 *     INBOX_XC.md        8%       INBOX_XC_ZKP.md   6%
 *     INBOX_GA.md        6%       INBOX_GA_ZKP.md   5%
 *
 * XC and GA would have received a preamble with no facts, no deliverables, no
 * acceptance criteria and no fences — and would have answered anyway, because a
 * truncated prompt still reads as a whole prompt. The dispatch would have looked
 * like it worked. Two of the four were already merged when this was found.
 *
 * That is the same shape as the two defects `run-agent.mjs`'s own header records
 * (`--inbox` parsing a path and discarding it; the handoff directory hardcoded to one
 * machine): the flag looks honoured, the work is done on other data. Reading a file
 * and reading what gets SENT are different questions, and only the second one matters.
 *
 * THE RULE: one `## ` heading per brief, everything under it, `###` below that.
 * A future task appended ABOVE it still becomes "newest", so the queue convention is
 * preserved rather than worked around.
 */
import fs from 'fs';
import path from 'path';

const DISPATCH_DIR = path.join(__dirname, '..', 'docs', 'dispatch');

/**
 * Byte-for-byte the extraction in `scripts/dispatch/run-agent.mjs`.
 *
 * Duplicated deliberately: the script is an `.mjs` with side effects at import, so a
 * test cannot import the function. A drift here would make this guard pass while the
 * real dispatch truncates — so if `newestInboxEntry` ever changes, change it here too.
 */
function newestInboxEntry(file: string): string | null {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('## '));
  if (start === -1) return null;
  const next = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start, next === -1 ? undefined : next).join('\n').trim();
}

const briefs = fs.existsSync(DISPATCH_DIR)
  ? fs.readdirSync(DISPATCH_DIR).filter((f) => /^INBOX_.*\.md$/.test(f))
  : [];

describe('dispatch INBOX briefs survive newestInboxEntry()', () => {
  it('finds briefs to check (a silent empty set would make this suite vacuous)', () => {
    expect(briefs.length).toBeGreaterThan(0);
  });

  it.each(briefs)('%s dispatches substantially all of its content', (name) => {
    const file = path.join(DISPATCH_DIR, name);
    const whole = fs.readFileSync(file, 'utf8');
    const sent = newestInboxEntry(file);

    // A brief with no `## ` at all dispatches NOTHING and exits 64 "no task", which
    // reads like an empty queue rather than a malformed file.
    expect(sent).not.toBeNull();

    // 95%, not 100%: the H1 title line and the blank line before the `## ` heading sit
    // outside the extracted slice by construction. Anything materially below this is a
    // brief whose body has been cut off.
    const ratio = (sent as string).length / whole.length;
    expect(ratio).toBeGreaterThan(0.95);
  });

  it.each(briefs)('%s has exactly one "## " heading, so nothing can fall outside it', (name) => {
    const lines = fs.readFileSync(path.join(DISPATCH_DIR, name), 'utf8').split(/\r?\n/);
    const h2 = lines.filter((l) => l.startsWith('## ') && !l.startsWith('### '));
    // Two or more `## ` headings means the SECOND one and everything after it is
    // discarded at dispatch. Use `###` for sections within a brief.
    expect(h2).toHaveLength(1);
  });
});
