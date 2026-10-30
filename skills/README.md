# Agent skills

[`metrics-explorer-links`](metrics-explorer-links/SKILL.md) teaches an AI agent to build links into the Metrics
Explorer (query text, formulas, display parameters, URL encoding). It uses the Agent Skills format (a directory with a
`SKILL.md` whose frontmatter names and describes the skill): copy the `metrics-explorer-links` directory into your
agent's skills directory, for Claude Code `~/.claude/skills/` or `.claude/skills/` in a project, and tell the agent
your Grafana address and the explorer dashboard's uid, e.g. in the project's `AGENTS.md` or `CLAUDE.md`.
