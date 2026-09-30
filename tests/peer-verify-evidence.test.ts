import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readPeerVerifyEvidence } from '../src/services/peer-verify-evidence';

describe('peer-verify missing evidence', () => {
  it('is NOT_CHECKED and never a pass', () => {
    for (const evidence of [undefined, null, '', '   ', [], {}, 0, false]) {
      const reading = readPeerVerifyEvidence(evidence);
      expect(reading.status).toBe('NOT_CHECKED');
      expect(reading.pass).toBeNull();
      expect(reading.pass).not.toBe(true);
      expect(JSON.stringify(reading)).not.toContain('verified');
      expect(JSON.stringify(reading)).not.toContain('"pass":true');
    }
  });

  it('a present body is still not a pass', () => {
    const reading = readPeerVerifyEvidence({ ref: 'artifact-1' });
    expect(reading.status).toBe('seen');
    expect(reading.pass).toBeNull();
    expect(reading.pass).not.toBe(true);
  });

  it('does not score, fetch, or insert', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'services', 'peer-verify-evidence.ts'), 'utf8');
    expect(src).toContain("status: 'NOT_CHECKED'");
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('.insert(');
    expect(src).not.toContain('supabase');
    expect(src).not.toContain('applyValidationEvent');
  });
});
