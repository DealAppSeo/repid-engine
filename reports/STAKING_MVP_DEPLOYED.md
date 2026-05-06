# Staking Demo MVP — Deployment Report

## 1. Objective and Scope
The objective of this sprint was to deploy a functional, public-facing demonstration of the RepID-weighted staking logic at `/stake` on the `trustrails-dev` frontend, communicating with the `repid-engine` backend API. The demo is meant to show how human-staked capital and agent RepID scores mathematically bound the allowed trade size for AI agents without requiring user authentication.

## 2. Phase Summaries

### Phase 1: Verify and Seed
- The four `repid_mvp_*` tables (`repid_mvp_users`, `repid_mvp_agents`, `repid_mvp_stakes`, `repid_mvp_trade_attempts`) were verified.
- Added two new humans ("Charlie" and "Dana") to `repid_mvp_users`.
- Populated `repid_mvp_stakes` to ensure each human (Alice, Charlie, Dana) has exactly one active stake against VERITAS, Test Newbie, and SOPHIA respectively.
- RLS Policy: The Supabase UI or direct SQL is required to enable RLS and public-read policies for `repid_mvp_trade_attempts` as the programmatic `exec_sql` RPC function is unavailable.

### Phase 2: Fix Local Demo & Regression
- **Bug Fix**: Modified `TradeAttempt` interface and `decideTrade` logic in `scripts/demo/repid-staking-mvp-demo.ts` to correctly map the `stakeId` from the backing stakes. This resolved the regression where rows had `stake_id = null`.
- **Regression Test**: Created `tests/repid-staking-demo.test.ts` to assert that `stakeId` is populated correctly.
- **Test Suite**: Executed `npm test`; the new regression test passes. All previous core suite tests remain green (excluding pre-existing `receipt-issuer.test.ts` failure due to missing schema file in another repo).

### Phase 3: Backend Routes (`repid-engine`)
- Created `src/routes/stake.ts` featuring three endpoints:
  - `POST /api/stake/attempt-trade`
  - `GET /api/stake/recent`
  - `GET /api/stake/seeded`
- Applied a `5 req/min` IP rate limit to the `attempt-trade` POST route.
- Mounted the router in `src/index.ts` _above_ the `authMiddleware` to fulfill the "No login, no wallet, no auth" requirement.
- Merged the feature branch into `main` and pushed to remote to trigger Railway deployment.

### Phase 4: Frontend Page (`trustrails-dev`)
- Created `app/stake/page.tsx` utilizing the Next.js App Router and the site's existing UI styling (dark mode, amber highlights, monospaced fonts).
- Built an interactive form to select one of the three humans, view their stake and RepID, enter a USD trade size, and view the decision (`✅ APPROVED`, `❌ REJECTED_SIZE`, `❌ REJECTED_REPID_TOO_LOW`).
- Integrated a live-updating table for recent decisions fetched from `/api/stake/recent`.
- Removed all "Patent Portfolio Pending" copy globally from `layout.tsx` and other pages to adhere to sprint constraints.
- Fixed a Next.js 15 build failure related to synchronous `headers()` usage in `app/page.tsx`.

### Phase 5: Verification & Blockers
- The backend successfully compiles and runs locally on `http://localhost:3002`.
- The frontend successfully compiles and runs locally on `http://localhost:3000`.
- **Blocker**: The Railway production deployment (`https://zkp-postcard-production.up.railway.app`) is currently unresponsive (returning 404 for the API routes), preventing the Vercel-deployed frontend from fetching data.
- **Testing**: Using the browser subagent, we confirmed the `/stake` route renders successfully in Next.js. However, because Next.js aggressively cached the failed Railway API fetches during build/hydration, the humans list did not populate during the automated smoke test, preventing the final e2e screenshot of an accepted/rejected trade.
- Local endpoint `http://localhost:3002/api/stake/seeded` was manually verified via `curl` to return the correct seeded human data. 

## 3. Recommended Next Steps
1. **Railway Status**: Investigate why `zkp-postcard-production.up.railway.app` is failing to serve traffic on the `main` branch.
2. **Supabase RLS**: Manually execute `ALTER TABLE repid_mvp_trade_attempts ENABLE ROW LEVEL SECURITY; CREATE POLICY "public_read" ON repid_mvp_trade_attempts FOR SELECT USING (true);` via the Supabase dashboard.
3. **Vercel Redeploy**: Once the Railway API is up, redeploy `trustrails-dev` to Vercel (or update the env var `NEXT_PUBLIC_REPID_ENGINE_URL`) to hydrate the page with real data.
