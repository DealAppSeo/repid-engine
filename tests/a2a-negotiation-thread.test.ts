/**
 * A WHOLE NEGOTIATION, END TO END — the path production has never taken.
 *
 * MEASURED against the live database on 2026-09-04, across every bid round ever
 * recorded: `max_round` is 1 on every RFQ, every offer was made by the PROVIDER,
 * no round has ever accepted another, and no award ever landed below list price.
 * The counter-offer half of this negotiation engine — the half that makes it a
 * negotiation rather than a price board — has never once run against real
 * traffic. The sibling suites cover each function alone; nothing walks a thread.
 *
 * That is the gap this file closes. It drives the REAL exported functions in
 * sequence, the way `src/routes/v1/negotiation.ts` calls them, so a regression in
 * how they COMPOSE is caught here even though each one still passes its own unit
 * test. It deliberately does not re-implement any of them: a scenario that
 * reimplements the thing it demonstrates proves only that the copy agrees with
 * itself.
 *
 * The story it walks is the one the seller reserve exists for: a provider that
 * will take at least X but is willing to accept less than it first asked.
 *
 *     provider asks 0.12, will not go below 0.10
 *     buyer counters 0.09   -> REFUSED, under the reserve
 *     buyer counters 0.105  -> allowed
 *     provider tries to drop its own floor to 0.095 -> REFUSED, reserve is fixed
 *     provider accepts 0.105
 */
import { createHash } from 'node:crypto';
import {
  SELLER_RESERVE_TERM,
  parseSellerReserve,
  validateDeclaredReserve,
  threadReserve,
  checkAgainstReserve,
  checkReserveUnchanged,
  validatePrice,
  computeOfferHash,
  verifyStoredOfferHash,
  offerCap,
  roundCapExceeded,
  negotiationConfig,
  type RoundRow,
  type RfqRow,
  type OfferedBy,
} from '../src/services/a2a-negotiation';

const cfg = negotiationConfig();

const USDC = (dollars: number) => Math.round(dollars * 1e6);

const PROVIDER = 'prov-agent-1';
const BUYER = 'buyer-agent-1';

/** The buyer's published band. Deliberately wide, so the RESERVE is what binds. */
const rfq: Pick<RfqRow, 'min_price_usdc_raw' | 'max_price_usdc_raw' | 'max_rounds'> = {
  min_price_usdc_raw: USDC(0.01),
  max_price_usdc_raw: USDC(0.5),
  max_rounds: 3,
};

let seq = 0;
/** A round row exactly as the route would persist it, hash included. */
function round(
  offered_by: OfferedBy,
  round_no: number,
  price: number,
  terms: unknown,
): RoundRow {
  const base = {
    bid_id: 'bid-1',
    round_no,
    offered_by,
    actor_agent_id: offered_by === 'provider' ? PROVIDER : BUYER,
    price_usdc_raw: price,
    eta_seconds: 3600,
    terms,
    expires_at: '2026-09-05T00:00:00.000Z',
  };
  return {
    id: `round-${++seq}`,
    rfq_id: 'rfq-1',
    accepts_round_id: null,
    offer_hash: computeOfferHash(base),
    actor_signature: null,
    actor_signing_address: null,
    signature_verified: false,
    attestation_level: 'server_attested',
    created_at: '2026-09-04T00:00:00.000Z',
    ...base,
  };
}

describe('a negotiation thread, walked the way the route walks it', () => {
  const RESERVE = USDC(0.1);
  const ASK = USDC(0.12);

  /** Round 1: the provider asks 0.12 and commits to a 0.10 floor. */
  function openingOffer(): RoundRow {
    return round('provider', 1, ASK, { [SELLER_RESERVE_TERM]: RESERVE });
  }

  it('the provider may declare a floor below its own ask', () => {
    expect(validateDeclaredReserve(RESERVE, ASK, rfq, cfg)).toEqual({ ok: true });
    expect(validatePrice(ASK, rfq, cfg)).toEqual({ ok: true });
    expect(parseSellerReserve(openingOffer().terms)).toEqual({ ok: true, reserve: RESERVE });
  });

  it('refuses a floor ABOVE the provider’s own ask — that is a contradiction, not a floor', () => {
    const bad = validateDeclaredReserve(USDC(0.2), ASK, rfq, cfg);
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('reserve_above_own_price');
  });

  it('refuses a floor above the buyer’s ceiling up front, not after a thread that could never close', () => {
    const bad = validateDeclaredReserve(USDC(0.6), USDC(0.7), rfq, cfg);
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('reserve_above_rfq_max');
  });

  it('THE COUNTER THE BUYER MAY NOT MAKE: 0.09 is under the declared floor', () => {
    const thread = [openingOffer()];
    const bound = threadReserve(thread);
    expect(bound).toBe(RESERVE);

    // The buyer's counter passes the RFQ band — the band is not what stops it.
    expect(validatePrice(USDC(0.09), rfq, cfg)).toEqual({ ok: true });

    const check = checkAgainstReserve(USDC(0.09), bound);
    expect(check.ok).toBe(false);
    expect(check.error).toBe('below_provider_reserve');
  });

  it('THE COUNTER THE BUYER MAY MAKE: 0.105 clears the floor and is under the ask', () => {
    const thread = [openingOffer()];
    const counter = USDC(0.105);
    expect(counter).toBeLessThan(ASK); // a real concession, not a rubber stamp
    expect(validatePrice(counter, rfq, cfg)).toEqual({ ok: true });
    expect(checkAgainstReserve(counter, threadReserve(thread))).toEqual({ ok: true });
  });

  it('exactly AT the reserve is allowed — the floor is inclusive', () => {
    expect(checkAgainstReserve(RESERVE, RESERVE)).toEqual({ ok: true });
  });

  it('THE MOVE THE PROVIDER MAY NOT MAKE: quietly lowering its own floor when pressed', () => {
    const thread = [openingOffer(), round('buyer', 2, USDC(0.105), {})];
    const bound = threadReserve(thread);

    // The provider rebids, restating a cheaper floor to look accommodating.
    const check = checkReserveUnchanged({ [SELLER_RESERVE_TERM]: USDC(0.095) }, bound);
    expect(check.ok).toBe(false);
    expect(check.error).toBe('reserve_immutable');
  });

  it('and may not drop the floor by omitting it either', () => {
    const bound = threadReserve([openingOffer()]);
    const check = checkReserveUnchanged({}, bound);
    expect(check.ok).toBe(false);
    expect(check.error).toBe('reserve_immutable');
  });

  it('a later provider offer restating the SAME floor is fine', () => {
    const bound = threadReserve([openingOffer()]);
    expect(checkReserveUnchanged({ [SELLER_RESERVE_TERM]: RESERVE }, bound)).toEqual({ ok: true });
  });

  /**
   * The binding reserve is the one on the provider's FIRST round, so a buyer
   * cannot introduce a reserve and a provider cannot append a better one later.
   */
  it('the thread’s floor comes from the provider’s first round, not the newest one', () => {
    const thread = [
      openingOffer(),
      round('buyer', 2, USDC(0.105), { [SELLER_RESERVE_TERM]: USDC(0.4) }), // buyer cannot set one
      round('provider', 3, USDC(0.115), { [SELLER_RESERVE_TERM]: USDC(0.11) }), // nor a later provider round
    ];
    expect(threadReserve(thread)).toBe(RESERVE);
  });

  it('a thread with no provider round yet has no floor', () => {
    expect(threadReserve([])).toBeNull();
    expect(threadReserve([round('buyer', 1, USDC(0.105), {})])).toBeNull();
  });

  it('a provider that declares nothing is simply not using the feature', () => {
    const thread = [round('provider', 1, ASK, {})];
    expect(threadReserve(thread)).toBeNull();
    // ...and then any price in the RFQ band is negotiable, which is the point.
    expect(checkAgainstReserve(USDC(0.02), null)).toEqual({ ok: true });
  });
});

/**
 * THE RESERVE IS AS TAMPER-EVIDENT AS THE PRICE.
 *
 * This is the load-bearing claim of putting it in `terms` instead of a column:
 * `terms` is inside `offerPreimage()` via `canonicalJson`, so the reserve is
 * covered by `offer_hash` — and therefore by the actor's signature over that
 * hash, on the day agents sign. If it were not, a stored reserve could be edited
 * after the fact and the whole commitment would be decoration.
 */
describe('the declared floor is inside the offer hash', () => {
  const opening = () => round('provider', 1, USDC(0.12), { [SELLER_RESERVE_TERM]: USDC(0.1) });

  it('a well-formed round verifies against its own stored hash', () => {
    expect(verifyStoredOfferHash(opening())).toBe(true);
  });

  it('editing the reserve after the fact breaks the hash', () => {
    const tampered: RoundRow = { ...opening(), terms: { [SELLER_RESERVE_TERM]: USDC(0.05) } };
    expect(verifyStoredOfferHash(tampered)).toBe(false);
  });

  it('REMOVING the reserve breaks the hash too', () => {
    // The attack the equality check alone would miss: not changing the number,
    // deleting it, so the thread looks like it never had a floor.
    const stripped: RoundRow = { ...opening(), terms: {} };
    expect(verifyStoredOfferHash(stripped)).toBe(false);
  });

  it('two different reserves give two different hashes', () => {
    const a = computeOfferHash({
      bid_id: 'b', round_no: 1, offered_by: 'provider', actor_agent_id: PROVIDER,
      price_usdc_raw: USDC(0.12), eta_seconds: 3600,
      terms: { [SELLER_RESERVE_TERM]: USDC(0.1) }, expires_at: '2026-09-05T00:00:00.000Z',
    });
    const b = computeOfferHash({
      bid_id: 'b', round_no: 1, offered_by: 'provider', actor_agent_id: PROVIDER,
      price_usdc_raw: USDC(0.12), eta_seconds: 3600,
      terms: { [SELLER_RESERVE_TERM]: USDC(0.1) + 1 }, expires_at: '2026-09-05T00:00:00.000Z',
    });
    expect(a).not.toBe(b);
    // sanity: these are real digests, not empty strings compared to each other
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash('sha256').update('').digest('hex')).not.toBe(a);
  });
});

/**
 * The round cap is what bounds the reserve-probing this design admits to. The
 * module says so in its own header: refusing a counter below the floor tells the
 * buyer a floor EXISTS, and a buyer willing to spend rounds can binary-search it.
 * The cap is the thing that makes that search finite, so it is worth a test
 * rather than a comment.
 */
describe('the round cap bounds how far a buyer can probe the floor', () => {
  it('allows two offers per permitted round', () => {
    expect(offerCap({ max_rounds: 3 })).toBe(6);
  });

  it('refuses once the cap is reached', () => {
    expect(roundCapExceeded({ rounds_used: 5 }, { max_rounds: 3 })).toBe(false);
    expect(roundCapExceeded({ rounds_used: 6 }, { max_rounds: 3 })).toBe(true);
    expect(roundCapExceeded({ rounds_used: 7 }, { max_rounds: 3 })).toBe(true);
  });

  it('a search for a floor in a wide band cannot run past the cap', () => {
    // 0.01–0.50 at 1-unit resolution is ~490,000 candidates; binary search needs
    // ~19 probes. The cap allows 6 offers total, both sides included.
    const band = rfq.max_price_usdc_raw! - rfq.min_price_usdc_raw;
    const probesNeeded = Math.ceil(Math.log2(band));
    expect(probesNeeded).toBeGreaterThan(offerCap(rfq));
  });
});
