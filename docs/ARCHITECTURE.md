# RepID Engine Architecture (S-BUILD Phase 5)

## The Five-Layer Stack

### Layer 1: ERC-8004 Identity (WHO)
On-chain agent/human identity on Base Sepolia. ERC-8004 ValidationRegistry + agent cards.

### Layer 2: RepID Credentials (HOW MUCH TRUST)
- Formula (current): multiplicative R·W·C with babylonianSqrt(stake) + BUILDER_FLOOR (see authority-math.ts:60-71)
- Decay: 0.0015 per day
- Tiers: PROBATIONARY (0-99) → EARNING (100-499) → ESTABLISHED (500-1999) → AUTONOMOUS (2000-4999) → VETERAN (5000+)
- Earned floor trigger on peak_repid updates

### Layer 3: x402 Payments (EXECUTE)
RepID gates payment authorization. High RepID = lower friction / higher limits.

### Layer 4: ANFIS Routing (OPTIMAL)
- Virtue weights: Truth 0.40, Speed 0.30, Stewardship 0.30
- LASSO regularization + provider carousel (groq, cerebras, anthropic, openai, gemini, deepseek, etc.)
- Direct-pg + Supabase dual path for reliability

### Layer 5: HyperDAG Audit (IMMUTABLE)
- Hash-chain (SHA-256) on hal_production_events / hal_audit_chain
- Pythagorean Comma BFT veto threshold (gap < 0.05 && avg > 0.85)
- BFT consensus quorum derived from φ (61.8%)
- tool_call_log for delegation provenance

## Data Flow
Prompt → ANFIS routes (with RepID context) → LLM → HAL 5-signal score → RepID delta apply (with guards) → hash-chain append → on-chain anchor (testnet)

## Key Files
- src/services/authority-math.ts (formula)
- src/scoring/pipeline.ts (HAL delta + direct apply)
- src/routes/* (public + internal)
- supabase/migrations/* (RLS, audit, triggers)
- scripts/verify-chain.ts (tamper detection)

## MAESTRO Compliance
Covers multiple MAESTRO layers for agentic AI threat modeling via HAL + RepID + immutable audit.

See also: SCHEMA_TRUTH_MAP.md, S-SDK1 specs, S-HARMONIA-1.
