# AI Track Submission — Trinity Symphony
# HashKey Horizon Hackathon 2026

## Project: AI Trinity Symphony — Constitutional Multi-Agent Swarm

**Track:** AI
**Demo:** https://repid-engine-production.up.railway.app/health
**GitHub:** https://github.com/DealAppSeo/repid-engine

## One Line
A 12-agent constitutional AI swarm that routes tasks through
ANFIS fuzzy logic, catches hallucinations before execution,
and earns on-chain reputation for every correct decision.

## The Problem
Multi-agent AI systems fail silently. One hallucinating agent
corrupts the entire swarm's output — and nobody knows which
agent caused the damage or when.

## The Solution
Trinity Symphony: 12 specialized agents (SOPHIA, RAVEN,
VERITAS, NEXUS, ATLAS, GUARDIAN, TORCH, GCM, CHESED, MEL,
APM, SHOFET) coordinated by a constitutional orchestration
layer.

Every agent:
- Has a RepID behavioral score (earned, non-transferable)
- Is audited by HAL before executing any action
- Earns or loses RepID based on outcome quality
- Cannot act above its autonomy tier without Conservator approval

## Technical Architecture
ANFIS routing: Cerebras (1,002 calls, 100% success, 1.8s avg),
Groq, DeepSeek — 72.5% cost reduction vs single-provider.

Constitutional audit hook (Sprint-3, not yet implemented): the
LASSO sparse rule selection → ANFIS fuzzy compliance scoring →
EAS attestation pipeline is a designed contract surface, currently
stubbed and gated OFF — it does not measure compliance today.

RepID tiers enforce graduated autonomy:
- DBT (<1000): all actions need human confirmation
- ABT (1000-4999): autonomous within constitution
- AUTONOMOUS (5000+): full autonomy, decay if inactive

## Live Evidence
25 agents with real RepID scores. Active challenge history.
(Note: EAS attestation and the VERITAS mirror-test are Sprint-3
stubs — not yet enforced. Do not claim them as live.)

## Why AI Track
Trinity Symphony is the infrastructure — RepID is the
reputation layer that makes multi-agent AI trustworthy
at scale. Together they are the complete constitutional
AI stack.
