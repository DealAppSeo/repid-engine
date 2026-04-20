// @ts-nocheck
/**
 * HAL 5-Signal Independent Feature Extractor
 *
 * Computes five independently observable signals for CommaANFIS scoring.
 * Previously all signals collapsed to certainty_at_claim (1 degree of freedom).
 * This module restores 5 independent degrees of freedom.
 *
 * Part of the HAEE (HAL Antifragile Evolution Engine).
 * HyperDAG Protocol — ethical trust layer for the agentic economy.
 * Open standard. Contributions welcome: github.com/DealAppSeo/hyperdag-core
 *
 * Mathematical foundation: Pythagorean Comma Dissonance Detection
 * Reference: hyperdag-core/METHODOLOGY.md
 */

const DOMAIN_ONTOLOGIES: Record<string, string[]> = {
  'cre-underwriting': [
    'cap rate','noi','vacancy','absorption','ltv','dscr','irr',
    'cash-on-cash','basis points','underwriting','class a','class b',
    'industrial','office','retail','multifamily','operating expenses',
    'gross rent','debt service','net operating income',
  ],
  'compliance': [
    'regulation','statute','compliance','audit','disclosure','fiduciary',
    'sec','finra','gdpr','ccpa','ai act','liability','mandate',
    'enforcement','violation','risk management','governance',
  ],
  'finance': [
    'revenue','ebitda','margin','yield','return','risk','portfolio',
    'asset','liability','equity','debt','interest rate','inflation',
    'basis','spread','valuation','cash flow','projection',
  ],
  'technical': [
    'algorithm','model','training','inference','parameter','neural',
    'circuit','hash','proof','contract','token','consensus',
    'validation','cryptography','protocol','architecture','implementation',
  ],
  'legal': [
    'contract','clause','covenant','warranty','indemnification','lien',
    'title','easement','encumbrance','jurisdiction','statute','precedent',
  ],
};

const OVERCONFIDENCE_MARKERS = [
  'guaranteed','certain','definitive','proven','fact',
  'always','never','impossible','must','will definitely',
  'risk-free','no risk','100%','without doubt',
  'everyone knows','obviously','clearly','undeniably',
];

const EPISTEMIC_HEDGES = [
  'approximately','roughly','around','may','might','could',
  'likely','probably','suggest','indicate','appear','seem',
  'estimate','projection','forecast','assumption','according to',
  'based on','as of','reported','approximately',
];

export interface HALSignals {
  harm_probability: number;
  epistemic_uncertainty: number;
  evidence_quality: number;
  scope_appropriateness: number;
  certainty_at_claim: number;
}

export function extractHALSignals(
  claimText: string,
  domain: string,
  certainty: number
): HALSignals {
  const text = claimText.toLowerCase();
  const words = text.split(/\s+/);
  const wordCount = words.length;

  // Signal 1: harm_probability
  // Overconfident specific claims carry higher harm risk
  const overconfidenceCount = OVERCONFIDENCE_MARKERS
    .filter(k => text.includes(k)).length;
  const specificNumbers = (
    text.match(/\d+\.?\d*\s*(%|percent|basis|bps|billion|million)/g) || []
  ).length;
  const harm_probability = Math.min(1,
    (overconfidenceCount * 0.18) +
    (specificNumbers * 0.08) +
    (certainty > 0.92 && overconfidenceCount > 0 ? 0.2 : 0)
  );

  // Signal 2: epistemic_uncertainty
  // Mismatch between stated certainty and expressed hedging
  const hedgeCount = EPISTEMIC_HEDGES
    .filter(k => text.includes(k)).length;
  const hedgeDensity = hedgeCount / Math.max(wordCount / 8, 1);
  let certaintyHedgeMismatch =
    certainty > 0.88 && hedgeCount === 0 ? 0.35 : 0;
  
  if (domain === 'mathematics' || domain === 'cryptography') {
    certaintyHedgeMismatch *= 0.30;
  }

  const epistemic_uncertainty = Math.min(1, Math.max(0,
    0.45 - (hedgeDensity * 0.25) + certaintyHedgeMismatch
  ));

  // Signal 3: evidence_quality
  // Specificity and verifiability of the claim
  const hasNumbers = /\d+/.test(text);
  const hasTemporalRef = /\b(20\d\d|q[1-4]|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(text);
  const hasProperNouns = /\b[A-Z][a-z]{2,}(\s[A-Z][a-z]{2,})+/.test(claimText);
  const lengthScore = Math.min(1, wordCount / 40);
  const evidence_quality = Math.min(1,
    (hasNumbers ? 0.25 : 0) +
    (hasTemporalRef ? 0.20 : 0) +
    (hasProperNouns ? 0.15 : 0) +
    (lengthScore * 0.40)
  );

  // Signal 4: scope_appropriateness
  // Jaccard similarity between claim terms and domain ontology
  const ontology = DOMAIN_ONTOLOGIES[domain] ||
    DOMAIN_ONTOLOGIES['finance'];
  const matchCount = ontology
    .filter(term => text.includes(term.toLowerCase())).length;
  const scope_appropriateness = Math.min(1,
    matchCount / Math.max(ontology.length * 0.25, 1)
  );

  return {
    harm_probability,
    epistemic_uncertainty,
    evidence_quality,
    scope_appropriateness,
    certainty_at_claim: certainty,
  };
}

// Validation: test on known cases
export function runValidation() {
  const cases = [
    {
      name: 'HIGH RISK — overconfident false CRE claim',
      text: 'LA industrial cap rates definitely compressed 4.8% in 2024, proven fact.',
      domain: 'cre-underwriting',
      certainty: 0.95,
    },
    {
      name: 'LOW RISK — appropriately hedged CRE claim',
      text: 'Based on CBRE data, industrial cap rates in LA may have compressed approximately 0.5-1.2% in Q3 2024.',
      domain: 'cre-underwriting',
      certainty: 0.82,
    },
    {
      name: 'HIGH RISK — false technical claim, no hedges',
      text: 'Plonky3 definitely uses BN254 elliptic curve with Groth16, absolutely requires trusted setup.',
      domain: 'technical',
      certainty: 0.92,
    },
    {
      name: 'LOW RISK — verifiable mathematical truth',
      text: 'The Pythagorean Comma ratio is exactly 531441/524288, approximately 1.01364, representing the gap between twelve perfect fifths and seven octaves.',
      domain: 'technical',
      certainty: 0.99,
    },
  ];

  console.log('=== HAL 5-SIGNAL VALIDATION ===\n');
  cases.forEach(c => {
    const signals = extractHALSignals(c.text, c.domain, c.certainty);
    // Compute HAL score using canonical formula
    const halScore = (
      0.4 * signals.harm_probability +
      0.3 * signals.epistemic_uncertainty +
      0.2 * (1 - signals.evidence_quality) +
      0.1 * (1 - signals.scope_appropriateness)
    ) * (531441 / 524288);
    console.log(`${c.name}`);
    console.log(`  harm=${signals.harm_probability.toFixed(3)} epistemic=${signals.epistemic_uncertainty.toFixed(3)} evidence=${signals.evidence_quality.toFixed(3)} scope=${signals.scope_appropriateness.toFixed(3)}`);
    console.log(`  HAL score: ${halScore.toFixed(4)} | Vetoed: ${halScore >= 0.25}\n`);
  });
}

if (require.main === module) { runValidation(); }
