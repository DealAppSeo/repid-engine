/**
 * repid-decay-apply-gate.test.ts
 *
 * `run-repid-decay.ts` walks every active agent and lowers scores. It was left
 * OPERATOR-RUN on purpose — its own header says "designed cron-ready but NOT
 * auto-deployed". Promoting it to a Railway cron means the write decision is now
 * made by configuration rather than by a human typing `--apply`, so the parse of
 * that decision is the safety property.
 *
 * DRY-RUN must remain the default under every ambiguous input.
 */

import { shouldApply } from '../scripts/run-repid-decay';

describe('shouldApply — dry-run is the default', () => {
  it('defaults to DRY-RUN with no flag and no env', () => {
    expect(shouldApply([], {})).toBe(false);
  });

  it('honours the operator --apply flag', () => {
    expect(shouldApply(['node', 'x', '--apply'], {})).toBe(true);
  });

  it('honours REPID_DECAY_APPLY=true for the cron', () => {
    expect(shouldApply([], { REPID_DECAY_APPLY: 'true' })).toBe(true);
  });
});

describe('only the exact string enables writes', () => {
  // A half-recognised truthy value is how an ambiguous flag becomes an
  // unintended mutation of 104 agents' scores.
  it('refuses every near-miss', () => {
    for (const v of ['1', 'yes', 'YES', 'True', 'TRUE', ' true', 'true ', 'on', '']) {
      expect(shouldApply([], { REPID_DECAY_APPLY: v })).toBe(false);
    }
  });

  it('refuses an unset and an undefined env', () => {
    expect(shouldApply([], {})).toBe(false);
    expect(shouldApply([], { REPID_DECAY_APPLY: undefined })).toBe(false);
  });

  it('a false-y env cannot be overridden into truth by a similar flag', () => {
    // --dry-run, --applyx etc must not be mistaken for --apply
    expect(shouldApply(['--applyx'], {})).toBe(false);
    expect(shouldApply(['--dry-run'], { REPID_DECAY_APPLY: 'false' })).toBe(false);
  });
});

describe('flag and env compose safely', () => {
  it('the explicit flag wins even when env says false', () => {
    // An operator running it by hand with --apply meant it.
    expect(shouldApply(['--apply'], { REPID_DECAY_APPLY: 'false' })).toBe(true);
  });

  it('env alone is sufficient for the cron, no flag needed', () => {
    expect(shouldApply(['node', 'run-repid-decay.ts'], { REPID_DECAY_APPLY: 'true' })).toBe(true);
  });
});
