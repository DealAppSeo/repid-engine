/**
 * The unbound-caller guard on the SERVICE LISTING surface.
 *
 * PR #338 closed `/contracts/<uuid>` for callers that authenticate with a shared
 * env key and therefore carry no agent identity. It did not close the listings
 * those contracts are created from, and there the same nesting bug is INVERTED:
 * on `PATCH`/`DELETE /services/<id>` the generic path-UUID check inside
 * `if (dbAgentId)` compares a SERVICE id to the caller's AGENT id, so a bound
 * agent is refused on every listing including its own, while the unidentified
 * caller skips that check with the rest of the block and reaches every row.
 *
 * Two things are pinned here:
 *   1. the rule itself, as a pure function, at every mode; and
 *   2. that a BOUND key is never touched by it — two guards claiming one
 *      responsibility is how one of them silently stops working.
 *
 * Default (`off`) is byte-identical to before, which the mode tests assert
 * directly rather than by implication.
 */
import {
  assessUnboundServiceMutation,
  unboundServiceRefusalBody,
  serviceGuardLogLine,
  parsePartyMode,
  PARTY_ENFORCEMENT_ENV,
} from '../src/middleware/contract-party-guard';

const SERVICE = 'dddddddd-1111-2222-3333-444444444444';

function assess(
  method: string,
  path: string,
  opts: { hasBoundAgent?: boolean; mode?: 'off' | 'shadow' | 'enforce' } = {},
) {
  return assessUnboundServiceMutation({
    method,
    path,
    hasBoundAgent: opts.hasBoundAgent ?? false,
    mode: opts.mode ?? 'enforce',
  });
}

describe('assessUnboundServiceMutation — which requests it matches', () => {
  test('POST /services (create) is matched for an unbound caller', () => {
    const a = assess('POST', '/api/v1/services');
    expect(a.isUnboundServiceMutation).toBe(true);
    expect(a.action).toBe('create');
    expect(a.serviceId).toBeNull();
  });

  test('PATCH /services/<id> (update) is matched and names the listing', () => {
    const a = assess('PATCH', `/api/v1/services/${SERVICE}`);
    expect(a.isUnboundServiceMutation).toBe(true);
    expect(a.action).toBe('update');
    expect(a.serviceId).toBe(SERVICE);
  });

  test('DELETE /services/<id> (delist) is matched', () => {
    const a = assess('DELETE', `/api/v1/services/${SERVICE}`);
    expect(a.isUnboundServiceMutation).toBe(true);
    expect(a.action).toBe('delist');
    expect(a.serviceId).toBe(SERVICE);
  });

  test('the bare mount (no /api/v1 prefix) is matched too — both mounts exist', () => {
    expect(assess('POST', '/services').isUnboundServiceMutation).toBe(true);
    expect(assess('DELETE', `/services/${SERVICE}`).isUnboundServiceMutation).toBe(true);
  });

  test('a trailing slash does not evade the match', () => {
    expect(assess('POST', '/api/v1/services/').isUnboundServiceMutation).toBe(true);
    expect(assess('PATCH', `/api/v1/services/${SERVICE}/`).isUnboundServiceMutation).toBe(true);
  });

  test('a query string does not evade the match', () => {
    expect(assess('DELETE', `/api/v1/services/${SERVICE}?force=1`).isUnboundServiceMutation).toBe(true);
  });

  test('method matching is case-insensitive', () => {
    expect(assess('patch', `/api/v1/services/${SERVICE}`).isUnboundServiceMutation).toBe(true);
  });
});

describe('assessUnboundServiceMutation — what it deliberately does NOT match', () => {
  test.each([
    ['GET', '/api/v1/services'],
    ['GET', `/api/v1/services/${SERVICE}`],
    ['GET', '/api/v1/services/categories'],
    ['HEAD', '/api/v1/services'],
    ['OPTIONS', `/api/v1/services/${SERVICE}`],
  ])('%s %s is left alone — reads are the discovery surface', (method, path) => {
    expect(assess(method, path).isUnboundServiceMutation).toBe(false);
  });

  test('POST on an item path is not matched — no such route, flagging it is noise', () => {
    expect(assess('POST', `/api/v1/services/${SERVICE}`).isUnboundServiceMutation).toBe(false);
  });

  test('PATCH on the collection root is not matched — no such route', () => {
    expect(assess('PATCH', '/api/v1/services').isUnboundServiceMutation).toBe(false);
  });

  test('a non-uuid item segment is not matched (e.g. the /categories read alias)', () => {
    expect(assess('DELETE', '/api/v1/services/categories').isUnboundServiceMutation).toBe(false);
  });

  test('the pre-auth public manifest sub-path is not matched', () => {
    expect(assess('POST', `/api/v1/services/${SERVICE}/manifest.json`).isUnboundServiceMutation).toBe(false);
  });

  test('a path that merely starts with the word is not matched', () => {
    expect(assess('POST', '/api/v1/services-registry').isUnboundServiceMutation).toBe(false);
    expect(assess('POST', '/api/v1/agent-services').isUnboundServiceMutation).toBe(false);
  });

  test('contract paths are the OTHER assessor\'s job, not this one', () => {
    expect(assess('POST', `/api/v1/contracts/${SERVICE}/escrow`).isUnboundServiceMutation).toBe(false);
  });
});

describe('assessUnboundServiceMutation — bound keys are never this guard\'s business', () => {
  test.each([
    ['POST', '/api/v1/services'],
    ['PATCH', `/api/v1/services/${SERVICE}`],
    ['DELETE', `/api/v1/services/${SERVICE}`],
  ])('%s %s with a bound agent is untouched even in enforce mode', (method, path) => {
    const a = assess(method, path, { hasBoundAgent: true, mode: 'enforce' });
    expect(a.isUnboundServiceMutation).toBe(false);
    expect(a.refuse).toBe(false);
    expect(a.serviceId).toBeNull();
    expect(a.action).toBeNull();
  });
});

describe('assessUnboundServiceMutation — modes', () => {
  test('off: refuses nothing AND observes nothing — off means off', () => {
    const a = assess('DELETE', `/api/v1/services/${SERVICE}`, { mode: 'off' });
    expect(a.isUnboundServiceMutation).toBe(true);
    expect(a.observe).toBe(false);
    expect(a.refuse).toBe(false);
    expect(a.mode).toBe('off');
  });

  test('shadow: observes and refuses nothing', () => {
    const a = assess('DELETE', `/api/v1/services/${SERVICE}`, { mode: 'shadow' });
    expect(a.isUnboundServiceMutation).toBe(true);
    expect(a.observe).toBe(true);
    expect(a.refuse).toBe(false);
    expect(a.mode).toBe('shadow');
  });

  test('enforce: observes and refuses', () => {
    const a = assess('DELETE', `/api/v1/services/${SERVICE}`, { mode: 'enforce' });
    expect(a.observe).toBe(true);
    expect(a.refuse).toBe(true);
  });

  test('it reads the SAME env switch as the contract guard — not a second knob', () => {
    expect(PARTY_ENFORCEMENT_ENV).toBe('CONTRACT_PARTY_ENFORCEMENT');
    const prev = process.env[PARTY_ENFORCEMENT_ENV];
    try {
      process.env[PARTY_ENFORCEMENT_ENV] = 'enforce';
      expect(
        assessUnboundServiceMutation({
          method: 'DELETE',
          path: `/api/v1/services/${SERVICE}`,
          hasBoundAgent: false,
        }).refuse,
      ).toBe(true);

      process.env[PARTY_ENFORCEMENT_ENV] = 'shadow';
      expect(
        assessUnboundServiceMutation({
          method: 'DELETE',
          path: `/api/v1/services/${SERVICE}`,
          hasBoundAgent: false,
        }).refuse,
      ).toBe(false);

      delete process.env[PARTY_ENFORCEMENT_ENV];
      expect(
        assessUnboundServiceMutation({
          method: 'DELETE',
          path: `/api/v1/services/${SERVICE}`,
          hasBoundAgent: false,
        }).refuse,
      ).toBe(false);
    } finally {
      if (prev === undefined) delete process.env[PARTY_ENFORCEMENT_ENV];
      else process.env[PARTY_ENFORCEMENT_ENV] = prev;
    }
  });

  test('an unrecognised mode value fails closed to off, not open to enforce', () => {
    expect(parsePartyMode('ENFORCE_LATER')).toBe('off');
    expect(parsePartyMode('')).toBe('off');
    expect(parsePartyMode(undefined)).toBe('off');
  });
});

describe('refusal body and log line', () => {
  test('the refusal reuses the unbound_caller code — one condition, one name', () => {
    const body = unboundServiceRefusalBody(assess('DELETE', `/api/v1/services/${SERVICE}`));
    expect(body.error).toBe('unbound_caller');
    expect(body.service_id).toBe(SERVICE);
    expect(body.action).toBe('delist');
  });

  test('the create refusal does not claim a service id it does not have', () => {
    const body = unboundServiceRefusalBody(assess('POST', '/api/v1/services'));
    expect(body.service_id).toBeNull();
    expect(body.message).toMatch(/another agent's behalf/);
  });

  test('the log line carries the shared prefix so ONE grep covers both surfaces', () => {
    const shadow = serviceGuardLogLine(
      assess('PATCH', `/api/v1/services/${SERVICE}`, { mode: 'shadow' }),
    );
    expect(shadow).toContain('[contract-party-guard]');
    expect(shadow).toContain('WOULD-REFUSE');
    expect(shadow).toContain('resource=service');
    expect(shadow).toContain(`service=${SERVICE}`);

    const enforced = serviceGuardLogLine(
      assess('PATCH', `/api/v1/services/${SERVICE}`, { mode: 'enforce' }),
    );
    expect(enforced).toContain('REFUSED');
    expect(enforced).not.toContain('WOULD-REFUSE');
  });

  test('a create observation says "new" rather than a null id', () => {
    expect(serviceGuardLogLine(assess('POST', '/api/v1/services', { mode: 'shadow' })))
      .toContain('service=new');
  });
});
