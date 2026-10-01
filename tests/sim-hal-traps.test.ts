import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('sim-hal-traps', () => {
  const root = path.join(__dirname, '..');
  const script = path.join(root, 'scripts', 'sim-hal-traps.mjs');
  const fixturePath = path.join(root, 'scripts', 'fixtures', 'hal-traps.json');

  it('prints first_pass against post_hal and does not print 0', () => {
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    const lines = out.trim().split(/\r?\n/);
    expect(lines[0]).toBe('trap\tfirst_pass\tpost_hal\tdisagree');
    expect(lines).toHaveLength(11);
    const rows = lines.slice(1).map((line) => line.split('\t'));
    expect(rows).toHaveLength(10);
    let saves = 0;
    let bothTrue = 0;
    for (const row of rows) {
      expect(row).toHaveLength(4);
      expect(row[1] === 'TRUE' || row[1] === 'FALSE' || row[1] === 'NOT_CHECKED').toBe(true);
      expect(row[2] === 'TRUE' || row[2] === 'FALSE' || row[2] === 'NOT_CHECKED').toBe(true);
      expect(row[3] === 'TRUE' || row[3] === 'FALSE' || row[3] === 'NOT_CHECKED').toBe(true);
      expect(row[1]).not.toBe('0');
      expect(row[2]).not.toBe('0');
      expect(row[3]).not.toBe('0');
      expect(row).not.toContain('0');
      if (row[1] === 'NOT_CHECKED' || row[2] === 'NOT_CHECKED') {
        expect(row[3]).toBe('NOT_CHECKED');
      } else if (row[1] === row[2]) {
        expect(row[3]).toBe('FALSE');
      } else {
        expect(row[3]).toBe('TRUE');
      }
      if (row[1] === 'TRUE' && row[2] === 'FALSE') saves += 1;
      if (row[1] === 'TRUE' && row[2] === 'TRUE') bothTrue += 1;
    }
    expect(saves).toBe(4);
    expect(bothTrue).toBe(6);
  });

  it('uses the ten fixture claims and does not insert them', () => {
    const src = readFileSync(script, 'utf8');
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      claims: { id: string; trap: string; claim: string; expected: string }[];
    };
    expect(fixture.claims).toHaveLength(10);
    const expected: Record<string, string> = {
      surgeon: 'TRUE',
      'missing-dollar': 'FALSE',
      'tuesday-boy': 'FALSE',
      monty: 'FALSE',
      'average-speed': 'FALSE',
      disease: 'FALSE',
      ropes: 'TRUE',
      'two-envelope': 'FALSE',
      birthday: 'TRUE',
      ravens: 'TRUE',
    };
    for (const claim of fixture.claims) {
      expect(claim.expected).toBe(expected[claim.id]);
      expect(claim.expected === 'TRUE' || claim.expected === 'FALSE').toBe(true);
      expect(claim.expected).not.toBe('99');
      expect(claim.expected).not.toBe('45');
      expect(claim.claim.endsWith('.')).toBe(true);
      expect(claim.claim.slice(0, -1).includes('.')).toBe(false);
    }
    const disease = fixture.claims.find((claim) => claim.id === 'disease');
    const speed = fixture.claims.find((claim) => claim.id === 'average-speed');
    expect(disease?.expected).toBe('FALSE');
    expect(speed?.expected).toBe('FALSE');
    const traps = fixture.claims.map((claim) => claim.trap).sort();
    expect(traps).toEqual([
      'average-speed',
      'birthday',
      'disease',
      'missing-dollar',
      'monty',
      'ravens',
      'ropes',
      'surgeon',
      'tuesday-boy',
      'two-envelope',
    ]);
    expect(src).toContain('hal-traps.json');
    expect(src).toContain("'NOT_CHECKED'");
    expect(src).toContain('claim is an essay');
    expect(src).toContain('expected is not TRUE or FALSE');
    expect(src).not.toContain('supabase');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('.insert(');
    const printed = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    expect(printed).not.toContain('user_id');
  });

  it('fails closed when a row uses 0 for a missing pass', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      claims: { first_pass_verdict?: unknown; post_hal_verdict?: unknown }[];
    };
    expect(fixture.claims).toHaveLength(10);
    for (const claim of fixture.claims) {
      expect(claim.first_pass_verdict).not.toBe(0);
      expect(claim.first_pass_verdict).not.toBe('0');
      expect(claim.post_hal_verdict).not.toBe(0);
      expect(claim.post_hal_verdict).not.toBe('0');
    }
    const row = JSON.stringify({
      trap: 'surgeon',
      first_pass_verdict: 0,
      post_hal_verdict: '0',
    });
    const out = execFileSync(process.execPath, [script, row], { cwd: root, encoding: 'utf8' });
    expect(out).toBe('surgeon\tNOT_CHECKED\tNOT_CHECKED\tNOT_CHECKED\n');
    expect(out.trim().split('\t')).not.toContain('0');
  });
});
