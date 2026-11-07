import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("next/server", () => ({ after: vi.fn() }));

const migrationsFolder = fileURLToPath(
  new URL("../../../../packages/db/drizzle", import.meta.url),
);

type ProviderHandler = (
  body: string,
  res: import("node:http").ServerResponse,
) => void;

let container: StartedPostgreSqlContainer;
let provider: Server;
let dbModule: typeof import("@agentlathe/db");
let route: typeof import("../../app/v1/chat/completions/route");
let agent: { id: string; name: string };
let handleCompletion: ProviderHandler;

const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

const base = {
  id: "gen-test",
  object: "chat.completion.chunk",
  created: 1,
  model: "test/model",
};

function sseResponse(
  res: import("node:http").ServerResponse,
  frames: string[],
) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const frame of frames) res.write(frame);
  res.end();
}

function streamingCompletion(deltas: string[]): ProviderHandler {
  return (_body, res) =>
    sseResponse(res, [
      chunk({
        ...base,
        choices: [
          { index: 0, delta: { role: "assistant" }, finish_reason: null },
        ],
      }),
      ...deltas.map((text) =>
        chunk({
          ...base,
          choices: [
            { index: 0, delta: { content: text }, finish_reason: null },
          ],
        }),
      ),
      chunk({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      }),
      "data: [DONE]\n\n",
    ]);
}

function completionRequest(
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function parseSseFrames(text: string): unknown[] {
  return text
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => frame.slice("data: ".length))
    .map((data) => (data === "[DONE]" ? "[DONE]" : JSON.parse(data)));
}

function contentDeltas(frames: unknown[]): string[] {
  return frames
    .filter(
      (frame): frame is { choices: Array<{ delta: { content?: string } }> } =>
        typeof frame === "object" && frame !== null && "choices" in frame,
    )
    .map((frame) => frame.choices[0]?.delta?.content)
    .filter((content): content is string => typeof content === "string");
}

async function latestRun() {
  const { desc } = await import("drizzle-orm");
  const [run] = await dbModule.db
    .select()
    .from(dbModule.agentRuns)
    .orderBy(desc(dbModule.agentRuns.createdAt))
    .limit(1);
  return run;
}

describe("POST /v1/chat/completions against a scripted provider (requires Docker)", () => {
  beforeAll(async () => {
    provider = createServer((req, res) => {
      if (req.method === "GET" && req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      let body = "";
      req.on("data", (part) => {
        body += part;
      });
      req.on("end", () => handleCompletion(body, res));
    });
    await new Promise<void>((resolve) => provider.listen(0, resolve));
    const port = (provider.address() as AddressInfo).port;
    process.env.PROVIDER_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.PROVIDER_API_KEY = "test-key";

    container = await new PostgreSqlContainer("postgres:16").start();
    process.env.DATABASE_URL = container.getConnectionUri();

    dbModule = await import("@agentlathe/db");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(drizzle(dbModule.getPool()), { migrationsFolder });

    route = await import("../../app/v1/chat/completions/route");

    await dbModule.setSettings({ trackV1Runs: true });
    const [seeded] = await dbModule.db
      .insert(dbModule.agents)
      .values({
        name: "v1-stream-agent",
        slug: dbModule.agentSlug("v1-stream-agent"),
        model: "test/model",
        recordTraffic: true,
      })
      .returning();
    agent = seeded;
  }, 60000);

  afterAll(async () => {
    await dbModule.closePool();
    await container.stop();
    await new Promise<void>((resolve, reject) =>
      provider.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(async () => {
    await dbModule.db.delete(dbModule.agentRuns);
  });

  it("streams SSE frames in order, ends with [DONE], and records the run with its transcript", async () => {
    handleCompletion = streamingCompletion(["Hello", " world"]);

    const res = await route.POST(
      completionRequest(
        {
          model: agent.name,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        },
        { "x-thread-id": "thread-42", "x-subject-id": " user-42 " },
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const frames = parseSseFrames(await res.text());
    const first = frames[0] as {
      choices: Array<{ delta: { role?: string } }>;
    };
    expect(first.choices[0].delta.role).toBe("assistant");
    expect(contentDeltas(frames)).toEqual(["Hello", " world"]);
    const finish = frames.find(
      (frame) =>
        typeof frame === "object" &&
        frame !== null &&
        (frame as { choices?: Array<{ finish_reason?: string | null }> })
          .choices?.[0]?.finish_reason === "stop",
    );
    expect(finish).toBeDefined();
    expect(frames.at(-1)).toBe("[DONE]");

    await vi.waitFor(async () => {
      const run = await latestRun();
      expect(run).toBeDefined();
      expect(run.agentId).toBe(agent.id);
      expect(run.source).toBe("v1");
      expect(run.status).toBe("ok");
      expect(run.threadId).toBe("thread-42");
      expect(run.subjectId).toBe("user-42");
      expect(run.model).toBe("test/model");
      expect(run.inputTokens).toBe(12);
      expect(run.outputTokens).toBe(7);

      const [transcript] = await dbModule.db
        .select()
        .from(dbModule.runTranscripts)
        .where(
          (await import("drizzle-orm")).eq(
            dbModule.runTranscripts.runId,
            run.id,
          ),
        );
      expect(transcript).toBeDefined();
      expect(transcript.input).toEqual([{ role: "user", content: "hi" }]);
    });
  });

  it("rejects a subject longer than 200 characters before running anything", async () => {
    const before = await latestRun();

    const res = await route.POST(
      completionRequest(
        { model: agent.name, messages: [{ role: "user", content: "hi" }] },
        { "x-subject-id": "u".repeat(201) },
      ),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        message: "x-subject-id must be at most 200 characters.",
        type: "invalid_request_error",
      },
    });
    expect((await latestRun())?.id).toBe(before?.id);
  });

  it("emits usage when stream_options.include_usage is set", async () => {
    handleCompletion = streamingCompletion(["ok"]);

    const res = await route.POST(
      completionRequest({
        model: agent.name,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    );

    const frames = parseSseFrames(await res.text());
    const usageFrame = frames.find(
      (frame) =>
        typeof frame === "object" && frame !== null && "usage" in frame,
    ) as { usage: { prompt_tokens: number; completion_tokens: number } };
    expect(usageFrame).toBeDefined();
    expect(usageFrame.usage.prompt_tokens).toBe(12);
    expect(usageFrame.usage.completion_tokens).toBe(7);
  });

  it("records a provider failure mid-stream as an errored run, not a healthy one", async () => {
    handleCompletion = (_body, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "boom", type: "invalid_request" } }),
      );
    };

    const res = await route.POST(
      completionRequest({
        model: agent.name,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    );

    expect(res.status).toBe(200);
    const frames = parseSseFrames(await res.text());
    const errorFrame = frames.find(
      (frame) =>
        typeof frame === "object" && frame !== null && "error" in frame,
    );
    expect(errorFrame).toBeDefined();
    expect(frames.at(-1)).not.toBe("[DONE]");

    await vi.waitFor(async () => {
      const run = await latestRun();
      expect(run).toBeDefined();
      expect(run.status).toBe("error");
      expect(run.error).toBeTruthy();
    });
  });

  it("returns a complete OpenAI-shaped body and records the run on the non-streaming path", async () => {
    handleCompletion = (_body, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "gen-test",
          object: "chat.completion",
          created: 1,
          model: "test/model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "plain answer" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      );
    };

    const res = await route.POST(
      completionRequest({
        model: agent.name,
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("plain answer");
    expect(json.choices[0].finish_reason).toBe("stop");
    expect(json.model).toBe(agent.name);

    await vi.waitFor(async () => {
      const run = await latestRun();
      expect(run).toBeDefined();
      expect(run.status).toBe("ok");
      expect(run.source).toBe("v1");
    });
  });

  it("injects the agent's memory for the run's subject, records what it saw, and warns about a store it could not load", async () => {
    let systemPrompt = "";
    handleCompletion = (body, res) => {
      systemPrompt = JSON.parse(body).messages[0].content;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "gen-test",
          object: "chat.completion",
          created: 1,
          model: "test/model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hola." },
              finish_reason: "stop",
            },
          ],
        }),
      );
    };
    const [profiles] = await dbModule.db
      .insert(dbModule.memoryStores)
      .values({
        name: "Profiles",
        scope: "agent_subject",
        ownerAgentId: agent.id,
        purpose: "Who they are.",
      })
      .returning();
    await dbModule.applyMemoryOps(
      profiles.id,
      "user-42",
      [{ op: "add", content: "Prefers Spanish." }],
      { author: "human" },
    );

    try {
      const res = await route.POST(
        completionRequest(
          { model: agent.name, messages: [{ role: "user", content: "hi" }] },
          { "x-subject-id": "user-42" },
        ),
      );
      expect(res.status).toBe(200);

      expect(systemPrompt).toContain(
        '### Your history with subject "user-42" (16 / 8,000 characters)',
      );
      expect(systemPrompt).toMatch(
        /- \[s1\] Prefers Spanish\. \(\d{4}-\d{2}-\d{2}\)/,
      );
      await vi.waitFor(async () => {
        const run = await latestRun();
        expect(run.subjectId).toBe("user-42");
        expect(run.memorySeen).toEqual([
          { storeId: profiles.id, partitionKey: "user-42", revision: 1 },
        ]);
        expect(run.warnings).toBeNull();
      });

      await route.POST(
        completionRequest({
          model: agent.name,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(systemPrompt).not.toContain("## Memory");
      await vi.waitFor(async () => {
        const run = await latestRun();
        expect(run.memorySeen).toBeNull();
        expect(run.warnings).toEqual([
          {
            code: "memory_missing_subject",
            message:
              'Ran without the memory of "v1-stream-agent": no x-subject-id was sent.',
          },
        ]);
      });
    } finally {
      await dbModule.db.delete(dbModule.memoryStores);
    }
  });

  it("uses the custom key memory only when x-memory-key matches the key the agent expects", async () => {
    let systemPrompt = "";
    handleCompletion = (body, res) => {
      systemPrompt = JSON.parse(body).messages[0].content;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "gen-test",
          object: "chat.completion",
          created: 1,
          model: "test/model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
        }),
      );
    };
    const [team] = await dbModule.db
      .insert(dbModule.memoryStores)
      .values({
        name: "Team",
        scope: "custom",
        ownerAgentId: agent.id,
        memoryKey: "team-ops",
        purpose: "Team decisions.",
      })
      .returning();
    const ask = (headers: Record<string, string>) =>
      route.POST(
        completionRequest(
          { model: agent.name, messages: [{ role: "user", content: "hi" }] },
          headers,
        ),
      );

    try {
      await ask({ "x-memory-key": "team-ops" });
      expect(systemPrompt).toContain('### Memory for key "team-ops"');
      await vi.waitFor(async () => {
        expect((await latestRun()).memorySeen).toEqual([
          { storeId: team.id, partitionKey: "team-ops", revision: 0 },
        ]);
      });

      await ask({ "x-memory-key": "someone-else" });
      expect(systemPrompt).not.toContain("## Memory");
      await vi.waitFor(async () => {
        expect((await latestRun()).warnings).toEqual([
          {
            code: "memory_key_mismatch",
            message:
              'Ran without the memory of "v1-stream-agent": x-memory-key did not match the key this agent expects.',
          },
        ]);
      });
    } finally {
      await dbModule.db.delete(dbModule.memoryStores);
    }
  });

  it("saves what the agent writes to memory when the run ends, linked to the run", async () => {
    const replies = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "memory_add",
              arguments: JSON.stringify({
                content: "Prefers email over phone.",
              }),
            },
          },
        ],
      },
      { role: "assistant", content: "Noted." },
    ];
    handleCompletion = (_body, res) => {
      const message = replies.shift();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "gen-test",
          object: "chat.completion",
          created: 1,
          model: "test/model",
          choices: [
            {
              index: 0,
              message,
              finish_reason: message?.tool_calls ? "tool_calls" : "stop",
            },
          ],
        }),
      );
    };
    const [profiles] = await dbModule.db
      .insert(dbModule.memoryStores)
      .values({
        name: "Profiles",
        scope: "agent_subject",
        ownerAgentId: agent.id,
        purpose: "Who they are.",
      })
      .returning();

    try {
      const res = await route.POST(
        completionRequest(
          {
            model: agent.name,
            messages: [{ role: "user", content: "Email me, please." }],
          },
          { "x-subject-id": "user-7" },
        ),
      );
      expect((await res.json()).choices[0].message.content).toBe("Noted.");

      const run = await latestRun();
      const { entries, revision } = await dbModule.readPartition(
        profiles.id,
        "user-7",
      );
      expect(revision).toBe(1);
      expect(entries).toMatchObject([
        { shortId: "s1", content: "Prefers email over phone." },
      ]);
      const { getRunMemoryChanges } = await import("../../lib/queries-memory");
      expect(await getRunMemoryChanges(run.id)).toMatchObject({
        changes: [
          {
            op: "add",
            shortId: "s1",
            content: "Prefers email over phone.",
            before: null,
            storeName: "Profiles",
          },
        ],
        proposals: [],
      });
    } finally {
      await dbModule.db.delete(dbModule.memoryStores);
    }
  });
});
