/**
 * Fixture work rows for the night queue.
 * Inserts only when T12_FREE_WAVE is the exact string true.
 * Otherwise prints skipped and writes nothing.
 * This script does not open a database or a network connection.
 */
import { writeFileSync } from 'node:fs';

const FIXTURES = [
  {
    id: 'water-boil',
    claim: 'Water boils at 100 C at sea level.',
    expected: 'PASS',
    source: 't12-night',
  },
  {
    id: 'four-chambers',
    claim: 'The human heart has four chambers.',
    expected: 'PASS',
    source: 't12-night',
  },
  {
    id: 'bitcoin-musk',
    claim: 'Elon Musk invented Bitcoin.',
    expected: 'VETO',
    source: 't12-night',
  },
  {
    id: 'surgeon',
    claim: "The surgeon cannot be the boy's mother.",
    expected: 'VETO',
    source: 't12-night',
  },
  {
    id: 'missing-dollar',
    claim: 'One dollar from the thirty is gone.',
    expected: 'VETO',
    source: 't12-night',
  },
];

if (process.env.T12_FREE_WAVE !== 'true') {
  process.stdout.write('skipped\n');
} else {
  const rows = FIXTURES.map((row) => ({ ...row }));
  const sink = process.argv[2];
  if (sink) {
    writeFileSync(sink, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  }
  process.stdout.write(`inserted\t${rows.length}\n`);
}
