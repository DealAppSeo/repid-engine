/**
 * An unreachable RPC must never be reported as an on-chain fact.
 *
 * WHAT WAS WRONG. `Erc8004Minter.verifyOnChain` wrapped its `ownerOf()` call in one catch
 * that produced, for EVERY failure:
 *
 *     { onChainOwner: null, drift: true, reason: `ownerOf reverted: ${msg}` }
 *
 * That branch fires for two things that are not alike:
 *
 *   - the contract REVERTED — the chain answered, and the answer is "no such token";
 *   - the call never landed — RPC down, timeout, rate limit, proxy refusal.
 *
 * The second is NOT_CHECKED, and it was being published as a revert *and* as drift against
 * the database. That is a network failure wearing the clothes of an on-chain finding: the
 * same defect class that scored NOT_CHECKED as FAILED in the settlement path and cost twelve
 * days, arriving here in the identity path.
 *
 * WHY IT MATTERS MORE NOW THAN IT DID. The passport's `registered_onchain` is about to
 * resolve UNVERIFIED against this call. If an unreachable chain reads as "reverted", an RPC
 * outage silently flips live, genuinely-minted agents to NOT_MINTED on the public passport —
 * asserting an absence from our own inability to look.
 *
 * MEASURED 2026-08-30, from a sandbox whose proxy refuses every public Base RPC. ethers v6:
 *
 *     code = "SERVER_ERROR"   shortMessage = "server response 403 Forbidden"
 *     e.code === 'CALL_EXCEPTION'  ->  false
 *
 * So the two are plainly distinguishable and always were. `CALL_EXCEPTION` is ethers' code
 * for the contract itself reverting; everything else means we never got an answer.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyOwnerOfError } from '../src/services/erc8004-minter';

const SOURCE = readFileSync(join(__dirname, '..', 'src', 'services', 'erc8004-minter.ts'), 'utf8');

/**
 * The single `return { ... }` object carrying a given `check:` label.
 *
 * A fixed-width window back from the marker is NOT good enough and the first draft of this
 * file proved it: 700 characters before `check: 'NOT_CHECKED'` reaches back into the REVERTED
 * return above it, so the slice contained that branch's `drift: true` and its "ownerOf
 * reverted" string and the assertions failed against correct code. Anchor on the nearest
 * preceding `return {` so the slice is exactly one object, whatever the surrounding comments do.
 */
function returnBlockFor(label: string): string {
  const marker = SOURCE.indexOf(`check: '${label}'`);
  if (marker < 0) throw new Error(`no return labelled ${label}`);
  const start = SOURCE.lastIndexOf('return {', marker);
  if (start < 0) throw new Error(`no return object before ${label}`);
  return SOURCE.slice(start, marker);
}

describe('classifyOwnerOfError — the contract answered vs we never reached it', () => {
  it('CALL_EXCEPTION is the contract answering: a real revert', () => {
    expect(classifyOwnerOfError({ code: 'CALL_EXCEPTION', message: 'execution reverted' })).toBe('REVERTED');
  });

  it('SERVER_ERROR — the exact shape measured against a refusing proxy — is NOT_CHECKED', () => {
    // Verbatim from the 2026-08-30 probe, so this test fails if the discriminator is
    // ever narrowed to something that does not cover the case that actually occurs.
    const measured = { code: 'SERVER_ERROR', shortMessage: 'server response 403 Forbidden' };
    expect(classifyOwnerOfError(measured)).toBe('NOT_CHECKED');
  });

  it.each(['NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR', 'UNKNOWN_ERROR', 'BAD_DATA'])(
    'transport failure %s is NOT_CHECKED, never a revert',
    (code) => {
      expect(classifyOwnerOfError({ code })).toBe('NOT_CHECKED');
    },
  );

  it('an error with no code fails SAFE — NOT_CHECKED, not REVERTED', () => {
    // Direction matters. Claiming "the contract reverted" is a positive assertion about the
    // chain and needs evidence; absent evidence the honest answer is that we did not check.
    expect(classifyOwnerOfError(new Error('boom'))).toBe('NOT_CHECKED');
    expect(classifyOwnerOfError({})).toBe('NOT_CHECKED');
    expect(classifyOwnerOfError(null)).toBe('NOT_CHECKED');
    expect(classifyOwnerOfError(undefined)).toBe('NOT_CHECKED');
  });
});

describe('verifyOnChain wiring', () => {
  it('the NOT_CHECKED branch does NOT assert drift', () => {
    // The regression that would be easiest to reintroduce, and the one with teeth: setting
    // `drift: true` on a call that never reached the chain reports a discrepancy with a
    // chain nobody read. Pinned against the source because it is a property of one branch,
    // and a green suite that never entered that branch would say nothing about it.
    const branch = returnBlockFor('NOT_CHECKED');
    expect(branch).toContain('drift: false');
    expect(branch).not.toContain('drift: true');
    // and the revert branch, which SHOULD assert drift, still does — so this pins the
    // distinction rather than just banning a string.
    expect(returnBlockFor('REVERTED')).toContain('drift: true');
  });

  it('every outcome of the cross-check is labelled', () => {
    for (const outcome of ['NO_TOKEN', 'OWNER_FOUND', 'REVERTED', 'NOT_CHECKED']) {
      expect(SOURCE).toContain(`check: '${outcome}'`);
    }
  });

  it('the reason for an unreached chain does not say "reverted"', () => {
    // The string a human reads in a log or a payload. "ownerOf reverted" sent one
    // investigation down the wrong path already; an unreached chain must say so plainly.
    const branch = returnBlockFor('NOT_CHECKED');
    expect(branch).toMatch(/chain not reached/);
    expect(branch).not.toMatch(/ownerOf reverted/);
    expect(returnBlockFor('REVERTED')).toMatch(/ownerOf reverted/);
  });
});
