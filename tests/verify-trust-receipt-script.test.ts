/**
 * The public verifier's own tests.
 *
 * `scripts/verify-trust-receipt.mjs` is the artifact a stranger runs to check a
 * trust receipt without trusting us. It shipped with NO test of its own, which
 * is the wrong way round: it is the one piece of this repo whose whole value is
 * that its verdict can be relied on by someone who cannot read the code.
 *
 * These drive the REAL script as a subprocess — `--file`, so no network — and
 * assert on what it prints and the exit code it returns. Testing it any other
 * way (importing a copy of the logic) would prove the copy agrees with itself,
 * which is exactly the failure the script's own header refuses.
 *
 * THE CASE THAT MATTERS MOST is `an honest decay is NOT_CHECKED, never FAILED`.
 * The leg was originally `to - from === delta`, which is not the engine's
 * accounting: `repid_before` is written pre-decay and `repid_after` is
 * clamp(decayed + delta), so decay and the clamp both move a score without
 * appearing in `delta`. That check would have called an honest decayed row a
 * forgery. It passed on the live ledger only because no contract-linked event
 * has decayed yet (measured 2026-09-04, 1,339 events) — a green tick borrowed
 * from a hard case that had not happened.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', 'scripts', 'verify-trust-receipt.mjs');
const DIR = mkdtempSync(join(tmpdir(), 'receipt-verify-'));

interface RepEvent {
  agent: string;
  event: string;
  delta: number;
  from: number;
  to: number;
  decay?: number | null;
}

/** A receipt with only the fields these legs read. */
function receipt(events: RepEvent[]): Record<string, unknown> {
  return {
    contract_id: 'test-contract',
    settled_at: '2026-09-04T00:00:00Z',
    buyer: 'buyer-agent',
    provider: 'provider-agent',
    reputation_events: events,
  };
}

/** Run the real script against a receipt; never throws on a non-zero exit. */
function run(r: Record<string, unknown>): { code: number; out: string } {
  const file = join(DIR, `r-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(r));
  try {
    const out = execFileSync('node', [SCRIPT, '--file', file], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** The `reputation ledger arithmetic` line, as the script prints it. */
function ledgerLine(out: string): string {
  const line = out.split('\n').find((l) => l.includes('reputation ledger arithmetic'));
  if (!line) throw new Error(`no ledger leg in output:\n${out}`);
  return line;
}
const outcomeOf = (line: string): 'VERIFIED' | 'NOT_CHECKED' | 'FAILED' =>
  line.includes('FAIL') ? 'FAILED' : line.includes('??') ? 'NOT_CHECKED' : 'VERIFIED';

describe('verify-trust-receipt: reputation ledger arithmetic', () => {
  it('VERIFIED when the score lands exactly on from + delta', () => {
    const { out } = run(receipt([{ agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 1020 }]));
    expect(outcomeOf(ledgerLine(out))).toBe('VERIFIED');
  });

  it('VERIFIED when a recorded decay closes the identity', () => {
    // clamp(1000 - 30 + 20) = 990. `to - from` is -10, nothing like the +20
    // delta, and this is a perfectly honest row.
    const { out } = run(
      receipt([{ agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 990, decay: 30 }]),
    );
    expect(outcomeOf(ledgerLine(out))).toBe('VERIFIED');
  });

  it('THE REGRESSION: an unexplained DROP is NOT_CHECKED, not FAILED', () => {
    // The old `to - from === delta` check called this a rewritten ledger. It is
    // the shape of an honest decay whose decomposition nobody recorded — and
    // decay is unrecorded on every contract-linked event in the live ledger, so
    // this is the common case, not an exotic one.
    const line = ledgerLine(run(receipt([
      { agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 990 },
    ])).out);
    expect(outcomeOf(line)).toBe('NOT_CHECKED');
    // and it must say WHY, naming both causes it cannot distinguish
    expect(line).toMatch(/decay or the 10000 cap/);
  });

  it('FAILED when a recorded decay does NOT close the identity', () => {
    // Decay is stated, so there is nothing left to be undetermined about.
    const { out, code } = run(
      receipt([{ agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 1015, decay: 30 }]),
    );
    expect(outcomeOf(ledgerLine(out))).toBe('FAILED');
    expect(code).toBe(1);
  });

  it('FAILED on negative decay — decay only ever lowers a score', () => {
    const { out } = run(
      receipt([{ agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 1050, decay: -30 }]),
    );
    expect(ledgerLine(out)).toMatch(/negative/);
    expect(outcomeOf(ledgerLine(out))).toBe('FAILED');
  });

  it('FAILED when a score rises ABOVE its own delta away from the floor', () => {
    // The fraud this leg exists to catch: award yourself more than you recorded.
    // Nothing in the engine lifts a score above its delta except the floor.
    const { out, code } = run(receipt([
      { agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 1500 },
    ]));
    expect(outcomeOf(ledgerLine(out))).toBe('FAILED');
    expect(code).toBe(1);
  });

  it('VERIFIED when the rise above the delta lands exactly on the floor', () => {
    // clamp lifting a would-be sub-floor score to 10 is the one legitimate cause.
    const { out } = run(receipt([{ agent: 'a', event: 'VALIDATION_FAILED', delta: -100, from: 60, to: 10 }]));
    expect(outcomeOf(ledgerLine(out))).toBe('VERIFIED');
  });

  it('FAILED on a score outside the published [10, 10000] range', () => {
    const { out } = run(receipt([{ agent: 'a', event: 'SERVICE_FULFILLED', delta: 40, from: 10000, to: 10040 }]));
    expect(ledgerLine(out)).toMatch(/outside the published/);
    expect(outcomeOf(ledgerLine(out))).toBe('FAILED');
  });

  it('FAILED when one agent’s events do not chain', () => {
    const { out } = run(receipt([
      { agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 1020 },
      { agent: 'a', event: 'SERVICE_SATISFIED', delta: 30, from: 1500, to: 1530 }, // 1020 -> 1500
    ]));
    expect(ledgerLine(out)).toMatch(/previous event ended at 1020/);
    expect(outcomeOf(ledgerLine(out))).toBe('FAILED');
  });

  /**
   * `to === from + delta` with no published decay is NOT the identity closing.
   * It means the row balances IF no decay was applied, and the receipt never
   * says that — a writer that decayed by D and inflated by the same D lands
   * here too. The verdict stays VERIFIED (the books do balance as published),
   * but the assumption has to be on the page, or the reader takes the green
   * tick for a decomposition that was never checked.
   *
   * This is not a corner: measured 2026-09-04, decay is unpublished on every
   * contract-linked event in the live ledger, so this is what a stranger
   * running the verifier against production sees today.
   */
  it('names the no-decay ASSUMPTION when it verified without a published decay', () => {
    const line = ledgerLine(run(receipt([
      { agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 1020 },
    ])).out);
    expect(outcomeOf(line)).toBe('VERIFIED');
    expect(line).toMatch(/NO decay is published/);
    expect(line).toMatch(/this receipt does not state/);
  });

  it('claims the decomposition only for the events that published one', () => {
    const line = ledgerLine(run(receipt([
      { agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 990, decay: 30 },
      { agent: 'b', event: 'SERVICE_FULFILLED', delta: 20, from: 2000, to: 2020 },
    ])).out);
    expect(outcomeOf(line)).toBe('VERIFIED');
    expect(line).toMatch(/1 decompose against a published decay/);
    expect(line).toMatch(/other 1 balance against from\/delta alone/);
  });

  it('claims a clean decomposition only when every event published a decay', () => {
    const line = ledgerLine(run(receipt([
      { agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 990, decay: 30 },
    ])).out);
    expect(outcomeOf(line)).toBe('VERIFIED');
    expect(line).toMatch(/every score lands exactly where its own from\/decay\/delta put it/);
    expect(line).not.toMatch(/does not state/);
  });

  it('separate agents chain independently', () => {
    const { out } = run(receipt([
      { agent: 'buyer', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 1020 },
      { agent: 'provider', event: 'SERVICE_FULFILLED', delta: 20, from: 3000, to: 3020 },
    ]));
    expect(outcomeOf(ledgerLine(out))).toBe('VERIFIED');
  });
});

describe('verify-trust-receipt: the delta-earned leg states what it cannot prove', () => {
  it('is always NOT_CHECKED when there are events, however clean the arithmetic', () => {
    const { out } = run(receipt([{ agent: 'a', event: 'SERVICE_FULFILLED', delta: 20, from: 1000, to: 1020 }]));
    const line = out.split('\n').find((l) => l.includes('reputation delta earned'));
    expect(line).toBeDefined();
    expect(outcomeOf(line as string)).toBe('NOT_CHECKED');
  });

  it('spells out the over-read it exists to prevent', () => {
    // Without this, "reputation ledger arithmetic VERIFIED" reads as "the
    // reputation was earned", which is a claim no leg on this receipt supports.
    const { out } = run(receipt([{ agent: 'a', event: 'SERVICE_FULFILLED', delta: 500, from: 1000, to: 1500 }]));
    const line = out.split('\n').find((l) => l.includes('reputation delta earned')) as string;
    expect(line).toMatch(/never as "the reputation was earned"/);
  });

  it('is absent when there are no events, rather than asserting about nothing', () => {
    const { out } = run(receipt([]));
    expect(out).not.toMatch(/reputation delta earned/);
  });
});
