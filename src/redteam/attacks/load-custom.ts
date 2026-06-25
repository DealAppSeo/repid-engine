import fs from 'fs';
import path from 'path';
import { type AttackCase } from '../types';

/**
 * Load *.attack.ts files from attacks/ directory.
 * Each file must export `attack: AttackCase` or `attacks: AttackCase[]`.
 */
export async function loadCustomAttacks(attacksDir: string): Promise<AttackCase[]> {
  if (!fs.existsSync(attacksDir)) return [];

  const files = fs
    .readdirSync(attacksDir)
    .filter((f) => f.endsWith('.attack.ts') && !f.startsWith('template'));

  const out: AttackCase[] = [];
  for (const file of files) {
    const mod = await import(path.join(attacksDir, file));
    if (mod.attack) out.push(mod.attack as AttackCase);
    if (Array.isArray(mod.attacks)) out.push(...(mod.attacks as AttackCase[]));
  }
  return out;
}