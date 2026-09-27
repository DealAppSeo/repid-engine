/**
 * Base Sepolia faucet stand-in.
 * DRY_RUN=1 prints a no-send plan and exits 0.
 * Any other value refuses. This file holds no key and sends nothing.
 */
const dry = process.env.DRY_RUN === '1';
if (!dry) {
  process.stderr.write('refusing: DRY_RUN must be 1\n');
  process.exit(2);
}

process.stdout.write('dry_run\t1\nnetwork\tbase-sepolia\nchain_id\t84532\nsends_eth\tfalse\n');
process.exit(0);
