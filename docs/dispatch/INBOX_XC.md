# INBOX_XC: red-team PR #1190 (V1-9 Stripe Checkout, inert)

## Task

**Lane:** RED-TEAM. You have **no write scope**: the deliverable is text. Do not claim to have
created, edited or committed a file. You hold `reasoning` and `repo_read`, scoped to THIS
workspace, which is PR #1190's branch. **Three outcomes: VERIFIED / NOT_CHECKED / FAILED.**
Dispatched by CC2 (Claude) on 2026-10-04: this PR touches money, so it gets a red-team before merge.

### What it is

`src/routes/pay-checkout.ts`, mounted before auth in `src/index.ts`:
- `GET /api/v1/pay/tiers`: priced tiers from the `stripe_products` catalog, no Stripe ids.
- `POST /api/v1/pay/checkout {tier_id}`: a `mode=subscription` Stripe Checkout Session for the
  catalog price of that tier; returns only the `checkout.stripe.com` URL.
- Inert (503 `NOT_CONFIGURED`, no call) unless `PAY_CHECKOUT_ENABLED=true` AND
  `STRIPE_SECRET_KEY` AND an https `PAY_RETURN_ORIGIN`. Writes nothing.
- Tests: `tests/pay-checkout.test.ts`.

### Deliverable

Rank by failure direction: money moving wrongly first, then a leak, then availability. For each
finding give the input, the file:line you read, and the jest test that would catch it. At minimum, try:
- Can a caller make Stripe charge anything other than a catalog price at its catalog amount?
  Body fields, type confusion on `tier_id` (string, float, huge, negative, array, object),
  prototype pollution through `express.json`.
- Can a caller steer the return URLs (open redirect, `{CHECKOUT_SESSION_ID}` abuse,
  `PAY_RETURN_ORIGIN` edge cases such as IDNs, ports, trailing paths)?
- Does any path echo Stripe's error body, the key, or the price id to the caller?
- Is "inert" really inert: any configuration where one variable alone produces a Stripe call?
- Rate limit before auth: can it be used to burn the Stripe account's API rate limit, or to
  create sessions at scale (sessions are free but count)? Is 10/min/IP enough given
  `ipKeyGenerator` behind Railway's proxy (trust proxy setting)?
- Anything a reviewer should know before Sean sets the three variables (restricted-key scopes,
  test vs live mode, what happens without a webhook).

One verdict line: **MERGE / FIX FIRST / HOLD**, with the single most important reason.
