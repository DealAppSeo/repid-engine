# Trading Bridge Architecture

The strategic abstraction layer that lets agents execute trades through
either a **REST** broker connection (today) or an **MCP server**
(v0.2) without any caller code changes.

---

## The contract

```ts
interface TradingBridge {
  validateCredentials(creds): Promise<ValidateResult>;
  placeOrder(args):           Promise<PlaceOrderResult>;
  getAccount(creds):          Promise<AccountResult>;
  getOrderStatus(args):       Promise<OrderStatusResult>;
  getProviderName():          'alpaca_rest' | 'alpaca_mcp';
}
```

Any new transport (e.g. an FIX adapter, an Interactive Brokers REST
wrapper, an MCP server) implements this same interface. Callers
construct a bridge through the factory:

```ts
import { getTradingBridge } from './trading-bridge/factory';

const bridge = getTradingBridge(builder.trading_provider);
await bridge.placeOrder({ ... });
```

That's the whole surface. Callers never know REST vs MCP; they never
import an implementation file.

---

## Files

```
src/services/trading-bridge/
  ├── types.ts          ← interface + DTOs
  ├── alpaca-rest.ts    ← REST implementation (today)
  ├── alpaca-mcp.ts     ← STUB (v0.2 will replace with real MCP)
  └── factory.ts        ← getTradingBridge(provider) → TradingBridge
```

The MCP stub returns `ok: false` with a clear "MCP path not yet
implemented" error. The route layer (`/api/v1/builder/link-trading-account`,
`/api/v1/agent/execute-paper-trade`) detects this error via the
`isMcpNotImplemented` helper and responds **HTTP 501** instead of 400 —
making it obvious to clients that MCP is a future capability, not a
broken request.

---

## v0.2 swap procedure

To replace the MCP stub with a real MCP-backed implementation in the
v0.2 sprint:

1. Replace the stub method bodies in `alpaca-mcp.ts` with real MCP
   client calls (e.g. via the official Alpaca MCP server).
2. **No other code changes.** No callers need to be updated. The factory
   already routes `alpaca_mcp` to this file.
3. Existing builders who are linked with `provider: 'alpaca_mcp'`
   automatically start working — no migration, no re-link required.

The factory is the single point of construction. Switching defaults
from REST → MCP is a one-line change at `factory.ts`.

---

## Why an abstraction at all?

Without this layer, every trade-placing call site in the codebase would
need to know whether to call `fetch('https://paper-api.alpaca.markets/v2/orders', ...)`
or speak the MCP protocol. Adding a new broker would touch every call
site. Removing one (e.g. when Alpaca shuts down their REST in favor of
MCP-only) would require an audit-and-rewrite pass.

With the bridge interface:

- Adding a broker = one new file implementing the interface + one
  factory line.
- Removing a broker = delete the file + remove the factory line.
- Migrating between transports for the same broker = swap one file's
  implementation. Caller code is untouched.

This pays its rent the first time we add a second broker or transport.
The cost today (~150 LOC across 4 files) is trivial relative to the
flexibility it preserves.

---

## Credential security

Credentials never live in caller code. The flow is:

```
HTTP request body
  ↓
linkTradingAccount(input)        ← src/services/link-trading-account.ts
  ↓
bridge.validateCredentials(...)   ← bridge sees plaintext, validates with broker
  ↓
encryptCredentials(creds)         ← AES-256-GCM (src/services/trading-creds-crypto.ts)
  ↓
builders.trading_credentials_encrypted = { v: 1, iv, tag, ciphertext }
```

On every subsequent trade:

```
loadBuilder(...)
  ↓
decryptCredentials(builder.trading_credentials_encrypted)
  ↓
bridge.placeOrder({ ..., credentials })   ← bridge sees plaintext, broker call
```

Plaintext creds exist only in memory during a single request. The
encryption key (`TRADING_CREDS_ENCRYPTION_KEY` env) is rotated by
re-encrypting all rows; the format includes a `v` field for future
schema migrations.

---

## Testing

`tests/reponomics-trading-bridge.test.ts` covers:

- Factory routing (correct adapter per provider name)
- MCP stub returns the not-implemented error consistently
- REST adapter is a thin wrapper over `fetch` (with fetch mocked)
- AES-GCM encryption round-trips, IVs differ per call, tampering is detected

Integration with the live Alpaca paper API is exercised via the demo
walkthrough (curl recipes in `REPONOMICS-FULL-ACCOUNT-FLOW.md`) rather
than as a unit test (it requires an API key).
