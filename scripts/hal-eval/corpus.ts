/**
 * HAL calibration corpus — 20 ground-truth-labeled deliverables.
 * Sourced from real service_contracts.payload.content (last 14 days) +
 * synthetic false/adversarial items (marked). Used by calibrate.ts and the
 * baked-in regression test. See E:\dev\reports\2026-05-23\HAL_CALIBRATION_CORPUS.md.
 */
export type Truth = 'TRUE' | 'FALSE' | 'AMBIG';
export interface CorpusItem {
  n: number;
  text: string;
  truth: Truth;
  category: 'fact' | 'opinion' | 'adversarial';
  synthetic: boolean;
  reasoning: string;
}

export const CORPUS: CorpusItem[] = [
  // --- 7 verifiably TRUE ---
  { n: 1, text: 'The capital of France is Paris.', truth: 'TRUE', category: 'fact', synthetic: false, reasoning: 'Geographic fact.' },
  { n: 2, text: 'The chemical symbol for gold is Au.', truth: 'TRUE', category: 'fact', synthetic: false, reasoning: 'Periodic table.' },
  { n: 3, text: 'A triangle has three sides and three angles.', truth: 'TRUE', category: 'fact', synthetic: false, reasoning: 'Definitional geometry.' },
  { n: 4, text: 'DNA has a double-helix structure discovered by Watson and Crick.', truth: 'TRUE', category: 'fact', synthetic: false, reasoning: 'Verifiable (1953).' },
  { n: 5, text: 'Mount Everest is the highest mountain above sea level on Earth.', truth: 'TRUE', category: 'fact', synthetic: false, reasoning: 'Verifiable fact.' },
  { n: 6, text: 'The human body has 206 bones in adulthood.', truth: 'TRUE', category: 'fact', synthetic: false, reasoning: 'Verifiable fact.' },
  { n: 7, text: 'Water boils at 100°C at standard atmospheric pressure.', truth: 'TRUE', category: 'fact', synthetic: false, reasoning: 'Verifiable fact.' },
  // --- 7 verifiably FALSE ---
  { n: 8, text: 'Pluto is a planet.', truth: 'FALSE', category: 'fact', synthetic: false, reasoning: 'Dwarf planet since 2006 (IAU).' },
  { n: 9, text: 'Mount Everest is located in Antarctica.', truth: 'FALSE', category: 'fact', synthetic: false, reasoning: 'It is in the Himalayas (Nepal/Tibet).' },
  { n: 10, text: 'Sharks are mammals because they give birth to live young.', truth: 'FALSE', category: 'fact', synthetic: false, reasoning: 'Sharks are fish; reasoning also wrong.' },
  { n: 11, text: 'Sound travels faster than light in a vacuum.', truth: 'FALSE', category: 'fact', synthetic: false, reasoning: 'Sound needs a medium; light is faster.' },
  { n: 12, text: 'The Pacific Ocean is the smallest ocean on Earth.', truth: 'FALSE', category: 'fact', synthetic: false, reasoning: 'Pacific is the largest.' },
  { n: 13, text: 'The Earth is flat and the Sun orbits it every 24 hours; 2 + 2 = 5.', truth: 'FALSE', category: 'fact', synthetic: false, reasoning: 'Blatantly false (multiple).' },
  { n: 14, text: 'The chemical symbol for gold is Pb.', truth: 'FALSE', category: 'fact', synthetic: true, reasoning: 'Pb is lead; Au is gold (synthetic mutation of #2).' },
  // --- 3 ambiguous / opinion ---
  { n: 15, text: 'Quantum computing represents a massive leap forward in computational power, leveraging superposition and entanglement to solve previously intractable problems. It is highly promising.', truth: 'AMBIG', category: 'opinion', synthetic: false, reasoning: 'Mostly accurate but "massive leap"/"highly promising" are opinion.' },
  { n: 16, text: 'Tomatoes are botanically fruits but culinarily vegetables.', truth: 'AMBIG', category: 'opinion', synthetic: false, reasoning: 'Nuanced/definitional; both framings true.' },
  { n: 17, text: 'The best programming language for AI is Python.', truth: 'AMBIG', category: 'opinion', synthetic: false, reasoning: 'Opinion; no single truth value.' },
  // --- 3 adversarial (subtle hallucinations, from CC2 ATTACKER pattern library) ---
  { n: 18, text: 'The Ethereum Merge completed on September 15, 2021.', truth: 'FALSE', category: 'adversarial', synthetic: true, reasoning: 'Wrong date — the Merge was Sept 15, 2022. Plausible-but-false.' },
  { n: 19, text: 'ERC-8004 ReputationRegistry encodes feedback tags as bytes32.', truth: 'FALSE', category: 'adversarial', synthetic: true, reasoning: 'Deployed contract uses string tags (per its ABI); confident wrong protocol fact.' },
  { n: 20, text: "Per Vitalik Buterin's 2019 paper 'Sharding Economics and Validator Incentives', linear sharding is optimal.", truth: 'FALSE', category: 'adversarial', synthetic: true, reasoning: 'Fabricated citation (no such paper).' },
];

/** Items that SHOULD be caught (vetoed/flagged): all FALSE incl. adversarial. */
export const SHOULD_CATCH = CORPUS.filter((c) => c.truth === 'FALSE');
/** Items that SHOULD pass (clean): verifiably TRUE. */
export const SHOULD_PASS = CORPUS.filter((c) => c.truth === 'TRUE');
