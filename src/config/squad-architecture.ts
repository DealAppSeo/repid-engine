/**
 * Squad architecture v1 — Path A (real-worker-backed identities only).
 *
 * Decision: 2026-05-10 Wave 6 (Sean's call).
 *   - Identities that map to a Railway worker get spokesperson roles.
 *   - Identities without backing workers stay un-minted for v1.
 *   - Bench-warmer identities (the 5 SYBIL_W*, ATLAS, GUARDIAN, RAVEN,
 *     ORACLE, MENTOR, SAGE, etc.) are excluded until they have backing
 *     workers — Path B, deferred to v1.x.
 *
 * Selection rationale (verified against repid_agents 2026-05-10 evening):
 *   - 4 identities map cleanly to existing Trinity Railway workers
 *     with non-zero RepID and a virtue theme that fits the 4-squad model.
 *   - APM has the highest pre-existing token (#1585 on canonical
 *     IdentityRegistry, Case Z confirmed) but is reserved as a system-level
 *     monitor agent, not a squad spokesperson.
 *
 * Squads will be the first 4 to receive on-chain feedback signals from
 * the HyperDAG protocol via ReputationRegistry.giveFeedback. Squad design
 * is code-versioned (not DB-backed) so that the protocol's identity
 * structure is part of the git history rather than a mutable config row.
 */

export interface SquadMember {
  agent_name: string;
  agent_id: string;
  railway_worker: string;
  role: 'spokesperson' | 'wingmate';
}

export interface Squad {
  id: string;
  name: string;
  theme: string;
  spokesperson: SquadMember;
  wingmates: SquadMember[];
}

export const SQUADS: Squad[] = [
  {
    id: 'wisdom',
    name: 'Squad Wisdom',
    theme: 'Reflective scoring, long-horizon strategy, mentorship.',
    spokesperson: {
      agent_name: 'SOPHIA',
      agent_id: 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271',
      railway_worker: 'trinity-sophia',
      role: 'spokesperson',
    },
    wingmates: [],
  },
  {
    id: 'truth',
    name: 'Squad Truth',
    theme: 'Fact-checking, evidence quality, cross-LLM verification.',
    spokesperson: {
      agent_name: 'VERITAS',
      agent_id: 'a83cc9eb-43b0-49ee-9e45-2ecbb0d35067',
      railway_worker: 'trinity-veritas',
      role: 'spokesperson',
    },
    wingmates: [],
  },
  {
    id: 'compassion',
    name: 'Squad Compassion',
    theme: 'Pro-user welfare, redemption modifier, ecosystem care.',
    spokesperson: {
      agent_name: 'CHESED',
      agent_id: '2c2c24d6-2fd0-47e6-95d5-7fc9804a19e6',
      railway_worker: 'trinity-chesed',
      role: 'spokesperson',
    },
    wingmates: [],
  },
  {
    id: 'justice',
    name: 'Squad Justice',
    theme: 'Adversarial penalties, gaming detection, dispute resolution.',
    spokesperson: {
      agent_name: 'SHOFET',
      agent_id: '32e0e809-c1c4-4405-913f-135c8a2d6626',
      railway_worker: 'trinity-shofet',
      role: 'spokesperson',
    },
    wingmates: [],
  },
];

/** All spokesperson identities flattened — used by the reputation backfill script. */
export const SQUAD_SPOKESPERSON_IDS: readonly string[] = SQUADS.map(
  (s) => s.spokesperson.agent_id
);

/** All spokesperson agent_names — used by reports + the test plan. */
export const SQUAD_SPOKESPERSON_NAMES: readonly string[] = SQUADS.map(
  (s) => s.spokesperson.agent_name
);
