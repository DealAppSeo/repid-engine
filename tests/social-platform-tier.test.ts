/**
 * The platform publishability tier gate (2026-10-12).
 *
 * `verifyAndQueueDraft` already fails closed against the HAL verdict. This adds a SECOND, narrower
 * gate: only platforms wired to a reviewed publish path (LinkedIn and X) may reach a publishable
 * state. TikTok, YouTube, any unlisted/unknown platform, an empty string, and a missing platform
 * are held — fail-closed, so absence lands on the restrictive outcome.
 *
 * The gate is DEMOTE-ONLY. It may only move a status DOWN: a clean verdict on a draft-only platform
 * is held, but a veto is never un-vetoed, a held verdict is never promoted, and a clean verdict on
 * LinkedIn/X still reaches `ready`. The invariant tests below are the load-bearing ones — they are
 * what the mutation checks (recorded in the PR) drive RED when the gate is made to promote.
 */
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
  resolvePlatformTier,
  PUBLISHABLE_STATUSES,
  PUBLISHABLE_PLATFORMS,
} from '../src/services/social-publish-gate';

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

describe('resolvePlatformTier — the pure helper (presence AND absence)', () => {
  it('linkedin → publishable', () => {
    expect(resolvePlatformTier('linkedin').tier).toBe('publishable');
  });

  it('x → publishable', () => {
    expect(resolvePlatformTier('x').tier).toBe('publishable');
  });

  it('twitter → publishable (alias of x)', () => {
    const r = resolvePlatformTier('twitter');
    expect(r.tier).toBe('publishable');
    expect(r.reason).toMatch(/\bx\b/i);
  });

  it('case and surrounding space are normalised', () => {
    expect(resolvePlatformTier('LinkedIn ').tier).toBe('publishable');
    expect(resolvePlatformTier('  X  ').tier).toBe('publishable');
    expect(resolvePlatformTier(' Twitter ').tier).toBe('publishable');
  });

  it('tiktok → draft_only', () => {
    expect(resolvePlatformTier('tiktok').tier).toBe('draft_only');
  });

  it('youtube → draft_only', () => {
    expect(resolvePlatformTier('youtube').tier).toBe('draft_only');
  });

  it('an unknown string → draft_only', () => {
    expect(resolvePlatformTier('mastodon-fork-v3').tier).toBe('draft_only');
  });

  it("'' (empty string) → draft_only — absence is never publishable", () => {
    expect(resolvePlatformTier('').tier).toBe('draft_only');
    expect(resolvePlatformTier('   ').tier).toBe('draft_only');
  });

  it('undefined → draft_only — fail-closed', () => {
    expect(resolvePlatformTier(undefined).tier).toBe('draft_only');
  });

  it('every draft_only resolution carries a reason a human can act on', () => {
    for (const p of ['tiktok', 'youtube', 'unknown-thing', '', undefined] as const) {
      const r = resolvePlatformTier(p);
      expect(r.tier).toBe('draft_only');
      expect(typeof r.reason).toBe('string');
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it('only LinkedIn and X (+ the twitter alias) are publishable — nothing else', () => {
    // Pin the allowlist so a silent widening is a failing test, not a shipped change.
    expect([...PUBLISHABLE_PLATFORMS].sort()).toEqual(['linkedin', 'x']);
  });
});

describe('end-to-end: the tier gate decides the queue state, on a clean HAL verdict', () => {
  const queueCleanOn = async (platform: string | undefined) => {
    evaluate.mockResolvedValue(halReply());
    return verifyAndQueueDraft({ platform: platform as string, content: 'the sky is blue' });
  };

  it('LinkedIn → ready (clean verdict reaches a publishable state)', async () => {
    const r = await queueCleanOn('linkedin');
    expect(r.status).toBe('ready');
    expect(r.platform_tier).toBe('publishable');
    expect(inserted[0].status).toBe('ready');
  });

  it('X → ready', async () => {
    const r = await queueCleanOn('x');
    expect(r.status).toBe('ready');
    expect(r.platform_tier).toBe('publishable');
  });

  it('twitter → ready (alias of x reaches publishable)', async () => {
    const r = await queueCleanOn('twitter');
    expect(r.status).toBe('ready');
    expect(r.platform_tier).toBe('publishable');
  });

  it('TikTok → held, never publishable, even on a clean verdict', async () => {
    const r = await queueCleanOn('tiktok');
    expect(r.status).toBe('needs_review');
    expect(r.platform_tier).toBe('draft_only');
    expect(PUBLISHABLE_STATUSES).not.toContain(r.status as never);
    expect(inserted[0].status).toBe('needs_review');
  });

  it('YouTube → held', async () => {
    const r = await queueCleanOn('youtube');
    expect(r.status).toBe('needs_review');
    expect(r.platform_tier).toBe('draft_only');
    expect(PUBLISHABLE_STATUSES).not.toContain(r.status as never);
  });

  it('an unknown platform → held', async () => {
    const r = await queueCleanOn('some-new-network');
    expect(r.status).toBe('needs_review');
    expect(r.platform_tier).toBe('draft_only');
    expect(PUBLISHABLE_STATUSES).not.toContain(r.status as never);
  });

  it('a missing platform → held (fail-closed)', async () => {
    const r = await queueCleanOn(undefined);
    expect(r.status).toBe('needs_review');
    expect(r.platform_tier).toBe('draft_only');
    expect(PUBLISHABLE_STATUSES).not.toContain(r.status as never);
  });

  it('the demotion reason is folded into the human-readable note', async () => {
    const r = await queueCleanOn('tiktok');
    expect(r.note).toMatch(/held/i);
    expect(r.note).toMatch(/tiktok/i);
    expect(r.note).toMatch(/publishable tier/i);
  });
});

describe('INVARIANTS — the gate only ever moves a status DOWN', () => {
  it('a vetoed verdict stays vetoed on LinkedIn — the gate never un-vetoes', async () => {
    evaluate.mockResolvedValue(halReply({ decision: 'vetoed', hal_score: 0.1 }));
    const r = await verifyAndQueueDraft({ platform: 'linkedin', content: 'a false claim' });
    expect(r.status).toBe('vetoed');
    expect(PUBLISHABLE_STATUSES).not.toContain(r.status as never);
  });

  it('a vetoed verdict stays vetoed on a draft-only platform too', async () => {
    evaluate.mockResolvedValue(halReply({ decision: 'vetoed', hal_score: 0.1 }));
    const r = await verifyAndQueueDraft({ platform: 'tiktok', content: 'a false claim' });
    expect(r.status).toBe('vetoed');
  });

  it('a degraded/needs_review verdict stays held on LinkedIn — the gate never promotes', async () => {
    evaluate.mockResolvedValue(
      halReply({ mode: 'extractor-fallback', degraded_mode: true, degraded_reason: 'quorum unavailable', hal_score: 0.99 }),
    );
    const r = await verifyAndQueueDraft({ platform: 'linkedin', content: 'the sky is blue' });
    expect(r.status).toBe('needs_review');
    expect(r.degraded).toBe(true);
    // The platform gate did not touch this — HAL already held it. The note stays the HAL note.
    expect(r.note).toMatch(/not a verification/i);
  });

  it('a flagged verdict stays held on LinkedIn (publishable platform, held verdict)', async () => {
    evaluate.mockResolvedValue(halReply({ decision: 'flagged' }));
    const r = await verifyAndQueueDraft({ platform: 'linkedin', content: 'a contested claim' });
    expect(r.status).toBe('needs_review');
  });

  it('the gate never RAISES a status: a held verdict on a publishable platform is not promoted', async () => {
    // Exhaustive over the HAL held/block verdicts crossed with a publishable platform. None may
    // come out in a publishable state — the gate is demote-only and cannot invent a promotion.
    for (const decision of ['vetoed', 'flagged', 'abstain']) {
      evaluate.mockResolvedValue(halReply({ decision }));
      const r = await verifyAndQueueDraft({ platform: 'x', content: 'claim' });
      expect(PUBLISHABLE_STATUSES).not.toContain(r.status as never);
    }
  });

  it('the row written to the queue matches the returned demoted status', async () => {
    evaluate.mockResolvedValue(halReply());
    const r = await verifyAndQueueDraft({ platform: 'tiktok', content: 'clean copy' });
    expect(inserted[0].status).toBe(r.status);
    expect(inserted[0].status).toBe('needs_review');
  });
});
