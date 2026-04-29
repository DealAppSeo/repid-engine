# Gyroscope Flywheel Design Specification

## Current State Audit

### What Exists
1. **authority-math.ts**: Contains a monolithic formula calculating authority from stake size, agent RepID, agent wisdom, and agent character. `authority = stakeSqrt * combinedScore / 500_000n`. It lacks any network or referral components.
2. **anonymous-signup.ts**: Token-only builders are created with `current_repid = 0`, `earns_repid_rewards = false`, and `auth_method = 'token_only'`. 
3. **full-account-signup.ts**: Email/password builders are created with `current_repid = 5000`, `earns_repid_rewards = true`. 
4. **canonical-writer**: Contains `writeRepIDCanonical` to write new agent RepIDs back to the Base Sepolia blockchain via the `giveFeedback` endpoint on `ReputationRegistry`. 
5. **Database (Builders Table)**: Contains basic identifying columns (`address`, `email`, `session_token`), trading credentials (`trading_provider`, `trading_paper_account_id`), and tracking stats (`current_repid`, `ghost_cohort_count`, `agent_count`).
6. **Routes & Stake**: `stake-vault.ts` correctly isolates simulated stake vs active stake; `v1.ts` handles the demo interactions correctly for running rounds, snapshotting authority, and scaling bets.
7. **Tests**: Covered adequately for pure math properties, basic integrations, and `/demo/run-round-anonymous` workflows, but does not capture multi-flywheel dynamics yet.

### What Works
- The basic "Loop 1" (trading outcomes affecting RepID) is wired up correctly through `linked-bet-resolver.ts` and `agent-trader.ts`.
- The demo snapshot APIs securely return dynamic recommended bets based on the actual math constraints.
- Token-based deterministic addresses for demo users work seamlessly.

### What Changes for the Gyroscope
The core change is shifting from a single dimension (Stake + Performance) to five interconnected flywheels. The `builders` table will be enriched to track referrals, shares, challenge stats, and tier progression. The authority math will pivot from a single monolithic calculation to a three-input weighted formula (base + earned + viral + capital) that explicitly rewards ecosystem participation alongside trading performance and capital locking.

---

## Authority Math Redesign

The new authority formula shifts from a single product to an additive three-component architecture, establishing the minimum viable floor and heavily weighting earned reputation over raw capital.

**Formula**:
`authority_raw = base_floor + earned_component + viral_component + capital_component`

Where:
- `base_floor` = `50_000_000` (raw $50 — minimum viability guarantee)
- `earned_component` = `max(0, current_repid - 100) * EARNED_WEIGHT_RAW`
- `viral_component` = `(verified_referrals * REFERRAL_BONUS_RAW) + min(SHARE_CAP_RAW, share_count * SHARE_BONUS_RAW)`
- `capital_component` = `sqrt(stake_raw / 1_000_000) * CAPITAL_WEIGHT_RAW`

### Constants Tuning:
To satisfy the design goals, we tune the constants as follows:
- `EARNED_WEIGHT_RAW = 50_000` (Every 1 RepID past 100 = +$0.05 authority)
- `REFERRAL_BONUS_RAW = 10_000_000` (+$10 authority per verified referral)
- `SHARE_BONUS_RAW = 1_000_000` (+$1 authority per share intent)
- `SHARE_CAP_RAW = 10_000_000` (Max +$10 authority from pure sharing)
- `CAPITAL_WEIGHT_RAW = 1_000_000` ($1 stake → 1 sqrt → +$1 authority; $100 stake → 10 sqrt → +$10 authority)

### Rationale:
- **Earned dominates**: Performance drives the primary capability lever, allowing exceptional agents to trade larger sizes without whale capital.
- **Capital is the smallest weight**: To prevent pay-to-win, the capital component grows logarithmically (via sqrt). Moving from $100 to $1,000 only yields a ~$21 advantage.
- **Viral jumpstarts**: Referrals yield quick, flat bonuses, getting new users over the authority hump before they establish long-term RepID.

### Worked Examples:
1. **Fresh Demo**: Token-only, RepID 100, no shares/refs, $100 stake
   `50M (base) + 0 (earned) + 0 (viral) + 10M (capital) = 60_000_000 (~$60)`
2. **Growing Demo**: Token-only, RepID 500, no shares/refs, $100 stake
   `50M (base) + 20M (earned) + 0 (viral) + 10M (capital) = 80_000_000 (~$80)`
3. **Viral Starter**: Token-only, RepID 100, no stake, 5 verified refs
   `50M (base) + 0 (earned) + 50M (viral) + 0 (capital) = 100_000_000 (~$100)`
4. **Balanced Growth**: Token-only, RepID 1000, $100 stake, 3 verified refs
   `50M (base) + 45M (earned) + 30M (viral) + 10M (capital) = 135_000_000 (~$135)`
5. **Whale**: RepID 100, $1000 stake, no refs/shares
   `50M (base) + 0 (earned) + 0 (viral) + 31M (capital) = 81_622_776 (~$81)`
6. **Master Trader**: RepID 5000, $0 stake, no refs
   `50M (base) + 245M (earned) + 0 (viral) + 0 (capital) = 295_000_000 (~$295)`
7. **Viral Sharer (No Refs)**: RepID 100, $100 stake, 15 shares (hits cap)
   `50M (base) + 0 (earned) + 10M (viral cap) + 10M (capital) = 70_000_000 (~$70)`
8. **Engaged Mid-Tier**: RepID 2500, $50 stake, 2 verified refs, 5 shares
   `50M (base) + 120M (earned) + 25M (viral) + 7M (capital) = 202_071_067 (~$202)`
9. **Super-Promoter**: RepID 150, $0 stake, 20 verified refs
   `50M (base) + 2.5M (earned) + 200M (viral) + 0 (capital) = 252_500_000 (~$252)`
10. **Poor Trader**: RepID 50, $100 stake (earned floored at 0)
    `50M (base) + 0 (earned) + 0 (viral) + 10M (capital) = 60_000_000 (~$60)`

---

## Schema Deltas Spec

**`builders` table updates**:
- `share_count_total` (INTEGER DEFAULT 0): Tracks pure sharing intent to calculate the small, capped viral bonus.
- `verified_referrals_count` (INTEGER DEFAULT 0): Counts referred friends who have passed the paper-trade hurdle. Read heavily by the authority snapshot formula.
- `pending_referrals_count` (INTEGER DEFAULT 0): Transient pipeline count.
- `current_tier` (TEXT DEFAULT 'tier_1'): Defines access limits (`tier_1`, `tier_2`, `tier_3`).
- `tier_unlocked_at` (TIMESTAMPTZ): Audit log for the moment of progression.
- `challenge_wins` / `challenge_losses` (INTEGER DEFAULT 0): Competence statistics for tier 2 → 3 progression constraints.

**`share_tokens` table**:
- *Why*: Powers HMAC-secured referral, challenge, and win-card shares without leaking builder IDs or infinite-use links.
- *Columns*: `id` (UUID PK), `builder_id` (UUID FK), `token_hash` (TEXT UNIQUE), `intent` ('referral' | 'challenge' | 'demo_share'), `created_at` / `expires_at` (TIMESTAMPTZ), `used_count`, `last_used_at`, `max_uses`.
- *Indexes*: UNIQUE on `token_hash`.
- *RLS*: Builders can read their own generated tokens. Insert via secure endpoints only.

**`referrals` table**:
- *Why*: Manages the pipeline of onboarding a referred user, linking them back to the referrer, and gating the bonus until they prove engaged behavior.
- *Columns*: `id` (UUID PK), `referrer_builder_id` (UUID FK), `referred_builder_id` (UUID FK UNIQUE), `share_token_id` (UUID FK), `status` ('pending' | 'verified' | 'expired'), `pending_at`, `verified_at`, `trades_required`, `trades_completed`.
- *Indexes*: FK indexing on both builder IDs.
- *RLS*: System role writes only. Read access for referrer and referred.

**`agent_challenges` table**:
- *Why*: Facilitates 1v1 PvP matching (Loop 5: Network).
- *Columns*: `id`, `challenger_builder_id`, `challenged_builder_id` (NULLABLE), `challenger_agent_id`, `challenged_agent_id` (NULLABLE), `share_token_id`, `status` ('open' | 'accepted' | 'in_progress' | 'completed'), `start_at`, `end_at`, `duration_hours`, `winner_builder_id`, `challenger_repid_delta`, `challenged_repid_delta`.
- *Indexes*: Composite on `status` and `end_at` for job processing.
- *Migration Ordering*: `builders` delta → `share_tokens` → `referrals` / `agent_challenges`.

---

## API Contract Spec

**Share Endpoints**:
- `POST /api/v1/share/generate`: Body `{ builder_id, intent, expires_in_hours? }`. Returns securely signed payload `{ token, share_url, qr_code_data }`.
- `POST /api/v1/share/redeem`: Body `{ share_token, new_builder_id }`. Validates token intent. Returns `{ ok, referral_id, status: 'pending' }` and increments referrer's `share_count_total`.

**Referral Endpoints**:
- `GET /api/v1/builder/:id/referrals`: Returns list of pending and verified referrals to populate UI widgets.
- `POST /api/v1/referral/check-verification`: Internal worker endpoint. Promotes `pending` to `verified` once `trades_completed >= trades_required`, then triggers RepID recalculation for the referrer.

**Challenge Endpoints**:
- `POST /api/v1/challenge/create`: Body `{ challenger_id, challenger_agent_id, duration_hours? }`. Returns a shareable link and QR code.
- `POST /api/v1/challenge/accept`: Target builder accepts. Validates agents and begins tracking performance epoch.
- `GET /api/v1/challenge/:id/leaderboard`: Real-time tracking of performance and RepID deltas for both parties over the challenge duration.

**Tier Endpoints**:
- `GET /api/v1/builder/:id/tier-status`: Exposes `current_tier`, `next_tier`, and a payload of arrays: `requirements_met` vs `requirements_pending` (e.g., 5000 RepID, 3 verified refs).
- `POST /api/v1/builder/:id/tier-up`: Evaluates current state and unlocks capabilities if requirements are met.

**Flywheel Status**:
- `GET /api/v1/builder/:id/flywheel`: Aggregated comprehensive summary showing the entire Gyroscope loop performance for the specific user.

**Anti-Gaming Requirements**:
- HMAC-signed share tokens and strict `expires_at` constraints block brute forcing.
- Verification hurdles (≥5 paper trades) prevent click-farm referral botting.
- Rate limits (max 5 share links per hour).
- IP/device deduplication on first redemption.
- Constitutional veto logic overrides any sudden Tier progression that breaks safety invariant rules.

---

## Multi-Broker Abstraction Spec

**Adapter Interface**:
```typescript
interface BrokerAdapter {
  name: string;
  asset_classes: ('stocks' | 'crypto' | 'options')[];
  paper_trading: boolean;
  auth_flow: 'api_key' | 'oauth';
  place_order(params): Promise<OrderResult>;
  get_position(symbol): Promise<Position>;
  cancel_order(order_id): Promise<void>;
  get_account_balance(): Promise<Balance>;
}
```

**Brokers to Spec**:
1. **alpaca_rest** (existing): Stocks, options (paper supported). API Key auth.
2. **alpaca_mcp** (existing): Similar to above, LLM Tooling layer.
3. **kraken_rest** (NEW): Crypto (paper trading available via simulated environments). API Key auth. Distinct rate limits and REST vs WebSocket behaviors.
4. **kraken_mcp** (NEW): Crypto, native LLM tool mapping.
5. **coinbase_advanced** (FUTURE): Stocks ETF + Crypto. OAuth flow for consumer access.
6. **binance_us** (FUTURE): Crypto depth and breadth.

**Migration Needs**:
- Expand `trading_provider` check constraints or enums in `builders` to support new strings (`kraken`, `alpaca_mcp`, etc.).
- Convert `trading_credentials_encrypted` into a flexible JSONB map keyed by provider name to allow a user to hold multiple broker linkages simultaneously.

---

## Tier Progression Spec

**Tier 1 — Demo / paper-on-demo-wallet**
- *Entry*: Anonymous token-only signup.
- *RepID Range*: 100 → 999.
- *Authority Cap*: $200.
- *Capability Unlocks*: Run demo rounds, share win cards, view leaderboards.
- *Exit Gates*: RepID >= 1000 AND verified_referrals >= 0.

**Tier 2 — Paper-on-personal-account**
- *Entry*: ERC-7231 mint OR email signup with verified paper account.
- *RepID Range*: 1000 → 4999.
- *Authority Cap*: Scales cleanly with stake, no hard limit.
- *Capability Unlocks*: Custom agent tuning, friend challenges, referral RepID boosts.
- *Exit Gates*: RepID >= 5000 AND verified_referrals >= 3 AND challenge_wins >= 5.

**Tier 3 — Real-trading**
- *Entry*: Met Tier 2 constraints.
- *RepID Range*: 5000+.
- *Authority Cap*: Initially 50% of personal stake, grows dynamically.
- *Capability Unlocks*: Real-money execution, advanced customization, federated learning, decay rate tuning.

**Master Tier (Informal)**
- *Entry*: RepID 10000+.
- *Capability Unlocks*: No staking requirements, agent leasing rights, tournament curation, governance voting.

---

## Pedagogy Disclosure Timing Spec

The system follows a strict "Reveal Value Before Vocabulary" philosophy.

| Visitor state | Loop revealed | UI element | Words avoided | Words introduced | Suggested Copy |
|---|---|---|---|---|---|
| Lands on page | None | Hero only | RepID, authority, tier | (none) | "Start trading now." |
| Stakes $100 | Loop 1 hint | Authority | RepID, tier | authority | "Authority unlocked: $50 limit per round." |
| First round succeeds | Loop 1 named | RepID toast | tier | RepID | "+50 RepID. Your agent learned and improved." |
| Click Share Win | Loop 2 named | Share modal | tier, viral | referral, share | "Share this trade. Both of you get stronger." |
| Reach RepID 500 | Loop 4 hint | Auth card | (none new) | stake reduction | "As your RepID grows, your stake frees up." |
| Reach RepID 1000 | Loop 3 named | Tier-up | master tier | tier 2, capability | "Welcome to Tier 2: Connect your own broker." |
| Friend joins | Loop 5 emerges | Challenge | (none new) | competition | "Challenge your friend. Winner takes the RepID." |
| Reach RepID 2500 | Loop 4 deeper | Stake card | (none new) | (reinforce) | "RepID is your collateral. Minimums dropped." |
| Reach RepID 5000 | Tier 3 invite | Big modal | (none new) | real trading | "You proved yourself. Real trading is unlocked." |
