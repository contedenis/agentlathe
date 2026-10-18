# Usage

How to build agents in agentlathe and call them from the outside. If you have not got it running yet, start with the [quickstart](../README.md#quickstart-with-docker).

## Agents

An agent is a name, a model slug, an optional system prompt, and a step budget. Everything else (tools, skills, sub-agents, MCP tools) is attached by relation. `maxSteps` defaults to `20` and caps the agent's own steps — shared across approval rounds, not per round, and a sub-agent's steps count against the sub-agent's budget, not its caller's; the name is unique, because `/v1` lets callers address an agent by it.

In the UI: **Agents → New agent**. The model dropdown is populated from the provider's `/models` catalog — OpenRouter's by default.

```bash
curl -X POST http://localhost:3000/api/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Support triage",
    "model": "~deepseek/deepseek-v4-flash-latest",
    "systemPrompt": "Classify the ticket, then answer it. Be concise.",
    "maxSteps": 12,
    "toolIds": ["<tool-uuid>"],
    "skillIds": ["<skill-uuid>"]
  }'
```

Agents can be **deactivated** (`isActive: false`) rather than deleted: an inactive agent disappears from `/v1/models`, its MCP endpoint returns 404, and its runs stay.

## HTTP tools

A tool is a **JSON Schema** for its input plus an **endpoint URL**. The schema is validated when you save the tool (invalid JSON Schema → 400) and **enforced at run time**: input the model emits that does not match it is rejected back to the model instead of reaching your endpoint. When the agent calls the tool, the runner does a `POST` to that URL with the tool input as the JSON body (`content-type: application/json`, 30s timeout) and hands the response text back to the model — capped at 256 KiB, with anything beyond that truncated and marked `[truncated]`. A non-2xx or a timeout does not end the run: the model is handed the detail (`HTTP <status>: <body>`, or the timeout) and can retry or explain, but the call is recorded as **failed**, so filtering a run's calls by error shows it.

Set `needsApproval: true` and the tool becomes gated: in the Playground an approval banner appears and waits for you.

```bash
curl -X POST http://localhost:3000/api/tools \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Close ticket",
    "description": "Closes a support ticket by id.",
    "endpoint": "https://internal.example.com/tickets/close",
    "inputSchema": {
      "type": "object",
      "properties": { "ticketId": { "type": "string" } },
      "required": ["ticketId"]
    },
    "needsApproval": true
  }'
```

MCP tools can also require approval — per agent, toggled on each selected tool in the agent form (the shield on the selected-tool badge). Sub-agent calls never gate.

## MCP servers

An MCP server entry is a `serverUrl` plus optional static auth headers. The dashboard's **Test connection** button lists the server's tools before you save anything:

```bash
curl -X POST http://localhost:3000/api/mcp-servers/test \
  -H "Content-Type: application/json" \
  -d '{
    "serverUrl": "https://api.githubcopilot.com/mcp/",
    "authConfig": { "headers": { "Authorization": "Bearer ghp_..." } }
  }'
```

Header values can be **references to environment variables** instead of literal secrets: a value that starts with `AGENTLATHE_SECRET_` is treated as the name of an env var and resolved when the app connects, so only the name lands in the database. The variable must hold the full header value, `Bearer` prefix included:

```bash
# in .env — compose forwards it to the app container; without Docker, apps/web/.env.local
AGENTLATHE_SECRET_GITHUB_PAT=Bearer ghp_...
```

```json
{ "headers": { "Authorization": "AGENTLATHE_SECRET_GITHUB_PAT" } }
```

If the variable is not set (or empty) when a connection is attempted, it fails before any request goes out: the **Test connection** button surfaces the error immediately, and at run time the server is reported through the same failed-servers channel as a dead server. What this protects — and what it does not — is in [SECURITY.md](../SECURITY.md#secrets-are-stored-in-plaintext).

Tool selection is **explicit per agent** — you pick which of the server's tools that agent gets, you do not inherit the whole surface. Selected tools are namespaced `{server}__{tool}` (the server name is slugified, the remote tool name is left alone), so `GitHub` + `search_issues` becomes `GitHub__search_issues` and two servers exposing `search` do not collide. Each selected tool can be marked to **require approval** (the shield on its badge in the agent form), which puts it behind the same gate as an approval-flagged HTTP tool.

A server that fails to open is collected and reported, not fatal — the rest of the agent's tools still work, and the run detail page lists which servers were down. A server that opens but no longer offers a tool you selected is reported there too, naming the missing tools. Connecting to a server and listing its tools is each bounded by a 30s timeout (the dashboard's **Test connection** included); once connected, an individual tool call gets 60s before it is aborted, handed to the model as an error and recorded as a failed call.

Auth is **static headers only** (literal values or `AGENTLATHE_SECRET_*` env references); interactive OAuth is deferred, see [SECURITY.md](../SECURITY.md).

## Skills

A skill is a name, a description and a body of text. Only the **name and description** go into the system prompt, under an `## Available skills` heading; the body is loaded on demand when the model calls the built-in `load_skill` tool:

```
## Available skills
Use the `load_skill` tool with the skill name to load its full content.
- Support tone: How to talk to a user reporting a problem.
- Concise answers: Rules for answering without filler.
```

So five long playbooks cost you five lines of context until one is actually needed. `load_skill` takes `{ "name": "Support tone" }` and returns the body.

## Sub-agents

Attach agent B to agent A and A gains a `subagent_{slug}` tool — an agent whose slug is `response-writer` gets `subagent_response-writer`. It takes a single `task` string, runs the child **one-shot** (`generate`, no shared conversation state) and returns its text.

Three guards, all of which return an error string to the model rather than throwing:

- **Cycles are blocked.** The call stack is threaded through the runtime; re-entering an agent already on it fails with `Error: sub-agent cycle detected.`
- **Depth is capped at 5.** Beyond that: `Error: maximum sub-agent depth exceeded.`
- **Fan-out is budgeted.** A run gets 20 sub-agent invocations across the whole tree; past that: `Error: sub-agent call budget for this run is exhausted.`

Children always run headless, so an approval-gated tool inside a sub-agent is denied, not executed.

## Schedules

A schedule sends a fixed message to an agent on a repeating trigger and records the run, with nobody calling it. In the UI: **Schedules → New schedule**.

The trigger is a preset, not a cron expression:

| Repeats | Runs |
|---|---|
| Every hour | First at the time you set, then every hour at that minute |
| Daily | Every day at the time |
| Weekdays | Monday to Friday at the time |
| Weekly | On the weekday you pick, at the time |
| Monthly | On the day of the start date you pick, at the time. In months without that day (a 31st in April, a 30th in February) it runs on the last day of the month |

Times are 24-hour and belong to a time zone: the form uses your browser's and shows it, and the schedule keeps it. Across a daylight-saving change a time that does not exist that day moves forward by the gap, and a time that repeats runs once, at the first of the two. "Every hour" runs every real hour and never less than an hour apart, including the hour that repeats when clocks go back. The form previews the next five runs.

The message can carry variables, filled in for each run: `{{date}}` and `{{datetime}}` (when the run was due, in the schedule's time zone), `{{nominal_at}}` (the same time in UTC), `{{last_success_at}}` (when the last successful run was due, or `never`) and `{{schedule}}` (its name).

**Every time a schedule comes due it leaves an occurrence**, listed on the schedule's page with its result, the reason and a link to the run:

- **succeeded** / **failed** — the run finished, or ended with an error.
- **skipped · missed** — it came due more than 2 minutes before a scheduler saw it (the app was down, or no scheduler was running). Missed runs are skipped, never caught up: after downtime the schedule runs again at its next time.
- **skipped · overlap** — the previous run of the same schedule was still going.
- **blocked** — a check before calling the model failed: the agent is inactive, `PROVIDER_API_KEY` is not set, or an MCP server the agent uses references an `AGENTLATHE_SECRET_*` variable that is not set.
- **interrupted** — the app stopped while the run was in progress.

There are no retries. After **5 failed or blocked runs in a row** the schedule pauses itself and says why; activating it again clears the count. Skipped and interrupted runs do not count.

**Run now** starts a run immediately, whether or not the schedule is active, and does not move its next run; it is refused while another run of the same schedule is in progress.

A scheduled run has no human to ask, so a tool that requires approval is denied with the reason "not available in scheduled runs", the same way `/v1` denies it. Scheduled runs appear in **Runs** with the source **Scheduled**, are recorded by default, and always keep their transcript, like the Playground's: they are your own automation, not third-party traffic.

Schedules fire only while a scheduler is running, which the app does by itself unless `SCHEDULER_ENABLED` is `false`; the Schedules page says when it last ticked, or warns that nothing is running. See [DEPLOYMENT.md](DEPLOYMENT.md#the-scheduler).

```bash
curl -X POST http://localhost:3000/api/schedules \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "<agent-uuid>",
    "name": "Monday digest",
    "frequency": "weekly",
    "weekday": 1,
    "timeOfDay": "09:00",
    "timezone": "Europe/Madrid",
    "input": "Summarize what changed since {{last_success_at}}."
  }'

# weekday is 0 (Sunday) to 6 and only for weekly; startDate (YYYY-MM-DD) only for monthly
curl -X POST http://localhost:3000/api/schedules/<schedule-uuid>/run
curl http://localhost:3000/api/schedules/<schedule-uuid>/occurrences
```

## Metrics

Three tables, deliberately separated:

- **`agent_runs`** — one row per call: agent, source (`dashboard` / `v1` / `mcp` / `schedule`), status, `thread_id`, model, duration, steps, tool calls, in/out tokens, approvals requested and granted, error. **No message content.**
- **`agent_run_calls`** — one row per invocation inside a run: `kind` (`tool`, `mcp`, `sub_agent`, `skill`), name, duration, status (`ok` / `error` / `denied`). This is what makes "which tool is slow, which one keeps getting denied" answerable.
- **`run_transcripts`** — the actual input and output messages, keyed 1:1 on the run.

Each run also points at the **agent version** it ran with: a hash of the agent's behavior-relevant configuration (model, prompt, step limit, skills, tools, MCP selections, sub-agents) taken when the run started. The run detail page shows its first 8 characters next to the duration, so two runs with the same short hash ran with the same configuration; clicking it opens that configuration: prompt, skills, tools, MCP selections and sub-agents. MCP auth headers are never part of it, and of a tool or server URL only scheme and host stay readable; the rest is stored as a short digest.

Whether a run is recorded at all is gated **per source**, in `settings`: `trackDashboardRuns` and `trackScheduleRuns` default to `true`, `trackV1Runs` and `trackMcpRuns` to `false`. Toggle them under "What to record" in `/metrics`, or over the API:

```bash
curl -X PATCH http://localhost:3000/api/settings \
  -H "Content-Type: application/json" \
  -d '{ "trackV1Runs": true, "agentRunTtlDays": 30, "transcriptTtlDays": 7 }'
```

Retention is TTL-based and swept lazily, when a page that shows runs loads and about every ten minutes while a [scheduler](#schedules) runs: runs default to **90 days**, transcripts to **14**. Both `agentRunTtlDays` and `transcriptTtlDays` are configurable through that same `PATCH`. Deleting an agent deletes its runs, criteria and versions; deleting a run deletes its transcript, notes and verdicts. Agent versions have no TTL.

**Evaluation.** When an agent has [criteria](#criteria), its metrics page (`/metrics/[id]`) has an Evaluation section for the selected range, and `/metrics` shows the overall pass rate, the runs awaiting review (all of them, not only those in the range, linking to the same queue in the runs list) and a pass-rate column per agent. Everything follows the criteria counting rules: your review overrides the judge, unreviewed needs-review, not-applicable, skipped and errored verdicts stay out of the rate, and only verdicts given to the criterion's current question count.

- **Evaluation by agent version** — one row per active criterion, one column per agent version that was judged in the range, ordered by when each version last ran in the range (the newest is highlighted; a version is labelled by the first 8 characters of its hash, the date it first appeared and its last run). A version that ran in several periods, for example after you reverted a change, is one column, and the newest is whichever ran most recently. Each cell shows the pass rate, `n` (the verdicts it is based on) and how many are still to review; a dash means no data. To answer "did my last change help?", read the newest column against the one before it: next to the newest cell, the change in points appears only when both versions have at least 5 judged verdicts. With fewer it says "too few verdicts to compare" instead, because a swing of a few runs is noise. Under every version but the first, a one-line summary says what changed against the column to its left (the same pair the change in points compares), and **What changed** opens the diff: model, step limit, a line diff of the prompt, and the skills, tools, MCP servers and sub-agents that were added, removed or edited. Entities are matched by name, so a rename reads as one removed and one added. A change inside a sub-agent is named but not detailed; that sub-agent's own metrics page shows it. Inactive criteria are left out.
- **Pass rate over time** — the daily pass rate of each criterion, on days that have judged verdicts. Dashed vertical lines mark the day a new agent version first ran.
- **Judge vs human** — among verdicts you reviewed that the judge had called pass or fail, the share where you kept its verdict (it needs at least 5 reviews to show a percentage), and how you resolved the ones the judge left as needs review.

## Fix drafts

A fix draft is a structured note anchored to a specific point in a run — either a whole **turn** (`{"type":"turn"}`) or one **tool call** (`{"type":"tool_call","toolCallId":"..."}`). Each carries a category naming which lever of the agent the problem points at: `prompt`, `tool_definition`, `tool_policy`, `missing_tool`, `model`, or `other`, plus a rationale and an optional proposed value. Status moves `open` → `applied` or `dismissed`.

You write them from the **"Note a fix"** button on any turn in the Playground, or from the run detail page at `/runs/[id]`:

```bash
curl -X POST http://localhost:3000/api/runs/<run-uuid>/fix-drafts \
  -H "Content-Type: application/json" \
  -d '{
    "messageId": "msg-7",
    "anchor": { "type": "tool_call", "toolCallId": "call_abc123" },
    "category": "tool_definition",
    "rationale": "The schema lets the model pass a ticket title where an id is expected.",
    "proposedValue": "Rename the field to ticketId and describe the format."
  }'
```

The Home page surfaces a **"Runs to review"** list — runs that either failed or carry an open note — instead of just the most recent ones, so the queue stays useful once you have thousands of runs.

## Criteria

A criterion is a yes/no question a judge (TypeSafe's Jev, through OpenRouter's Decisions API by default) answers about every run of an agent. Manage them in the **Evaluation** tab of the agent page.

Writing one:

- **Phrase the question so that yes means the run did well**, e.g. "Did the assistant avoid promising a refund without confirmation?".
- **Describe both sides.** "Passes when" and "Fails when" are what make the judge reliable; with only one of them the text is merely appended to the question.
- **"Only evaluate when"** (optional) is a second yes/no question. Runs where its answer is no are marked not applicable instead of judged.
- **Advanced:** "Fail below" and "Pass above" (0 to 1, defaults 0.2 and 0.8) turn the judge's probability into a verdict. Scores between them are flagged **needs review**.

```bash
curl -X POST http://localhost:3000/api/agents/<agent-uuid>/criteria \
  -H "Content-Type: application/json" \
  -d '{
    "question": "Did the assistant avoid promising a refund without confirmation?",
    "passDescription": "No refund is promised, or it is promised after the refund tool confirmed it.",
    "failDescription": "A refund is promised before any tool confirmed it.",
    "appliesWhen": "Did the user ask for a refund?"
  }'

# judge one run now, against all active criteria or only some
curl -X POST http://localhost:3000/api/runs/<run-uuid>/evaluate \
  -H "Content-Type: application/json" \
  -d '{ "criterionIds": ["<criterion-uuid>"] }'
```

Each criterion shows its pass rate over the runs of the last 30 days (pass / (pass + fail), where a human review overrides the judge; verdicts given under an earlier wording of the question do not count, so editing the question starts a fresh rate) and how many verdicts still need review. Deactivating a criterion stops evaluating it and keeps its verdicts; deleting it deletes them too.

**From a fix draft:** on a run page, "Turn into criterion" on a note opens the dialog with the note's rationale as "Fails when". Write the question and the passing side. While you type, the dialog checks the criterion against the run the note came from and tells you whether it fails there as expected; the check never blocks saving.

**Copy from agent…** copies selected criteria from another agent. The copies are independent of the originals.

**Evaluation** runs automatically once a run's transcript is stored, unless you switch off "Evaluate new runs automatically" in the agent form, under **Recording and evaluation** next to "Record external traffic" (`autoEvaluate` on the agent API; the Evaluation tab says which way it is set). Only runs with a stored transcript can be judged, so /v1 and MCP runs need the agent's traffic recording on. **Re-evaluate recent runs** judges the agent's latest runs again and reports the totals (a human review is kept unless the criterion's question was edited since). If the judge endpoint does not serve the Decisions API, or the key or judge model is wrong, the tab shows the last evaluation error. The judge model is set under the metrics page's settings ("Judge model", default `typesafe/jev-1.13`, or `judgeModel` in `PATCH /api/settings`), which also shows the host the judge is called on.

**Another judge endpoint.** By default the judge is OpenRouter's Decisions API, reached with `PROVIDER_API_KEY`. If `PROVIDER_BASE_URL` points somewhere else (OpenAI, Ollama, vLLM), that endpoint does not serve the judge and evaluations fail until you set the two variables below. To call Jev somewhere else, set two env vars: `JUDGE_URL`, the full endpoint, and `JUDGE_API_KEY`, its key. For TypeSafe's own API that is `https://api.typesafe.ai/v1/systemone`, with the judge model set to a TypeSafe id such as `jev-latest`. Any host that speaks the same Decisions / System One API works the same way (AIMLAPI, a LiteLLM proxy). `JUDGE_URL` without `JUDGE_API_KEY` refuses to call: the provider key is never sent to another host. `JUDGE_API_KEY` on its own keeps OpenRouter and only bills judge calls to a different key.

## Reviewing verdicts

The run page (`/runs/[id]`) puts the run's counts in one line and its review work in two tabs, **Evaluation** and **Fix drafts**, each labelled with what waits in it (verdicts to review, open notes). It opens on Evaluation when a verdict needs review, on Fix drafts when only notes are open, and switches to Fix drafts when you save a note. The Evaluation tab lists one verdict per criterion, worst first: unreviewed fails, then verdicts that need review, then errors and skips, then the ones a human already reviewed, then passes and not-applicable. Each row shows the question as it was judged (with a note when the criterion has been reworded since), the verdict, the judge's probability of a pass, and why a verdict is missing when the judge errored or skipped the run (transcript too long, or the run paused on an approval). **Re-evaluate** judges the run again against the agent's active criteria.

- **Human review.** On a pass, fail or needs-review verdict, **Pass** / **Fail** records your own call; it overrides the judge in the pass rates, the counts and the runs list: the row's badge shows your verdict and a "Reviewed · judge said ..." line keeps what the judge said when you disagreed. **Undo** removes it. A review belongs to the question it answered: re-evaluating after the question was edited discards it, while re-evaluating under the same wording keeps it.
- **Note a fix.** On a failed (or still undecided) verdict, **Note a fix** opens the usual fix-draft dialog anchored to the run's last assistant turn, with the rationale prefilled as "Failed criterion: ..." ("Judge unsure on criterion: ..." when the verdict is still undecided). Edit it, pick the lever and save.
- **No criteria, no transcript.** An agent without active criteria shows a link to the agent page; a run without a stored transcript cannot be evaluated (for /v1 and MCP runs, turn on the agent's external traffic recording).

On the **Runs** page every row summarises its verdicts: a red badge counts failures (a human review counts instead of the judge), an amber one counts verdicts still waiting for review, and a green check ("No failures") means every verdict passed or did not apply and at least one passed (a muted "n/a" when none applied). When nothing needs attention but the judge errored or skipped a run, an "error" or "skipped" badge says so. Only verdicts of active criteria under their current wording are counted. The **Evaluation** filter next to the **Source** buttons narrows the list, and is kept when you change the page or the source:

- **Needs review** is the review queue: runs with at least one unreviewed needs-review verdict, with how many there are next to its name. When it is empty the list says "Nothing to review."
- **Failed**: runs with at least one failing verdict, after human reviews.
- **Not evaluated**: runs with a stored transcript and no counted verdicts, for agents that have at least one active criterion, to spot gaps (for example runs from before you wrote a criterion).

---

## Calling your agents

### OpenAI-compatible API (`/v1`)

Every **active** agent is exposed as a model. Point any OpenAI-compatible client (Cursor, LiteLLM, the `openai` SDK) at `http://localhost:3000/v1`.

`GET /v1/models` returns each agent's **ID** (a slug you pick in the agent form — lowercase letters, digits, `.`, `_`, `-`) as the model `id`:

```bash
curl http://localhost:3000/v1/models
```
```json
{
  "object": "list",
  "data": [
    { "id": "support-triage", "object": "model", "created": 1755300000, "owned_by": "agentlathe" }
  ]
}
```

The `model` field accepts **the agent's ID, its display name, or its UUID** — the resolver checks whether the string is a UUID and falls back to a slug/name lookup:

```bash
# by UUID, streaming
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-thread-id: my-conversation-42" \
  -d '{
    "model": "3f6c1e5a-...-9b21",
    "messages": [{ "role": "user", "content": "hi" }],
    "stream": true,
    "stream_options": { "include_usage": true }
  }'

# by ID
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "support-triage",
    "messages": [{ "role": "user", "content": "hi" }]
  }'
```

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: "not-needed", // no auth — see the security model
});

const res = await client.chat.completions.create({
  model: "3f6c1e5a-...-9b21", // or "Support triage"
  messages: [{ role: "user", content: "hi" }],
});
```

The API is **stateless**: the caller owns the full `messages` history on every request. The optional `x-thread-id` header groups the runs of one conversation in the dashboard; without it each call stands alone.

Tools flagged `needsApproval` are **automatically denied** on `/v1` — it is headless, there is nobody there to approve. The model gets back `tool '<name>' requires approval; not available over the API` and can carry on without it.

### MCP endpoint (one per agent)

Each active agent is also a tiny MCP server at:

```
POST http://localhost:3000/mcp/agents/{agent-id-or-uuid}
```

The path segment accepts the agent's **ID (slug), its URL-encoded name, or its UUID** — same resolver as the `/v1` `model` field.

It speaks streamable HTTP (protocol `2025-11-25`, `2025-06-18` accepted) and exposes exactly **one tool**, `ask_{id}` — the agent with ID `response-writer` becomes `ask_response-writer` — taking a single `message` string and returning the agent's answer. Progress notifications are sent per step when the client supplies a `progressToken`.

```json
{
  "mcpServers": {
    "support-triage": { "url": "http://localhost:3000/mcp/agents/support-triage" }
  }
}
```

Approvals here are **not** auto-denied: if the client declared `elicitation` support during `initialize`, a gated tool triggers an `elicitation/create` request with an `approve` boolean, and the run blocks until the human answers. Clients without elicitation get the headless behaviour instead.

---

## Recording and privacy

This matters more than a feature list, so read it before pointing real traffic at it.

Two things get stored, and they are governed separately:

| | What it stores | Default | Where to change it |
|---|---|---|---|
| **Run** | One row: agent, source, status, duration, steps, tokens, tool calls. No message content. | Playground and schedules **on**; API and MCP **off** | "What to record" in `/metrics`, or `PATCH /api/settings` |
| **Transcript** | The actual messages of the call, input and output. | Playground and schedules **always**; API and MCP **off** | "Record external traffic" on the agent |

So the default is: your own experiments are recorded, third-party traffic is not — until you decide otherwise, per agent.

**Transcripts are stored verbatim. There is no redaction.** If a caller sends an API key, a customer's email or a medical record in a message, that is what lands in your database, in plaintext, on any agent you switched recording on for. agentlathe does not detect, mask or hash anything. Turning on recording for an agent that serves real users is a decision about their data, not just yours — make it deliberately, and tell them if that is what your jurisdiction expects.

Retention is TTL-based and swept lazily (on page loads, and every ten minutes or so while a scheduler runs): runs default to 90 days, transcripts to 14 — transcripts are the heavy, sensitive half, so they expire first. Both are configurable. Deleting an agent deletes its runs, and deleting a run deletes its transcript, notes and verdicts. A verdict outlives the transcript it was judged on, which is why a run older than the transcript TTL can no longer be re-evaluated.

**Evaluated transcripts leave the instance.** When an agent has active criteria, each run that is evaluated (or previewed against a draft criterion) is sent to the judge as text: TypeSafe's Jev, through OpenRouter by default or the host `JUDGE_URL` names. Agents without criteria send nothing, and switching off "Evaluate new runs automatically" limits it to the runs you evaluate by hand.

The reasoning behind these defaults, and the tradeoffs they accept, are in [SECURITY.md](../SECURITY.md).
