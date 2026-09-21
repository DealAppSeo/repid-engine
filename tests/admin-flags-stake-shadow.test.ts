/**
 * admin-flags-stake-shadow.test.ts — the flag reporter must not drift from the gate.
 *
 * `STAKE_AUTHORITY_SHADOW_ENABLED` changes no behaviour, so its state is invisible from
 * outside the process. That is why it needs a reporter — and why the reporter is the thing
 * that can lie: nothing else contradicts it. A flag row announcing a feature ON while the
 * gate has it OFF is worse than no row, because it is believed.
 *
 * WHY THIS READS SOURCE RATHER THAN BOOTING THE ROUTE. `admin-flags.ts` imports
 * `x402-release-retry-worker`, which pulls a tree ending in module-scope construction of
 * `RepIdAttestationService` — real side effects at import time, and a live `getHalConfig`
 * network read per request. Standing all that up to assert one row would test the import
 * graph, not the invariant, and would be the kind of brittle suite that gets muted. The
 * repo already guards this way where the property is structural: `provider-egress-guard`
 * reads source for the same reason.
 *
 * The invariant is structural: the row must CALL the gate's predicate, never restate it.
 * Every other row in that route spells `=== 'true'` inline, so each is two copies of one
 * rule that can diverge. This one is not, and these tests are what keeps it that way.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stakeAuthorityShadowEnabled } from '../src/services/stake-authority-shadow';

const ROUTE = readFileSync(join(__dirname, '../src/routes/admin-flags.ts'), 'utf8');
const FLAG = 'STAKE_AUTHORITY_SHADOW_ENABLED';

describe('admin/flags — stake_authority_shadow_enabled is reported', () => {
  it('the row exists — an unreported money-path flag is the reason it was added', () => {
    expect(ROUTE).toMatch(/stake_authority_shadow_enabled:\s*\{/);
  });

  it('reports `source`, so "set but ignored" is distinguishable from "never set"', () => {
    const row = ROUTE.slice(ROUTE.indexOf('stake_authority_shadow_enabled:'));
    expect(row.slice(0, 400)).toMatch(
      /source:\s*process\.env\['STAKE_AUTHORITY_SHADOW_ENABLED'\]\s*===\s*undefined\s*\?\s*'default'\s*:\s*'env'/,
    );
  });

  it('CALLS the gate predicate — it must not restate the comparison inline', () => {
    const row = ROUTE.slice(ROUTE.indexOf('stake_authority_shadow_enabled:')).slice(0, 400);
    expect(row).toMatch(/value:\s*stakeAuthorityShadowEnabled\(\)/);
    // The drift this file exists to prevent: a second copy of the rule.
    expect(row).not.toMatch(new RegExp(`${FLAG}[^\\n]*===\\s*'true'`));
    expect(row).not.toMatch(/toLowerCase\(\)\s*===\s*'true'/);
  });

  it('imports that predicate from the module that owns the gate', () => {
    expect(ROUTE).toMatch(
      /import\s*\{\s*stakeAuthorityShadowEnabled\s*\}\s*from\s*'\.\.\/services\/stake-authority-shadow'/,
    );
  });

  it('is NOT added to the public readiness allowlist — that would be a disclosure decision', () => {
    // flag-readiness.ts's PUBLIC_FLAGS is for gates an unauthenticated caller can already
    // infer from behaviour. This one changes no behaviour, so it cannot be inferred, and
    // putting it there would disclose rather than report.
    const readiness = readFileSync(join(__dirname, '../src/config/flag-readiness.ts'), 'utf8');
    expect(readiness).not.toContain(FLAG);
  });
});

describe('the predicate the row delegates to', () => {
  const saved = process.env[FLAG];
  afterEach(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['True', true],
    ['1', false],
    ['yes', false],
    ['on', false],
    [' true', false],
    ['', false],
  ])('%p resolves to %p', (v, want) => {
    process.env[FLAG] = v as string;
    expect(stakeAuthorityShadowEnabled()).toBe(want);
  });

  it('unset resolves false', () => {
    delete process.env[FLAG];
    expect(stakeAuthorityShadowEnabled()).toBe(false);
  });
});
