# exBots Agents API

Gateway + agent runtime behind agents.exbots.ai. Runs as a container on Railway.
Request path: classify → policy → route → run agent → audit log.

Services (Railway project "exbots-agents"):
  api       this repo (Dockerfile)
  postgres  audit log, tenants, policies, runs   (add via Railway "Database" → Postgres)
  redis     job queue                            (added when the worker lands)
  worker    long-running jobs                    (next)

Endpoints: GET /health · GET /api/agents · GET /api/models · GET /api/policy · GET /api/audit · POST /api/chat
