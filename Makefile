# Manual targets. Nothing here runs in CI.
# cold-agent: a fresh agent builds an app from the public docs only, then the toolkit checks it. Needs COLD_AGENT_CMD; see scripts/cold-agent.sh.
.PHONY: cold-agent
cold-agent:
	./scripts/cold-agent.sh
