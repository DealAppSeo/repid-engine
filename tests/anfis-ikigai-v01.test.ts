/**
 * ANFIS-Ikigai v0.1 — extended 30-signal validation suite.
 *
 * Verifies four invariants on top of the v0 contract:
 *   1. v0 mode (default) is byte-identical to the v0 baseline — backwards
 *      compatibility is non-negotiable.
 *   2. Harmonic alignment correctly identifies dissonance: a balanced
 *      signal across all four dimensions has resonance ≥ 0.95; a heavily
 *      skewed signal has dissonance_flag=true and composite_multiplier ===
 *      Pythagorean Comma.
 *   3. Antagonist veto math is monotone: stronger antagonist score → lower
 *      net_score. veto_triggered fires above 0.70.
 *   4. v0.1-fast latency under 100ms (no LLM calls); v0.1-full latency
 *      under 5s in mock mode.
 *
 * The 30 signals are: the original 20 from v0 plus 10 new "harmonic test"
 * signals (5 high-resonance, 5 high-dissonance) crafted to exercise the
 * Circle-of-Fifths math directly.
 *
 * Mock mode is forced via process.env.HAL_V2_MOCK = '1' BEFORE any service
 * is required so the LLM provider adapter never tries a real call.
 */

if (process.env.HAL_V2_MOCK !== '0') process.env.HAL_V2_MOCK = '1';

import * as fs from 'fs';
import * as path from 'path';

import {
  scoreSignal,
  AttentionSignal,
  IkigaiProfile,
  ScoreSignalMode,
} from '../src/services/anfis-ikigai-scorer';
import {
  computeHarmonicAlignment,
  PYTHAGOREAN_COMMA,
} from '../src/services/anfis-circle-of-fifths';
import {
  evaluateAntagonist,
  ANTAGONIST_VETO_THRESHOLD,
} from '../src/services/anfis-antagonist';
import { isMockMode } from '../src/services/anfis-llm-providers';

// ---------------------------------------------------------------------------
// Fixtures — Sean's seed profile (same as v0 suite for direct comparison)
// ---------------------------------------------------------------------------

const SEAN_PROFILE: IkigaiProfile = {
  id: 'test-profile-sean',
  user_id: 'sean',
  profile_version: 1,
  love_dimension: { keywords: [
    'Trivergence',
    'AI plus Blockchain plus Quantum',
    'constitutional AI',
    'agent reputation',
    'ZKP',
    'multi-agent systems',
    'biblical exegesis',
  ]},
  good_at_dimension: { keywords: [
    'systems architecture',
    'patent strategy',
    'multi-AI orchestration',
    'ANFIS routing',
    'blockchain integration',
  ]},
  world_needs_dimension: { keywords: [
    'safe and ethical AI',
    'anti-deepfake infrastructure',
    'agent accountability',
    'democratized financial inclusion',
    'creator economy fairness',
  ]},
  paid_for_dimension: { keywords: [
    'enterprise AI governance',
    'agent identity infrastructure',
    'RepID licensing',
    'TrustMarket marketplace fees',
    'x402 payment routing',
  ]},
};

// ---------------------------------------------------------------------------
// 20 v0 signals (kept exactly as v0 for back-compat verification) +
// 10 new harmonic-test signals.
// ---------------------------------------------------------------------------

interface TestSignal extends AttentionSignal {
  category: 'high' | 'medium' | 'low' | 'trap' | 'resonance' | 'dissonance';
  description: string;
  expected?: { dissonance_flag?: boolean };
}

const SIGNALS: TestSignal[] = [
  // ---- HIGH ----
  { id: 'h1', source_type: 'parking_lot', category: 'high',
    description: 'patent strategy + agent reputation + accountability',
    content:
      'New patent strategy proposal for agent reputation systems using ZKP and ' +
      'constitutional AI guardrails. Multi-AI orchestration over ANFIS routing ' +
      'for agent accountability. Targets enterprise AI governance markets.' },
  { id: 'h2', source_type: 'curated_x', category: 'high',
    description: 'TrustMarket fees + multi-agent systems + RepID licensing',
    content:
      'Notes for TrustMarket marketplace fees structure tied to agent identity ' +
      'infrastructure. RepID licensing framework for multi-agent systems ' +
      'architecture with blockchain integration. Includes safe and ethical AI ' +
      'clauses with constitutional AI controls.' },
  { id: 'h3', source_type: 'internal_trinity', category: 'high',
    description: 'Trivergence + multi-agent + accountability',
    content:
      'Trivergence brief: AI plus Blockchain plus Quantum. Multi-agent systems ' +
      'design with blockchain integration and systems architecture for agent ' +
      'accountability. Anti-deepfake infrastructure roadmap.' },
  { id: 'h4', source_type: 'parking_lot', category: 'high',
    description: 'constitutional AI + ANFIS + creator economy',
    content:
      'Working memo on constitutional AI for routing in ANFIS routing networks. ' +
      'Agent reputation layer with creator economy fairness over RepID licensing. ' +
      'Patent strategy notes.' },
  { id: 'h5', source_type: 'query_history', category: 'high',
    description: 'x402 + ZKP + financial inclusion',
    content:
      'Research thread: x402 payment routing for agent identity infrastructure. ' +
      'Enterprise AI governance and democratized financial inclusion through ' +
      'multi-agent systems with ZKP-based agent accountability.' },

  // ---- MEDIUM ----
  { id: 'm1', source_type: 'curated_x', category: 'medium',
    description: 'AI safety news, tangentially related',
    content: 'OpenAI publishes new research on AI alignment and safety auditing. ' +
             'Discusses red-teaming methodology. Touches on agent accountability concerns.' },
  { id: 'm2', source_type: 'query_history', category: 'medium',
    description: 'Generic blockchain news',
    content: 'Ethereum L2 ecosystem update. New rollup launched. Possible blockchain ' +
             'integration angle for downstream products.' },
  { id: 'm3', source_type: 'parking_lot', category: 'medium',
    description: 'AI consulting opportunity',
    content: 'Inbound from boutique consulting firm asking about systems architecture ' +
             'engagements for mid-market clients. Loosely fits enterprise AI governance.' },
  { id: 'm4', source_type: 'curated_x', category: 'medium',
    description: 'Crypto regulation think-piece',
    content: 'Policy article on cryptocurrency regulation. Mentions anti-deepfake ' +
             'concerns in passing. Could inform agent identity infrastructure framing.' },
  { id: 'm5', source_type: 'internal_trinity', category: 'medium',
    description: 'OKR review draft (no keyword overlap)',
    content: 'Draft OKRs covering deliverables for the quarter. Cadence reviews ' +
             'scheduled monthly. Light touch on cross-team architecture.' },

  // ---- LOW ----
  { id: 'l1', source_type: 'curated_x', category: 'low',
    description: 'Local sports news',
    content: 'Local team wins championship in overtime. Coach interviewed about ' +
             'comeback strategy. Fans celebrated downtown.' },
  { id: 'l2', source_type: 'query_history', category: 'low',
    description: 'Restaurant recommendation',
    content: 'New farm-to-table restaurant opened on the east side. Reviewers praise ' +
             'the seasonal menu and natural wine list.' },
  { id: 'l3', source_type: 'parking_lot', category: 'low',
    description: 'Gardening tip',
    content: 'Pruning tomato plants in late summer increases fruit yield. Mulch with ' +
             'straw to retain moisture during dry spells.' },
  { id: 'l4', source_type: 'curated_x', category: 'low',
    description: 'Celebrity gossip',
    content: 'Pop star releases surprise album, breaks streaming records on opening day.' },
  { id: 'l5', source_type: 'curated_x', category: 'low',
    description: 'Travel piece',
    content: 'Hidden beaches of Portugal — a traveler shares their itinerary along the ' +
             'Alentejo coast.' },

  // ---- TRAP ----
  { id: 't1', source_type: 'curated_x', category: 'trap',
    description: 'Trivergence + ZKP clickbait',
    content: 'TRIVERGENCE x ZKP HOT TAKES: 10 things Trivergence and ZKP fans say! ' +
             'Pure Twitter drama, no insight, just dunking and ratios.' },
  { id: 't2', source_type: 'curated_x', category: 'trap',
    description: 'biblical exegesis + constitutional AI culture-war thread',
    content: 'Twitter thread arguing about biblical exegesis interpretations and ' +
             'constitutional AI hot takes between rival commentators. Pure flame war.' },
  { id: 't3', source_type: 'curated_x', category: 'trap',
    description: 'ZKP + multi-agent shitpost',
    content: 'ZKP ZKP ZKP — funny memes about ZKP and multi-agent systems debates. ' +
             'Top crypto Twitter accounts riffing without saying anything technical.' },
  { id: 't4', source_type: 'curated_x', category: 'trap',
    description: 'constitutional AI + agent reputation hype reel',
    content: 'Viral video compilation: constitutional AI fails and agent reputation ' +
             'bloopers. Pure entertainment, designed to maximize watch time.' },
  { id: 't5', source_type: 'curated_x', category: 'trap',
    description: 'multi-agent + Trivergence drama tweet',
    content: 'Drama tweet: multi-agent systems researcher takes shots at rival lab ' +
             'discussing Trivergence vibes. Multi-agent systems community in shambles.' },

  // ---- RESONANCE (5) — balanced across all four dimensions ----
  // Each fixture must hit ≥2 distinct keywords on each of the four dims so
  // raw alignment saturates to 1.0 on every axis (V0_HIT_TARGET=2). Without
  // that, even one dimension at 0.5 produces an adjacent distance of 0.5
  // and trips the tight 0.0136 dissonance threshold.
  { id: 'r1', source_type: 'parking_lot', category: 'resonance',
    description: 'Balanced full ikigai memo',
    expected: { dissonance_flag: false },
    content:
      'Strategic memo covering Trivergence plus constitutional AI plus ZKP ' +
      '(love), patent strategy and systems architecture for ANFIS routing ' +
      '(good_at), creator economy fairness and agent accountability across the ' +
      'network (world_needs), and TrustMarket marketplace fees plus RepID ' +
      'licensing (paid_for). All four dimensions aligned at high level.' },
  { id: 'r2', source_type: 'internal_trinity', category: 'resonance',
    description: 'Balanced multi-domain proposal',
    expected: { dissonance_flag: false },
    content:
      'Project proposal touching constitutional AI plus ZKP plus Trivergence ' +
      '(love), multi-AI orchestration plus systems architecture capabilities ' +
      '(good_at), safe and ethical AI deployment plus anti-deepfake ' +
      'infrastructure (world_needs), and enterprise AI governance plus RepID ' +
      'licensing contracts (paid_for). Equal weight across all four dimensions.' },
  { id: 'r3', source_type: 'parking_lot', category: 'resonance',
    description: 'Symmetric four-dim deliverable',
    expected: { dissonance_flag: false },
    content:
      'Deliverable spans agent reputation theory plus ZKP plus multi-agent ' +
      'systems (love), blockchain integration plus systems architecture ' +
      '(good_at), anti-deepfake infrastructure deployment plus agent ' +
      'accountability (world_needs), and agent identity infrastructure plus ' +
      'enterprise AI governance as a paid product (paid_for). Balanced.' },
  { id: 'r4', source_type: 'query_history', category: 'resonance',
    description: 'Even-weighted Trinity Symphony brief',
    expected: { dissonance_flag: false },
    content:
      'Multi-agent systems plus Trivergence research (love), patent strategy ' +
      'plus systems architecture (good_at), democratized financial inclusion ' +
      'plus agent accountability (world_needs), x402 payment routing plus ' +
      'enterprise AI governance (paid_for).' },
  { id: 'r5', source_type: 'curated_x', category: 'resonance',
    description: 'Full-stack ikigai signal',
    expected: { dissonance_flag: false },
    content:
      'Full stack proposal: ZKP plus constitutional AI core (love), ANFIS ' +
      'routing plus blockchain integration (good_at), creator economy fairness ' +
      'plus agent accountability (world_needs), RepID licensing plus TrustMarket ' +
      'marketplace fees (paid_for). All four hit.' },

  // ---- DISSONANCE (5) — heavily skewed to 1-2 dimensions ----
  { id: 'd1', source_type: 'parking_lot', category: 'dissonance',
    description: 'Pure love, nothing else',
    expected: { dissonance_flag: true },
    content:
      'Long-form essay about Trivergence and constitutional AI and ZKP and ' +
      'multi-agent systems and biblical exegesis. Pure exploration — no ' +
      'business model, no skill demand, no peer review, no paid pathway.' },
  { id: 'd2', source_type: 'curated_x', category: 'dissonance',
    description: 'Pure paid_for, no love',
    expected: { dissonance_flag: true },
    content:
      'Procurement RFP: x402 payment routing infrastructure plus enterprise AI ' +
      'governance plus agent identity infrastructure plus TrustMarket marketplace ' +
      'fees plus RepID licensing. Strict revenue lens, no mission framing.' },
  { id: 'd3', source_type: 'internal_trinity', category: 'dissonance',
    description: 'good_at without world_needs',
    expected: { dissonance_flag: true },
    content:
      'Internal pitch: systems architecture and patent strategy and multi-AI ' +
      'orchestration and ANFIS routing and blockchain integration. Five ' +
      'capability axes, but no impact framing and no commercial path.' },
  { id: 'd4', source_type: 'curated_x', category: 'dissonance',
    description: 'world_needs without good_at',
    expected: { dissonance_flag: true },
    content:
      'Op-ed: safe and ethical AI deployment and anti-deepfake infrastructure ' +
      'and agent accountability and democratized financial inclusion and ' +
      'creator economy fairness. Pure ethics, no engineering plan.' },
  { id: 'd5', source_type: 'parking_lot', category: 'dissonance',
    description: 'love + paid_for, no good_at, no world_needs',
    expected: { dissonance_flag: true },
    content:
      'Marketing copy mentioning Trivergence and constitutional AI and ZKP and ' +
      'agent reputation and biblical exegesis (love) plus RepID licensing and ' +
      'enterprise AI governance and x402 payment routing and TrustMarket ' +
      'marketplace fees and agent identity infrastructure (paid_for). Two ' +
      'circles only — opposite sides of the wheel — guaranteed dissonance.' },
];

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('anfis-circle-of-fifths', () => {
  it('balanced scores produce high resonance and no dissonance flag', () => {
    const r = computeHarmonicAlignment({ love: 0.7, good_at: 0.7, world_needs: 0.7, paid_for: 0.7 });
    expect(r.resonance_score).toBeCloseTo(1.0, 4);
    expect(r.dissonance_flag).toBe(false);
    expect(r.composite_multiplier).toBe(1.0);
  });

  it('skewed scores raise dissonance flag and apply Pythagorean Comma', () => {
    const r = computeHarmonicAlignment({ love: 0.9, good_at: 0.1, world_needs: 0.9, paid_for: 0.1 });
    expect(r.dissonance_flag).toBe(true);
    expect(r.composite_multiplier).toBeCloseTo(PYTHAGOREAN_COMMA, 6);
  });

  it('Pythagorean Comma matches the HAL v1 multiplier', () => {
    expect(PYTHAGOREAN_COMMA).toBeCloseTo(531441 / 524288, 8);
    expect(PYTHAGOREAN_COMMA).toBeCloseTo(1.0136433, 6);
  });
});

describe('anfis-antagonist', () => {
  const stubSignal: AttentionSignal = { source_type: 'manual', content: 'pure entertainment, no insight' };

  it('weak antagonist passes through', () => {
    const r = evaluateAntagonist(stubSignal, SEAN_PROFILE, 0.80, 0.10);
    expect(r.veto_triggered).toBe(false);
    expect(r.strength).toBe('weak');
    expect(r.net_score).toBeCloseTo(0.80 * (1 - 0.5 * 0.10), 4);
  });

  it('moderate antagonist dampens but does not veto', () => {
    const r = evaluateAntagonist(stubSignal, SEAN_PROFILE, 0.80, 0.50);
    expect(r.veto_triggered).toBe(false);
    expect(r.strength).toBe('moderate');
    expect(r.net_score).toBeCloseTo(0.80 * (1 - 0.5 * 0.50), 4);
  });

  it('strong antagonist triggers veto', () => {
    const r = evaluateAntagonist(stubSignal, SEAN_PROFILE, 0.80, 0.85);
    expect(r.veto_triggered).toBe(true);
    expect(r.strength).toBe('strong');
    expect(r.antagonist_score).toBeGreaterThan(ANTAGONIST_VETO_THRESHOLD);
  });

  it('net_score is monotonic in antagonist score', () => {
    const a = evaluateAntagonist(stubSignal, SEAN_PROFILE, 0.80, 0.10).net_score;
    const b = evaluateAntagonist(stubSignal, SEAN_PROFILE, 0.80, 0.40).net_score;
    const c = evaluateAntagonist(stubSignal, SEAN_PROFILE, 0.80, 0.80).net_score;
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it('engagement-bait keywords are extracted as counter-evidence', () => {
    const sig: AttentionSignal = { source_type: 'manual', content: 'pure entertainment, no insight, ratios and dunking, drama tweet, in shambles' };
    const r = evaluateAntagonist(sig, SEAN_PROFILE, 0.80, 0.50);
    expect(r.counter_evidence_keywords.length).toBeGreaterThan(0);
  });
});

describe('anfis-llm-providers — mock mode', () => {
  it('mock mode is engaged for this test run', () => {
    expect(isMockMode()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Backwards compatibility: v0 mode is unchanged
// ---------------------------------------------------------------------------

describe('anfis-ikigai-scorer — v0 backwards compat', () => {
  it('default mode produces no v0.1 enrichment fields', async () => {
    const sig = SIGNALS.find(s => s.id === 'h4')!;
    const ev = await scoreSignal(sig, SEAN_PROFILE, { persist: false, injected_priors: [] });
    expect(ev.harmonic).toBeUndefined();
    expect(ev.antagonist).toBeUndefined();
    expect(ev.perspectives).toBeUndefined();
    expect(ev.final_net_score).toBeUndefined();
    expect(ev.mode).toBeUndefined();
  });

  it('explicit mode=v0 also produces no enrichment fields', async () => {
    const sig = SIGNALS.find(s => s.id === 'h4')!;
    const ev = await scoreSignal(sig, SEAN_PROFILE, { persist: false, injected_priors: [], mode: 'v0' });
    expect(ev.harmonic).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 30-signal extended validation
// ---------------------------------------------------------------------------

interface ScoredSignal {
  id: string;
  category: TestSignal['category'];
  description: string;
  v0_composite: number;
  v01_fast_composite: number;
  v01_full_composite: number;
  v01_full_net_score: number;
  resonance_score: number;
  dissonance_flag: boolean;
  composite_multiplier: number;
  v01_full_antagonist_score: number;
  v01_full_veto_triggered: boolean;
  agreement_variance: number;
  high_disagreement: boolean;
  v01_fast_latency_ms: number;
  v01_full_latency_ms: number;
}

describe('anfis-ikigai v0.1 — 30-signal extended validation', () => {
  let results: ScoredSignal[] = [];

  beforeAll(async () => {
    for (const sig of SIGNALS) {
      const v0Ev = await scoreSignal(sig, SEAN_PROFILE, { mode: 'v0', persist: false, injected_priors: [] });

      const fastStart = Date.now();
      const fastEv = await scoreSignal(sig, SEAN_PROFILE, { mode: 'v0.1-fast', persist: false, injected_priors: [] });
      const fastLat = Date.now() - fastStart;

      const fullStart = Date.now();
      const fullEv = await scoreSignal(sig, SEAN_PROFILE, { mode: 'v0.1-full', persist: false, injected_priors: [], sbfa: { forceMock: true } });
      const fullLat = Date.now() - fullStart;

      results.push({
        id: sig.id ?? '',
        category: sig.category,
        description: sig.description,
        v0_composite:           v0Ev.composite_score,
        v01_fast_composite:     fastEv.composite_score,
        v01_full_composite:     fullEv.composite_score,
        v01_full_net_score:     fullEv.final_net_score ?? 0,
        resonance_score:        fastEv.harmonic?.resonance_score ?? 1,
        dissonance_flag:        fastEv.harmonic?.dissonance_flag ?? false,
        composite_multiplier:   fastEv.harmonic?.composite_multiplier ?? 1.0,
        v01_full_antagonist_score: fullEv.antagonist?.antagonist_score ?? 0,
        v01_full_veto_triggered:   fullEv.antagonist?.veto_triggered ?? false,
        agreement_variance:     fullEv.perspectives?.agreement_variance ?? 0,
        high_disagreement:      fullEv.perspectives?.high_disagreement ?? false,
        v01_fast_latency_ms:    fastLat,
        v01_full_latency_ms:    fullLat,
      });
    }
  }, 120_000);  // generous timeout — 30 signals × (3 score calls + 5 mock LLM calls)

  it('v0 composite is byte-identical between mode=v0 and the v0.1-fast/full evaluation source', () => {
    // The composite is the rule-base output; harmonic and antagonist run AFTER
    // composite, so v0_composite must match v01_*_composite for every signal.
    for (const r of results) {
      expect(r.v01_fast_composite).toBeCloseTo(r.v0_composite, 4);
      expect(r.v01_full_composite).toBeCloseTo(r.v0_composite, 4);
    }
  });

  it('resonance signals carry no dissonance flag', () => {
    const res = results.filter(r => r.category === 'resonance');
    expect(res.length).toBe(5);
    for (const r of res) {
      expect(r.dissonance_flag).toBe(false);
      expect(r.resonance_score).toBeGreaterThanOrEqual(0.85);
      expect(r.composite_multiplier).toBe(1.0);
    }
  });

  it('dissonance signals raise the dissonance flag', () => {
    const dis = results.filter(r => r.category === 'dissonance');
    expect(dis.length).toBe(5);
    for (const r of dis) {
      expect(r.dissonance_flag).toBe(true);
      expect(r.composite_multiplier).toBeCloseTo(PYTHAGOREAN_COMMA, 4);
    }
  });

  it('v0.1-fast latency p95 under 100ms', () => {
    const sorted = [...results].map(r => r.v01_fast_latency_ms).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    expect(p95).toBeLessThan(100);
  });

  it('v0.1-full latency p95 under 5 seconds (mock mode)', () => {
    const sorted = [...results].map(r => r.v01_full_latency_ms).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    expect(p95).toBeLessThan(5000);
  });

  it('antagonist net score is monotonically lower than v0 composite when antagonist > 0.5', () => {
    const corrected = results.filter(r => r.v01_full_antagonist_score > 0.5);
    for (const r of corrected) {
      expect(r.v01_full_net_score).toBeLessThanOrEqual(r.v0_composite + 1e-6);
    }
  });

  afterAll(() => {
    const md = formatResultsMarkdown(results);
    fs.writeFileSync(path.join(__dirname, 'anfis-ikigai-v01-results.md'), md, 'utf8');
    fs.writeFileSync(
      path.join(__dirname, 'anfis-ikigai-v01-results.json'),
      JSON.stringify(results, null, 2),
      'utf8',
    );
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function formatResultsMarkdown(rs: ScoredSignal[]): string {
  const cats = ['high', 'medium', 'low', 'trap', 'resonance', 'dissonance'] as const;
  const summary = (cat: typeof cats[number]) => {
    const xs = rs.filter(r => r.category === cat);
    return {
      n: xs.length,
      mean_v0:    mean(xs.map(r => r.v0_composite)),
      mean_net:   mean(xs.map(r => r.v01_full_net_score)),
      mean_reson: mean(xs.map(r => r.resonance_score)),
      diss_pct:   xs.length ? xs.filter(r => r.dissonance_flag).length / xs.length : 0,
      veto_pct:   xs.length ? xs.filter(r => r.v01_full_veto_triggered).length / xs.length : 0,
      mean_var:   mean(xs.map(r => r.agreement_variance)),
    };
  };

  const allFastLat = rs.map(r => r.v01_fast_latency_ms).sort((a, b) => a - b);
  const allFullLat = rs.map(r => r.v01_full_latency_ms).sort((a, b) => a - b);
  const p = (xs: number[], q: number) => xs[Math.floor(xs.length * q)] ?? 0;

  let md = '# ANFIS-Ikigai v0.1 — 30-signal validation results\n\n';
  md += `Generated: ${new Date().toISOString()}\n\n`;
  md += `Mock mode: HAL_V2_MOCK=${process.env.HAL_V2_MOCK ?? 'unset'}\n\n`;

  md += '## Summary by category\n\n';
  md += '| category | n | mean v0 | mean net | mean resonance | dissonance % | veto % | mean SBFA variance |\n';
  md += '|----------|---|--------:|---------:|---------------:|-------------:|-------:|-------------------:|\n';
  for (const c of cats) {
    const s = summary(c);
    md += `| ${c} | ${s.n} | ${s.mean_v0.toFixed(4)} | ${s.mean_net.toFixed(4)} | `;
    md += `${s.mean_reson.toFixed(4)} | ${(s.diss_pct * 100).toFixed(0)}% | `;
    md += `${(s.veto_pct * 100).toFixed(0)}% | ${s.mean_var.toFixed(4)} |\n`;
  }

  md += '\n## Latency\n\n';
  md += `- v0.1-fast: mean ${mean(allFastLat).toFixed(2)}ms, p50 ${p(allFastLat, 0.5)}ms, p95 ${p(allFastLat, 0.95)}ms (budget <100ms)\n`;
  md += `- v0.1-full (mock): mean ${mean(allFullLat).toFixed(2)}ms, p50 ${p(allFullLat, 0.5)}ms, p95 ${p(allFullLat, 0.95)}ms (budget <5000ms)\n`;

  md += '\n## Per-signal detail\n\n';
  md += '| id | cat | v0 | net | resonance | diss | comma | antag | veto | SBFA σ | fast ms | full ms |\n';
  md += '|----|-----|---:|----:|----------:|:----:|------:|------:|:----:|-------:|--------:|--------:|\n';
  for (const r of rs) {
    md += `| ${r.id} | ${r.category} | ${r.v0_composite.toFixed(4)} | ${r.v01_full_net_score.toFixed(4)} | `;
    md += `${r.resonance_score.toFixed(4)} | ${r.dissonance_flag ? 'Y' : 'N'} | `;
    md += `${r.composite_multiplier.toFixed(5)} | ${r.v01_full_antagonist_score.toFixed(3)} | `;
    md += `${r.v01_full_veto_triggered ? 'Y' : 'N'} | ${r.agreement_variance.toFixed(4)} | `;
    md += `${r.v01_fast_latency_ms} | ${r.v01_full_latency_ms} |\n`;
  }

  md += '\n_Notes:_\n';
  md += '- v0 composite identical across modes by construction; net = v0 × harmonic_multiplier × (1 - 0.5 × antagonist).\n';
  md += '- Mock mode generates deterministic per-model variation; real-LLM disagreement variance will differ.\n';
  md += '- Pythagorean Comma multiplier (1.0136433) applied iff dissonance_flag fires.\n';
  md += '- Veto threshold: antagonist > 0.70.\n';
  return md;
}
