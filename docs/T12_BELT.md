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

## The call (`src/orchestration/t12-attempt.ts`, unwired)

`t12Ask(prompt)` runs the wave for real, one host at a time, through `providerFetch`:

| step | URL | key |
|---|---|---|
| local | `<T12_LOCAL_BASE_URL>/chat/completions` (loopback only; model `T12_LOCAL_MODEL`, default `local`) | **none** |
| groq | `PROVIDER_URLS.groqChatCompletions` | `GROQ_API_KEY`, only to groq |
| cerebras | `PROVIDER_URLS.cerebrasChatCompletions` | `CEREBRAS_API_KEY`, only to cerebras |

- The cloud steps use the registry URL directly, never `resolveProviderEndpoint`, so the
  process-wide `LOCAL_LLM_BASE_URL` cannot redirect them (a test pins it).
- `ONLY_ATTESTATIONS_LEAVE` is asserted before each call; under it a cloud step is refused
  before any byte leaves and the wave moves on.
- An answer is a 2xx with non-empty `choices[0].message.content`. An empty or unparseable 2xx
  is treated as a failure, so the wave tries the next host.
- Nothing calls `t12Ask` yet, and it makes no call unless `T12_FREE_WAVE` is exactly `true`.
