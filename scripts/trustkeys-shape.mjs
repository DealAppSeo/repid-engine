/**
 * Classify a fixed list of env names by value shape.
 * Prints the name and the shape word only. Never prints a value.
 */
const NAMES = [
  'SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SERVICE_KEY',
  'DATABASE_URL',
];

const SHAPES = new Set(['sb_secret', 'postgresql', 'unset', 'other']);

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

function shape(value) {
  if (typeof value !== 'string' || value.length === 0) return 'unset';
  if (value.startsWith('sb_secret_')) return 'sb_secret';
  if (value.startsWith('postgresql://') || value.startsWith('postgres://')) return 'postgresql';
  return 'other';
}

const lines = [];
for (const name of NAMES) {
  const label = shape(process.env[name]);
  if (!SHAPES.has(label)) fail(`bad shape for ${name}`);
  lines.push(`${name}\t${label}`);
}

process.stdout.write(`${lines.join('\n')}\n`);
