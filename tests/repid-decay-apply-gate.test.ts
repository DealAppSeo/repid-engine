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

import { shouldApply, applyDecays } from '../scripts/run-repid-decay';

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

describe('applyDecays — each write runs once; the log row only when the decay applied', () => {
  const decay = (id: string, before: number, after: number) => ({
    row: { id, agent_name: `agent-${id}`, current_repid: before } as any,
    r: { decay_amount: before - after, repid_before: before, repid_after: after } as any,
  });
  let warnSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { warnSpy.mockRestore(); errSpy.mockRestore(); });

  it('UPDATE is a compare-and-set on the value read; no write asks for retries', async () => {
    const calls: Array<{ sql: string; params: unknown[]; opts: any }> = [];
    const query: any = async (sql: string, params: unknown[], opts: any) => {
      calls.push({ sql, params, opts });
      return /^\s*UPDATE/.test(sql) ? [{ id: 'a1' }] : [];
    };
    const out = await applyDecays([decay('a1', 500, 480)], query);
    expect(out).toEqual({ applied: 1, changed: 0, failed: [] });
    expect(calls[0]!.sql).toMatch(/AND current_repid = \$3/);
    expect(calls[0]!.params).toEqual([480, 'a1', 500]);
    expect(calls[1]!.sql).toMatch(/INSERT INTO repid_vesting_events/);
    for (const c of calls) {
      expect(c.opts.retries).toBeUndefined();
      expect(c.opts.idempotent).toBeUndefined();
    }
  });

  it('score changed since the read → no update applied, NO log row', async () => {
    const calls: string[] = [];
    const query: any = async (sql: string) => { calls.push(sql); return []; };
    const out = await applyDecays([decay('a1', 500, 480)], query);
    expect(out).toEqual({ applied: 0, changed: 1, failed: [] });
    expect(calls.some((s) => /INSERT/.test(s))).toBe(false);
  });

  it('one agent failing does not stop the rest, and is reported', async () => {
    const query: any = async (sql: string, params: unknown[]) => {
      if (/^\s*UPDATE/.test(sql) && params[1] === 'a1') throw new Error('timeout');
      return /^\s*UPDATE/.test(sql) ? [{ id: params[1] }] : [];
    };
    const out = await applyDecays([decay('a1', 500, 480), decay('a2', 300, 290)], query);
    expect(out).toEqual({ applied: 1, changed: 0, failed: ['agent-a1'] });
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/FAILED for agent-a1 \(a1\): timeout/));
  });
});
