# Usage

How to build agents in agentlathe, review what they did and call them from the outside. If you have not got it running yet, start with the [quickstart](../README.md#quickstart-with-docker).

## Agents

An agent is a name, a model slug, an optional system prompt, and a step budget. Everything else (tools, skills, sub-agents, MCP tools, knowledge collections) is attached by relation. `maxSteps` defaults to `20` and caps the agent's own steps — shared across approval rounds, not per round, and a sub-agent's steps count against the sub-agent's budget, not its caller's; the name is unique, because `/v1` lets callers address an agent by it.

In the UI: **Agents → New agent**. The model dropdown is populated from the provider's `/models` catalog — OpenRouter's by default. You do not have to start from an empty form: the [builder](#the-agent-builder) proposes an agent from what the instance already has.

The agent page has four tabs: **Playground**, **Configuration**, **Evaluation** and **Connect**; the address carries the tab (`?tab=connect`), so a link opens the same one. In the Playground, **New conversation** clears the chat and starts a new thread.

A run may take up to 30 minutes in total (`RUN_TIMEOUT_SECONDS`), sub-agent calls included and time spent waiting for an approval excluded; past that it is stopped and recorded as failed.

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

A tool is a **JSON Schema** for its input plus an **endpoint URL**. The schema is validated when you save the tool (invalid JSON Schema → 400) and **enforced at run time**: input the model emits that does not match it is rejected back to the model instead of reaching your endpoint. When the agent calls the tool, the runner does a `POST` to that URL with the tool input as the JSON body (`content-type: application/json`, 30s timeout) and hands the response text back to the model. The text is capped at a quarter of the agent's model context, counting four characters per token (about 1 MB on a 1,000,000-token model, 128 KB on a 128,000-token one); anything beyond that is truncated and marked `[truncated]`. MCP tool results get the same cap. A non-2xx or a timeout does not end the run: the model is handed the detail (`HTTP <status>: <body>`, or the timeout) and can retry or explain, but the call is recorded as **failed**, so filtering a run's calls by error shows it.

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

MCP tools can also require approval — per agent, toggled on each selected tool in the agent form (the shield on the selected-tool badge). A skill's script can too (see [Scripts](#scripts)). Sub-agent calls never gate.

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

A server that fails to open is collected and reported, not fatal — the rest of the agent's tools still work, and the run detail page lists which servers were down. A server that opens but no longer offers a tool you selected is reported there too, naming the missing tools. Connecting to a server and listing its tools is each bounded by a 30s timeout (the dashboard's **Test connection** included); once connected, an individual tool call gets 60s before it is aborted, handed to the model as an error and recorded as a failed call. A response from the server larger than 8 MB fails the call the same way.

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

### Scripts

A skill can also carry a JavaScript script, for what a model computes badly on its own: arithmetic, dates, parsing and validating data. The agent gets it as a tool of its own, named `skill_` plus the skill's name (`skill_Date_math`) and described by the skill's description; the skills list in the prompt says which tool runs it. The script is the body of a function: it reads the tool's input as `input` and returns a JSON value. It cannot be `async`: a script that returns a promise fails.

```js
// input: { "start": "2026-01-31", "days": 30 }
const date = new Date(input.start);
date.setUTCDate(date.getUTCDate() + input.days);
return { date: date.toISOString().slice(0, 10) };
```

**Input and result.** An optional input schema (JSON Schema, of type `object`) is enforced like an HTTP tool's: input that does not match goes back to the model instead of reaching the script. Without one the script takes any object. The input is limited to 256 KB. What the script returns reaches the model as `{ "result": … }`, with a `logs` array when it called `console.log`.

**Limits.** The script runs in a sandbox: no network, no files, no environment variables, no packages and no timers, two seconds and 64 MB at most, and a result cut at the same limit as a tool's. A script that throws, runs out of time or out of memory does not end the run: the model is handed the error and the call is recorded as failed. The instance runs four scripts at a time; more wait briefly, and when too many are waiting a call fails the same way.

**Testing.** **Test run** in the skill form runs the script against an input you type, before you save.

**Approval.** "Requires approval before running" gates the script like a tool that needs approval: the Playground asks, an MCP client that supports elicitation is asked, and `/v1`, schedules and sub-agents deny it.

**Metrics.** On the metrics page a script's runs are a row of their own, "*name* (script)", apart from the loads of the skill's text.

Over the API a skill takes `script` (up to 100,000 characters, `null` for none), `inputSchema` and `needsApproval`.

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

A schedule can also act for a **Subject** and send a **Memory key** (`subjectId` / `memoryKey` over the API, up to 200 characters each): its runs get them as if a caller had sent `x-subject-id` / `x-memory-key`, so they read and write that [memory](#memory).

The message can carry variables, filled in for each run: `{{date}}` and `{{datetime}}` (when the run was due, in the schedule's time zone), `{{nominal_at}}` (the same time in UTC), `{{last_success_at}}` (when the last successful run was due, or `never`) and `{{schedule}}` (its name).

**Every time a schedule comes due it leaves an occurrence**, listed on the schedule's page with its result, the reason and a link to the run:

- **succeeded** / **failed** — the run finished, or ended with an error; a run stopped by the time limit is failed.
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

# weekday is 0 (Sunday) to 6 and only for weekly; startDate (YYYY-MM-DD) only for monthly;
# subjectId and memoryKey are optional
curl -X POST http://localhost:3000/api/schedules/<schedule-uuid>/run
curl http://localhost:3000/api/schedules/<schedule-uuid>/occurrences
```

## Run subjects

A run can say who it acted for: a customer, a ticket, a repository, whatever your callers are about. Send `x-subject-id` on `/v1` or MCP, fill **Act as subject** in the Playground (and **Memory key**, its `x-memory-key`, which appears for agents with a custom-key memory), or give a schedule a **Subject**. The run page shows it, and **Runs** filters by it. It is a label of up to 200 characters that the caller picks, not an identity anyone checked: see [SECURITY.md](../SECURITY.md).

## Memory

Memory is what an agent keeps between runs. Each agent has at most one, chosen under **Memory** in its form:

| Memory | One memory for | Loaded when |
|---|---|---|
| **Agent memory** | All the agent's runs | Always |
| **Agent memory per subject** | Each `x-subject-id` | The run has a subject |
| **Agent memory with a custom key** | The value you set in the agent | The request sends `x-memory-key` with exactly that value |

A memory is a list of short entries (500 characters each) under a character limit (8,000 by default, 20,000 at most), with a **purpose** that tells the agent what belongs in it. At the start of every run the entries are added to the end of the agent's instructions, framed as data saved in earlier runs and not as instructions, each with an id like `s3` and the date it was written. The agent page warns when the limit would take more than a quarter of the model's context.

The agent changes its memory with three tools: `memory_add`, `memory_update` and `memory_delete`. Their changes are saved when the run ends and seen from the next run, never by the run that made them, and each change records the run that made it. Changes that would overflow the limit, touch a pinned entry or look like a credential are refused back to the model. Turn on **Require approval** and the changes wait on the memory's page for you to approve or reject them; one whose entry changed in the meantime is rejected. If a tool of the agent's own already has one of those names, it is renamed, keeping its approval gate.

A run that lacks what its memory needs (a subject for a per-subject memory, the right `x-memory-key` for a custom one) runs without memory and says so on the run page, and the agent page counts those runs over the last week. Both need the run recorded: `/v1` and MCP runs are not recorded by default (see [Metrics](#metrics)), and without a run row there is no warning, and the memory's changes are saved without the run that made them. Sub-agents load their own memory with the same subject and key as the run that called them.

**Compaction.** When a memory passes 90% of its limit after a run, the agent's model consolidates it down to 60%: it keeps, merges or deletes entries, giving a reason for each deletion, and keeps pinned ones as they are. The result is checked before it is applied (every entry accounted for once, pinned ones included in the 60%) and retried once with what was wrong; if it still fails, nothing changes and the failure is listed. A merged or dropped entry keeps its history and can be restored like any deleted one. If the pinned entries alone take more than 60%, the memory is not compacted and its page says so.

**The Memory section** lists every agent's memory. Its page shows the memory, one per subject for a per-subject memory, and lets you add, edit, pin, delete and restore entries, with the history of each: nothing is overwritten, every change to an entry's text is a new version, and a deleted entry keeps its history and can be restored. The run page shows the memory a run loaded, rebuilt at the revision it saw, and what the run changed.

```bash
curl -X POST http://localhost:3000/api/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Support coordinator",
    "model": "~deepseek/deepseek-v4-flash-latest",
    "memory": {
      "type": "agent_subject",
      "settings": {
        "purpose": "What each customer told you about their account and preferences.",
        "charLimit": 8000,
        "requireApproval": false
      }
    }
  }'
```

`type` is `none`, `agent`, `agent_subject` or `custom`; `custom` also takes `memoryKey`. Over the API every `settings` field is required, and `charLimit` runs from 1,000 to 20,000. Switching type keeps the old memory's entries, off, until you switch back. Changing a custom key starts an empty memory for the new key; the old key's entries stay on the memory's page, and come back if you set the old key again. The other `/api/memory-stores` routes are the dashboard's own and may change between versions.

**Forgetting a subject.** **Forget subject**, on a per-subject memory or on **Runs** filtered by a subject, deletes that subject's memory in every agent, with its history; the transcripts and fix drafts of its runs; and the schedules that act for it. The runs stay, without the subject, so metrics do not change. What its runs wrote into an agent memory or a custom-key one stays there: delete it by hand. A run for that subject still in progress when you forget it can save to its memory when it ends, and is recorded with the subject: forget again once its traffic has stopped.

```bash
curl -X POST http://localhost:3000/api/subjects/forget \
  -H "Content-Type: application/json" \
  -d '{ "subjectId": "customer-123" }'
```

## Knowledge

Knowledge is documents an agent can consult. In the UI: **Knowledge → New collection**, then **Upload documents** on the collection's page.

A collection has a unique name and a **description**. The description is what the agent reads in its instructions to decide when to search the collection, so say what it holds and when it helps: "Refund, shipping and warranty policies, current as of this year" works better than "Policies".

Documents can be **PDF** (with a text layer), **Markdown** (`.md`, `.markdown`) or **plain text** (`.txt`), up to 20 MB each. The type is checked by the extension and by the content: a `.pdf` must start like a PDF, and Markdown and text must be UTF-8. There is no CSV, no images, no OCR and no import from a URL. The original file is kept and can be downloaded from the document's page.

**Processing.** An uploaded document is processed in the background, starting right after the upload: its text is extracted, split into passages of about 800 characters that overlap by about 150, and each passage is embedded with `EMBEDDING_MODEL` through the same provider as the agents (see [Embedding model](#embedding-model)). The collection's page lists every document as **waiting**, **processing**, **ready** or **failed**, with its pages and size. A PDF where fewer than half the pages have text fails at once with "No text found. Is it a scanned PDF?". A failure from the provider is retried twice, two minutes apart, and the document then fails; it shows why and can be retried once you fixed the cause (a key, a model, a quota). A document that cannot be read fails at once and is not offered a retry: upload a readable version instead. The document's page shows its extracted text, page by page, up to its first 100,000 characters: it is what agents search and read, so if something is missing or garbled there, it is missing for the agent too.

Processing runs in every app process, two documents at a time. A document left in processing by a process that stopped is taken over after 10 minutes; a process that stops gracefully with its scheduler on gives its documents back without spending an attempt. Retries, interrupted documents and the re-embedding after a model change are picked up by the [scheduler](#schedules), every 30 seconds, and by the next upload or retry: with `SCHEDULER_ENABLED=false` on every process, documents are processed only right after an upload or a retry, and the collection's page warns about it.

**Attaching to an agent.** The agent form has a **Knowledge** card: pick collections from **Add a collection**, which searches them by name, and remove one with its ×. Each attached collection is used in one of two modes:

| Mode | What the agent gets |
|---|---|
| **Search** (default) | A `search_knowledge` tool, and a list of the collections it can search, with their descriptions, at the end of its instructions |
| **Always read** | The text of every document of the collection at the end of its instructions, on every run |

`search_knowledge` takes a `query` and returns the five passages closest in meaning to it, from all the agent's searched collections, each with its collection, document and page (PDF only). It finds meaning, not exact text: a part number or an error code may not come back first. If the embedding provider fails during a search, the tool returns the error to the model and the run goes on. The run page shows each search with its query and the passages it returned, and each one is recorded as a call of kind `knowledge`.

**Always read** is for short documents the agent must always keep in mind. They are framed in the instructions as reference material — data, not instructions. The collections an agent reads whole share a quarter of the model's context, counting about four characters per token (when the provider does not report the model's context, `CONTEXT_LIMIT_FALLBACK` tokens, 128,000 unless you set it); the agent form shows how much of it they take. A collection that does not fit is searched instead for that run, and the run carries a warning, shown on the run page and counted on the agent page under "Runs that ran without part of their context". Both need the run recorded: `/v1` and MCP runs are not recorded by default (see [Metrics](#metrics)).

If the agent searches a collection and a tool of its own already resolves to `search_knowledge`, that tool is renamed `search_knowledge_2`, keeping its approval gate. Sub-agents use their own collections, not their caller's. An agent's [version](#metrics) includes the name, description and mode of each attached collection, not its documents: adding a document changes what the agent finds without creating a new version.

Deleting a document deletes its file, its text and its passages, and agents stop finding it from their next run. Deleting a collection deletes its documents and detaches it from every agent.

```bash
curl -X POST http://localhost:3000/api/knowledge/collections \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Support policies",
    "description": "Refund, shipping and warranty policies."
  }'

# one file per request, in a multipart "file" field
curl -X POST http://localhost:3000/api/knowledge/collections/<collection-uuid>/documents \
  -F "file=@policies.pdf"

# attach it to an agent; mode is "search" or "always"
curl -X PATCH http://localhost:3000/api/agents/<agent-uuid> \
  -H "Content-Type: application/json" \
  -d '{ "knowledge": [{ "collectionId": "<collection-uuid>", "mode": "search" }] }'
```

`knowledge` replaces the agent's whole list of collections. The other `/api/knowledge` routes are the dashboard's own and may change between versions.

### Embedding model

`EMBEDDING_MODEL` (default `openai/text-embedding-3-small`) is called through `PROVIDER_BASE_URL` with `PROVIDER_API_KEY`, so the provider must serve an OpenAI-compatible embeddings endpoint. OpenRouter does; for another provider, set a model it serves.

Changing it re-embeds every document with the new model, reusing the text already extracted. Until a document is re-embedded, search does not find it (agents that read its collection whole are not affected), and the collection's page says so. Every app process must use the same `EMBEDDING_MODEL`: two processes with different values keep re-embedding each other's documents.

Search is the same with or without the Postgres [pgvector](https://github.com/pgvector/pgvector) extension, and returns the same passages; with it, it is faster (about 40 ms against 1 s over 10,000 passages in our measurements). The compose stack includes it; see [DEPLOYMENT.md](DEPLOYMENT.md#running-without-docker) for a Postgres of your own.

## Metrics

Three tables, deliberately separated:

- **`agent_runs`** — one row per call: agent, source (`dashboard` / `v1` / `mcp` / `schedule`), status, `thread_id`, `subject_id`, model, duration, steps, tool calls, in/out tokens, approvals requested and granted, error. **No message content.**
- **`agent_run_calls`** — one row per invocation inside a run: `kind` (`tool`, `mcp`, `sub_agent`, `skill`, `memory`, `knowledge`), name, duration, status (`ok` / `error` / `denied`). This is what makes "which tool is slow, which one keeps getting denied" answerable. A skill's script is a `skill` call under its tool name (`skill_…`); loading the skill's text is a `skill` call under the skill's name.
- **`run_transcripts`** — the actual input and output messages, keyed 1:1 on the run.

Each run also points at the **agent version** it ran with: a hash of the agent's behavior-relevant configuration (model, prompt, step limit, skills and their scripts, tools, MCP selections, sub-agents, memory settings, knowledge collections and their modes) taken when the run started. The run detail page shows its first 8 characters next to the duration, so two runs with the same short hash ran with the same configuration; clicking it opens that configuration: prompt, skills, tools, MCP selections, sub-agents, memory and knowledge. MCP auth headers are never part of it, and of a tool or server URL only scheme and host stay readable; the rest is stored as a short digest.

Whether a run is recorded at all is gated **per source**, in `settings`: `trackDashboardRuns` and `trackScheduleRuns` default to `true`, `trackV1Runs` and `trackMcpRuns` to `false`. Toggle them under "What to record" in **Settings** (`/settings`), or over the API:

```bash
curl -X PATCH http://localhost:3000/api/settings \
  -H "Content-Type: application/json" \
  -d '{ "trackV1Runs": true, "agentRunTtlDays": 30, "transcriptTtlDays": 7 }'
```

Retention is TTL-based and swept lazily, when a page that shows runs loads and about every ten minutes while a [scheduler](#schedules) runs: runs default to **90 days**, transcripts to **14**. Both `agentRunTtlDays` and `transcriptTtlDays` are configurable through that same `PATCH`. Deleting an agent deletes its runs, criteria, versions, schedules and memory; deleting a run deletes its transcript, notes and verdicts. Agent versions have no TTL.

**Evaluation.** When an agent has [criteria](#criteria), its metrics page (`/metrics/[id]`) has an Evaluation section for the selected range, and `/metrics` shows the overall pass rate, the runs awaiting review (all of them, not only those in the range, linking to the same queue in the runs list) and a pass-rate column per agent. Everything follows the criteria counting rules: your review overrides the judge, unreviewed needs-review, not-applicable, skipped and errored verdicts stay out of the rate, and only verdicts given to the criterion's current question count.

- **Evaluation by agent version** — one row per active criterion, one column per agent version that was judged in the range, ordered by when each version last ran in the range (the newest is highlighted; a version is labelled by the first 8 characters of its hash, the date it first appeared and its last run). A version that ran in several periods, for example after you reverted a change, is one column, and the newest is whichever ran most recently. Each cell shows the pass rate, `n` (the verdicts it is based on) and how many are still to review; a dash means no data. To answer "did my last change help?", read the newest column against the one before it: next to the newest cell, the change in points appears only when both versions have at least 5 judged verdicts. With fewer it says "too few verdicts to compare" instead, because a swing of a few runs is noise. Under every version but the first, a one-line summary says what changed against the column to its left (the same pair the change in points compares), and **What changed** opens the diff: model, step limit, a line diff of the prompt, and the skills, tools, MCP servers, sub-agents, memory and knowledge collections that were added, removed or edited. Entities are matched by name, so a rename reads as one removed and one added. A change inside a sub-agent is named but not detailed; that sub-agent's own metrics page shows it. Inactive criteria are left out.
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

The Home page surfaces a **"Needs attention"** list — runs that either failed or carry an open note — instead of just the most recent ones, so the queue stays useful once you have thousands of runs.

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

**Evaluation** runs automatically once a run's transcript is stored, unless you switch off "Evaluate new runs automatically" in the agent form, under **Recording and evaluation** next to "Record external traffic" (`autoEvaluate` on the agent API; the Evaluation tab says which way it is set). Only runs with a stored transcript can be judged, so /v1 and MCP runs need the agent's traffic recording on. **Re-evaluate recent runs** judges the agent's latest runs again and reports the totals (a human review is kept unless the criterion's question was edited since). If the judge endpoint does not serve the Decisions API, or the key or judge model is wrong, the tab shows the last evaluation error. The judge model is set under **Settings** ("Judge model", default `typesafe/jev-1.13`, or `judgeModel` in `PATCH /api/settings`), which also shows the host the judge is called on.

**Another judge endpoint.** By default the judge is OpenRouter's Decisions API, reached with `PROVIDER_API_KEY`. If `PROVIDER_BASE_URL` points somewhere else (OpenAI, Ollama, vLLM), that endpoint does not serve the judge and evaluations fail until you set the two variables below. To call Jev somewhere else, set two env vars: `JUDGE_URL`, the full endpoint, and `JUDGE_API_KEY`, its key. For TypeSafe's own API that is `https://api.typesafe.ai/v1/systemone`, with the judge model set to a TypeSafe id such as `jev-latest`. Any host that speaks the same Decisions / System One API works the same way (AIMLAPI, a LiteLLM proxy). `JUDGE_URL` without `JUDGE_API_KEY` refuses to call: the provider key is never sent to another host. `JUDGE_API_KEY` on its own keeps OpenRouter and only bills judge calls to a different key.

## Reviewing verdicts

The run page (`/runs/[id]`) puts the run's counts in one line and its review work in two tabs, **Evaluation** and **Fix drafts**, each labelled with what waits in it (verdicts to review, open notes). It opens on Evaluation when a verdict needs review, on Fix drafts when only notes are open, and switches to Fix drafts when you save a note. The Evaluation tab lists one verdict per criterion, worst first: unreviewed fails, then verdicts that need review, then errors and skips, then the ones a human already reviewed, then passes and not-applicable. Each row shows the question as it was judged (with a note when the criterion has been reworded since), the verdict, the judge's probability of a pass, and why a verdict is missing when the judge errored or skipped the run (transcript too long, or the run paused on an approval). **Re-evaluate** judges the run again against the agent's active criteria.

- **Human review.** On a pass, fail or needs-review verdict, **Pass** / **Fail** records your own call; it overrides the judge in the pass rates, the counts and the runs list: the row's badge shows your verdict and a "Reviewed · judge said ..." line keeps what the judge said when you disagreed. **Undo** removes it. A review belongs to the question it answered: re-evaluating after the question was edited discards it, while re-evaluating under the same wording keeps it.
- **Note a fix.** On a failed (or still undecided) verdict, **Note a fix** opens the usual fix-draft dialog anchored to the run's last assistant turn, with the rationale prefilled as "Failed criterion: ..." ("Judge unsure on criterion: ..." when the verdict is still undecided). Edit it, pick the lever and save.
- **No criteria, no transcript.** An agent without active criteria shows a link to the agent page; a run without a stored transcript cannot be evaluated (for /v1 and MCP runs, turn on the agent's external traffic recording).

On the **Runs** page every row summarises its verdicts: a red badge counts failures (a human review counts instead of the judge), an amber one counts verdicts still waiting for review, and a green check ("No failures") means every verdict passed or did not apply and at least one passed (a muted "n/a" when none applied). When nothing needs attention but the judge errored or skipped a run, an "error" or "skipped" badge says so. Only verdicts of active criteria under their current wording are counted. The **Evaluation** filter next to the **Source** buttons narrows the list, and is kept when you change the page or the source:

- **Needs review** is the review queue: runs with at least one unreviewed needs-review verdict, with how many there are next to its name. When it is empty the list says "Nothing to review."
- **Failed a criterion**: runs with at least one failing verdict, after human reviews. A run that failed to finish is a different thing: it shows as an error in the status column.
- **Not evaluated**: runs with a stored transcript and no counted verdicts, for agents that have at least one active criterion, to spot gaps (for example runs from before you wrote a criterion).

Next to them, **Needs attention** keeps the runs that failed or carry an open note — the same list Home shows — and an agent's **Runs** link opens the list filtered to that agent. The filters combine. A run opened from the list remembers the filters it came from: the arrows at the top of the run page go to the newer and the older run in that same list, so a queue can be reviewed without going back to it.

## The agent builder

The builder is a chat that knows what this instance has and proposes configuration for you to review. It never saves anything: every proposal opens in the form you would have filled in yourself.

**Builder model.** The builder uses a model of its own: set "Builder model" under **Settings** to the ID of a model your provider serves (`builderModel` in `PATCH /api/settings`, `null` to turn it off). Until you do, the builder is off. It writes system prompts, so pick a capable model; its calls are billed by your provider like an agent's.

**A new agent.** On **Agents → New agent**, **Describe it to the builder** opens the chat. Say what the agent is for, who calls it and what it must not do. The builder reads the instance's HTTP tools with their input schemas, skills, MCP servers, knowledge collections and agents, and looks up the tools an MCP server offers and the models of your provider. It answers with a card: the model it picked, what it attaches and why, and what the agent would need that the instance does not have yet. **Load into form** fills the agent form; change what you like and save. A proposal that names something that does not exist, a taken name or a model your provider does not serve is sent back to the builder before you see it. Loading a proposal over a form you already edited asks first.

**An existing agent.** **Improve with builder** on an agent's page opens the edit form with the chat open; the edit form has the same button, **Improve it with the builder**. There the builder also knows that agent's configuration. It reads the latest open [notes](#fix-drafts) on the agent's runs, the [verdicts](#reviewing-verdicts) where a run failed a criterion or the judge was unsure, the latest runs that ended in an error, and any of those runs' transcripts, and proposes the changed configuration. The card says what differs from the saved one, names a model that changes and any MCP tool that loses its approval, and says how many notes the change answers. After you save, it offers to mark those notes applied.

**Schedules and criteria.** For an existing agent the builder can also propose a schedule, or criteria, such as one that would catch a problem it just fixed. Each opens in its own form.

**Skills.** In both places it can propose a skill, with a [script](#scripts) when the job is computing. A skill you save is not attached to any agent until an agent proposal, or you, attach it.

**What is kept.** The conversation stays in your browser tab and goes away with it. Nothing about it is recorded on the server: no run, no transcript, no cost on the metrics page. What the builder reads is other people's text, so read what a proposal changes before you save it. See [SECURITY.md](../SECURITY.md#the-builder-sends-your-catalog-to-its-model) for what the builder sends to its model.

---

## Calling your agents

### OpenAI-compatible API (`/v1`)

Every **active** agent is exposed as a model. Point any OpenAI-compatible client (Cursor, LiteLLM, the `openai` SDK) at `http://localhost:3000/v1`. The agent's **Connect** tab has this call, the SDK snippets and the MCP client block filled in for that agent.

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

The API is **stateless**: the caller owns the full `messages` history on every request. The optional `x-thread-id` header groups the runs of one conversation in the dashboard; without it each call stands alone. `x-subject-id` names who the run acted for, and `x-memory-key` picks a memory with a custom key (see [Memory](#memory)); each takes up to 200 characters, and a longer one is refused with a 400.

Tools flagged `needsApproval` are **automatically denied** on `/v1` — it is headless, there is nobody there to approve. The model gets back `tool '<name>' requires approval; not available over the API` and can carry on without it.

**Errors.** A run that fails answers with `The server had an error while processing your request.` (`type: "api_error"`), as a 500 or, when streaming, as a final `error` frame with no `[DONE]`. A streaming run stopped by the time limit ends with `The run exceeded its time limit.` instead; a non-streaming one returns the same generic 500. The provider's or the tool's own message is not sent to the client: it is on the run, on the **Runs** page, when the run is recorded. The MCP endpoint does answer with the error's message.

### MCP endpoint (one per agent)

Each active agent is also a tiny MCP server at:

```
POST http://localhost:3000/mcp/agents/{agent-id-or-uuid}
```

The path segment accepts the agent's **ID (slug), its URL-encoded name, or its UUID** — same resolver as the `/v1` `model` field.

It speaks streamable HTTP (protocol `2025-11-25`, `2025-06-18` accepted) and exposes exactly **one tool**, `ask_{id}` — the agent with ID `response-writer` becomes `ask_response-writer` — taking a single `message` string and returning the agent's answer. Progress notifications are sent per step when the client supplies a `progressToken`. `x-subject-id` and `x-memory-key` are read from the HTTP request headers, as on `/v1`; one over 200 characters is refused with an invalid-params error.

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
| **Run** | One row: agent, source, status, duration, steps, tokens, tool calls. No message content. | Playground and schedules **on**; API and MCP **off** | "What to record" in **Settings** (`/settings`), or `PATCH /api/settings` |
| **Transcript** | The actual messages of the call, input and output. | Playground and schedules **always**; API and MCP **off** | "Record external traffic" on the agent |

So the default is: your own experiments are recorded, third-party traffic is not — until you decide otherwise, per agent.

**Transcripts are stored verbatim. There is no redaction.** If a caller sends an API key, a customer's email or a medical record in a message, that is what lands in your database, in plaintext, on any agent you switched recording on for. agentlathe does not detect, mask or hash anything. Turning on recording for an agent that serves real users is a decision about their data, not just yours — make it deliberately, and tell them if that is what your jurisdiction expects.

Retention is TTL-based and swept lazily (on page loads, and every ten minutes or so while a scheduler runs): runs default to 90 days, transcripts to 14 — transcripts are the heavy, sensitive half, so they expire first. Both are configurable. Deleting an agent deletes its runs and its memory, and deleting a run deletes its transcript, notes and verdicts. A verdict outlives the transcript it was judged on, which is why a run older than the transcript TTL can no longer be re-evaluated.

**Evaluated transcripts leave the instance.** When an agent has active criteria, each run that is evaluated (or previewed against a draft criterion) is sent to the judge as text: TypeSafe's Jev, through OpenRouter by default or the host `JUDGE_URL` names. Agents without criteria send nothing, and switching off "Evaluate new runs automatically" limits it to the runs you evaluate by hand.

**Memory has no TTL.** Entries and every past version stay until you delete the memory or its agent: deleting an entry hides it but keeps its history, which can be restored. Forgetting a subject removes that subject's memory and transcripts. Like transcripts, memory is not redacted: the agent's tools refuse an entry that looks like a credential, and nothing else is checked.

**The builder sends your catalog to its model.** When someone uses the [builder](#the-agent-builder), the names and descriptions of what the instance has go to the builder's model at your provider, and for an existing agent also its configuration and the notes, verdicts and transcripts the builder reads. Its conversations are not recorded on the server; they stay in the browser tab. See [SECURITY.md](../SECURITY.md#the-builder-sends-your-catalog-to-its-model).

**Knowledge documents leave the instance to be indexed.** The whole text of every document you upload is sent to the embedding provider, again whenever `EMBEDDING_MODEL` changes, and what agents find or read whole goes to their model with each run. Documents, their text and their passages have no TTL and no redaction, and anyone who reaches the dashboard can read and download them. A document can also carry text written to steer the agent: see [SECURITY.md](../SECURITY.md#knowledge-is-sent-out-to-be-indexed-and-read-as-data).

The reasoning behind these defaults, and the tradeoffs they accept, are in [SECURITY.md](../SECURITY.md).
