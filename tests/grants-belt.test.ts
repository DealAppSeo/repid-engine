/**
 * Tool-belt grants (Sean's GO, 2026-10-07): a person picks a role and a belt for one of their agents,
 * and the browser mints a real grant from their PAI. Three rules make that safe and possible.
 *
 * 1. THE GRANTOR IS THE KEY'S OWN AGENT, BY ID. Before this, an agent-bound key (anyone can get one
 *    from the public register route) could mint or revoke in another agent's name. Names are not
 *    unique in repid_agents, so the binding is by id only.
 * 2. A GRANTOR CAN REACH ITS OWN GRANT. /grants/<grant-id>/revoke carries a grant id, which the
 *    generic path check read as a mismatched agent id, so a bound key could never revoke (G6).
 * 3. A READ-ONLY BELT GRANT IS MINTABLE BY A NEW USER. Every role may carry `read:tool:*`; CTO and
 *    CMO still carry no spend. A cold grant that only reads needs no auditFor.
 */
import { authMiddleware } from '../src/middleware/auth';
import { applyRoleCeiling, rolePermits, ROLE_NAMES } from '../src/services/principal-roles';
import { decideMint } from '../src/services/principal-grants';

const BOUND = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER = 'bbbbbbbb-1111-2222-3333-444444444444';
const GRANT = 'cccccccc-1111-2222-3333-444444444444';

jest.mock('../src/db', () => ({
  db: {
    from: () => {
      const b: any = {
        select: () => b,
        eq: () => b,
        maybeSingle: () => Promise.resolve({ data: { agent_name: 'my-pai' }, error: null }),
      };
      return b;
    },
  },
}));

jest.mock('../src/auth/api-keys', () => ({
  validateAgentApiKey: jest.fn().mockImplementation(async (key: string) => (key === 'bound-key' ? { agent_id: BOUND } : null)),
}));

jest.mock('../src/engine/agent-log', () => ({ logAgentEvent: jest.fn().mockResolvedValue(undefined) }));

function run(path: string, apiKey: string, body: Record<string, unknown> = {}) {
  const req: any = { method: 'POST', path, headers: { authorization: `Bearer ${apiKey}` }, ip: '127.0.0.1', body, query: {} };
  const res: any = {
    statusCode: 0,
    body: null as any,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { this.body = payload; return this; },
  };
  const next = jest.fn();
  return Promise.resolve(authMiddleware(req, res, next)).then(() => ({ res, next }));
}

beforeEach(() => {
  process.env.REPID_API_KEYS = 'operator-key:pro';
});

describe('1. the grantor is the key\'s own agent, by id', () => {
  const mint = (grantor: unknown) =>
    run('/api/v1/grants', 'bound-key', { grantor_agent_id: grantor, grantee_agent_id: OTHER, grant_class: 'cold', capabilities: ['read:tool:github'], ttl_seconds: 60 });

  it('passes when the grantor is the bound agent\'s id, in any case', async () => {
    for (const id of [BOUND, BOUND.toUpperCase()]) {
      const { res, next } = await mint(id);
      expect(next).toHaveBeenCalled();
      expect(res.statusCode).toBe(0);
    }
  });

  it.each([
    ['another agent\'s id', OTHER],
    ['the bound agent\'s NAME (names are not unique, so not accepted here)', 'my-pai'],
    ['a non-string', 42],
    ['an empty string', ''],
  ])('refuses %s with 403 naming the field', async (_name, grantor) => {
    const { res, next } = await mint(grantor);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.field).toBe('body.grantor_agent_id');
  });

  it('refuses a revoke asked in another agent\'s name', async () => {
    const { res, next } = await run(`/api/v1/grants/${GRANT}/revoke`, 'bound-key', { requested_by: OTHER });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.field).toBe('body.requested_by');
  });

  it('leaves an operator key unbound, as before', async () => {
    const { next } = await run('/api/v1/grants', 'operator-key', { grantor_agent_id: 'any-agent', grantee_agent_id: OTHER });
    expect(next).toHaveBeenCalled();
  });
});

describe('2. a grantor can reach its own grant', () => {
  it('revoke with requested_by = the bound id is not mistaken for an agent-id mismatch', async () => {
    const { res, next } = await run(`/api/v1/grants/${GRANT}/revoke`, 'bound-key', { requested_by: BOUND });
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(0);
  });

  it('authorize (a read-only decision) is reachable with a bound key', async () => {
    const { next } = await run(`/api/v1/grants/${GRANT}/authorize`, 'bound-key', { capability: 'read:tool:github' });
    expect(next).toHaveBeenCalled();
  });

  it('the carve-out is exact: any other path under a grant id still gets the agent-id check', async () => {
    const { res, next } = await run(`/api/v1/grants/${GRANT}/anything-else`, 'bound-key', {});
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});

describe('3. a read-only belt grant is mintable by a new user', () => {
  const NOT_CHECKED_AEFF = { aEff: null, outcome: 'NOT_CHECKED' as const, bindingTerm: null, detail: 'new agent: no collateral measured', rRouteIsLedgerApproximation: true as const };
  const NOT_CHECKED_SIG = { required: false as const, status: 'NOT_CHECKED' as const, detail: 'unsigned' };
  const belt = (over: Record<string, unknown> = {}) =>
    ({ grantorAgentId: BOUND, granteeAgentId: OTHER, grantClass: 'cold', capabilities: ['read:tool:github', 'read:tool:gitleaks'], caveats: [], ttlSeconds: 30 * 86400, role: 'cto', ...over }) as any;

  it('every role may carry read-only tools', () => {
    for (const role of ROLE_NAMES) {
      expect(rolePermits(role, 'read:tool:github')).toBe(true);
      expect(applyRoleCeiling(['read:tool:github'], role).refused).toEqual([]);
    }
  });

  it('CTO and CMO still carry no spend, alongside a belt', () => {
    for (const role of ['cto', 'cmo']) {
      const out = applyRoleCeiling(['read:tool:github', 'pay:usdc'], role);
      expect(out.allowed).toEqual(['read:tool:github']);
      expect(out.refused).toEqual(['pay:usdc']);
    }
  });

  it('read:tool does not open other read verbs', () => {
    expect(applyRoleCeiling(['read:activity'], 'cto').refused).toEqual(['read:activity']);
  });

  it('a cold belt grant with no auditFor mints with unmeasured collateral (theta_cold = 0)', () => {
    const d = decideMint(belt(), NOT_CHECKED_AEFF, NOT_CHECKED_SIG);
    expect(d).toMatchObject({ allowed: true, depth: 0 });
  });

  it('an auditing cold grant still requires auditFor, and auditFor still cannot be the grantee', () => {
    expect(decideMint(belt({ capabilities: ['audit:read'], role: null }), NOT_CHECKED_AEFF, NOT_CHECKED_SIG)).toMatchObject({ allowed: false });
    expect(decideMint(belt({ capabilities: ['audit:read'], role: null, auditFor: OTHER }), NOT_CHECKED_AEFF, NOT_CHECKED_SIG)).toMatchObject({ allowed: false });
  });

  it('a belt grant that slips in spend is refused by the role before anything else', () => {
    const d = decideMint(belt({ capabilities: ['read:tool:github', 'pay:usdc'] }), NOT_CHECKED_AEFF, NOT_CHECKED_SIG);
    expect(d.allowed).toBe(false);
    expect((d as any).reason).toMatch(/role ceiling refuses pay:usdc/);
  });

  it('a cold grant with a write verb is refused even with no role', () => {
    const d = decideMint(belt({ capabilities: ['write:repo'], role: null }), NOT_CHECKED_AEFF, NOT_CHECKED_SIG);
    expect(d.allowed).toBe(false);
    expect((d as any).reason).toMatch(/non-read capabilities: write:repo/);
  });
});
