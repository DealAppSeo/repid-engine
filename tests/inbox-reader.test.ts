/**
 * The ai_dispatch reader's claim/reply/release algebra (2026-08-27).
 *
 * WHAT THESE TESTS ARE FOR. The reader's whole value is that it cannot produce
 * a dishonest read receipt. Every assertion below exists because a specific way
 * of getting that wrong is cheap to write and invisible afterwards:
 *
 *   - marking read without a reply       -> turns an honest zero into a fake 100%
 *   - filtering on `status` instead of   -> silently skips the mislabelled rows,
 *     `read_at`                             which are the ones worth answering
 *   - a non-atomic claim                 -> two runners answer the same message
 *   - a placeholder reply                -> a promise the system cannot keep
 *
 * The load-bearing ones are `read_at is written only alongside a reply` and
 * `a released claim restores the row exactly`. If either regresses, the reader
 * starts lying in the same shape as the table it reads.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require('../scripts/dispatch/inbox-lib.js');

const ROW = { id: 42, subject: 'status please #fleet', content: 'body', status: 'unread' };

describe('unread is read_at, never status', () => {
  it('claims guard on the OBSERVED status, whatever it is', () => {
    // The table contains rows labelled 'read' that were never read and never
    // answered. The reader must be able to claim those too, so the claim cannot
    // hard-code status='unread'.
    for (const observed of ['unread', 'read', 'pending', null]) {
      const p = lib.claimPatch({ ...ROW, status: observed }, 'runner-1');
      expect(p.filter.status).toBe(observed ?? null);
      expect(p.filter.id).toBe(42);
    }
  });

  it('the claim SWAPS status rather than setting a flag', () => {
    // Atomicity depends on this. Guarding on read_at IS NULL alone would let two
    // runners both match and both proceed; swapping the observed value means the
    // second runner's WHERE no longer matches.
    const p = lib.claimPatch(ROW, 'runner-1');
    expect(p.body.status).toBe(p.token);
    expect(p.token).not.toBe(ROW.status);
    expect(p.token).toContain('runner-1');
  });

  it('two runners produce different claim tokens', () => {
    const a = lib.claimPatch(ROW, 'runner-a').token;
    const b = lib.claimPatch(ROW, 'runner-b').token;
    expect(a).not.toBe(b);
  });
});

describe('read_at is written ONLY together with a reply', () => {
  it('the reply patch sets read_at, reply, reply_at and reply_from in one write', () => {
    const now = '2026-08-27T12:00:00.000Z';
    const p = lib.replyPatch(ROW, 'claiming:r1', 'a real answer', 'r1', now);
    expect(p.body.read_at).toBe(now);
    expect(p.body.reply).toBe('a real answer');
    expect(p.body.reply_at).toBe(now);
    expect(p.body.reply_from).toBe('r1');
    // read_at and reply_at must be the same instant: they describe one event.
    expect(p.body.read_at).toBe(p.body.reply_at);
  });

  it('NO patch the reader can emit sets read_at without a reply', () => {
    // THE LOAD-BEARING ASSERTION. Enumerate every patch shape and prove none of
    // them can stamp a read receipt on an unanswered message.
    const patches = [
      lib.claimPatch(ROW, 'r1').body,
      lib.releasePatch(ROW, 'claiming:r1').body,
    ];
    for (const body of patches) {
      expect(body.read_at).toBeUndefined();
    }
    const replyBody = lib.replyPatch(ROW, 'claiming:r1', 'answer', 'r1', '2026-08-27T12:00:00.000Z').body;
    expect(replyBody.read_at).toBeDefined();
    expect(replyBody.reply).toBeTruthy();
  });

  it('the reply patch is guarded by the claim token, so a lost race cannot overwrite', () => {
    const p = lib.replyPatch(ROW, 'claiming:r1', 'answer', 'r1', '2026-08-27T12:00:00.000Z');
    expect(p.filter.status).toBe('claiming:r1');
  });
});

describe('releasing a claim restores the row exactly', () => {
  it.each([['unread'], ['read'], ['pending']])('restores status %s', (observed) => {
    const row = { ...ROW, status: observed };
    const rel = lib.releasePatch(row, 'claiming:r1');
    expect(rel.body.status).toBe(observed);
    expect(rel.body.read_at).toBeUndefined();
    expect(rel.body.reply).toBeUndefined();
  });

  it('release is guarded by the token, so it cannot clobber another runner', () => {
    const rel = lib.releasePatch(ROW, 'claiming:r1');
    expect(rel.filter.status).toBe('claiming:r1');
  });
});

describe('routing', () => {
  it('prefers the subject over the body', () => {
    // A tag quoted inside a longer message must not hijack routing.
    const row = { subject: 'please #fleet', content: 'I once wrote #research about this' };
    expect(lib.detectTag(row)).toBe('fleet');
  });

  it('falls back to the body when the subject has no tag', () => {
    expect(lib.detectTag({ subject: 'no tag here', content: 'do a #fleet check' })).toBe('fleet');
  });

  it('returns null when there is no tag at all', () => {
    expect(lib.detectTag({ subject: 'hello', content: 'no tags' })).toBeNull();
  });

  it('is case-insensitive and normalises to lowercase', () => {
    expect(lib.detectTag({ subject: '#FLEET now', content: '' })).toBe('fleet');
  });

  it('an untagged message is UNHANDLED, not failed and not answered', () => {
    const plan = lib.planFor({ subject: 'hi', content: 'no tag' }, {});
    expect(plan.outcome).toBe('unhandled');
    expect(plan.reason).toMatch(/no recognised tag/);
  });

  it('a tag with no registered handler is UNHANDLED, never silently answered', () => {
    // "Never add a tag without a reader for it." A tag we do not serve must
    // surface as unhandled rather than draw a filler reply.
    const plan = lib.planFor({ subject: 'do #research', content: '' }, { fleet: async () => 'x' });
    expect(plan.outcome).toBe('unhandled');
    expect(plan.reason).toMatch(/no handler registered for #research/);
  });

  it('routes to a registered handler', () => {
    const fleet = async () => 'x';
    const plan = lib.planFor({ subject: '#fleet', content: '' }, { fleet });
    expect(plan.outcome).toBe('handle');
    expect(plan.handler).toBe(fleet);
  });
});

describe('the fleet answer never reports absence as failure', () => {
  const NOW = '2026-08-27T12:00:00.000Z';

  it('no rows is NOT_CHECKED, and says so in words', () => {
    // An empty view means no probe landed — the fleet was not observed. Calling
    // that "down" is the exact collapse of three outcomes into two that put a
    // healthy fleet on a redeploy list for twelve days.
    const out = lib.formatFleetState([], NOW);
    expect(out).toContain('NOT_CHECKED');
    expect(out).toMatch(/NOT that it is down/);
    expect(out).not.toMatch(/\bMEASURED\b/);
  });

  it('formats a real reading with a per-state tally', () => {
    const out = lib.formatFleetState(
      [
        { agent_name: 'a', state: 'idle', evidence: 'loop advancing, no task held', current_task_id: null },
        { agent_name: 'b', state: 'working', evidence: 'loop advancing, task held', current_task_id: 't-1' },
        { agent_name: 'c', state: 'idle', evidence: 'loop advancing, no task held', current_task_id: null },
      ],
      NOW,
    );
    expect(out).toContain('MEASURED');
    expect(out).toContain('2 idle');
    expect(out).toContain('1 working');
    expect(out).toContain('task=t-1');
  });

  it('states that unknown means not observed', () => {
    const out = lib.formatFleetState(
      [{ agent_name: 'a', state: 'unknown', evidence: 'no fresh probe', current_task_id: null }],
      NOW,
    );
    expect(out).toMatch(/never "down"/);
  });
});
