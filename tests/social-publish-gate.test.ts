/**
 * No post leaves the queue unverified (2026-08-28).
 *
 * `social_content_queue` shipped in 2026-04 with a complete publishing schema and no trust
 * columns at all — no author, no verdict, no verified_at — and nothing in either repo ever
 * referenced it. Every row sits in a publishable state; none was ever posted. So the product's
 * central claim, that an agent's output is verified before it ships, had a working
 * counterexample sitting in the same database.
 *
 * WHAT THESE TESTS DO AND DELIBERATELY DO NOT COVER. The real gate is a Postgres CHECK
 * constraint, because application code is the layer a future n8n flow or a hand-run UPDATE
 * routes around. That constraint was proven directly against the database — an unverified row
 * in a publishable state rejected, a vetoed one rejected, a verified one accepted — and a unit
 * test cannot re-prove it without a live connection. What IS tested here is the half that can
 * lie without the database noticing: which status this code CHOOSES for a verdict. If that
 * drifts, the constraint stays happily satisfied while flagged content quietly becomes ready.
 *
 * THE LAST TEST IS THE LOAD-BEARING ONE. It enumerates every decision the HAL response type
 * declares, read from the source, and requires each to resolve somewhere. A fifth outcome added
 * to HAL must not fall through a default into a publishable state — which is exactly what an
 * `if (vetoed) block; else publish` would do.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const inserted: any[] = [];
let nextId = 1;
jest.mock('../src/db', () => ({
  db: {
    from: () => ({
      insert: (row: any) => {
        inserted.push(row);
        return {
          select: () => ({
            single: () => Promise.resolve({ data: { id: nextId++, status: row.status }, error: null }),
          }),
        };
      },
    }),
  },
}));

const evaluate = jest.fn();
jest.mock('../src/hal/service', () => ({ halService: { evaluate: (...a: any[]) => evaluate(...a) } }));

import {
  verifyAndQueueDraft,
  resolveStatus,
  PUBLISHABLE_STATUSES,
  BLOCKING_DECISION,
} from '../src/services/social-publish-gate';

const AGENT = '11111111-2222-4333-8444-555555555555';

const halReply = (over: Record<string, unknown> = {}) => ({
  hal_score: 0.9,
  decision: 'clean',
  mode: 'fact-check',
  strictness: 2,
  product: 'trustshell',
  signals: {},
  latency_ms: 10,
  ...over,
});

beforeEach(() => {
  inserted.length = 0;
  evaluate.mockReset();
});

describe('a verdict decides the queue state', () => {
  it('clean content is queued ready', async () => {
    evaluate.mockResolvedValue(halReply());
    const r = await verifyAndQueueDraft({ platform: 'x', content: 'the sky is blue' });
    expect(r.status).toBe('ready');
    expect(inserted[0].status).toBe('ready');
  });

  it('THE REGRESSION: vetoed content never lands in a publishable state', async () => {
    evaluate.mockResolvedValue(halReply({ decision: 'vetoed', hal_score: 0.1 }));
    const r = await verifyAndQueueDraft({ platform: 'x', content: 'a false claim' });
    expect(r.status).toBe('vetoed');
    expect(PUBLISHABLE_STATUSES).not.toContain(r.status as never);
  });

  it('flagged is held for a human, not blocked and not published', async () => {
    // Three outcomes, never two. `flagged` means "look at this", and resolving it either way
    // would be a lie — as a block it censors, as a pass it publishes something unexamined.
    evaluate.mockResolvedValue(halReply({ decision: 'flagged' }));
    const r = await verifyAndQueueDraft({ platform: 'x', content: 'a contested claim' });
    expect(r.status).toBe('needs_review');
    expect(PUBLISHABLE_STATUSES).not.toContain(r.status as never);
  });

  it('abstain is held too — HAL declining to judge is not a pass', async () => {
    evaluate.mockResolvedValue(halReply({ decision: 'abstain' }));
    expect((await verifyAndQueueDraft({ platform: 'x', content: 'opinion' })).status).toBe('needs_review');
  });

  it('A DEGRADED EVALUATION IS NOT A VERIFICATION, however good the score', async () => {
    // extractor-fallback means strictness 2 was requested and the quorum was NOT available.
    // Publishing on that score while reporting it as verified is the exact fake-pass this
    // whole system exists to prevent, and a high score makes it more tempting, not less.
    evaluate.mockResolvedValue(
      halReply({ mode: 'extractor-fallback', degraded_mode: true, degraded_reason: 'quorum unavailable', hal_score: 0.99 }),
    );
    const r = await verifyAndQueueDraft({ platform: 'x', content: 'the sky is blue' });
    expect(r.status).toBe('needs_review');
    expect(r.degraded).toBe(true);
    expect(r.note).toMatch(/not a verification/i);
  });
});

describe('the row records what actually happened', () => {
  it('the verdict travels with the row, so an approver sees what HAL said', async () => {
    evaluate.mockResolvedValue(halReply({ decision: 'flagged', hal_score: 0.42 }));
    await verifyAndQueueDraft({ platform: 'x', content: 'claim', agentId: AGENT });
    const row = inserted[0];
    expect(row.hal_decision).toBe('flagged');
    expect(row.hal_score).toBe(0.42);
    expect(row.hal_mode).toBe('fact-check');
    expect(typeof row.verified_at).toBe('string');
    expect(row.agent_id).toBe(AGENT);
  });

  it('an ABSENT author stays absent — no placeholder is invented', async () => {
    // The column exists to answer "whose agent published this". A stamped 'unknown' would make
    // it 100% populated and worthless.
    evaluate.mockResolvedValue(halReply());
    await verifyAndQueueDraft({ platform: 'x', content: 'claim' });
    expect(inserted[0].agent_id).toBeUndefined();
  });

  it('the agent id is forwarded to HAL so the quorum calls are attributable', async () => {
    evaluate.mockResolvedValue(halReply());
    await verifyAndQueueDraft({ platform: 'x', content: 'claim', agentId: AGENT });
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ agentId: AGENT, strictness: 2 }));
  });

  it('no agent id means none is sent — not an empty string', async () => {
    evaluate.mockResolvedValue(halReply());
    await verifyAndQueueDraft({ platform: 'x', content: 'claim' });
    expect(evaluate.mock.calls[0][0].agentId).toBeUndefined();
  });
});

describe('the app-side states and the database gate agree', () => {
  it('every decision HAL can return resolves somewhere — none falls through to publishable', () => {
    // THE LOAD-BEARING TEST. Read from the source, so a fifth HAL outcome lands here rather
    // than in production. An unknown verdict must hold, never publish.
    const service = readFileSync(join(__dirname, '..', 'src', 'hal', 'service.ts'), 'utf8');
    const declared = service.match(/decision:\s*((?:'[a-z-]+'\s*\|\s*)*'[a-z-]+')/);
    expect(declared).not.toBeNull();
    const decisions = declared![1]!.split('|').map((s) => s.trim().replace(/'/g, ''));
    expect(decisions.length).toBeGreaterThan(1);

    for (const d of decisions) {
      const status = resolveStatus(d, false);
      expect(typeof status).toBe('string');
      // Only a clean verdict may reach a publishable state.
      if (d !== 'clean') expect(PUBLISHABLE_STATUSES).not.toContain(status as never);
    }
  });

  it('an unknown future verdict holds rather than publishes', () => {
    expect(PUBLISHABLE_STATUSES).not.toContain(resolveStatus('some-new-verdict', false) as never);
  });

  it('a degraded clean is not publishable even though clean is', () => {
    expect(PUBLISHABLE_STATUSES).toContain(resolveStatus('clean', false) as never);
    expect(PUBLISHABLE_STATUSES).not.toContain(resolveStatus('clean', true) as never);
  });

  it('the blocking decision and publishable list match the migration that enforces them', () => {
    // These two constants are the app-side mirror of the DB CHECK. If someone widens the list
    // here without widening the constraint, inserts start failing in production instead of
    // silently publishing — but the reverse edit would be silent, so pin both.
    expect(BLOCKING_DECISION).toBe('vetoed');
    expect([...PUBLISHABLE_STATUSES].sort()).toEqual(['approved', 'posted', 'ready', 'scheduled']);
  });
});
