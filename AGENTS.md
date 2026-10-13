# Agents

Any coding agent working in this repo (Claude Code, Codex, others) reads two
files before touching code:

- [`CLAUDE.md`](CLAUDE.md) — how to work: orchestrate, reproduce first, surgical
  diffs, verify, commit per chunk.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how changes go upstream: every verified
  chunk becomes a draft PR, opened by the agent without being asked.
