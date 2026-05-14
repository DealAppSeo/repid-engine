import * as dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });
import { loadSpokespersonKeys } from '../src/services/signing-keys';

const keys = loadSpokespersonKeys();
console.log('\nSpokesperson signing key status:');
console.log('================================');
for (const [name, info] of Object.entries(keys)) {
  const icon = info.status === 'loaded' ? '✅' : (info.status === 'mismatch' ? '⚠️' : '❌');
  console.log(`${icon} ${name}: ${info.status}${info.message ? ' - ' + info.message : ''}`);
}
