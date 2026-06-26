import path from 'path';
import fs from 'fs';
import { buildAtlasCoverageMatrix } from '../../src/redteam/atlas/coverage-matrix';
import { ALL_V3_ATTACKS, ALL_V3_SEQUENCES } from '../../src/redteam/attacks/v3';
import { ATTACK_ATLAS_BY_ID } from '../../src/redteam/atlas/attack-atlas-map';

const DOCS_DIR = path.join(path.resolve(__dirname, '../..'), 'docs', 'redteam');

describe('ATLAS coverage matrix (round-7 phase 1)', () => {
  const allIds = [...ALL_V3_ATTACKS.map((a) => a.id), ...ALL_V3_SEQUENCES.map((s) => s.id)];

  it('maps every v3 gauntlet attack to an ATLAS entry', () => {
    const missing = allIds.filter((id) => !ATTACK_ATLAS_BY_ID[id]);
    expect(missing).toEqual([]);
  });

  it('produces coverage matrix JSON', () => {
    const matrix = buildAtlasCoverageMatrix();
    fs.mkdirSync(DOCS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DOCS_DIR, 'atlas-coverage-round7.json'),
      JSON.stringify(matrix, null, 2)
    );

    expect(matrix.totalAttacks).toBe(allIds.length);
    expect(matrix.techniquesCovered).toBeGreaterThanOrEqual(8);
    expect(matrix.gaps.length).toBeGreaterThan(0);

    // eslint-disable-next-line no-console
    console.log('\n=== ATLAS COVERAGE ===');
    // eslint-disable-next-line no-console
    console.log(`covered: ${matrix.techniquesCovered}/${matrix.techniquesTotal} techniques`);
    // eslint-disable-next-line no-console
    console.log('gaps:', matrix.gaps.join(', '));
  });
});