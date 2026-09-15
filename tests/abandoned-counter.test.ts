/**
 * C10 A5 — abandoned counts attribute to a custodian for pre-registration mints.
 * SYNTHETIC ids only.
 */
import {
  abandonedCountsByCustodian,
  carryOriginsOntoCustodian,
  originAtMint,
} from '../src/identity/abandoned-counter';

const CUSTODIAN = '00000000-0000-4000-8000-0000000000c1';
const ORPHAN = '00000000-0000-4000-8000-0000000000c2';
const CLAIMED = '00000000-0000-4000-8000-0000000000c3';

describe('abandoned counter carry (C10 A5)', () => {
  it('a mint with no custodian is abandoned until claimed', () => {
    const row = originAtMint(ORPHAN, null);
    expect(row.status).toBe('abandoned');
    expect(row.custodian_id).toBeNull();
    expect(abandonedCountsByCustodian([row])).toEqual({});
  });

  it('pre-registration mints attach to the custodian at registration and stay attributable', () => {
    const orphan = originAtMint(ORPHAN, null);
    const live = originAtMint(CLAIMED, CUSTODIAN);
    const carried = carryOriginsOntoCustodian(CUSTODIAN, [orphan]);
    expect(carried[0]!.custodian_id).toBe(CUSTODIAN);
    expect(carried[0]!.minted_at_registration).toBe(false);
    expect(carried[0]!.status).toBe('abandoned');
    expect(abandonedCountsByCustodian([...carried, live])).toEqual({ [CUSTODIAN]: 1 });
  });
});
