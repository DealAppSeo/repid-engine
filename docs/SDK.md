# SDK Documentation
```typescript
// TypeScript SDK Example
const proveRepId = async () => {
    const res = await fetch('https://repid.dev/api/v1/prove-repid', { method: 'POST', body: JSON.stringify({ agent_id: "...", requester_pubkey: "...", requested_tier: "package" }) });
    return res.json();
}
```
```python
# Python SDK Example
import requests
res = requests.post("https://repid.dev/api/v1/prove-repid", json={"agent_id": "...", "requester_pubkey": "...", "requested_tier": "package"})
print(res.json())
```
```bash
# cURL
curl -X POST https://repid.dev/api/v1/prove-repid -H "Content-Type: application/json" -d '{"agent_id":"...","requester_pubkey":"...","requested_tier":"package"}'
```
