/**
 * No runnable migration may write a hardcoded on-chain identifier.
 *
 * `migrations/2026-06-03-eas-attestation-backfill.sql` copied three attestation UIDs out of the
 * Base Sepolia EAS explorer and wrote them onto our own rows so a report could link to easscan
 * and look verified. Its own comments said so: "real example UIDs from Base Sepolia EAS explorer
 * for verifiability in report."
 *
 * Those attestations are real and they are not ours. They attest nothing about any agent here. A
 * row carrying one asserts an on-chain fact it did not earn, in the most convincing possible
 * form — a valid 66-character UID that RESOLVES in a public explorer. An obvious stub
 * (`eas-stub-<ts>-<id>`) announces itself; this does the opposite.
 *
 * It was never applied (measured 2026-09-03: zero rows carry those UIDs). The hazard was that it
 * sat in `migrations/` looking like an ordinary pending backfill someone would reasonably run. It
 * is now renamed off `.sql` and fully commented out; this test is what stops the next one.
 *
 * Scope is deliberately narrow — a literal 0x-hex chain identifier assigned to an attestation,
 * transaction or merkle column — so it flags manufactured evidence and not ordinary SQL.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'migrations');

/** Only files a runner would actually execute. `.DO-NOT-RUN` and friends are out of scope. */
const runnable = readdirSync(MIGRATIONS)
  .filter((f) => f.toLowerCase().endsWith('.sql'))
  .filter((f) => statSync(join(MIGRATIONS, f)).isFile());

/** Strip `--` line comments and `/* *\/` blocks, so a neutralised file reads as empty. */
function executableSql(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
}

const CHAIN_COLUMNS = ['eas_attestation_uid', 'attestation_uid', 'tx_hash', 'txid', 'merkle_root'];

describe('migrations do not hardcode chain evidence', () => {
  it('sees the migrations directory (not vacuously green)', () => {
    expect(runnable.length).toBeGreaterThan(0);
  });

  it('no runnable migration assigns a literal 0x identifier to a chain column', () => {
    const offenders: string[] = [];
    for (const f of runnable) {
      const sql = executableSql(readFileSync(join(MIGRATIONS, f), 'utf8'));
      for (const col of CHAIN_COLUMNS) {
        // `col = '0x…'` — an assignment of a literal chain identifier, in a SET or a VALUES list.
        const re = new RegExp(`${col}\\s*=\\s*'0x[0-9a-fA-F]{16,}'`, 'g');
        const hits = sql.match(re);
        if (hits) offenders.push(`${f}: ${hits.length}× literal assignment to ${col}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('both neutralised backfills are inert and unrunnable', () => {
    // Both halves matter. Renaming alone leaves live statements one `mv` away from running;
    // commenting alone leaves a `.sql` a glob still picks up.
    //
    // The SECOND file was found by this very test on its first run, which is the argument for
    // writing the guard rather than fixing the one file by hand: the 06-03 migration borrowed
    // another project's attestations, and the 06-05 one — invisible until the scan — carries
    // OUR real UIDs under statements that no longer select the rows its own header documents.
    for (const stem of ['2026-06-03-eas-attestation-backfill', '2026-06-05-eas-c1-backfill']) {
      expect(runnable).not.toContain(`${stem}.sql`);
      const live = executableSql(readFileSync(join(MIGRATIONS, `${stem}.sql.DO-NOT-RUN`), 'utf8'))
        .split('\n')
        .filter((l) => l.trim().length > 0);
      expect(live).toEqual([]);
    }
  });

  it('the rule has teeth — it matches the statement that actually shipped', () => {
    const shipped = `UPDATE repid_zkp_proofs
      SET eas_attestation_uid = '0x6bf7a836a3f2fe108ba71edd127611cb6284fb2a6de1666799b2bedc9d753f4b',
          eas_schema = 'constitutional-compliance-v1'
      WHERE merkle_root IS NOT NULL AND eas_attestation_uid IS NULL LIMIT 4;`;
    const re = /eas_attestation_uid\s*=\s*'0x[0-9a-fA-F]{16,}'/g;
    expect(executableSql(shipped).match(re)).toHaveLength(1);
    // …and that a commented-out copy of the same line does NOT match, or the guard would
    // flag every neutralised file forever and get switched off.
    expect(executableSql('-- ' + shipped.replace(/\n/g, '\n-- ')).match(re)).toBeNull();
  });
});
