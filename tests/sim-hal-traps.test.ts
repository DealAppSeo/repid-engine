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
    expect(lines[0]).toBe(
      'trap\tid\tfirst_pass_verdict\tfirst_pass_at\tpost_hal_verdict\tpost_hal_at',
    );
    expect(lines).toHaveLength(11);
    const rows = lines.slice(1).map((line) => line.split('\t'));
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row[2] === 'TRUE' || row[2] === 'FALSE' || row[2] === 'NOT_CHECKED').toBe(true);
      expect(row[4] === 'TRUE' || row[4] === 'FALSE' || row[4] === 'NOT_CHECKED').toBe(true);
      expect(row[2]).not.toBe('0');
      expect(row[4]).not.toBe('0');
      expect(row).not.toContain('0');
    }
    const byId = new Map(rows.map((row) => [row[1], row]));
    expect(byId.get('surgeon-none')?.[2]).toBe('NOT_CHECKED');
    expect(byId.get('surgeon-none')?.[4]).toBe('FALSE');
    expect(byId.get('birthday-183')?.[4]).toBe('NOT_CHECKED');
    expect(byId.get('ravens-apple')?.[4]).toBe('NOT_CHECKED');
    expect(byId.get('monty-rule')?.[2]).toBe('NOT_CHECKED');
    expect(byId.get('monty-two-thirds')?.[2]).toBe('TRUE');
    expect(byId.get('monty-two-thirds')?.[4]).toBe('FALSE');
  });

  it('uses the ten fixture claims and does not insert them', () => {
    const src = readFileSync(script, 'utf8');
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { claims: { trap: string }[] };
    expect(fixture.claims).toHaveLength(10);
    const traps = fixture.claims.map((claim) => claim.trap).sort();
    expect(traps).toEqual([
      'birthday',
      'birthday',
      'missing-dollar',
      'missing-dollar',
      'monty-underspecified',
      'monty-underspecified',
      'ravens',
      'ravens',
      'surgeon',
      'surgeon',
    ]);
    expect(src).toContain('hal-traps.json');
    expect(src).toContain("'NOT_CHECKED'");
    expect(src).not.toContain('supabase');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('.insert(');
    const printed = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    expect(printed).not.toContain('user_id');
  });
});
