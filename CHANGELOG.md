# Changelog

What changed in each version of agentlathe, written for the people running an instance. Each version lists what you need to do when you upgrade under **Upgrading**. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); before 1.0, a minor version may carry breaking changes, always listed under **Upgrading**.

## [Unreleased]

## [0.2.0] - 2026-10-18

### Added

- **Evaluators.** Agents carry criteria: yes/no questions about each run, with optional descriptions of a pass and a fail, an "Only evaluate when" condition and their own thresholds. TypeSafe's Jev judges every new run with a stored transcript against them; verdicts the judge is unsure about land in a review queue, and your review overrides the judge. A fix draft turns into a criterion in one click, checked against the run it came from, and criteria can be copied between agents. Managed in the agent page's **Evaluation** tab.
- **Agent versions.** Every recorded run points at the configuration it ran with. The run page opens that configuration from its short hash.
- **Evaluation metrics.** Pass rate per criterion and agent version, with what changed between one version and the next, the pass rate over time, and how often your reviews agree with the judge. `/metrics` adds the overall pass rate and the runs awaiting review.
- **A judge endpoint of your own.** `JUDGE_URL` and `JUDGE_API_KEY` point the judge at TypeSafe's own API or any other host that serves Jev; the judge model is a setting under "What to record" in `/metrics`.

### Changed

- The run page shows its counts in one line and its review work in two tabs, **Evaluation** and **Fix drafts**, each labelled with what waits in it.
- The agent form groups "Record external traffic" and the new "Evaluate new runs automatically" under **Recording and evaluation**.

### Fixed

- A tool that fails, or input that does not match a tool's schema, no longer marks a Playground run as failed, hides the tool's error behind "An error occurred." or closes the agent's MCP connections mid-run.
- A Playground turn that continues after an approval is recorded with its real output instead of an empty one.
- `/v1` transcripts that carry an OpenAI tool-call history are read correctly, and a non-streaming `/v1` call can no longer be recorded twice.

### Security

- When an agent has active criteria, the transcripts of its evaluated runs are sent to the judge: TypeSafe, through OpenRouter or the host `JUDGE_URL` names. Agents without criteria send nothing.
- Agent versions keep a snapshot of each configuration (system prompt, skills, tool schemas) for as long as the agent exists, without MCP auth and with URLs reduced to scheme and host. A secret typed into a prompt stays in that history after you edit it. See [SECURITY.md](SECURITY.md).

### Upgrading

- Two migrations add the version and evaluation tables. The compose `migrator` applies them on `docker compose up`; without Docker, run `pnpm --filter @agentlathe/db migrate` before starting the app.
- Automatic evaluation is on for every agent, existing ones included, but does nothing until an agent has criteria.
- The judge uses OpenRouter's Decisions API with `PROVIDER_API_KEY` by default. If `PROVIDER_BASE_URL` points at another provider, evaluations fail until you set `JUDGE_URL` and `JUDGE_API_KEY` (see `.env.example`).

## [0.1.0] - 2026-09-14

First public release: agents defined in Postgres and exposed through an in-app Playground, an OpenAI-compatible `/v1` and one MCP endpoint per agent, with HTTP tools, MCP servers, skills, sub-agents and approval gates. Every call becomes a run you can read and annotate with fix drafts, and `/metrics` covers runs, latency, tokens and cost.

[Unreleased]: https://github.com/contedenis/agentlathe/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/contedenis/agentlathe/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/contedenis/agentlathe/releases/tag/v0.1.0
