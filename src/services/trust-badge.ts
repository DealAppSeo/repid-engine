/**
 * trust-badge.ts — reputation portability AS distribution.
 *
 * Spec: TRUSTMARKET_UX_MERGED_SPEC_v1 §10. A provider embeds this on their own
 * site; every badge links back to receipts on ours. The precedent named in the
 * spec is the SSL seal and the PayPal button — trust marks that spread because
 * the people displaying them wanted to, and that carried the issuer with them.
 *
 * THIS IS THE ONE ARTIFACT THAT LEAVES THE BUILDING. A manifest is read by
 * someone who already found us; a badge is seen by someone who has not. So it is
 * held to a stricter standard than any internal surface:
 *
 *   · IT RENDERS FROM buildProviderTrust, NEVER ITS OWN QUERY. A badge claiming
 *     "99% verified" beside a manifest saying "too few jobs to tell" would be
 *     worse than no badge at all, and it would be discovered by exactly the
 *     skeptic we most need to convince.
 *
 *   · IT SHOWS THE DENOMINATOR, ALWAYS (§10: "412 jobs · 99.2% verified · 3
 *     disputes"). A bare percentage is the number a fraud would choose.
 *
 *   · IT SHOWS STAKE-AT-RISK, INCLUDING WHEN THERE IS NONE. The spec calls stake
 *     the top trust primitive: "they had $X to lose if they lied" beats any
 *     score. When nothing is staked the badge says "no stake" rather than
 *     omitting the row — an absent row reads as an unasked question, and this
 *     one was asked and answered.
 *
 *   · A PROVIDER WITH NO RECORD GETS AN HONEST BADGE, NOT A FLATTERING ONE. New
 *     agents render "no completed jobs yet". We do not withhold the badge (that
 *     would make every visible badge good news and teach people the mark is
 *     meaningless) and we do not dress it up.
 *
 * SVG is deliberately self-contained: no external font, no image, no script, so
 * it renders inside a GitHub README, an OpenGraph card, or a hostile CSP.
 */

import { buildProviderTrust, type ProviderTrust } from './service-manifest';

export type BadgeVariant = 'full' | 'compact';

export interface BadgeData {
  agent_id: string;
  agent_name: string;
  tier: string | null;
  repid: number | null;
  /** Denominatored, per §10. Never a bare rate. */
  track_record: string;
  settled_jobs: number;
  disputed_jobs: number;
  verified_rate: number | null;
  sample_size_warning: boolean;
  stake_at_risk_usdc: number | null;
  stake_label: string;
  /** Where the badge points. The whole mechanism is that it links back. */
  verify_url: string;
  receipt_url: string | null;
  caveats: string[];
}

function publicBase(): string {
  return process.env.PUBLIC_BASE_URL || 'https://repid-engine-production.up.railway.app';
}

function marketBase(): string {
  return process.env.PUBLIC_MARKET_URL || 'https://trustmarket.dev';
}

export function toBadgeData(trust: ProviderTrust): BadgeData {
  const t = trust.track_record;
  const name = trust.agent_name ?? trust.agent_id.slice(0, 8);
  return {
    agent_id: trust.agent_id,
    agent_name: name,
    tier: trust.tier,
    repid: trust.repid,
    track_record: t.summary,
    settled_jobs: t.settled_jobs,
    disputed_jobs: t.disputed_jobs,
    verified_rate: t.verified_rate,
    sample_size_warning: t.sample_size_warning,
    stake_at_risk_usdc: trust.stake_at_risk_usdc,
    stake_label:
      trust.stake_at_risk_usdc != null
        ? `$${trust.stake_at_risk_usdc.toFixed(2)} at risk`
        : 'no stake at risk',
    verify_url: `${marketBase()}/agent/${trust.agent_id}`,
    receipt_url: trust.sample_receipt?.url ?? null,
    caveats: trust.caveats,
  };
}

export async function getBadgeData(agentId: string): Promise<BadgeData | null> {
  const trust = await buildProviderTrust(agentId);
  return trust ? toBadgeData(trust) : null;
}

/** Minimal XML escape. Agent names are user-controlled and land inside markup. */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Rough width for the monospace-ish stack we use. Keeps the box from clipping. */
function textWidth(s: string, size: number): number {
  return Math.ceil(s.length * size * 0.58);
}

/**
 * The embeddable mark.
 *
 * Colour carries meaning and must not overstate: amber (not green) whenever the
 * sample is too small or nothing is staked, because a green badge is read as an
 * endorsement and we have not earned the right to give one on 1 job.
 */
export function renderBadgeSvg(d: BadgeData, variant: BadgeVariant = 'full'): string {
  const cautious = d.sample_size_warning || d.stake_at_risk_usdc == null || d.settled_jobs === 0;
  const accent = cautious ? '#d97706' : '#16a34a';
  const bg = '#0f172a';
  const fg = '#e2e8f0';
  const dim = '#94a3b8';
  const font =
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

  if (variant === 'compact') {
    const label = 'TrustMarket';
    const value =
      d.settled_jobs === 0 ? 'no jobs yet' : `${d.settled_jobs} jobs · ${d.verified_rate}%`;
    const lw = textWidth(label, 11) + 16;
    const vw = textWidth(value, 11) + 16;
    const w = lw + vw;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
  <title>${esc(d.agent_name)} — ${esc(d.track_record)}</title>
  <rect width="${lw}" height="20" fill="${bg}"/>
  <rect x="${lw}" width="${vw}" height="20" fill="${accent}"/>
  <g font-family="${font}" font-size="11">
    <text x="${lw / 2}" y="14" fill="${fg}" text-anchor="middle">${esc(label)}</text>
    <text x="${lw + vw / 2}" y="14" fill="#ffffff" text-anchor="middle">${esc(value)}</text>
  </g>
</svg>`;
  }

  const line1 = d.agent_name + (d.tier ? ` · ${d.tier}` : '');
  const line2 = d.track_record;
  const line3 = d.stake_label;
  const w = Math.max(300, textWidth(line2, 12) + 32, textWidth(line1, 14) + 32);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="96" role="img" aria-label="TrustMarket badge for ${esc(d.agent_name)}">
  <title>${esc(line1)} — ${esc(line2)} — ${esc(line3)}</title>
  <rect width="${w}" height="96" rx="8" fill="${bg}"/>
  <rect x="0" y="0" width="4" height="96" rx="2" fill="${accent}"/>
  <g font-family="${font}">
    <text x="16" y="26" fill="${fg}" font-size="14" font-weight="600">${esc(line1)}</text>
    <text x="16" y="48" fill="${dim}" font-size="12">${esc(line2)}</text>
    <text x="16" y="68" fill="${accent}" font-size="12" font-weight="600">${esc(line3)}</text>
    <text x="16" y="86" fill="#64748b" font-size="10">verify at trustmarket.dev — every claim links to a receipt</text>
  </g>
</svg>`;
}

/** Copy-paste snippets. The badge only spreads if embedding it is trivial. */
export function renderEmbedSnippets(d: BadgeData): Record<string, string> {
  const base = publicBase();
  const svg = `${base}/api/v1/badge/${d.agent_id}.svg`;
  const compact = `${svg}?variant=compact`;
  const alt = `TrustMarket: ${d.track_record}`;
  return {
    markdown: `[![${alt}](${compact})](${d.verify_url})`,
    html: `<a href="${d.verify_url}"><img src="${svg}" alt="${esc(alt)}" height="96"></a>`,
    html_compact: `<a href="${d.verify_url}"><img src="${compact}" alt="${esc(alt)}" height="20"></a>`,
    url_svg: svg,
    url_json: `${base}/api/v1/badge/${d.agent_id}.json`,
  };
}
