import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('actual-vs-claimed', () => {
  const root = path.join(__dirname, '..');
  const script = path.join(root, 'scripts', 'actual-vs-claimed.mjs');
  const claimsPath = path.join(root, 'scripts', 'fixtures', 'actual-vs-claimed-claims.json');
  const receiptsDir = path.join(root, 'scripts', 'fixtures', 'receipts');

  it('prints claim, actual, status and never prints 0', () => {
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    const lines = out.trim().split(/\r?\n/);
    expect(lines[0]).toBe('claim\tactual\tstatus');
    expect(lines.length).toBeGreaterThan(1);

    for (const line of lines.slice(1)) {
      const row = line.split('\t');
      expect(row).toHaveLength(3);
      expect(row).not.toContain('0');
      expect(['TRUE', 'FALSE', 'NOT_CHECKED', 'MATCH', 'MISMATCH']).toContain(row[1]);
      expect(['NOT_CHECKED', 'MATCH', 'MISMATCH']).toContain(row[2]);
      if (row[1] === 'NOT_CHECKED') {
        expect(row[2]).toBe('NOT_CHECKED');
      }
    }
  });

  it('reports NOT_CHECKED when the receipt file is missing', () => {
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    const rows = out.trim().split(/\r?\n/).slice(1).map((line) => line.split('\t'));
    const coldFusion = rows.find((row) => row[0] === 'cold-fusion');
    expect(coldFusion).toBeDefined();
    expect(coldFusion![1]).toBe('NOT_CHECKED');
    expect(coldFusion![2]).toBe('NOT_CHECKED');
  });

  it('reports MATCH when the receipt agrees with the claim', () => {
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    const rows = out.trim().split(/\r?\n/).slice(1).map((line) => line.split('\t'));
    const musk = rows.find((row) => row[0] === 'musk-bitcoin');
    expect(musk).toBeDefined();
    expect(musk![1]).toBe('FALSE');
    expect(musk![2]).toBe('MATCH');
  });

  it('reports MISMATCH when the receipt contradicts the claim', () => {
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    const rows = out.trim().split(/\r?\n/).slice(1).map((line) => line.split('\t'));
    const surgeon = rows.find((row) => row[0] === 'surgeon');
    expect(surgeon).toBeDefined();
    expect(surgeon![1]).toBe('FALSE');
    expect(surgeon![2]).toBe('MISMATCH');
  });

  it('treats a receipt with actual 0 as NOT_CHECKED instead of printing 0', () => {
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    const rows = out.trim().split(/\r?\n/).slice(1).map((line) => line.split('\t'));
    const eiffel = rows.find((row) => row[0] === 'eiffel-rome');
    expect(eiffel).toBeDefined();
    expect(eiffel![1]).toBe('NOT_CHECKED');
    expect(eiffel![2]).toBe('NOT_CHECKED');
  });

  it('reads only local fixtures and does not call out', () => {
    const src = readFileSync(script, 'utf8');
    expect(src).toContain('actual-vs-claimed-claims.json');
    expect(src).not.toContain('supabase');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('.insert(');
    expect(src).not.toContain('HAL');
    expect(src).not.toContain('REAL_STAKING_ENABLED');
    expect(src).not.toContain('HUMAN_AGENT_BIND');
  });
});
