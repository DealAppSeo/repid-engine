import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL || 'https://qnnpjhlxljtqyigedwkb.supabase.co'
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || 'dummy'
const db = createClient(supabaseUrl, supabaseKey)

async function run() {
  const { data: cols, error: errCols } = await db.from('sprint_queue').select('*').limit(1)
  if (errCols) {
    console.error('Error fetching columns:', errCols)
  } else {
    console.log('Columns sample:', Object.keys((cols && cols[0]) || {}))
  }

  const { data: existing } = await db.from('sprint_queue').select('title').limit(20)
  console.log('Existing tasks:', existing)

  const tasks = [
    { title: 'repid-engine: Supabase schema — 6 tables', description: 'Create repid_agents, repid_events, repid_zkp_proofs, repid_ecosystem_supply, repid_stakes, repid_referendum_log in Supabase project qnnpjhlxljtqyigedwkb. Schema defined in GMPD v4.3 Section Sprint 2.', priority: 1, status: 'pending', category: 'repid-engine', assigned_to: 'gemini' },
    { title: 'repid-engine: Layer 1 — ecosystem-need dynamic weighting', description: 'Implement getEcosystemNeedWeight() and updateSupplyRate() in src/layers/ecosystem-need.ts.', priority: 2, status: 'pending', category: 'repid-engine', assigned_to: 'gemini' },
    { title: 'repid-engine: Layer 2+5 — challenge scoring + certainty penalty', description: 'Implement scoreChallengeOutcome() in src/layers/challenge-scoring.ts.', priority: 3, status: 'pending', category: 'repid-engine', assigned_to: 'gemini' },
    { title: 'repid-engine: Layer 3 — logarithmic prediction scoring', description: 'Implement scorePrediction() with proper scoring rules, φ³ floor cap.', priority: 4, status: 'pending', category: 'repid-engine', assigned_to: 'gemini' },
    { title: 'repid-engine: Layer 4 — decay + redemption arc rule', description: 'Implement computeDecayFactor() and applyDecay() and computeRedemptionModifier().', priority: 5, status: 'pending', category: 'repid-engine', assigned_to: 'gemini' },
    { title: 'repid-engine: Master orchestrator — all 5 layers unified', description: 'Implement updateRepId() in src/engine/repid-update.ts.', priority: 6, status: 'pending', category: 'repid-engine', assigned_to: 'gemini' },
    { title: 'repid-engine: REST API routes — agents + score + referendum stub', description: 'Full CRUD for /agents, /agents/:id, /score, /referendum.', priority: 7, status: 'pending', category: 'repid-engine', assigned_to: 'gemini' },
    { title: 'repid-engine: Railway deploy + curl verification', description: 'Deploy to Railway as new private service.', priority: 8, status: 'pending', category: 'repid-engine', assigned_to: 'gemini' },
    { title: 'TrustRepID.dev: Next.js portal scaffold', description: 'New repo DealAppSeo/trustrepid.', priority: 9, status: 'pending', category: 'trustrepid', assigned_to: 'gemini' },
    { title: 'TrustRepID.dev: Agent scorer playground — /score', description: 'ERC-8004 address or name search.', priority: 10, status: 'pending', category: 'trustrepid', assigned_to: 'gemini' },
    { title: 'TrustRepID.dev: Developer leaderboard — /leaderboard', description: 'Mixed human+agent rankings.', priority: 11, status: 'pending', category: 'trustrepid', assigned_to: 'gemini' },
    { title: '@hyperdag/trustshell: npm package scaffold', description: 'New public repo DealAppSeo/trustshell.', priority: 12, status: 'pending', category: 'trustshell', assigned_to: 'gemini' },
    { title: 'TrustTrader: Fix /demo page — restore paper trading terminal', description: 'Diagnose and fix the broken /demo page.', priority: 13, status: 'pending', category: 'trusttrader', assigned_to: 'gemini' },
    { title: 'TrustTrader: Fix trustrails.dev domain routing', description: 'trustrails.dev currently points to old StableHacks site.', priority: 14, status: 'pending', category: 'trusttrader', assigned_to: 'gemini' },
    { title: 'TrustTrader: hal-notify end-to-end test', description: 'VAPID keys are now live. Test the full push notification flow.', priority: 15, status: 'pending', category: 'trusttrader', assigned_to: 'gemini' },
    { title: 'TrustTrader: Crypto.com dual-source validation fix', description: 'BTC signal should use bothSources: true for Crypto.com dual-source validation.', priority: 16, status: 'pending', category: 'trusttrader', assigned_to: 'gemini' },
    { title: 'TrustTrader: /hal/results — benchmark data populated', description: 'Populate the /hal/results page with real data.', priority: 17, status: 'pending', category: 'trusttrader', assigned_to: 'gemini' },
    { title: 'TrustTrader: Paper portfolio P&L tracker on /demo', description: 'Wire paper portfolio P&L tracker into /demo page.', priority: 18, status: 'pending', category: 'trusttrader', assigned_to: 'gemini' },
    { title: 'TrustCRE.dev: April 22 Colorado demo prep', description: 'Prepare TrustCRE.dev demo for April 22.', priority: 19, status: 'pending', category: 'trustcre', assigned_to: 'gemini' },
    { title: 'TrustTrader PWA: App manifest + install prompt', description: 'Complete PWA setup at app.aitrinitysymphony.com.', priority: 20, status: 'pending', category: 'trusttrader', assigned_to: 'gemini' },
    { title: 'INITIATE Hackathon: TrustRepID.dev submission polish', description: 'Position TrustRepID.dev + repid-engine for INITIATE Hackathon.', priority: 21, status: 'pending', category: 'hackathon', assigned_to: 'gemini' },
    { title: 'Pacifica Hackathon: TrustTrader trading bot submission', description: 'Write up TrustTrader as constitutional trading agent for Pacifica Hackathon.', priority: 22, status: 'pending', category: 'hackathon', assigned_to: 'gemini' },
    { title: 'RAISE-26: Epistemic framework research paper', description: 'Position HAL epistemic framework.', priority: 23, status: 'pending', category: 'hackathon', assigned_to: 'grok' },
    { title: 'Supabase Realtime: Enable on repid_challenges table', description: 'Enable Supabase Realtime.', priority: 24, status: 'pending', category: 'trusttrader', assigned_to: 'sean' },
    { title: 'ERC-73 attestation: Phase 1 scoping', description: 'Scope ERC-73 integration for HyperDAG.', priority: 25, status: 'pending', category: 'hyperdag', assigned_to: 'claude' },
    { title: 'Marco De Rossi governance conversation', description: 'Schedule and conduct governance conversation with Marco De Rossi.', priority: 26, status: 'pending', category: 'business', assigned_to: 'sean' },
    { title: 'P-020: Email draft to patent attorney TODAY', description: 'P-020 draft is ready with Grok. Email to patent attorney immediately.', priority: 27, status: 'pending', category: 'patents', assigned_to: 'sean' },
    { title: 'P-023: Grok to draft full provisional', description: 'Ask Grok to draft P-023 provisional.', priority: 28, status: 'pending', category: 'patents', assigned_to: 'grok' },
    { title: 'repid-engine: ANFIS Layer 0 — self-optimizing rule referendum', description: 'Future sprint: implement 90-day ANFIS rule optimization loop.', priority: 29, status: 'pending', category: 'repid-engine', assigned_to: 'future' },
    { title: 'repid-engine: LNN ODE integration — motivation trajectory layer', description: 'Future sprint: integrate Liquid Neural Network ODE.', priority: 30, status: 'pending', category: 'repid-engine', assigned_to: 'future' }
  ]
  const { data, error } = await db.from('sprint_queue').upsert(tasks, { onConflict: 'title' })
  if (error) console.error('Insert error:', error)
  else {
    const { count } = await db.from('sprint_queue').select('*', { count: 'exact', head: true })
    console.log(`Successfully seeded. Total rows in sprint_queue: ${count}`)
  }
}
run()
