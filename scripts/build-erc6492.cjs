#!/usr/bin/env node
/**
 * Rebuilds src/services/erc6492-bytecode.ts from contracts/erc6492/UniversalSigValidator.sol.
 *
 * The bytecode is committed so the engine never compiles Solidity at runtime. This script is how
 * anyone checks that the committed constant is what the committed source compiles to:
 *   node scripts/build-erc6492.cjs          rewrite the .ts file
 *   node scripts/build-erc6492.cjs --print  print the bytecode only (used by the test)
 */
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'contracts', 'erc6492', 'UniversalSigValidator.sol');
const OUT = path.join(ROOT, 'src', 'services', 'erc6492-bytecode.ts');

function compileValidator() {
  const input = {
    language: 'Solidity',
    sources: { 'U.sol': { content: fs.readFileSync(SOURCE, 'utf8') } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['evm.bytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const fatal = (out.errors || []).filter((e) => e.severity === 'error');
  if (fatal.length) throw new Error(fatal.map((e) => e.formattedMessage).join('\n'));
  return '0x' + out.contracts['U.sol'].ValidateSigOffchain.evm.bytecode.object;
}

module.exports = { compileValidator };

if (require.main === module) {
  const bytecode = compileValidator();
  if (process.argv.includes('--print')) {
    process.stdout.write(bytecode + '\n');
  } else {
    const current = fs.readFileSync(OUT, 'utf8');
    const next = current.replace(/'0x[0-9a-f]+'/, `'${bytecode}'`);
    fs.writeFileSync(OUT, next);
    console.log(`wrote ${OUT} (${(bytecode.length - 2) / 2} bytes, solc ${solc.version()})`);
  }
}
