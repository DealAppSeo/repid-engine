/**
 * C9 public last_verified_action + C10 Bronze display. SYNTHETIC.
 */
import { publicIdentityFields } from '../src/identity/public-fields';

const NOW = new Date('2026-09-15T00:00:00.000Z');
const AGO_180 = '2026-03-19T00:00:00.000Z';

describe('public identity fields (C9/C10)', () => {
  it('bound agent: last_verified_action is public, idle_days is the gap, score display is not Bronze-capped', () => {
    const f = publicIdentityFields(
      {
        kind: 'ABT',
        last_verified_action: AGO_180,
        current_repid: 9000,
      },
      NOW,
    );
    expect(f.bound).toBe(true);
    expect(f.last_verified_action).toBe(AGO_180);
    expect(f.idle_days).toBe(180);
    expect(f.display_tier).toBe('Platinum');
  });

  it('unclaimed DBT at Veteran-range score still displays Bronze', () => {
    const f = publicIdentityFields({ kind: 'DBT', current_repid: 9000, last_verified_action: AGO_180 }, NOW);
    expect(f.bound).toBe(false);
    expect(f.display_tier).toBe('Bronze');
  });

  it('missing kind is null-with-reason, never a silent Bronze on every agent', () => {
    const f = publicIdentityFields({ current_repid: 9000, minted_at: '2026-05-10T00:00:00.000Z' }, NOW);
    expect(f.kind).toBeNull();
    expect(f.bound).toBeNull();
    expect(f.display_tier).toBeNull();
    expect(f.reasons.kind).toMatch(/kind_not_on_row/);
    expect(f.last_verified_action).toBe('2026-05-10T00:00:00.000Z');
  });
});
