/**
 * Vesting: earned RepID that the score does not include, and whether it is coming.
 *
 * Two bugs are pinned here, not one.
 *
 * THE VISIBLE ONE: a new agent's rewards are held during a cliff, so `current_repid` does
 * not move while the agent is in fact earning. The passport reported the unmoved score and
 * said nothing about the balance beside it, so a correctly-working system read as dead.
 *
 * THE ONE FOUND WHILE MEASURING IT: nothing releases the balance when the cliff ends. No
 * code path and no database function mentions `vested_repid` except the writer that
 * accumulates into it and the reads that report it. Agents whose cliff expired months ago
 * still hold the full balance, some still at exactly the starting RepID.
 *
 * `MATURED` is the rung that carries the second bug, and the tests below exist to keep it
 * distinguishable from `VESTING`. Collapsing them would present an indefinite hold as a
 * countdown — the original error one level up.
 */
import { describe, it, expect } from '@jest/globals';
import {
  deriveVestingState,
  vestingBlock,
  VESTING_NOTES,
  type VestingState,
} from '../src/services/vesting-status';

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const inDays = (d: number) => new Date(NOW + d * 86_400_000).toISOString();
const agoDays = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe('deriveVestingState', () => {
  it('NONE when nothing is withheld — a cliff with an empty balance is just a new agent', () => {
    expect(deriveVestingState({ vested_repid: 0, vesting_cliff_ends_at: inDays(20) }, NOW)).toBe('NONE');
    expect(deriveVestingState({}, NOW)).toBe('NONE');
    expect(deriveVestingState({ vested_repid: null, vesting_cliff_ends_at: null }, NOW)).toBe('NONE');
  });

  it('VESTING while the cliff is still running', () => {
    expect(deriveVestingState({ vested_repid: 19, vesting_cliff_ends_at: inDays(1) }, NOW)).toBe('VESTING');
    expect(deriveVestingState({ vested_repid: 500, vesting_cliff_ends_at: inDays(29) }, NOW)).toBe('VESTING');
  });

  it('MATURED once the cliff has passed and the balance is STILL held', () => {
    // This is the state that must not read as VESTING. Nothing is coming.
    expect(deriveVestingState({ vested_repid: 19, vesting_cliff_ends_at: agoDays(1) }, NOW)).toBe('MATURED');
    expect(deriveVestingState({ vested_repid: 500, vesting_cliff_ends_at: agoDays(106) }, NOW)).toBe('MATURED');
  });

  it('flips VESTING → MATURED exactly at the cliff, not before or after', () => {
    const at = new Date(NOW).toISOString();
    expect(deriveVestingState({ vested_repid: 5, vesting_cliff_ends_at: at }, NOW)).toBe('MATURED');
    expect(deriveVestingState({ vested_repid: 5, vesting_cliff_ends_at: at }, NOW - 1)).toBe('VESTING');
  });

  it('HELD when a balance exists with no usable cliff date — NOT_CHECKED, not a promise', () => {
    expect(deriveVestingState({ vested_repid: 42, vesting_cliff_ends_at: null }, NOW)).toBe('HELD');
    expect(deriveVestingState({ vested_repid: 42, vesting_cliff_ends_at: 'not a date' }, NOW)).toBe('HELD');
  });

  it('never reports a negative or non-numeric balance as withheld', () => {
    expect(deriveVestingState({ vested_repid: -5, vesting_cliff_ends_at: inDays(3) }, NOW)).toBe('NONE');
    expect(deriveVestingState({ vested_repid: NaN as unknown as number }, NOW)).toBe('NONE');
  });
});

describe('vestingBlock', () => {
  it('states the score a holder would have, without claiming they will get it', () => {
    const b = vestingBlock({ current_repid: 200, vested_repid: 19, vesting_cliff_ends_at: inDays(10) }, NOW);
    expect(b.state).toBe('VESTING');
    expect(b.vested_repid).toBe(19);
    expect(b.score_including_vested).toBe(219);
    expect(b.cliff_ends_at).toBe(inDays(10));
  });

  it('the MATURED note says the score UNDERSTATES, and does not call it a delay', () => {
    const b = vestingBlock({ current_repid: 200, vested_repid: 500, vesting_cliff_ends_at: agoDays(90) }, NOW);
    expect(b.state).toBe('MATURED');
    expect(b.score_including_vested).toBe(700);
    expect(b.note.toLowerCase()).toMatch(/not a delay|has still not been added|understat/);
    expect(b.note.toLowerCase()).not.toMatch(/will be released|will be added/);
  });

  it('the VESTING note explains WHY, because "your score did not move" needs a reason', () => {
    const note = VESTING_NOTES.VESTING.toLowerCase();
    expect(note).toMatch(/farm|sybil|deliberate/);
    expect(note).toMatch(/release date|held/);
  });

  it('NONE adds nothing to the score and says the score is whole', () => {
    const b = vestingBlock({ current_repid: 1299, vested_repid: 0 }, NOW);
    expect(b.state).toBe('NONE');
    expect(b.score_including_vested).toBe(1299);
    expect(b.vested_repid).toBe(0);
  });

  it('every state has a note and they are all distinct', () => {
    const states: VestingState[] = ['NONE', 'VESTING', 'MATURED', 'HELD'];
    const notes = states.map((s) => VESTING_NOTES[s]);
    expect(new Set(notes).size).toBe(states.length);
    for (const n of notes) expect(n.length).toBeGreaterThan(30);
  });

  it('a missing score does not make the withheld balance disappear', () => {
    const b = vestingBlock({ vested_repid: 19, vesting_cliff_ends_at: agoDays(2) }, NOW);
    expect(b.vested_repid).toBe(19);
    expect(b.score_including_vested).toBe(19);
  });
});
