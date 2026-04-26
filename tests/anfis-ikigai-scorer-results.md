# ANFIS-Ikigai v0 — 20-signal validation results

Generated: 2026-04-26T16:32:45.399Z

## Summary by category

| category | n | mean composite | min | max |
|----------|---|---------------:|----:|----:|
| high | 5 | 0.7650 | 0.7250 | 0.8000 |
| medium | 5 | 0.0000 | 0.0000 | 0.0000 |
| low | 5 | 0.0000 | 0.0000 | 0.0000 |
| trap | 5 | 0.2000 | 0.2000 | 0.2000 |

## Latency

- mean: 0.70ms
- p50:  0ms
- p95:  6ms
- budget: <50ms (v0)

## Acceptance verdict

- High vs Trap mean gap: 0.5650 (need > 0.15) — PASS
- Trap max composite: 0.2000 (need < 0.50) — PASS
- p95 latency: 6ms (need < 50ms) — PASS

## Per-signal detail

| id | cat | composite | love | good_at | world_needs | paid_for | rules | latency_ms | description |
|----|-----|----------:|-----:|--------:|------------:|---------:|------:|-----------:|-------------|
| h1 | high | 0.8000 | 1.000 | 1.000 | 0.500 | 0.500 | R2_vocation | 4 | Patent strategy + agent reputation + ZKP — vocation match |
| h2 | high | 0.7250 | 1.000 | 1.000 | 0.500 | 1.000 | R2_vocation,R4_profession | 6 | TrustMarket fees + multi-agent systems + RepID licensing |
| h3 | high | 0.7500 | 1.000 | 1.000 | 1.000 | 0.000 | R3_mission | 1 | Trivergence + multi-agent systems + blockchain + accountability |
| h4 | high | 0.8000 | 1.000 | 1.000 | 0.500 | 0.500 | R2_vocation | 0 | Constitutional AI + ANFIS + agent reputation + creator economy |
| h5 | high | 0.7500 | 1.000 | 0.000 | 1.000 | 1.000 | R3_mission | 0 | x402 + ZKP + multi-agent systems + financial inclusion |
| m1 | medium | 0.0000 | 0.000 | 0.000 | 0.500 | 0.000 | - | 1 | AI safety news, tangentially related |
| m2 | medium | 0.0000 | 0.000 | 0.500 | 0.000 | 0.000 | - | 0 | Generic blockchain news |
| m3 | medium | 0.0000 | 0.000 | 0.500 | 0.000 | 0.500 | - | 1 | AI consulting opportunity |
| m4 | medium | 0.0000 | 0.000 | 0.000 | 0.000 | 0.500 | - | 0 | Crypto regulation think-piece |
| m5 | medium | 0.0000 | 1.000 | 1.000 | 0.000 | 0.000 | - | 0 | Quarterly OKR review draft |
| l1 | low | 0.0000 | 0.000 | 0.000 | 0.000 | 0.000 | - | 0 | Local sports news |
| l2 | low | 0.0000 | 0.000 | 0.000 | 0.000 | 0.000 | - | 0 | Restaurant recommendation |
| l3 | low | 0.0000 | 0.000 | 0.000 | 0.000 | 0.000 | - | 0 | Gardening tip |
| l4 | low | 0.0000 | 0.000 | 0.000 | 0.000 | 0.000 | - | 0 | Celebrity gossip |
| l5 | low | 0.0000 | 0.000 | 0.000 | 0.000 | 0.000 | - | 1 | Travel piece |
| t1 | trap | 0.2000 | 1.000 | 0.000 | 0.000 | 0.000 | R6_engagement_trap | 0 | Trivergence + ZKP clickbait |
| t2 | trap | 0.2000 | 1.000 | 0.000 | 0.000 | 0.000 | R6_engagement_trap | 0 | Biblical exegesis + constitutional AI culture-war thread |
| t3 | trap | 0.2000 | 1.000 | 0.000 | 0.000 | 0.000 | R6_engagement_trap | 0 | ZKP + multi-agent systems shitpost |
| t4 | trap | 0.2000 | 1.000 | 0.000 | 0.000 | 0.000 | R6_engagement_trap | 0 | Constitutional AI + agent reputation hype reel |
| t5 | trap | 0.2000 | 1.000 | 0.000 | 0.000 | 0.000 | R6_engagement_trap | 0 | Multi-agent systems + Trivergence drama tweet |

_Notes:_
- Composite uses Sugeno weighted average; raw alignment columns are pre-fuzzification.
- Rule 6 (engagement trap) is the patent-relevant differentiator — see docs/P-014-REDUCTION-TO-PRACTICE.md.
- Persist=false in this run; no rows written to anfis_score_events.
