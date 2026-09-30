import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runLivePack, type LiveClaim } from '../src/hal/live-pack';

const IDS = [
  'musk-bitcoin',
  'vitamin-c',
  'surgeon',
  'missing-dollar',
  'birthday',
  'ravens',
  'cold-fusion',
  'eiffel-rome',
];

function mock(columns: 'present' | 'missing') {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  let calls = 0;
  const client = {
    from(table: string) {
      calls += 1;
      return {
        select() {
          return {
            async limit() {
              if (columns === 'missing') return { error: { message: 'column missing' } };
              return { error: null };
            },
          };
        },
        async insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return { error: null };
        },
      };
    },
  };
  return { client, inserts, calls: () => calls };
}

describe('e2e live pack', () => {
  const root = path.join(__dirname, '..');
  const fixturePath = path.join(root, 'scripts', 'fixtures', 'live-claims.json');
  const script = path.join(root, 'scripts', 'e2e-live-pack.mjs');
  const claims = JSON.parse(readFileSync(fixturePath, 'utf8')) as LiveClaim[];

  it('reads the eight fixture ids and nothing else', () => {
    expect(claims.map((row) => row.id)).toEqual(IDS);
    const raw = readFileSync(fixturePath, 'utf8');
    expect(raw).not.toContain('user_id');
    expect(raw).not.toContain('"claim"');
  });

  it('prints skipped and inserts nothing unless the flag is exact true', async () => {
    const db = mock('present');
    for (const flag of [undefined, '', 'TRUE', '1', 'on']) {
      const env: Record<string, string | undefined> = {};
      if (flag !== undefined) env.HAL_QUORUM_RECEIPT_ENABLED = flag;
      const { lines } = await runLivePack(claims, db.client, env);
      expect(lines).toHaveLength(8);
      for (const line of lines) expect(line.endsWith('\tskipped')).toBe(true);
    }
    expect(db.calls()).toBe(0);
    expect(db.inserts).toHaveLength(0);
  });

  it('verifies each id and prints inserted when the flag is exact true', async () => {
    const db = mock('present');
    const { lines } = await runLivePack(claims, db.client, { HAL_QUORUM_RECEIPT_ENABLED: 'true' });
    expect(lines.map((line) => line.split('\t')[0])).toEqual(IDS);
    expect(lines.every((line) => line.endsWith('\tinserted'))).toBe(true);
    expect(db.inserts).toHaveLength(8);
    for (const insert of db.inserts) {
      expect(insert.table).toBe('hal_quorum_validator_votes');
      expect(insert.row).not.toHaveProperty('user_id');
      expect(JSON.stringify(insert.row)).not.toContain('user_id');
      expect(Object.keys(insert.row)).not.toContain('claim');
    }
    expect(lines.join('\n')).not.toContain('user_id');
  });

  it('prints columns-missing and inserts nothing when the columns are absent', async () => {
    const db = mock('missing');
    const { lines } = await runLivePack(claims, db.client, { HAL_QUORUM_RECEIPT_ENABLED: 'true' });
    expect(lines.every((line) => line.endsWith('\tcolumns-missing'))).toBe(true);
    expect(db.inserts).toHaveLength(0);
  });

  it('a numeric 0 pass prints NOT_CHECKED', async () => {
    const db = mock('present');
    const { lines } = await runLivePack(
      [{ id: 'musk-bitcoin', receipt_id: 1, family: 'llama', host: 'groq', first_pass_verdict: 0, post_hal_verdict: 0 }],
      db.client,
      {},
    );
    expect(lines[0]).toBe('musk-bitcoin\tNOT_CHECKED\tNOT_CHECKED\tllama\tgroq\tskipped');
  });

  it('the script prints skipped when the flag is unset', () => {
    const env = { ...process.env };
    delete env.HAL_QUORUM_RECEIPT_ENABLED;
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env });
    const lines = out.trim().split(/\r?\n/);
    expect(lines).toHaveLength(8);
    expect(lines.map((line) => line.split('\t')[0])).toEqual(IDS);
    expect(lines.every((line) => line.endsWith('\tskipped'))).toBe(true);
  });

  it('the script prints inserted when the flag is exact true', () => {
    const env = { ...process.env, HAL_QUORUM_RECEIPT_ENABLED: 'true' };
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env });
    const lines = out.trim().split(/\r?\n/);
    expect(lines).toHaveLength(8);
    expect(lines.map((line) => line.split('\t')[0])).toEqual(IDS);
    expect(lines.every((line) => line.endsWith('\tinserted'))).toBe(true);
    expect(out).not.toContain('user_id');
  });
});
