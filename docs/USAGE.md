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

## Metrics

Three tables, deliberately separated:

- **`agent_runs`** — one row per call: agent, source (`dashboard` / `v1` / `mcp`), status, `thread_id`, model, duration, steps, tool calls, in/out tokens, approvals requested and granted, error. **No message content.**
- **`agent_run_calls`** — one row per invocation inside a run: `kind` (`tool`, `mcp`, `sub_agent`, `skill`), name, duration, status (`ok` / `error` / `denied`). This is what makes "which tool is slow, which one keeps getting denied" answerable.
- **`run_transcripts`** — the actual input and output messages, keyed 1:1 on the run.

Whether a run is recorded at all is gated **per source**, in `settings`: `trackDashboardRuns` defaults to `true`, `trackV1Runs` and `trackMcpRuns` to `false`. Toggle them under "What to record" in `/metrics`, or over the API:

```bash
curl -X PATCH http://localhost:3000/api/settings \
  -H "Content-Type: application/json" \
  -d '{ "trackV1Runs": true, "agentRunTtlDays": 30, "transcriptTtlDays": 7 }'
```

Retention is TTL-based and swept lazily (no cron): runs default to **90 days**, transcripts to **14**. Both `agentRunTtlDays` and `transcriptTtlDays` are configurable through that same `PATCH`. Deleting an agent deletes its runs; deleting a run deletes its transcript and notes.

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
| **Run** | One row: agent, source, status, duration, steps, tokens, tool calls. No message content. | Playground **on**; API and MCP **off** | "What to record" in `/metrics`, or `PATCH /api/settings` |
| **Transcript** | The actual messages of the call, input and output. | Playground **always**; API and MCP **off** | "Record external traffic" on the agent |

So the default is: your own experiments are recorded, third-party traffic is not — until you decide otherwise, per agent.

**Transcripts are stored verbatim. There is no redaction.** If a caller sends an API key, a customer's email or a medical record in a message, that is what lands in your database, in plaintext, on any agent you switched recording on for. agentlathe does not detect, mask or hash anything. Turning on recording for an agent that serves real users is a decision about their data, not just yours — make it deliberately, and tell them if that is what your jurisdiction expects.

Retention is TTL-based and swept lazily (no cron): runs default to 90 days, transcripts to 14 — transcripts are the heavy, sensitive half, so they expire first. Both are configurable. Deleting an agent deletes its runs, and deleting a run deletes its transcript and notes.

The reasoning behind these defaults, and the tradeoffs they accept, are in [SECURITY.md](../SECURITY.md).
