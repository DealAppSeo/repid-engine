/**
 * Regression: a `principal` carrying a PostgREST `.or()` injection payload must never reach
 * the filter in listGrants. A comma in the value turns it into a second, attacker-chosen OR
 * term (e.g. `,grantor_agent_id.not.is.null`) that returns the WHOLE principal_grants table
 * to an unauthenticated caller of GET /grants.
 *
 * Fails before the UUID guard: db.from is reached with the payload and `.or()` receives the
 * malicious filter. Passes after: the guard short-circuits to [] before any query runs.
 *
 * Mirrors this repo's standard `jest.mock('../src/db', ...)` pattern so it runs in CI with
 * no Supabase credentials.
 */
const orMock = jest.fn().mockReturnValue({
  order: () => ({ limit: () => Promise.resolve({ data: [] }) }),
});
const fromMock = jest.fn().mockReturnValue({ select: () => ({ or: orMock }) });
jest.mock('../src/db', () => ({ db: { from: (...a: any[]) => fromMock(...a) } }));

import { listGrants } from '../src/services/principal-grants';
import { isUuidPrincipal } from '../src/services/uuid-principal';

const INJECTION = '00000000-0000-0000-0000-000000000000,grantor_agent_id.not.is.null';
const VALID = '11111111-2222-3333-4444-555555555555';

describe('listGrants OR-filter injection guard', () => {
  beforeEach(() => {
    fromMock.mockClear();
    orMock.mockClear();
  });

  test('an injection payload never reaches the db and returns []', async () => {
    const out = await listGrants(INJECTION);
    expect(out).toEqual([]);
    expect(fromMock).not.toHaveBeenCalled(); // guard short-circuited before any query
  });

  test('a valid UUID reaches the filter with exactly its own two eq-terms', async () => {
    await listGrants(VALID);
    expect(fromMock).toHaveBeenCalledWith('principal_grants');
    expect(orMock).toHaveBeenCalledTimes(1);
    const filter = orMock.mock.calls[0]![0] as string;
    expect(filter).toBe(`grantor_agent_id.eq.${VALID},grantee_agent_id.eq.${VALID}`);
  });

  test('the guard rejects the payload and accepts a canonical UUID', () => {
    expect(isUuidPrincipal(INJECTION)).toBe(false);
    expect(isUuidPrincipal(VALID)).toBe(true);
    expect(isUuidPrincipal('')).toBe(false);
    expect(isUuidPrincipal(undefined)).toBe(false);
  });
});
