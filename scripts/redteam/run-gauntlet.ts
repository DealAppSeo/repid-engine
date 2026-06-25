#!/usr/bin/env npx ts-node
/**
 * CLI: run governance gauntlet and print scoreboard.
 *   npx ts-node scripts/redteam/run-gauntlet.ts
 */
import path from 'path';
import fs from 'fs';
import { runGauntlet, formatScoreboard } from '../../src/redteam/gauntlet-runner';
import { loadCustomAttacks } from '../../src/redteam/attacks/load-custom';
import { BUILTIN_ATTACKS } from '../../src/redteam/attacks/builtin';

const repoRoot = path.resolve(__dirname, '../..');

async function main() {
  const custom = await loadCustomAttacks(path.join(repoRoot, 'attacks'));
  const sb = runGauntlet({ repoRoot, attacks: [...BUILTIN_ATTACKS, ...custom] });
  const outPath = path.join(repoRoot, '.redteam-scoreboard.json');
  fs.writeFileSync(outPath, JSON.stringify(sb, null, 2));
  console.log(formatScoreboard(sb));
  console.log(`\nWrote ${outPath}`);
  process.exit(sb.breaches > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});