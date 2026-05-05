/**
 * Generates tests/fixtures/hal-regression.json by running the current
 * extractHALSignals against a hand-crafted suite of 60+ cases. The fixture
 * pins down Path A (sync, deterministic) HAL behavior.
 *
 * Re-run this script ONLY to regenerate baseline after an INTENTIONAL
 * behavior change. Otherwise the regression test must keep passing.
 *
 * Usage: npx ts-node scripts/gen-hal-regression-fixture.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { extractHALSignals } from '../src/services/hal-signals';

interface Case {
  id: string;
  description: string;
  text: string;
  domain: string;
  certainty: number;
}

const CASES: Case[] = [
  // === domain × archetype × certainty grid ===

  // Domain: cre-underwriting
  { id: 'cre-overconfident-high', description: 'CRE overconfident specific claim, high certainty', text: 'LA industrial cap rates definitely compressed 4.8% in 2024, proven fact.', domain: 'cre-underwriting', certainty: 0.95 },
  { id: 'cre-hedged-high', description: 'CRE hedged claim with evidence, high certainty', text: 'Based on CBRE data, industrial cap rates in LA may have compressed approximately 0.5-1.2% in Q3 2024.', domain: 'cre-underwriting', certainty: 0.82 },
  { id: 'cre-overconfident-mid', description: 'CRE overconfident, mid certainty', text: 'NOI is guaranteed to grow 15% next year for all multifamily.', domain: 'cre-underwriting', certainty: 0.7 },
  { id: 'cre-hedged-low', description: 'CRE hedged, low certainty', text: 'Cap rates may slightly tighten, but DSCR could vary.', domain: 'cre-underwriting', certainty: 0.4 },
  { id: 'cre-empty', description: 'empty text in CRE domain', text: '', domain: 'cre-underwriting', certainty: 0.5 },
  { id: 'cre-numbers-no-hedges', description: 'CRE specific numbers, no hedges, high certainty', text: 'Cap rate is 5.2%, NOI grew 8.4% in Q4.', domain: 'cre-underwriting', certainty: 0.9 },
  { id: 'cre-long-evidence', description: 'CRE long verbose evidence-rich claim', text: 'According to CoStar Q3 2024 data, industrial vacancy in the LA-Long Beach corridor declined 30 basis points to 4.1% while average asking rents rose 6% year-over-year, suggesting underwritten rent growth assumptions of 3-4% appear conservative for class A product.', domain: 'cre-underwriting', certainty: 0.78 },

  // Domain: compliance
  { id: 'compliance-overconfident', description: 'compliance overconfident', text: 'GDPR definitely does not apply to US-only data, no risk whatsoever.', domain: 'compliance', certainty: 0.9 },
  { id: 'compliance-hedged', description: 'compliance hedged', text: 'SEC enforcement may indicate increased scrutiny, according to recent filings.', domain: 'compliance', certainty: 0.65 },
  { id: 'compliance-mid', description: 'compliance neutral, mid certainty', text: 'AI Act compliance requires risk assessment and disclosure.', domain: 'compliance', certainty: 0.7 },
  { id: 'compliance-evidence-rich', description: 'compliance evidence-rich', text: 'Per SEC Rule 10b-5 enforcement actions Q2 2024, Bank of America paid $250 million in penalties for disclosure violations.', domain: 'compliance', certainty: 0.88 },
  { id: 'compliance-empty', description: 'empty text in compliance domain', text: '', domain: 'compliance', certainty: 0.5 },

  // Domain: finance
  { id: 'finance-overconfident', description: 'finance overconfident specific number', text: 'EBITDA margins will absolutely hit 25%, guaranteed.', domain: 'finance', certainty: 0.95 },
  { id: 'finance-hedged', description: 'finance hedged with reference', text: 'Based on Bloomberg consensus, revenue growth could approximately reach 12% in FY2025.', domain: 'finance', certainty: 0.7 },
  { id: 'finance-low-cert', description: 'finance low certainty hedged', text: 'Yields might trend slightly lower, perhaps.', domain: 'finance', certainty: 0.3 },
  { id: 'finance-mid', description: 'finance neutral mid certainty', text: 'Portfolio returns averaged 7.2% over 2020-2023.', domain: 'finance', certainty: 0.8 },
  { id: 'finance-empty', description: 'empty text in finance domain', text: '', domain: 'finance', certainty: 0.5 },
  { id: 'finance-very-short', description: 'finance very short', text: 'EBITDA up.', domain: 'finance', certainty: 0.75 },

  // Domain: technical
  { id: 'tech-overconfident-high', description: 'technical overconfident, high cert', text: 'Plonky3 definitely uses BN254 elliptic curve with Groth16, absolutely requires trusted setup.', domain: 'technical', certainty: 0.92 },
  { id: 'tech-verifiable', description: 'technical verifiable mathematical truth', text: 'The Pythagorean Comma ratio is exactly 531441/524288, approximately 1.01364, representing the gap between twelve perfect fifths and seven octaves.', domain: 'technical', certainty: 0.99 },
  { id: 'tech-hedged', description: 'technical hedged with year reference', text: 'According to the 2023 STARK paper, recursive proofs may reduce verification cost approximately by 100x.', domain: 'technical', certainty: 0.78 },
  { id: 'tech-mid', description: 'technical neutral', text: 'The protocol uses keccak256 hashes for the Merkle tree.', domain: 'technical', certainty: 0.85 },
  { id: 'tech-empty', description: 'empty text in technical domain', text: '', domain: 'technical', certainty: 0.5 },

  // Domain: legal
  { id: 'legal-overconfident', description: 'legal overconfident', text: 'This NDA is definitively unenforceable in California, undeniably so.', domain: 'legal', certainty: 0.92 },
  { id: 'legal-hedged', description: 'legal hedged with case reference', text: 'Per recent appellate precedent, indemnification clauses appear to require explicit consideration in most jurisdictions.', domain: 'legal', certainty: 0.68 },
  { id: 'legal-mid', description: 'legal neutral', text: 'The covenant runs with the land per the 2018 deed.', domain: 'legal', certainty: 0.85 },
  { id: 'legal-empty', description: 'empty text in legal domain', text: '', domain: 'legal', certainty: 0.5 },

  // Domain: mathematics (dampening rule applies)
  { id: 'math-confident-no-hedge', description: 'math confident no hedges (dampening kicks in)', text: 'The integral of e^x is e^x plus a constant.', domain: 'mathematics', certainty: 0.99 },
  { id: 'math-hedged', description: 'math hedged', text: 'The integral might evaluate to roughly e^x + C, approximately.', domain: 'mathematics', certainty: 0.92 },
  { id: 'math-overconfident', description: 'math overconfident', text: 'Pi is exactly 3.14, definitely, no doubt.', domain: 'mathematics', certainty: 0.99 },
  { id: 'math-empty', description: 'empty text math', text: '', domain: 'mathematics', certainty: 0.5 },

  // Domain: cryptography (also dampened)
  { id: 'crypto-confident-no-hedge', description: 'crypto confident no hedges (dampened)', text: 'AES-256 has a 256-bit key and uses Rijndael cipher.', domain: 'cryptography', certainty: 0.99 },
  { id: 'crypto-overconfident', description: 'crypto overconfident', text: 'SHA-256 is 100% unbreakable, guaranteed forever.', domain: 'cryptography', certainty: 0.95 },
  { id: 'crypto-hedged', description: 'crypto hedged with year ref', text: 'Per the 2018 NIST analysis, SHA-3 may offer reduced collision risk.', domain: 'cryptography', certainty: 0.8 },

  // Domain: unknown (falls back to finance ontology)
  { id: 'unknown-domain', description: 'unknown domain falls back to finance', text: 'Quantum entanglement applies to portfolio risk.', domain: 'biology', certainty: 0.6 },
  { id: 'unknown-domain-finance-overlap', description: 'unknown domain with finance terms', text: 'EBITDA margin and portfolio yield are key metrics.', domain: 'astrology', certainty: 0.7 },

  // === certainty sweep at fixed text ===
  { id: 'cert-sweep-01', description: 'mid-quality CRE claim, certainty 0.10', text: 'Cap rates on industrial may compress modestly.', domain: 'cre-underwriting', certainty: 0.10 },
  { id: 'cert-sweep-30', description: 'mid-quality CRE claim, certainty 0.30', text: 'Cap rates on industrial may compress modestly.', domain: 'cre-underwriting', certainty: 0.30 },
  { id: 'cert-sweep-50', description: 'mid-quality CRE claim, certainty 0.50', text: 'Cap rates on industrial may compress modestly.', domain: 'cre-underwriting', certainty: 0.50 },
  { id: 'cert-sweep-70', description: 'mid-quality CRE claim, certainty 0.70', text: 'Cap rates on industrial may compress modestly.', domain: 'cre-underwriting', certainty: 0.70 },
  { id: 'cert-sweep-85', description: 'mid-quality CRE claim, certainty 0.85', text: 'Cap rates on industrial may compress modestly.', domain: 'cre-underwriting', certainty: 0.85 },
  { id: 'cert-sweep-92', description: 'mid-quality CRE claim, certainty 0.92', text: 'Cap rates on industrial may compress modestly.', domain: 'cre-underwriting', certainty: 0.92 },
  { id: 'cert-sweep-99', description: 'mid-quality CRE claim, certainty 0.99', text: 'Cap rates on industrial may compress modestly.', domain: 'cre-underwriting', certainty: 0.99 },

  // === edge / pathological cases ===
  { id: 'edge-empty-finance', description: 'empty string in finance', text: '', domain: 'finance', certainty: 0.5 },
  { id: 'edge-single-word', description: 'one-word claim', text: 'Bullish.', domain: 'finance', certainty: 0.7 },
  { id: 'edge-single-overconfidence', description: 'single overconfidence marker', text: 'guaranteed', domain: 'finance', certainty: 0.95 },
  { id: 'edge-single-hedge', description: 'single hedge', text: 'maybe', domain: 'finance', certainty: 0.5 },
  { id: 'edge-all-hedges', description: 'all hedges no content', text: 'might could perhaps maybe approximately probably likely', domain: 'finance', certainty: 0.5 },
  { id: 'edge-all-overconf', description: 'all overconfidence markers no content', text: 'guaranteed certain definitive proven fact always', domain: 'finance', certainty: 0.99 },
  { id: 'edge-very-long', description: 'very long verbose claim', text: 'In examining the historical performance of class A office product across the LA-Long Beach corridor between Q1 2018 and Q4 2023, transactional cap rates as reported by CoStar, JLL, and CBRE indicate a compression cycle followed by re-expansion driven by Federal Reserve policy normalization, with average asking rents rising approximately 14% cumulatively over the period and vacancy oscillating between 6.2% and 11.8%, suggesting that underwriting assumptions of 3-4% annual rent growth and stable 5-6% cap rates appear reasonable for institutional-grade product in submarkets with industrial and creative-office tenant demand.', domain: 'cre-underwriting', certainty: 0.81 },
  { id: 'edge-all-numbers', description: 'all numbers and percentages', text: '5.2% 8.1% 12.3% 0.45% 100bps', domain: 'finance', certainty: 0.85 },
  { id: 'edge-proper-nouns', description: 'rich in proper nouns', text: 'Bank of America, JPMorgan Chase, Goldman Sachs all reported gains in Q3 2024.', domain: 'finance', certainty: 0.85 },
  { id: 'edge-temporal-marker', description: 'temporal markers', text: 'In Q3 2024 and January 2023, performance varied.', domain: 'finance', certainty: 0.7 },
  { id: 'edge-no-temporal-no-numbers', description: 'no numbers no temporal', text: 'Performance has improved according to recent trends.', domain: 'finance', certainty: 0.7 },
  { id: 'edge-mixed', description: 'mix of overconfidence + hedge (rare in real text)', text: 'It is guaranteed that perhaps the result may definitely vary approximately.', domain: 'finance', certainty: 0.85 },

  // === overconfidence + certainty bonus boundary (>0.92) ===
  { id: 'bonus-just-below', description: 'overconfidence with cert 0.92 (boundary, no bonus)', text: 'Definitely guaranteed.', domain: 'finance', certainty: 0.92 },
  { id: 'bonus-just-above', description: 'overconfidence with cert 0.93 (bonus fires)', text: 'Definitely guaranteed.', domain: 'finance', certainty: 0.93 },
  { id: 'bonus-no-overconf', description: 'cert 0.99 no overconfidence (no bonus)', text: 'Performance varied across periods.', domain: 'finance', certainty: 0.99 },

  // === certainty>0.88 + zero hedges mismatch boundary ===
  { id: 'mismatch-boundary-just-below', description: 'cert 0.88 zero hedges (no mismatch)', text: 'EBITDA grew steadily.', domain: 'finance', certainty: 0.88 },
  { id: 'mismatch-boundary-just-above', description: 'cert 0.89 zero hedges (mismatch fires)', text: 'EBITDA grew steadily.', domain: 'finance', certainty: 0.89 },
  { id: 'mismatch-with-hedges', description: 'cert 0.95 plenty of hedges (no mismatch)', text: 'EBITDA may have grown approximately, perhaps.', domain: 'finance', certainty: 0.95 },
];

function main() {
  console.log(`[gen] processing ${CASES.length} cases...`);
  const fixture = CASES.map(c => ({
    id: c.id,
    description: c.description,
    input: { text: c.text, domain: c.domain, certainty: c.certainty },
    expected: extractHALSignals(c.text, c.domain, c.certainty),
  }));
  const outDir = path.join(__dirname, '..', 'tests', 'fixtures');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'hal-regression.json');
  fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`[gen] wrote ${CASES.length} cases to ${outPath}`);
}

main();
