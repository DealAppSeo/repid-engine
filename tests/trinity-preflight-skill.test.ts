/**
 * trinity-preflight-skill.test.ts
 *
 * Proves the LANE E1 deliverable is REAL, not a promise: the trinity-preflight
 * skill exists on disk, carries valid `name`/`description`/`when-to-use`
 * frontmatter, and still contains every load-bearing directive that fixes
 * "different Claude, different truth". This is a structure guard — if a future
 * edit strips the recency-only liveness rule, the claim gate, the fences, or the
 * anti-idle handoff, this test fails rather than letting the skill silently rot.
 *
 * The skill is STATELESS by design; this test also asserts it carries no cached
 * live-state number (a proof/agent count baked into the file would be the exact
 * drift the skill exists to prevent).
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const SKILL_PATH = join(
  __dirname,
  '..',
  '.claude',
  'skills',
  'trinity-preflight',
  'SKILL.md',
);

describe('trinity-preflight SKILL.md', () => {
  it('exists on disk', () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  const raw = existsSync(SKILL_PATH) ? readFileSync(SKILL_PATH, 'utf8') : '';

  it('opens with YAML frontmatter carrying name, description and when-to-use', () => {
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    expect(fm).not.toBeNull();
    const block = fm![1];
    expect(block).toMatch(/^name:\s*trinity-preflight\s*$/m);
    expect(block).toMatch(/^description:\s*/m);
    expect(block).toMatch(/^when-to-use:\s*/m);
  });

  it('mandates the five preflight steps in order', () => {
    const steps = [
      /Step 1 — STATE your surface and access/,
      /Step 2 — Decide BUILD vs ADVISE-ONLY/,
      /Step 3 — Read fleet liveness from RECENCY only/,
      /Step 4 — Honor the claim gate and the permanent fences/,
      /Step 5 — End on a typed handoff, never idle/,
    ];
    const positions = steps.map((re) => raw.search(re));
    positions.forEach((p) => expect(p).toBeGreaterThan(-1));
    // strictly increasing => correct order
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
    }
  });

  it('declares the three surfaces and the access triad', () => {
    expect(raw).toMatch(/local-CC/);
    expect(raw).toMatch(/cloud\/desktop/);
    expect(raw).toMatch(/Cowork/);
    expect(raw).toMatch(/GH/);
    expect(raw).toMatch(/Railway/);
    expect(raw).toMatch(/Supabase/);
  });

  it('routes liveness to v_fleet_truth / last_ping recency and forbids the status column', () => {
    expect(raw).toMatch(/v_fleet_truth/);
    expect(raw).toMatch(/last_ping/);
    // must explicitly forbid trusting a static status column
    expect(raw).toMatch(/NEVER report liveness from a static `status` column/);
  });

  it('names the claim gate and the permanent fences', () => {
    expect(raw).toMatch(/claim gate/i);
    expect(raw).toMatch(/VERIFIED/);
    expect(raw).toMatch(/BLOCKED_FOR_SEAN/);
    // fences
    expect(raw).toMatch(/No merge to main/i);
    expect(raw).toMatch(/prod-fixture-guard\.js/);
    expect(raw).toMatch(/synthetic ids? only/i);
  });

  it('requires a typed handoff instead of going idle', () => {
    expect(raw).toMatch(/Idle after "done" is a failure/);
    expect(raw).toMatch(/typed handoff/i);
  });

  it('points at exactly the three named sources of truth', () => {
    expect(raw).toMatch(/CLAIM_LEDGER\.md/);
    expect(raw).toMatch(/SPRINT_BOARD\.md/);
    expect(raw).toMatch(/v_fleet_truth/);
  });

  it('is stateless — carries no cached live-state count', () => {
    // Strip the frontmatter, then assert no "N agents online" / "N proofs" style
    // cached figure survived into the body. Percentages (e.g. "≥95%") and the
    // synthetic-id zero-run are allowed; concrete live counts are not.
    const body = raw.replace(/^---\n[\s\S]*?\n---/, '');
    expect(body).not.toMatch(/\b\d{1,3}\s+agents?\s+online\b/i);
    expect(body).not.toMatch(/\b\d[\d,]{2,}\s+proofs?\b/i);
  });
});
