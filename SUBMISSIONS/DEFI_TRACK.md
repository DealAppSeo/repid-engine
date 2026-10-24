# DeFi Track Submission — TrustTrader
# HashKey Horizon Hackathon 2026

## Project: TrustTrader — Constitutional AI Trading Agent

**Track:** DeFi
**Demo:** https://trusttrader.dev/challenge
**GitHub:** https://github.com/DealAppSeo/trusttrader (private)

## One Line
The only AI trading agent with a mathematical veto —
HAL blocks trades when constitutional dissonance exceeds
0.48.

## The Problem
AI trading agents execute during market crises without
constitutional guardrails — causing catastrophic losses
that a human would have avoided.

## The Solution
TrustTrader + HAL (Hallucination Assurance Layer):

Constitutional veto engine:
totalDissonance = (φ⁻¹ × individual + (1-φ⁻¹) × pairwise)
                  × (531441/524288)

When dissonance > 0.48: trade is CAPITAL PROTECTED (not executed).
Congressional trading signal: hardcoded -1.0 (always vetoed).
Execution mode: paper trading always.

## Backtest results: none exist
~~4 for 4 crisis events; 0.00% drawdown with the HAL veto vs 49.63% without.~~
**RETRACTED 2026-10-23, do not cite.** No run is behind these numbers. No code in this repo or in
trusttrader computes a drawdown from a price path, and `public.backtest_variance`, the only table that
could hold a run, had 0 rows when checked on 2026-10-23. The four events named here (COVID, Ukraine,
SVB, FTX) do not even match trusttrader's own table (COVID, China mining ban, FTX, Bitcoin ETF rally).
- Live demo at trusttrader.dev/challenge

## RepID Integration
Every trading agent has a RepID behavioral score.
Agents that override HAL lose RepID immediately.
High-RepID agents earn more autonomous trading authority.
Low-RepID agents require human Conservator confirmation.

## Why DeFi Track
Constitutional AI trading with mathematical veto is the
missing safety layer for AI-DeFi on HashKey Chain.
Any protocol can integrate:
require(RepID.hasSufficientReputation(agent, 3000),
  "Insufficient behavioral reputation for this trade");
