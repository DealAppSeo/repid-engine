import { ALL_V3_ATTACKS, ALL_V3_SEQUENCES } from '../attacks/v3';
import {
  ATTACK_ATLAS_BY_ID,
  ATLAS_TECHNIQUE_CATALOG,
  lookupAttackAtlas,
  type AttackAtlasEntry,
} from './attack-atlas-map';

export interface AtlasCoverageRow {
  techniqueId: string;
  tactic: string;
  description: string;
  covered: boolean;
  attackCount: number;
  attackIds: string[];
}

export interface AtlasCoverageMatrix {
  generatedAt: string;
  totalAttacks: number;
  mappedAttacks: number;
  techniquesCovered: number;
  techniquesTotal: number;
  gaps: string[];
  rows: AtlasCoverageRow[];
  attackEntries: AttackAtlasEntry[];
}

function extractTechniqueKey(atlasTechnique: string, attackId?: string): string {
  if (attackId === 'sess-pocket-chain') return 'RECON→DESTRUCTIVE';
  if (attackId === 'sess-palisade-chain') return 'RECON→DESTRUCTIVE';
  if (attackId === 'sess-sakana-chain') return 'AML.T0018';
  const recon = atlasTechnique.match(/RECON→[A-Z]+/);
  if (recon) return recon[0];
  if (atlasTechnique.includes('AML.T0007 → AML.T0055')) return 'RECON→CREDENTIAL';
  if (atlasTechnique.includes('AML.T0007 → AML.T0048')) return 'RECON→DESTRUCTIVE';
  const m = atlasTechnique.match(/AML\.T\d+/);
  if (m) return m[0];
  if (atlasTechnique === 'n/a') return 'n/a';
  return atlasTechnique;
}

export function buildAtlasCoverageMatrix(): AtlasCoverageMatrix {
  const allIds = [
    ...ALL_V3_ATTACKS.map((a) => ({ id: a.id, name: a.name })),
    ...ALL_V3_SEQUENCES.map((s) => ({ id: s.id, name: s.name })),
  ];

  const attackEntries = allIds.map(({ id, name }) => lookupAttackAtlas(id, name));

  const techniqueToAttacks = new Map<string, Set<string>>();
  for (const entry of attackEntries) {
    const key = extractTechniqueKey(entry.atlasTechnique, entry.attackId);
    if (key === 'n/a') continue;
    if (!techniqueToAttacks.has(key)) techniqueToAttacks.set(key, new Set());
    techniqueToAttacks.get(key)!.add(entry.attackId);
  }

  const rows: AtlasCoverageRow[] = ATLAS_TECHNIQUE_CATALOG.map((t) => {
    const ids = [...(techniqueToAttacks.get(t.id) ?? [])].sort();
    return {
      techniqueId: t.id,
      tactic: t.tactic,
      description: t.description,
      covered: ids.length > 0,
      attackCount: ids.length,
      attackIds: ids,
    };
  });

  const gaps = rows.filter((r) => !r.covered).map((r) => r.techniqueId);
  const covered = rows.filter((r) => r.covered);

  return {
    generatedAt: new Date().toISOString(),
    totalAttacks: allIds.length,
    mappedAttacks: attackEntries.filter((e) => e.atlasTactic !== 'unmapped').length,
    techniquesCovered: covered.length,
    techniquesTotal: rows.length,
    gaps,
    rows,
    attackEntries,
  };
}