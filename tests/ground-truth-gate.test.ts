// ground-truth-gate — the corroboration path is an authority grant, so it is
// tested as one.
//
// This gate lets a LOCAL table overturn an external quorum's verdict. That is
// the right fix for the measured defect (the quorum vetoes TRUE claims about our
// private systems), and it is also the obvious way to launder a false claim:
// drop a row into ground_truth_facts and get anything cleared. Most of what
// follows tests the boundary that stops that.

// ground-truth-gate imports ../db → config.ts, which throws at module scope
// without SUPABASE_URL. Mock it so the gate can be tested as a pure unit.
let mockRows: any[] = [];
let mockError: any = null;
let mockThrows = false;

jest.mock('../src/db', () => ({
  db: {
    from: () => {
      if (mockThrows) throw new Error('boom');
      return { select: async () => ({ data: mockRows, error: mockError }) };
    },
  },
}));

import { checkGroundTruth, isDistinctive, containsValue } from '../src/hal/ground-truth-gate';

const CORRECT = { fact_key: 'chain_name', fact_value: 'Base Sepolia', category: 'chain', match_type: 'exact' };
const WRONG = { fact_key: 'chain_wrong', fact_value: 'Ethereum mainnet', category: 'chain', match_type: 'wrong_value' };

beforeEach(() => {
  mockRows = [CORRECT, WRONG];
  mockError = null;
  mockThrows = false;
});

describe('isDistinctive — the corroboration safety margin', () => {
  it('accepts multi-word proper nouns', () => {
    expect(isDistinctive('Base Sepolia')).toBe(true);
    expect(isDistinctive('Ethereum mainnet')).toBe(true);
  });

  it('accepts long identifiers', () => {
    expect(isDistinctive('0x8004A818BFB912233c491871b3d84c89A494BD9e')).toBe(true);
    expect(isDistinctive('@hyperdag/trustshell')).toBe(true);
  });

  it('accepts numbers only when long enough to mean something', () => {
    expect(isDistinctive('84532')).toBe(true);   // chain id
    expect(isDistinctive('2016')).toBe(false);   // a year — appears everywhere
    expect(isDistinctive('12')).toBe(false);
  });

  it('rejects short values', () => {
    expect(isDistinctive('v1')).toBe(false);
    expect(isDistinctive('P-0')).toBe(false);
  });

  it('ignores surrounding whitespace when judging', () => {
    expect(isDistinctive('  2016  ')).toBe(false);
    expect(isDistinctive('  Base Sepolia  ')).toBe(true);
  });
});

describe('containsValue — word-boundary matching', () => {
  it('matches values delimited by spaces and punctuation', () => {
    expect(containsValue('settlement uses USDC on Base Sepolia.', 'Base Sepolia')).toBe(true);
    expect(containsValue('chainId 84532.', '84532')).toBe(true);
    expect(containsValue('(84532)', '84532')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(containsValue('runs on base sepolia', 'Base Sepolia')).toBe(true);
  });

  it('does NOT match inside a longer number', () => {
    // Prevents "184532" corroborating a claim about chain 84532.
    expect(containsValue('block 184532 was mined', '84532')).toBe(false);
    expect(containsValue('845321', '84532')).toBe(false);
  });

  it('does NOT match inside a longer word', () => {
    expect(containsValue('Basel Sepolian dialect', 'Base Sepolia')).toBe(false);
  });

  it('handles regex metacharacters without throwing or over-matching', () => {
    expect(() => containsValue('installed @hyperdag/trustshell today', '@hyperdag/trustshell')).not.toThrow();
    expect(containsValue('installed @hyperdag/trustshell today', '@hyperdag/trustshell')).toBe(true);
    expect(containsValue('axbxc here', 'a.b.c')).toBe(false); // '.' stays literal
  });
});

describe('checkGroundTruth — verdict precedence', () => {
  it('corroborates a true internal claim (the measured false positive)', async () => {
    const r = await checkGroundTruth('HyperDAG x402 mesh settlement uses USDC on Base Sepolia.');
    expect(r.verdict).toBe('corroborated');
    expect(r.corroborating).toHaveLength(1);
    expect(r.degraded).toBe(false);
  });

  it('contradicts a claim carrying a recorded wrong value', async () => {
    const r = await checkGroundTruth('HyperDAG contracts are deployed on Ethereum mainnet.');
    expect(r.verdict).toBe('contradicted');
  });

  it('CONTRADICTION BEATS CORROBORATION when both appear', async () => {
    // The laundering shape: pad a false claim with true facts. Must not clear.
    const r = await checkGroundTruth('We use Base Sepolia, and the registry is on Ethereum mainnet.');
    expect(r.verdict).toBe('contradicted');
    expect(r.corroborating.length).toBeGreaterThan(0); // it did see the true one
  });

  it('says nothing about claims it holds no fact for', async () => {
    const r = await checkGroundTruth('The Eiffel Tower is located in Paris, France.');
    expect(r.verdict).toBe('no_match');
    expect(r.degraded).toBe(false);
  });

  it('does not corroborate on a non-distinctive value', async () => {
    mockRows = [{ fact_key: 'hyperdag_start_year', fact_value: '2016', category: 'history', match_type: 'exact' }];
    const r = await checkGroundTruth('In 2016 the Chicago Cubs won the World Series.');
    expect(r.verdict).toBe('no_match');
  });

  it('DEGRADES on a database error — an outage must never read as agreement', async () => {
    mockError = { message: 'connection refused' };
    mockRows = [];
    const r = await checkGroundTruth('HyperDAG uses Base Sepolia.');
    expect(r.verdict).toBe('no_match');
    expect(r.degraded).toBe(true);
  });

  it('treats an empty corpus as degraded, not as agreement', async () => {
    mockRows = [];
    const r = await checkGroundTruth('HyperDAG uses Base Sepolia.');
    expect(r.verdict).toBe('no_match');
    expect(r.degraded).toBe(true);
  });

  it('never throws when the db module itself explodes', async () => {
    mockThrows = true;
    const r = await checkGroundTruth('anything at all');
    expect(r.verdict).toBe('no_match');
    expect(r.degraded).toBe(true);
  });

  it('returns no_match on empty input without touching the database', async () => {
    mockThrows = true; // would throw if consulted
    const r = await checkGroundTruth('   ');
    expect(r.verdict).toBe('no_match');
  });
});
