# S-SDK1 — TrustShell SDK Interface Spec

**Date:** 2026-05-30  
**Branch:** feat/xc-s-sdk1-2026-05-30 (XC isolated worktree)  
**Design-only.** Read-only analysis performed on trustshell skeleton and GA constitutional-agent-base.

## Required Public Interface

The SDK exposes a `TrustShell` class with exactly these three methods.

### TypeScript Signatures

```typescript
export interface TrustShellConfig {
  agentId: string;
  apiKey: string;                    // ts_live_... or ts_test_...
  engineUrl?: string;                // defaults to production repid-engine
  llmProvider?: string;
  profile?: 'conservative' | 'balanced' | 'pro';
}

export interface ScoreOptions {
  prompt: string;
  provider?: string;
  timeoutMs?: number;
}

export interface ScoreResult {
  halScore: number;                  // 0.0–1.0
  signals: Record<string, any>;      // full 5-signal + comma BFT output
  verdict: 'clean' | 'flagged' | 'vetoed';
  proofHash: string;                 // for audit chain / provenance
  sessionId?: string;                // for .audit()
}

export interface VerifyResult {
  repid: number;
  lastAnchorTx?: string;
  latestProofHash: string;
  provenanceChain: Array<{
    txHash?: string;
    blockNumber?: number;
    proofHash: string;
    timestamp: string;
  }>;
}

export interface AuditResult {
  chainStatus: 'VALID' | 'BROKEN';
  entries: number;
  hashes: string[];                  // ordered proof hashes
  brokenAt?: { index: number; expected: string; actual: string };
}

export class TrustShell {
  constructor(config: TrustShellConfig);
  score(response: string, options: ScoreOptions): Promise<ScoreResult>;
  verify(agentId: string): Promise<VerifyResult>;
  audit(sessionId: string): Promise<AuditResult>;
}
```

### Python Signatures (parity)

```python
from dataclasses import dataclass
from typing import Optional, Dict, Any, List, Literal

@dataclass
class TrustShellConfig:
    agent_id: str
    api_key: str
    engine_url: Optional[str] = None
    llm_provider: Optional[str] = None
    profile: Optional[Literal["conservative", "balanced", "pro"]] = None

@dataclass
class ScoreOptions:
    prompt: str
    provider: Optional[str] = None
    timeout_ms: Optional[int] = None

@dataclass
class ScoreResult:
    hal_score: float
    signals: Dict[str, Any]
    verdict: Literal["clean", "flagged", "vetoed"]
    proof_hash: str
    session_id: Optional[str] = None

@dataclass
class VerifyResult:
    repid: int
    last_anchor_tx: Optional[str]
    latest_proof_hash: str
    provenance_chain: List[Dict[str, Any]]

@dataclass
class AuditResult:
    chain_status: Literal["VALID", "BROKEN"]
    entries: int
    hashes: List[str]
    broken_at: Optional[Dict[str, Any]] = None

class TrustShell:
    def __init__(self, config: TrustShellConfig): ...
    async def score(self, response: str, options: ScoreOptions) -> ScoreResult: ...
    async def verify(self, agent_id: str) -> VerifyResult: ...
    async def audit(self, session_id: str) -> AuditResult: ...
```

## Endpoint Mapping (repid-engine)

| Method     | Primary Endpoint(s)                              | Auth          | Status (2026-05-30) |
|------------|--------------------------------------------------|---------------|---------------------|
| score      | POST /api/v1/hal/evaluate (or /hal/signals)     | API key      | BUILT (core HAL + Comma BFT) |
| verify     | GET /api/v1/repid/{agentId} + audit-chain endpoints | API key or public | BUILT |
| audit      | GET /api/v1/audit/chain/{sessionId} or provenance | API key      | PARTIALLY BUILT (chain walker may need completion) |

**BUILT vs NEEDS_BACKEND:**
- HAL scoring + signals + verdict + proofHash: **BUILT**
- RepID + provenance chain: **BUILT**
- Full session-based audit with chainStatus + broken detection: **NEEDS_BACKEND** (light wrapper needed)
- API key validation + per-key rate limiting: **PARTIALLY BUILT** (middleware exists; dedicated ts_* key enforcement + limits need final wiring)

## Auth, Rate Limits, Errors

**Auth:** `Authorization: Bearer ts_live_...` or `X-Api-Key`. Key is scoped to an agentId.

**Rate Limits (per key):**
- score: 60/min (burst 10)
- verify: 300/min
- audit: 120/min

**Error Shape:**
```json
{
  "error": {
    "code": "HAL_TIMEOUT" | "INVALID_AGENT" | "RATE_LIMITED" | "AUTH_FAILED" | "CHAIN_BROKEN" | "INTERNAL",
    "message": "...",
    "details": {...},
    "request_id": "uuid"
  }
}
```

HTTP: 200 success, 400 validation, 401/403 auth, 429 rate limit, 5xx transient.

## Alignment with Existing trustshell Surface

The skeleton's `docs/api-reference.md` already defines a broader SDK (`evaluate`, `report`, `getRepID`, etc.). This S-SDK1 spec defines the **minimal stable public contract** (the three methods above) that the existing surface should implement or wrap. The broader methods can remain as convenience wrappers.

---

**End of S-SDK1_trustshell_interface_spec.md**