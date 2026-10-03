# T12 belt

Heartbeat stays a SQL write. This belt does not replace that write and does not call a model host.

`T12_FREE_WAVE` is on only when it is the exact string `true`. The order is then local, then groq,
then cerebras. **Local joins only when `T12_LOCAL_BASE_URL` is a loopback host** (`127.0.0.1`,
`localhost`, `::1`); a remote base is never treated as local. Send a local host no key.
**Not `LOCAL_LLM_BASE_URL`:** that one is process-wide and would also move the HAL quorum and
the contract validator onto the local box. The groq and cerebras steps must call each
provider's real endpoint, not one rewritten by `resolveProviderEndpoint`.

**A 429 stops the wave.** No further host is tried after a rate limit, and the caller must wait
(the host's `Retry-After`, when given, comes back as `retryAfterMs`) before the next wave. Any
other failure tries the next host. Nothing answering is `NOT_CHECKED`, never a pass, and
"answered" means a 2xx, not a checked result: the caller validates the body.

The status check for this belt is:

```
trustshell status
```

Do not call Anthropic from this belt.
