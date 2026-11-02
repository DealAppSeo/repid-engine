/**
 * TrustBadge — spec §10.
 *
 * This is the only artifact that leaves the building. A manifest is read by
 * someone who already found us; a badge is seen by someone who has not, on
 * somebody else's site, with no context. So the tests are mostly about what it
 * must never claim, and about the case a fraud would most want: a beautiful
 * badge backed by one job and no stake.
 */

import {
  toBadgeData,
  renderBadgeSvg,
  renderEmbedSnippets,
  esc,
} from '../src/services/trust-badge';
import { buildTrackRecord, type ProviderTrust } from '../src/services/service-manifest';

function trust(over: Partial<ProviderTrust> = {}): ProviderTrust {
  return {
    agent_id: 'agent-1',
    agent_name: 'trinity-orch',
    repid: 1611,
    tier: 'ESTABLISHED',
    erc8004_token_id: '6705',
    stake_at_risk_usdc: null,
    stake_status: 'none_recorded',
    stake_note: 'No stake recorded.',
    track_record: buildTrackRecord(0, 0),
    sample_receipt: null,
    caveats: [],
    ...over,
  };
}

// ===========================================================================
describe('the badge never publishes a bare percentage (§10)', () => {
  it('carries the denominator in the visible string', () => {
    const d = toBadgeData(trust({ track_record: buildTrackRecord(412, 3) }));
    expect(d.track_record).toContain('412 settled jobs');
    expect(d.track_record).toContain('3 disputes');
    const svg = renderBadgeSvg(d);
    expect(svg).toContain('412 settled jobs');
  });

  it('says "no jobs yet" rather than showing 0% or nothing', () => {
    const d = toBadgeData(trust());
    expect(d.track_record).toBe('No completed jobs yet.');
    expect(renderBadgeSvg(d)).toContain('No completed jobs yet');
  });
});

// ===========================================================================
describe('the case a fraud would want: perfect record, one job, no stake', () => {
  const d = () => toBadgeData(trust({ track_record: buildTrackRecord(1, 0) }));

  it('still says 100% — but never without the warning attached', () => {
    expect(d().verified_rate).toBe(100);
    expect(d().track_record).toMatch(/too few jobs/);
    expect(renderBadgeSvg(d())).toMatch(/too few jobs/);
  });

  it('renders CAUTIOUS colour, not the endorsement colour', () => {
    // Green reads as an endorsement. One job has not earned one.
    const svg = renderBadgeSvg(d());
    expect(svg).toContain('#d97706'); // amber
    expect(svg).not.toContain('#16a34a'); // green
  });

  it('only goes green with a real sample AND stake behind it', () => {
    const good = toBadgeData(
      trust({ track_record: buildTrackRecord(412, 3), stake_at_risk_usdc: 50, stake_status: 'recorded' }),
    );
    expect(renderBadgeSvg(good)).toContain('#16a34a');
  });

  it('stays cautious on a big record with NO stake', () => {
    const noStake = toBadgeData(trust({ track_record: buildTrackRecord(412, 3) }));
    expect(renderBadgeSvg(noStake)).toContain('#d97706');
  });
});

// ===========================================================================
describe('stake-at-risk is shown even when it is absent (§11)', () => {
  it('says "no stake at risk" rather than omitting the row', () => {
    const d = toBadgeData(trust());
    expect(d.stake_label).toBe('no stake at risk');
    expect(renderBadgeSvg(d)).toContain('no stake at risk');
  });

  it('shows the amount when there is one', () => {
    const d = toBadgeData(trust({ stake_at_risk_usdc: 50, stake_status: 'recorded' }));
    expect(d.stake_label).toBe('$50.00 at risk');
    expect(renderBadgeSvg(d)).toContain('$50.00 at risk');
  });
});

// ===========================================================================
describe('the badge links back — to a record that actually exists', () => {
  // Live 2026-11-02: trustmarket.dev/agent/<id> was a 404 and trustmarket.dev/ a
  // "Coming Soon" page, so every badge's link was dead. The link must point at the
  // badge's own public record, which we serve and which needs no key.
  const BASE = 'https://repid-engine-production.up.railway.app';
  const REC = `${BASE}/api/v1/badge/agent-1.json`;

  it('points at the badge own public record, not a trustmarket.dev page that does not exist', () => {
    const u = toBadgeData(trust()).verify_url;
    expect(u).toBe(REC);
    expect(u).not.toContain('trustmarket.dev');
    expect(u).not.toContain('/agent/');
  });

  it('every embed snippet wraps the image in that link', () => {
    const s = renderEmbedSnippets(toBadgeData(trust()));
    expect(s.markdown).toContain(`](${REC})`);
    expect(s.html).toContain(`<a href="${REC}">`);
    expect(s.html_compact).toContain(`<a href="${REC}">`);
    expect(s.url_json).toBe(REC);
  });

  it('offers a compact variant, since a README badge is one line', () => {
    const s = renderEmbedSnippets(toBadgeData(trust()));
    expect(s.markdown).toContain('variant=compact');
  });
});

// ===========================================================================
describe('the footer claims only what the linked record holds', () => {
  const withReceipt = () =>
    toBadgeData(
      trust({
        track_record: buildTrackRecord(412, 3),
        sample_receipt: { contract_id: 'r1', settled_at: null, url: 'https://x/api/v1/receipt/r1.json' },
      }),
    );

  it('never says "every claim links to a receipt" — the record offers ONE sample receipt', () => {
    for (const d of [withReceipt(), toBadgeData(trust())]) {
      const svg = renderBadgeSvg(d);
      expect(svg).not.toMatch(/every claim/i);
      expect(svg).not.toMatch(/verify at trustmarket\.dev/i);
    }
  });

  it('names a sample receipt only when the record has one', () => {
    expect(withReceipt().receipt_url).not.toBeNull();
    expect(renderBadgeSvg(withReceipt())).toContain('record: denominator, caveats, a sample receipt');
    expect(toBadgeData(trust()).receipt_url).toBeNull();
    const none = renderBadgeSvg(toBadgeData(trust()));
    expect(none).toContain('record: denominator, caveats<');
    expect(none).not.toContain('sample receipt');
  });

  it('fits the 300px minimum width the footer is drawn in (10px, ~0.58em per char)', () => {
    const footer = /<text[^>]*font-size="10"[^>]*>([^<]*)<\/text>/.exec(renderBadgeSvg(withReceipt()))![1];
    expect(Math.ceil(footer.length * 10 * 0.58) + 32).toBeLessThanOrEqual(300);
  });
});

// ===========================================================================
describe('markup safety — agent names are user-controlled', () => {
  it('escapes a name that tries to break out of the SVG', () => {
    const d = toBadgeData(trust({ agent_name: '"><script>alert(1)</script>' }));
    const svg = renderBadgeSvg(d);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('escapes the five XML-significant characters', () => {
    expect(esc(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });

  it('escapes inside the compact variant too', () => {
    const d = toBadgeData(trust({ agent_name: '<b>x</b>' }));
    expect(renderBadgeSvg(d, 'compact')).not.toContain('<b>');
  });
});

// ===========================================================================
describe('self-contained SVG', () => {
  it('has no external font, image, script or stylesheet', () => {
    const svg = renderBadgeSvg(toBadgeData(trust({ track_record: buildTrackRecord(20, 0) })));
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/<image/i);
    expect(svg).not.toMatch(/@import/i);
    expect(svg).not.toMatch(/xlink:href/i);
    // The SVG namespace is a bare identifier, never fetched — so strip it before
    // asserting no URL remains. Anything else that looks like a URL would be a
    // resource load, and a badge that reaches out is a badge a CSP will break.
    const withoutNamespace = svg.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '');
    expect(withoutNamespace).not.toMatch(/https?:\/\//i);
  });

  it('carries a <title> so it is legible to a screen reader', () => {
    expect(renderBadgeSvg(toBadgeData(trust()))).toContain('<title>');
  });
});
