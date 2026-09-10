/**
 * HYP-5 shadow ratchet. Live CALLSITES still name hosts. The shadow chokepoint
 * exists so a later wrap has somewhere to import. Live callers must not import
 * it yet — that would change egress.
 */
import fs from 'fs';
import path from 'path';
import { providerFetch } from '../src/hal/shadow-provider-fetch';

const REPO = path.join(__dirname, '..');
const CALLSITES: readonly string[] = [
  'src/engine/badges.ts',
  'src/hal/classifier.ts',
  'src/hal/completeness.ts',
  'src/hal/crag.ts',
  'src/hal/cross-llm-client.ts',
  'src/hal/fact-check.ts',
  'src/hal/lib/clients/embedding.ts',
  'src/hal/lib/cross-llm/embedding-client.ts',
  'src/hal/lib/cross-llm/index.ts',
  'src/services/adversarial-judge.ts',
  'src/services/pcp-validator.ts',
  'src/services/validation-repid-delta.ts',
];

describe('HYP-5 shadow ratchet', () => {
  it('shadow providerFetch refuses live use', async () => {
    await expect(providerFetch('https://api.groq.com/openai/v1/chat/completions')).rejects.toThrow(
      /shadow/,
    );
  });

  it('no CALLSITE imports the shadow chokepoint yet', () => {
    const hits = CALLSITES.filter((f) =>
      fs.readFileSync(path.join(REPO, f), 'utf8').includes('shadow-provider-fetch'),
    );
    expect(hits).toEqual([]);
  });
});
