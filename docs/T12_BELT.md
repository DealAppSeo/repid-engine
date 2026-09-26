# T12 belt

Heartbeat stays a SQL write. This belt does not replace that write and does not call a model host.

`T12_FREE_WAVE` is on only when it is the exact string `true`. The order is then groq, then cerebras.

The status check for this belt is:

```
trustshell status
```

Do not call Anthropic from this belt.
