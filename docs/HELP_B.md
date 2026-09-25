# Help B

Schema only. No production traffic writes a row, and an empty B does not score an agent.

```json
{
  "rater_type": "human or agent",
  "subject": "family or agent",
  "dim": "helpful or deep or accurate",
  "value": "0 to 1",
  "n": "how many ratings are inside value",
  "status": "recorded or NOT_CHECKED"
}
```

`n` missing, blank, or below 1 is `NOT_CHECKED`. `value` is then null. It is not 0.
