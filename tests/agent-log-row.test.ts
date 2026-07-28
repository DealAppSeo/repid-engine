/**
 * trinity_agent_logs write-contract tests.
 *
 * THE DEFECT THESE EXIST FOR (found in production, 2026-07-27, build-loop Beat 47):
 *   `trinity_agent_logs.agent` is `text NOT NULL` with no default, and the event discriminator
 *   column is `action` — there is no `event_type` column. Seven insert sites in this codebase
 *   omitted `agent`, and one of them also named `event_type`. Every one failed (`23502` / `42703`)
 *   inside a best-effort `catch` or an `if (error) console.error(...)`, so SIX audit actions wrote
 *   ZERO rows for the entire lifetime of the table while appearing to work:
 *     zkp_proof_generated · zkp_proof_verified · dag_node_verified · zkp_batch_generated
 *     · repid_score_changed · repid_gate_shadow
 *   [V, live prod] all six: 0 rows all-time. The natural control is middleware/auth.ts, which
 *   calls the SAME helper on the SAME table in the SAME deploy and does supply `agent`: 29,581
 *   rows in 30 days.
 *
 * The danger was never the missing rows. It was that an empty audit log reads as "nothing
 * happened" rather than "nothing was recorded" — a shadow-mode gate whose shadow log is silently
 * empty is indistinguishable from a gate that found no problems.
 */
import { buildAgentLogRow } from '../src/engine/agent-log-row';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

describe('buildAgentLogRow — the required-column contract', () => {
  it('accepts a well-formed row and passes extra columns through untouched', () => {
    const row = buildAgentLogRow({
      agent: 'trinity-orch',
      action: 'zkp_proof_verified',
      metadata: { tier: 'T1' },
      message: 'hello',
    });
    expect(row.agent).toBe('trinity-orch');
    expect(row.action).toBe('zkp_proof_verified');
    expect(row.message).toBe('hello');
    expect(row.metadata).toEqual({ tier: 'T1' });
  });

  it('REJECTS a missing `agent` — the column is NOT NULL, so this failed 23502 in production', () => {
    // Cast: the type already forbids this. The runtime guard is for callers that arrive via `any`
    // (the raw supabase client is loosely typed, and one call site passes its db in as `any`).
    expect(() => buildAgentLogRow({ action: 'zkp_proof_generated' } as any)).toThrow(/agent.*required/i);
  });

  it('REJECTS an empty-string `agent` — NOT NULL is satisfied but the row is useless', () => {
    expect(() => buildAgentLogRow({ agent: '', action: 'x' } as any)).toThrow(/agent.*required/i);
  });

  it('REJECTS a missing `action`', () => {
    expect(() => buildAgentLogRow({ agent: 'trinity-orch' } as any)).toThrow(/action.*required/i);
  });

  it('REJECTS `event_type` — that column does not exist on the table and naming it fails 42703', () => {
    // This is the exact shape repid-active-gate.ts shipped with: it names event_type AND omits
    // agent, so it failed twice over, and the surrounding catch hid both.
    expect(() =>
      buildAgentLogRow({ agent: 'a', action: 'repid_gate_shadow', event_type: 'repid_gate_shadow' } as any),
    ).toThrow(/event_type/i);
  });

  it('rejects the pre-fix repid-active-gate row verbatim', () => {
    expect(() =>
      buildAgentLogRow({ agent_name: 'sophia', event_type: 'repid_gate_shadow', metadata: {} } as any),
    ).toThrow();
  });
});

/**
 * The guard above only binds callers that USE it. This scan is what stops the next insert from
 * quietly bypassing it — the same defect would otherwise be reintroducible in one line.
 */
describe('no trinity_agent_logs insert bypasses the contract', () => {
  const SRC = join(__dirname, '..', 'src');

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  // Every `.from('trinity_agent_logs').insert(<arg>` in src/, with the first ~80 chars of <arg>.
  const INSERT_RE = /\.from\(\s*['"]trinity_agent_logs['"]\s*\)\s*\.insert\(([\s\S]{0,80})/g;
  const sites = walk(SRC).flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return Array.from(text.matchAll(INSERT_RE)).map((m) => ({
      file: file.slice(SRC.length + 1),
      arg: m[1] ?? '',
    }));
  });

  // GUARD ON THE GUARD. Without this, a regex that silently stops matching turns the whole suite
  // below into a vacuous pass over an empty list — which is precisely the "weaker property" class
  // that let the original bug survive. If the matcher breaks, this fails loudly instead.
  it('the scan actually finds the known insert sites (fails loudly if the matcher breaks)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(4);
  });

  it('every insert site constructs its row through buildAgentLogRow (or is the helper itself)', () => {
    const offenders = sites.filter(
      (s) => !/buildAgentLogRow\(|buildRow\(/.test(s.arg),
    );
    expect(offenders.map((o) => `${o.file}: .insert(${o.arg.slice(0, 60).replace(/\s+/g, ' ')}…`)).toEqual([]);
  });

  it('no trinity_agent_logs insert names an `event_type` column (it does not exist — 42703)', () => {
    // Scoped to the insert ARGUMENT, not the whole file: `types/database.types.ts` is generated
    // and legitimately contains `event_type:` for other tables. Checking file-wide flagged it —
    // the invariant is about what is written to THIS table, so that is what is inspected.
    const bad = sites.filter((s) => /\bevent_type\s*:/.test(s.arg));
    expect(bad.map((b) => `${b.file}: ${b.arg.slice(0, 60).replace(/\s+/g, ' ')}`)).toEqual([]);
  });
});
