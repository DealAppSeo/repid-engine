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
describe('the badge links back — that is the whole mechanism', () => {
  it('points at a verify URL', () => {
    expect(toBadgeData(trust()).verify_url).toContain('/agent/agent-1');
  });

  it('every embed snippet wraps the image in that link', () => {
    const s = renderEmbedSnippets(toBadgeData(trust()));
    expect(s.markdown).toContain('/agent/agent-1');
    expect(s.html).toContain('/agent/agent-1');
    expect(s.html_compact).toContain('/agent/agent-1');
  });

  it('offers a compact variant, since a README badge is one line', () => {
    const s = renderEmbedSnippets(toBadgeData(trust()));
    expect(s.markdown).toContain('variant=compact');
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
