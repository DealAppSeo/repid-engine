#!/usr/bin/env npx ts-node
/**
 * CLI: run packaged governance gauntlet and print scoreboard.
 *   npx ts-node scripts/redteam/run-packaged-gauntlet.ts
 */
import path from 'path';
import fs from 'fs';
import { guard } from '../../trustrails/guard';
import { BUILTIN_ATTACKS } from '../../src/redteam/attacks/builtin';
import { loadCustomAttacks } from '../../src/redteam/attacks/load-custom';
import { formatScoreboard } from '../../src/redteam/gauntlet-runner';
import { type AttackCase, type AttackResult, type GauntletScoreboard, type AttackSeverity } from '../../src/redteam/types';
import { type Tier } from '../../src/services/consequence-classifier';

const repoRoot = path.resolve(__dirname, '../..');

const TIER_RANK: Record<Tier, number> = { T0: 0, T1: 1, T2: 2 };

const DEFAULT_PROPOSER = {
  agentId: 'attacker',
  provider: 'anthropic' as const,
  lineageProvider: 'anthropic' as const,
  contextHash: 'ctx-attacker',
};

const DEFAULT_ADVERSARY = {
  agentId: 'defender',
  provider: 'groq' as const,
  lineageProvider: 'groq' as const,
  contextHash: 'ctx-defender',
};

const WEAK_OBJECTION = {
  summary: 'minor',
  citations: [{ kind: 'ci_run_id' as const, value: '28080981450' }],
};

const SEVERITY_RANK: Record<AttackSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function evaluatePackagedAttack(
  attack: AttackCase,
  repoRoot?: string
): AttackResult {
  const result = guard(attack.action, {
    repoRoot,
    chamber: {
      actionClass: 'merge',
      proposer: DEFAULT_PROPOSER,
      adversary: DEFAULT_ADVERSARY,
      objection: attack.objection ?? WEAK_OBJECTION,
    }
  });

  const tierOk = TIER_RANK[result.tier] >= TIER_RANK[attack.expectedMinTier];
  let breached = !tierOk;
  let breachReason: string | undefined;

  if (!tierOk) {
    breachReason = `expected min tier ${attack.expectedMinTier}, got ${result.tier} (verdict=${result.verdict})`;
  }

  const isChamber = result.log.chamber !== undefined;
  const chamberOutcome = result.log.chamber?.outcome;

  if (
    isChamber &&
    attack.forbidChamberProceed &&
    chamberOutcome === 'proceed'
  ) {
    breached = true;
    breachReason = breachReason
      ? `${breachReason}; chamber proceeded when forbidden`
      : `chamber outcome proceed forbidden (tier=${result.tier})`;
  }

  // Mock GovernanceVerdict for formatScoreboard
  const mockVerdict: any = {
    tier: result.tier,
    gate: isChamber ? 'chamber' : (result.tier === 'T0' ? 'auto-proceed' : 'hitl'),
    classification: { hits: result.log.rulesFired },
    reason: result.reason,
    decision: isChamber ? { outcome: chamberOutcome } : undefined,
  };

  return {
    attack,
    outcome: breached ? 'BREACH' : 'CAUGHT',
    verdict: mockVerdict,
    breachReason,
  };
}

async function main() {
  const custom = await loadCustomAttacks(path.join(repoRoot, 'attacks'));
  const attacks = [...BUILTIN_ATTACKS, ...custom];
  
  const results = attacks.map((a) => evaluatePackagedAttack(a, repoRoot));

  const caught = results.filter((r) => r.outcome === 'CAUGHT').length;
  const breaches = results.filter((r) => r.outcome === 'BREACH');
  const byCategory: GauntletScoreboard['byCategory'] = {};
  const bySeverity: GauntletScoreboard['bySeverity'] = {
    critical: { total: 0, breaches: 0 },
    high: { total: 0, breaches: 0 },
    medium: { total: 0, breaches: 0 },
    low: { total: 0, breaches: 0 },
  };

  for (const r of results) {
    const cat = r.attack.category;
    if (!byCategory[cat]) byCategory[cat] = { total: 0, caught: 0, breaches: 0 };
    byCategory[cat].total++;
    if (r.outcome === 'CAUGHT') byCategory[cat].caught++;
    else byCategory[cat].breaches++;

    bySeverity[r.attack.severity].total++;
    if (r.outcome === 'BREACH') bySeverity[r.attack.severity].breaches++;
  }

  const holes = [...breaches].sort(
    (a, b) =>
      SEVERITY_RANK[a.attack.severity] - SEVERITY_RANK[b.attack.severity] ||
      a.attack.id.localeCompare(b.attack.id)
  );

  const sb: GauntletScoreboard = {
    runAt: new Date().toISOString(),
    total: results.length,
    caught,
    breaches: breaches.length,
    catchRate: results.length ? caught / results.length : 1,
    byCategory,
    bySeverity,
    results,
    holes,
  };

  const outPath = path.join(repoRoot, '.redteam-packaged-scoreboard.json');
  fs.writeFileSync(outPath, JSON.stringify(sb, null, 2));
  console.log(formatScoreboard(sb));
  console.log(`\nWrote ${outPath}`);
  process.exit(sb.breaches > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
