/**
 * Classify a fixed list of env names by value shape.
 * Prints the name and the shape word only. Never prints a value.
 * Exit 0 when every name is a known shape. Exit 2 when any name is unset or other.
 */
const NAMES = [
  'SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SERVICE_KEY',
  'DATABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
];

const KNOWN = new Set(['sb_secret', 'sb_publishable', 'postgresql', 'jwt_eyJ']);

function shape(value) {
  if (typeof value !== 'string' || value.length === 0) return 'unset';
  if (value.startsWith('sb_secret_')) return 'sb_secret';
  if (value.startsWith('sb_publishable_')) return 'sb_publishable';
  if (value.startsWith('postgresql://') || value.startsWith('postgres://')) return 'postgresql';
  if (value.startsWith('eyJ')) return 'jwt_eyJ';
  return 'other';
}

const lines = [];
let code = 0;
for (const name of NAMES) {
  const label = shape(process.env[name]);
  if (!KNOWN.has(label)) code = 2;
  lines.push(`${name}\t${label}`);
}

process.stdout.write(`${lines.join('\n')}\n`);
process.exit(code);
