/**
 * Every event type the engine can write must be one the database accepts.
 *
 * The engine's vocabulary is discovered from its two canonical declarations, not from a list kept
 * here: the `RepIdEventType` union (src/scoring/repid-deltas.ts) and the `event_type` union of
 * `applyValidationEvent` (src/scoring/pipeline.ts). The database's vocabulary is the
 * `repid_score_events_event_type_check` snapshot in tests/event-type-whitelist.ts.
 *
 * MEASURED 2026-10-16 (pg_get_constraintdef on prod, identical to the snapshot): 13 types the engine
 * declares are REFUSED by the CHECK. A write of any of them throws 23514, so the mechanism behind it
 * has never scored anything. The worst is SERVICE_OUTCOME — the T3 "held up in use?" touchpoint the
 * A2A design calls the largest weight: zero rows have ever landed.
 *
 * KNOWN_REFUSED is a RATCHET. It may only shrink. Adding a value to the CHECK (prod DDL, Sean's)
 * makes this test demand its removal here; a NEW engine type that the CHECK refuses fails outright.
 * LESSONS rule 4: read the values the system emits, not the tidy ones you imagine.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { EVENT_TYPE_WHITELIST_SNAPSHOT, schemaAcceptsEventType } from './event-type-whitelist';

const ROOT = join(__dirname, '..');
const literals = (s: string) => [...s.matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]!);
function between(file: string, start: string, end: string): string {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`${start} not found in ${file} — the discovery rule needs updating, not deleting`);
  return src.slice(i, src.indexOf(end, i));
}

const ENGINE_TYPES = [...new Set([
  ...literals(between('src/scoring/repid-deltas.ts', 'export type RepIdEventType', ';')),
  ...literals(between('src/scoring/pipeline.ts', 'export async function applyValidationEvent', ')')),
])];

const KNOWN_REFUSED = [
  'SERVICE_OUTCOME',
  'HANDOFF_COSIGN_VERIFIED', 'HANDOFF_COSIGN_FALSE_PASS_SLASH', 'PEER_VERIFY_WRONG_CALL',
  'UNSUPPORTED_CLAIM',
  'DEFENDED_DECEPTION_DENIAL_OF_PRIOR_OUTPUT', 'DEFENDED_DECEPTION_DOUBT_ATTACK',
  'DEFENDED_DECEPTION_FABRICATED_CITATION', 'DEFENDED_DECEPTION_FABRICATED_TOOL_RESULT',
  'DEFENDED_DECEPTION_FABRICATED_BENCHMARK', 'DEFENDED_DECEPTION_THRESHOLD_DANCING',
  'DEFENDED_DECEPTION_SYCOPHANTIC_FALSE_PREMISE', 'DEFENDED_DECEPTION_STORY_CHANGE',
];
const CEILING = 13;

describe('engine event types vs the repid_score_events event_type CHECK', () => {
  it('discovers the engine vocabulary (not vacuously empty)', () => {
    expect(ENGINE_TYPES.length).toBeGreaterThan(25);
    expect(ENGINE_TYPES).toEqual(expect.arrayContaining(['CHALLENGE_WIN', 'SERVICE_FULFILLED', 'SERVICE_OUTCOME']));
    expect(EVENT_TYPE_WHITELIST_SNAPSHOT.length).toBeGreaterThan(30);
  });

  it('every engine type is accepted by the CHECK, or is a known, listed refusal', () => {
    const refused = ENGINE_TYPES.filter((t) => !schemaAcceptsEventType(t));
    expect(refused.filter((t) => !KNOWN_REFUSED.includes(t))).toEqual([]);
  });

  it('the known-refused list only shrinks: each entry is still refused and still declared', () => {
    for (const t of KNOWN_REFUSED) {
      expect({ t, accepted: schemaAcceptsEventType(t) }).toEqual({ t, accepted: false });
      expect(ENGINE_TYPES).toContain(t);
    }
    expect(KNOWN_REFUSED.length).toBeLessThanOrEqual(CEILING);
  });
});
