import * as fs from 'fs';
import * as path from 'path';
import { getKeyHealth } from '../../src/services/key-health';

const JSON_FILE_PATH = path.join(process.cwd(), 'key-health.json');

describe('Key-Health Registry Tests', () => {
  let backupData: string | null = null;

  beforeAll(() => {
    if (fs.existsSync(JSON_FILE_PATH)) {
      backupData = fs.readFileSync(JSON_FILE_PATH, 'utf8');
    }
  });

  afterAll(() => {
    if (backupData !== null) {
      fs.writeFileSync(JSON_FILE_PATH, backupData, 'utf8');
    } else if (fs.existsSync(JSON_FILE_PATH)) {
      fs.unlinkSync(JSON_FILE_PATH);
    }
  });

  it('should return UNKNOWN if key-health.json is missing', () => {
    if (fs.existsSync(JSON_FILE_PATH)) {
      fs.unlinkSync(JSON_FILE_PATH);
    }
    const res = getKeyHealth('openai');
    expect(res.status).toContain('UNKNOWN');
  });

  it('should return correct health status if record is fresh', () => {
    const mockRecord = [
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
        status: 'LIVE',
        last_checked: new Date().toISOString(),
        latency_ms: 100
      }
    ];
    fs.writeFileSync(JSON_FILE_PATH, JSON.stringify(mockRecord, null, 2), 'utf8');

    const res = getKeyHealth('openai');
    expect(res.status).toBe('LIVE');
    
    // Case insensitivity check
    const resUpper = getKeyHealth('OPENAI');
    expect(resUpper.status).toBe('LIVE');
  });

  it('should return UNKNOWN if record is stale', () => {
    const mockRecord = [
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
        status: 'LIVE',
        last_checked: new Date(Date.now() - 70 * 60 * 1000).toISOString(), // 70 minutes ago
        latency_ms: 100
      }
    ];
    fs.writeFileSync(JSON_FILE_PATH, JSON.stringify(mockRecord, null, 2), 'utf8');

    const res = getKeyHealth('openai', 60); // 60 minutes limit
    expect(res.status).toContain('UNKNOWN');
  });
});
