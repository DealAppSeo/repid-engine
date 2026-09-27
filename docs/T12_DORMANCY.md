# T12 dormancy

Diagnosed 2026-09-25 from the agent source, not from a live environment read.

## Heartbeat writer

`heartbeat()` in `trinity-symphony-shared/lib/ConstitutionalAgentV4.js`.

It does not call an HTTP host. A presence write, when the mode allows one, is a SQL upsert through `pgQuery` into `trinity_agent_registry`, `agent_heartbeat`, and `trinity_heartbeat`.

The same file's model-provider map names `https://api.anthropic.com/v1/messages` for model calls. That map is not what `heartbeat()` calls.

## Last date

The note in `src/observability/agent-liveness.ts` says nothing has written `agent_heartbeat` since **2026-07-17 22:18**. That is a prior note in this repo. It was not re-measured against the database today.

## Host

The write host is Postgres, reached by `pgQuery`. There is no HTTP host on the heartbeat path.

Each agent process also serves `GET /health` from memory. That URL is the process's own health route, not a provider.

## Live env

Heartbeat mode, the legacy heartbeat-writes switch, and the free-wave flag on the running fleet are **NOT_CHECKED**. This pass did not read an environment file and did not start the swarm.
