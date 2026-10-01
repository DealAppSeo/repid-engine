import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('sim-hal-quorum', () => {
  const root = path.join(__dirname, '..');
  const script = path.join(root, 'scripts', 'sim-hal-quorum.mjs');
  const fixturePath = path.join(root, 'scripts', 'fixtures', 'hal-correlated.json');

  it('prints per-family first_pass, post_hal, and honest post_hal for at least 8 claims', () => {
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    const lines = out.trim().split(/\r?\n/);
    expect(lines[0]).toBe('claim\tfamily\tfirst_pass\tpost_hal\th_post_hal');

    const summaryLines = lines.filter(
      (l) => l.startsWith('first_pass_') || l.startsWith('post_hal_'),
    );
    expect(summaryLines).toHaveLength(6);

    const rows = lines.slice(1).filter(
      (l) => !l.startsWith('first_pass_') && !l.startsWith('post_hal_'),
    );
    expect(rows.length).toBeGreaterThanOrEqual(8 * 2);

    for (const row of rows) {
      const cells = row.split('\t');
      expect(cells).toHaveLength(5);
      expect(cells).not.toContain('0');
      const [, , first, post, hPost] = cells;
      for (const cell of [first, post, hPost]) {
        expect(['TRUE', 'FALSE', 'NOT_CHECKED']).toContain(cell);
      }
      if (first === 'FALSE' && post === 'TRUE') {
        expect(hPost).not.toBe('TRUE');
      }
    }

    for (const line of summaryLines) {
      const count = line.split('\t')[1];
      expect(count).not.toBe('0');
      expect(Number.isInteger(Number(count))).toBe(true);
    }
  });

  it('fixture expected counts match the honest aggregation and contain no user_id', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      claims: {
        id: string;
        first_pass: Record<string, string>;
        post_hal: string;
        expected: { first_pass: Record<string, number>; post_hal: Record<string, number> };
      }[];
    };
    expect(fixture.claims).toHaveLength(8);

    const totalFirst = { TRUE: 0, FALSE: 0, NOT_CHECKED: 0 };
    const totalPost = { TRUE: 0, FALSE: 0, NOT_CHECKED: 0 };

    for (const claim of fixture.claims) {
      const computedFirst = { TRUE: 0, FALSE: 0, NOT_CHECKED: 0 };
      const computedPost = { TRUE: 0, FALSE: 0, NOT_CHECKED: 0 };
      for (const [family, verdict] of Object.entries(claim.first_pass)) {
        expect(typeof family).toBe('string');
        expect(['TRUE', 'FALSE', 'NOT_CHECKED', 0]).toContain(verdict as unknown as string | number);
        const first = verdict === 'TRUE' ? 'TRUE' : verdict === 'FALSE' ? 'FALSE' : 'NOT_CHECKED';
        const post = claim.post_hal === 'TRUE' ? 'TRUE' : claim.post_hal === 'FALSE' ? 'FALSE' : 'NOT_CHECKED';
        const hPost = first === 'FALSE' && post === 'TRUE' ? 'NOT_CHECKED' : post;
        computedFirst[first] += 1;
        computedPost[hPost] += 1;
      }
      expect(computedFirst).toEqual(claim.expected.first_pass);
      expect(computedPost).toEqual(claim.expected.post_hal);
      for (const k of ['TRUE', 'FALSE', 'NOT_CHECKED'] as const) {
        totalFirst[k] += claim.expected.first_pass[k];
        totalPost[k] += claim.expected.post_hal[k];
      }
    }

    const printed = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    expect(printed).not.toContain('user_id');
    expect(printed).not.toContain('\t0\n');
    expect(printed).toContain(`first_pass_TRUE\t${totalFirst.TRUE}`);
    expect(printed).toContain(`first_pass_FALSE\t${totalFirst.FALSE}`);
    expect(printed).toContain(`first_pass_NOT_CHECKED\t${totalFirst.NOT_CHECKED}`);
    expect(printed).toContain(`post_hal_TRUE\t${totalPost.TRUE}`);
    expect(printed).toContain(`post_hal_FALSE\t${totalPost.FALSE}`);
    expect(printed).toContain(`post_hal_NOT_CHECKED\t${totalPost.NOT_CHECKED}`);

    const src = readFileSync(script, 'utf8');
    expect(src).toContain('hal-correlated.json');
    expect(src).toContain('first_pass FALSE + post_hal TRUE');
    expect(src).not.toContain('supabase');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('.insert(');
  });
});
