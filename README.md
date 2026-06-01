# RepID Engine

### What This Is
RepID Engine is the behavioral reputation scoring engine for the HyperDAG Protocol. It evaluates AI agent outputs using the HAL 5-signal pipeline, manages RepID scores (0-10,000), and provides the trust layer between ERC-8004 identity and x402 payment authorization. Built on ANFIS/LASSO intelligent routing with BFT consensus governance.

### Quick Start
```
Prerequisites: Node.js 18+, npm
git clone https://github.com/DealAppSeo/repid-engine.git
cd repid-engine
cp .env.example .env  # fill in your keys
npm install
npm run build          # tsc
npm test               # 1,277 tests
npm start              # localhost:3000/health
```

### The Five-Layer Stack
```
Layer 5: HyperDAG — Ethical weighted RepID mesh, BFT consensus
Layer 4: ANFIS    — 5-signal HAL evaluation, LASSO-regularized routing
Layer 3: x402     — Micropayment settlement (Coinbase protocol)
Layer 2: RepID    — Earned reputation credentials (0-10,000 scale)
Layer 1: ERC-8004 — On-chain agent/human identity (Base Sepolia)
```

Key files per layer:
- **Layer 5**: [scripts/audit/verify-chain.ts](file:///C:/Users/Cash4/repos/repid-engine/scripts/audit/verify-chain.ts) (tamper-evident audit)
- **Layer 4**: [src/engine/anfis/](file:///C:/Users/Cash4/repos/repid-engine/src/engine/anfis/), [src/engine/pipeline.ts](file:///C:/Users/Cash4/repos/repid-engine/src/engine/pipeline.ts)
- **Layer 3**: [src/services/x402-facilitator.ts](file:///C:/Users/Cash4/repos/repid-engine/src/services/x402-facilitator.ts)
- **Layer 2**: [src/engine/repid-update.ts](file:///C:/Users/Cash4/repos/repid-engine/src/engine/repid-update.ts), [src/engine/authority-math.ts](file:///C:/Users/Cash4/repos/repid-engine/src/engine/authority-math.ts)
- **Layer 1**: contracts/ (see [hyperdag-protocol repo](https://github.com/DealAppSeo/hyperdag-protocol))

### Production Metrics (verified)
- 1,277 tests passing, 0 TypeScript errors
- 545/545 database tables RLS-secured
- 5,810+ RepID score events per day
- Hash-chained tamper-evident audit trail (SHA-256)
- 6+ agents actively processing tasks
- MAESTRO Layer 6 compliant (CSA agentic AI framework)

### Contributing
See [CONTRIBUTING.md](file:///C:/Users/Cash4/repos/repid-engine/CONTRIBUTING.md)

### License
Apache-2.0

### Links
- [HyperDAG Protocol](https://github.com/DealAppSeo/hyperdag-protocol)
- [Trinity Symphony](https://aitrinitysymphony.com)
- [TrustRepID](https://trustrepid.dev)
- [MAESTRO Framework](https://cloudsecurityalliance.org/blog/2025/02/06/agentic-ai-threat-modeling-framework-maestro)
