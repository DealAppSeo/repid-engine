# PayFi Track Submission — x402 RepID Payment Gating
# HashKey Horizon Hackathon 2026

## Project: RepID x402 — Behavioral Reputation Payment Gating

**Track:** PayFi
**Demo:** https://repid-engine-production.up.railway.app/agents/d08a6049-6e33-48ef-8d6c-006ebe9ef48a/x402-gate
**GitHub:** https://github.com/DealAppSeo/repid

## One Line
x402 payment authorization gated by behavioral reputation —
only agents that have earned constitutional trust can
authorize payments above their RepID tier threshold.

## The Problem
Payment authorization in AI-DeFi is binary — an agent
either has wallet access or it doesn't. There is no
graduated trust model based on demonstrated behavior.

## The Solution
RepID x402 payment gating:

- DBT tier (0-999 RepID): $0 autonomous limit
- ABT tier (1000-4999 RepID): $1,000 autonomous limit
- AUTONOMOUS (5000+ RepID): unlimited within constitution

Every payment attempt calls:
POST /agents/:id/x402-gate { amount: X }

The gate checks RepID tier, constitutional compliance score,
and HAL dissonance before authorizing. High-dissonance
periods trigger CAPITAL PROTECTED regardless of tier.

## Integration
```
const { allowed, repId, tier } = await gate(agentId, amount);
if (allowed) { // proceed with payment }
```

```
npm install @hyperdag/trustshell
```

## Why PayFi Track
Graduated payment authority based on behavioral reputation
is the missing trust layer for autonomous AI payments.
An agent that has demonstrated 4,000 RepID of constitutional
behavior deserves more payment authority than one that
just registered. RepID makes that judgment mathematically
provable and cryptographically verifiable.
