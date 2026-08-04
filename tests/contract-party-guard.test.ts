/**
 * The unbound-caller contract guard.
 *
 * `auth.ts` refuses a BOUND key that is not a party to a contract. That check is
 * correct and it lives inside `if (dbAgentId)`. A shared `REPID_API_KEYS` env key
 * authenticates fine and leaves `dbAgentId` undefined, so it skipped every party check
 * and could mutate anyone's contract.
 *
 * `/fulfill` and `/satisfy` noticed and self-defend. `/escrow`, `/cancel`, `/dispute`
 * and `/resolve` did not — and `/escrow` moves a contract to `escrowed` with no payment
 * when `X402_ENFORCEMENT_ENABLED` is unset, which it is by default (it is compared
 * against the literal string `'true'`).
 *
 * These tests pin the branch that was missing, and pin that it stays out of the way of
 * the branch that already worked.
 */

import {
  PARTY_ENFORCEMENT_ENV,
  assessUnboundContractAccess,
  parsePartyMode,
  partyGuardLogLine,
  unboundRefusalBody,
} from '../src/middleware/contract-party-guard';

const UUID = '97c2d308-b6e7-4900-bcea-dd43a4aacb46';

const at = (path: string, method = 'POST', hasBoundAgent = false, mode?: 'off' | 'shadow' | 'enforce') =>
  assessUnboundContractAccess({ path, method, hasBoundAgent, ...(mode ? { mode } : {}) });

describe('mode parsing — off unless explicitly asked', () => {
  it.each([
    [undefined, 'off'],
    ['', 'off'],
    ['true', 'off'],
    ['1', 'off'],
    ['on', 'off'],
    ['shadow', 'shadow'],
    ['enforce', 'enforce'],
    ['  ENFORCE ', 'enforce'],
  ])('%p -> %p', (raw, want) => {
    expect(parsePartyMode(raw as string | undefined)).toBe(want);
  });

  it('the env var name is the one the runbook will reference', () => {
    expect(PARTY_ENFORCEMENT_ENV).toBe('CONTRACT_PARTY_ENFORCEMENT');
  });
});

describe('THE HOLE: an unidentified caller mutating a contract', () => {
  it.each(['escrow', 'cancel', 'dispute', 'resolve'])(
    'detects /%s — the four that did NOT self-defend',
    (action) => {
      const a = at(`/api/v1/contracts/${UUID}/${action}`, 'POST', false, 'enforce');
      expect(a.isUnboundContractMutation).toBe(true);
      expect(a.refuse).toBe(true);
      expect(a.contractId).toBe(UUID);
      expect(a.action).toBe(action);
    },
  );

  it('also covers /fulfill and /satisfy — belt and braces, one vocabulary', () => {
    for (const action of ['fulfill', 'satisfy']) {
      expect(at(`/api/v1/contracts/${UUID}/${action}`, 'POST', false, 'enforce').refuse).toBe(true);
    }
  });

  it('works on the bare mount as well as the /api/v1 one', () => {
    expect(at(`/contracts/${UUID}/escrow`, 'POST', false, 'enforce').refuse).toBe(true);
  });

  it('covers the contract root with no action', () => {
    const a = at(`/api/v1/contracts/${UUID}`, 'PATCH', false, 'enforce');
    expect(a.isUnboundContractMutation).toBe(true);
    expect(a.action).toBeNull();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('treats %s as mutating', (m) => {
    expect(at(`/api/v1/contracts/${UUID}/escrow`, m, false, 'enforce').refuse).toBe(true);
  });

  it('ignores query strings when matching the path', () => {
    expect(at(`/api/v1/contracts/${UUID}/escrow?debug=1`, 'POST', false, 'enforce').refuse).toBe(true);
  });
});

describe('what it must NOT touch', () => {
  it('THE LOAD-BEARING EXCLUSION: a BOUND key is left entirely alone', () => {
    // auth.ts already checks bound keys against the contract's parties. Two guards
    // both claiming that responsibility is how one of them silently stops working.
    const a = at(`/api/v1/contracts/${UUID}/escrow`, 'POST', true, 'enforce');
    expect(a.isUnboundContractMutation).toBe(false);
    expect(a.refuse).toBe(false);
  });

  it('leaves GET alone — reads are a different, smaller problem', () => {
    // Blocking reads would break the marketplace status endpoints without closing
    // the hole that matters.
    expect(at(`/api/v1/contracts/${UUID}`, 'GET', false, 'enforce').refuse).toBe(false);
    expect(at(`/api/v1/contracts/${UUID}/escrow`, 'GET', false, 'enforce').refuse).toBe(false);
  });

  it('ignores non-contract paths entirely', () => {
    for (const p of [
      '/api/v1/agents/abc/score-event',
      '/api/v1/marketplace/listings',
      '/api/v1/negotiation/rfqs',
      '/health',
    ]) {
      expect(at(p, 'POST', false, 'enforce').isUnboundContractMutation).toBe(false);
    }
  });

  it('ignores a contract-shaped path whose id is not a uuid', () => {
    expect(at('/api/v1/contracts/not-a-uuid/escrow', 'POST', false, 'enforce').isUnboundContractMutation).toBe(
      false,
    );
  });
});

describe('shadow first, because enforcing is a live change on the money path', () => {
  it('off changes nothing at all', () => {
    const a = at(`/api/v1/contracts/${UUID}/escrow`, 'POST', false, 'off');
    expect(a.refuse).toBe(false);
    expect(a.isUnboundContractMutation).toBe(true); // still observed
  });

  it('shadow OBSERVES and refuses nothing — that is the whole point', () => {
    const a = at(`/api/v1/contracts/${UUID}/escrow`, 'POST', false, 'shadow');
    expect(a.isUnboundContractMutation).toBe(true);
    expect(a.refuse).toBe(false);
    expect(partyGuardLogLine(a)).toMatch(/WOULD-REFUSE/);
  });

  it('only enforce refuses, and says so in the log', () => {
    const a = at(`/api/v1/contracts/${UUID}/escrow`, 'POST', false, 'enforce');
    expect(a.refuse).toBe(true);
    expect(partyGuardLogLine(a)).toMatch(/REFUSED/);
  });

  it('the log line is greppable and carries the contract — shadow must be countable', () => {
    const line = partyGuardLogLine(at(`/api/v1/contracts/${UUID}/escrow`, 'POST', false, 'shadow'));
    expect(line).toContain('[contract-party-guard]');
    expect(line).toContain(UUID);
    expect(line).toContain('mode=shadow');
  });

  it('defaults to off when the env var is unset', () => {
    const prev = process.env[PARTY_ENFORCEMENT_ENV];
    try {
      delete process.env[PARTY_ENFORCEMENT_ENV];
      expect(at(`/api/v1/contracts/${UUID}/escrow`).refuse).toBe(false);
    } finally {
      if (prev !== undefined) process.env[PARTY_ENFORCEMENT_ENV] = prev;
    }
  });
});

describe('the refusal body', () => {
  const a = at(`/api/v1/contracts/${UUID}/escrow`, 'POST', false, 'enforce');

  it('reuses the code /fulfill and /satisfy already return', () => {
    // One condition, one vocabulary. A second error code for the same situation
    // makes client handling guesswork.
    expect(unboundRefusalBody(a).error).toBe('unbound_caller');
  });

  it('tells the caller what to do instead', () => {
    expect(unboundRefusalBody(a).message).toMatch(/agent-issued key/);
  });

  it('names the contract and action so the refusal is actionable', () => {
    const b = unboundRefusalBody(a);
    expect(b.contract_id).toBe(UUID);
    expect(b.action).toBe('escrow');
  });

  it('leaks no key material', () => {
    const blob = JSON.stringify(unboundRefusalBody(a));
    expect(blob).not.toMatch(/eyJ|sk-|0x[0-9a-fA-F]{40,}/);
  });
});
