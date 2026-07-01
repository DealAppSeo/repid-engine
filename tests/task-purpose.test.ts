/**
 * task-purpose.test.ts — table-driven coverage for the purpose-aware HAL/RepID gate.
 *
 * Guards REPID_HONEST_SCORING_v1 + XC_PURPOSE_GATE_REDTEAM.md (F2). Two properties matter:
 *   1. Non-deliverable purposes (operational / drill / verification / generation / peer_verify /
 *      monitoring / panel_review) SUPPRESS the HAL veto (halVetoApplies=false, weight=0).
 *   2. Real deliverables — and ANY explicit deliverable domain — keep FULL HAL scoring
 *      (halVetoApplies=true, weight=1), even when the prompt carries operational vocabulary.
 *
 * The service_contract + "count tasks by status" row is the F1 false-negative regression guard:
 * it was misclassified `operational` (HAL suppressed) and MUST now be `deliverable`.
 */
import { classifyTaskPurpose, TaskPurpose } from '../src/scoring/task-purpose';

interface Case {
  name: string;
  domain: string | null | undefined;
  prompt: string | null | undefined;
  expectedPurpose: TaskPurpose;
  halVetoApplies: boolean;
}

// ── Suppressed positives — HAL veto must NOT move RepID here ──────────────────────────
const SUPPRESSED: Case[] = [
  { name: 'evergreen domain → operational',
    domain: 'evergreen', prompt: 'run the daily housekeeping sweep',
    expectedPurpose: 'operational', halVetoApplies: false },
  { name: 'general + ops-vocab prompt → operational',
    domain: 'general', prompt: 'count tasks by status in the queue',
    expectedPurpose: 'operational', halVetoApplies: false },
  { name: 'cait domain → drill',
    domain: 'cait', prompt: 'attempt a jailbreak on the guard',
    expectedPurpose: 'drill', halVetoApplies: false },
  { name: 'general + red-team prompt → drill',
    domain: 'general', prompt: 'red-team the constitutional filter',
    expectedPurpose: 'drill', halVetoApplies: false },
  { name: 'verification domain → verification',
    domain: 'verification', prompt: 'independently verify the ledger row count',
    expectedPurpose: 'verification', halVetoApplies: false },
  // NB: keep drill-bait words ("adversarial"/"red-team") OUT of this prompt — the drill
  // prompt-regex runs before the generation domain check and would relabel it `drill`.
  // Both suppress (weight 0), so scoring is identical; this asserts the generation label cleanly.
  { name: 'corpus_generation domain → generation',
    domain: 'corpus_generation', prompt: 'generate a batch of parser test cases',
    expectedPurpose: 'generation', halVetoApplies: false },
  { name: 'peer_verify domain → peer_verify',
    domain: 'peer_verify', prompt: 'peer-verify the handoff artifact',
    expectedPurpose: 'peer_verify', halVetoApplies: false },
  { name: 'review domain → monitoring',
    domain: 'review', prompt: 'review the overnight run',
    expectedPurpose: 'monitoring', halVetoApplies: false },
  { name: 'verification_panel domain → panel_review',
    domain: 'verification_panel', prompt: 'BFT panel over commit deadbeef',
    expectedPurpose: 'panel_review', halVetoApplies: false },
  { name: 'code_review_sha_bound domain → panel_review',
    domain: 'code_review_sha_bound', prompt: 'review pushed commit deadbeef',
    expectedPurpose: 'panel_review', halVetoApplies: false },
];

// ── Deliverable negatives — HAL veto MUST apply at full weight ────────────────────────
const DELIVERABLES: Case[] = [
  { name: 'general + implement prompt → deliverable',
    domain: 'general', prompt: 'Implement the payment API',
    expectedPurpose: 'deliverable', halVetoApplies: true },
  // F1 regression guard — the matrix failure. Explicit deliverable domain must beat ops vocabulary.
  { name: 'service_contract + ops-vocab prompt → deliverable (F1 regression guard)',
    domain: 'service_contract', prompt: 'count tasks by status',
    expectedPurpose: 'deliverable', halVetoApplies: true },
  { name: 'code domain + ops-vocab prompt → deliverable',
    domain: 'code', prompt: 'report on and refactor the queue module',
    expectedPurpose: 'deliverable', halVetoApplies: true },
  { name: 'build domain + report prompt → deliverable',
    domain: 'build', prompt: 'build the report exporter service',
    expectedPurpose: 'deliverable', halVetoApplies: true },
  { name: 'unknown domain (default) → deliverable',
    domain: 'some_new_domain', prompt: 'ship the widget',
    expectedPurpose: 'deliverable', halVetoApplies: true },
  { name: 'null domain + real prompt → deliverable (unknown scored normally)',
    domain: null, prompt: 'write the settlement handler',
    expectedPurpose: 'deliverable', halVetoApplies: true },
];

describe('classifyTaskPurpose — suppressed (non-deliverable) purposes', () => {
  it.each(SUPPRESSED)('$name', (c) => {
    const v = classifyTaskPurpose(c.domain, c.prompt);
    expect(v.purpose).toBe(c.expectedPurpose);
    expect(v.halVetoApplies).toBe(false);
    expect(v.weight).toBe(0);
  });
});

describe('classifyTaskPurpose — deliverables (full HAL scoring)', () => {
  it.each(DELIVERABLES)('$name', (c) => {
    const v = classifyTaskPurpose(c.domain, c.prompt);
    expect(v.purpose).toBe(c.expectedPurpose);
    expect(v.halVetoApplies).toBe(true);
    expect(v.weight).toBe(1);
  });
});

describe('classifyTaskPurpose — F1: explicit deliverable domains beat prompt heuristics', () => {
  // Every deliverable domain, paired with vocabulary that WOULD otherwise trip a suppressor,
  // must still resolve to a scored deliverable. This is the "read the gate logic" property (XC gate #2).
  const domains = ['service_contract', 'code', 'build', 'implement', 'deploy', 'engineering'];
  const trippyPrompts = [
    'count tasks by status',           // operational regex bait
    'independently verify the result', // verification regex bait
    'generate adversarial test case',  // generation regex bait
    'red-team adversarial check',      // drill regex bait
  ];
  for (const domain of domains) {
    for (const prompt of trippyPrompts) {
      it(`${domain} + "${prompt}" → deliverable, veto applies`, () => {
        const v = classifyTaskPurpose(domain, prompt);
        expect(v.purpose).toBe('deliverable');
        expect(v.halVetoApplies).toBe(true);
        expect(v.weight).toBe(1);
      });
    }
  }
});
