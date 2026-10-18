import { createServer, type Server, type ServerResponse } from "node:http";
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

type ProviderHandler = (body: string, res: ServerResponse) => void;

let container: StartedPostgreSqlContainer;
let provider: Server;
let dbModule: typeof import("@agentlathe/db");
let engine: typeof import("../../lib/scheduler/engine");
let drizzleOrm: typeof import("drizzle-orm");
let handleCompletion: ProviderHandler;
let providerCalls: string[] = [];

function completion(text: string, delayMs = 0): ProviderHandler {
  return (_body, res) => {
    setTimeout(() => {
      if (res.destroyed) return;
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
              message: { role: "assistant", content: text },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
      );
    }, delayMs);
  };
}

const rejected: ProviderHandler = (_body, res) => {
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "model not found" } }));
};

async function makeAgent(name: string, isActive = true) {
  const [agent] = await dbModule.db
    .insert(dbModule.agents)
    .values({
      name,
      slug: dbModule.agentSlug(name),
      model: "test/model",
      isActive,
    })
    .returning();
  return agent;
}

async function makeSchedule(
  agentId: string,
  overrides: Partial<typeof dbModule.schedules.$inferInsert> = {},
  dueAgo = "1 second",
) {
  const { sql } = drizzleOrm;
  const [schedule] = await dbModule.db
    .insert(dbModule.schedules)
    .values({
      agentId,
      name: "Morning digest",
      frequency: "daily",
      timeOfDay: "09:00",
      timezone: "Europe/Madrid",
      input: "Run {{schedule}} for {{date}}.",
      nextRunAt: sql`now() - ${dueAgo}::interval`,
      ...overrides,
    })
    .returning();
  return schedule;
}

async function runTick(signal = new AbortController().signal) {
  const executions = await engine.tick(signal);
  await Promise.all(executions.map((execution) => execution.done));
  return executions;
}

async function occurrencesOf(scheduleId: string) {
  const { eq } = drizzleOrm;
  return dbModule.db
    .select()
    .from(dbModule.scheduleOccurrences)
    .where(eq(dbModule.scheduleOccurrences.scheduleId, scheduleId));
}

async function reload(scheduleId: string) {
  const { eq } = drizzleOrm;
  const [schedule] = await dbModule.db
    .select()
    .from(dbModule.schedules)
    .where(eq(dbModule.schedules.id, scheduleId));
  return schedule;
}

describe("scheduler tick against Postgres and a scripted provider (requires Docker)", () => {
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
      req.on("end", () => {
        providerCalls.push(body);
        handleCompletion(body, res);
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, resolve));
    const port = (provider.address() as AddressInfo).port;
    process.env.PROVIDER_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.PROVIDER_API_KEY = "test-key";

    container = await new PostgreSqlContainer("postgres:16").start();
    process.env.DATABASE_URL = container.getConnectionUri();

    dbModule = await import("@agentlathe/db");
    drizzleOrm = await import("drizzle-orm");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(drizzle(dbModule.getPool()), { migrationsFolder });

    engine = await import("../../lib/scheduler/engine");
  }, 60000);

  afterAll(async () => {
    await dbModule.closePool();
    await container.stop();
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      provider.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(async () => {
    await dbModule.db.delete(dbModule.agents);
    await dbModule.db.delete(dbModule.mcpServers);
    providerCalls = [];
    handleCompletion = completion("Digest ready.");
  });

  it("runs a due schedule once: a scheduled run with its transcript, and the next occurrence ahead", async () => {
    const agent = await makeAgent("digest agent");
    const schedule = await makeSchedule(agent.id, { consecutiveFailures: 2 });

    const executions = await runTick();

    expect(executions).toHaveLength(1);
    const [occurrence] = await occurrencesOf(schedule.id);
    expect(occurrence).toMatchObject({
      status: "succeeded",
      nominalAt: schedule.nextRunAt,
      reason: null,
    });
    expect(occurrence.runId).toEqual(expect.any(String));
    expect(occurrence.finishedAt).not.toBeNull();

    const { eq } = drizzleOrm;
    const [run] = await dbModule.db
      .select()
      .from(dbModule.agentRuns)
      .where(eq(dbModule.agentRuns.id, occurrence.runId as string));
    expect(run).toMatchObject({
      source: "schedule",
      scheduleId: schedule.id,
      status: "ok",
    });
    const [transcript] = await dbModule.db
      .select()
      .from(dbModule.runTranscripts)
      .where(eq(dbModule.runTranscripts.runId, run.id));
    const [input] = transcript.input as Array<{ content: string }>;
    expect(input.content).toMatch(
      /^Run Morning digest for \d{4}-\d{2}-\d{2}\.$/,
    );
    expect(transcript.output).toEqual([
      { role: "assistant", content: "Digest ready." },
    ]);
    expect(providerCalls).toHaveLength(1);

    const after = await reload(schedule.id);
    expect(after.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
    expect(after.consecutiveFailures).toBe(0);

    const [appSettings] = await dbModule.db.select().from(dbModule.settings);
    expect(appSettings.schedulerHeartbeatAt).not.toBeNull();
  });

  it("two ticks at once claim a due occurrence exactly once", async () => {
    const agent = await makeAgent("concurrent agent");
    const schedule = await makeSchedule(agent.id);

    const [first, second] = await Promise.all([runTick(), runTick()]);

    expect(first.length + second.length).toBe(1);
    expect(await occurrencesOf(schedule.id)).toHaveLength(1);
    expect(providerCalls).toHaveLength(1);
  });

  it("an occurrence missed by more than the grace period is skipped and the schedule moves on", async () => {
    const agent = await makeAgent("missed agent");
    const schedule = await makeSchedule(agent.id, {}, "10 minutes");

    expect(await runTick()).toHaveLength(0);

    const [occurrence] = await occurrencesOf(schedule.id);
    expect(occurrence.status).toBe("skipped_missed");
    expect(occurrence.reason).toMatch(/but no scheduler was running until/);
    expect(providerCalls).toHaveLength(0);
    expect((await reload(schedule.id)).nextRunAt?.getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it("skips an occurrence while the previous one is still running", async () => {
    const agent = await makeAgent("overlap agent");
    const schedule = await makeSchedule(agent.id);
    const { sql } = drizzleOrm;
    await dbModule.db.insert(dbModule.scheduleOccurrences).values({
      scheduleId: schedule.id,
      nominalAt: new Date("2026-01-01T00:00:00Z"),
      status: "running",
      heartbeatAt: sql`now()`,
    });

    expect(await runTick()).toHaveLength(0);

    const statuses = (await occurrencesOf(schedule.id)).map(
      (row) => row.status,
    );
    expect(statuses.sort()).toEqual(["running", "skipped_overlap"]);
    expect(providerCalls).toHaveLength(0);
  });

  it("blocks without calling the model when the agent is inactive, the key is missing or an MCP secret is unset", async () => {
    const inactive = await makeSchedule(
      (await makeAgent("inactive agent", false)).id,
    );

    const withMcp = await makeAgent("mcp agent");
    const [server] = await dbModule.db
      .insert(dbModule.mcpServers)
      .values({
        name: "github",
        serverUrl: "https://example.com/mcp",
        authConfig: {
          headers: { Authorization: "AGENTLATHE_SECRET_SCHEDULER_TEST_UNSET" },
        },
      })
      .returning();
    await dbModule.db
      .insert(dbModule.agentMcpTools)
      .values({ agentId: withMcp.id, serverId: server.id, toolName: "issues" });
    const missingSecret = await makeSchedule(withMcp.id);

    await runTick();

    const [inactiveOccurrence] = await occurrencesOf(inactive.id);
    const [secretOccurrence] = await occurrencesOf(missingSecret.id);
    expect(inactiveOccurrence).toMatchObject({
      status: "blocked_preflight",
      reason: "The agent is inactive.",
    });
    expect(secretOccurrence.status).toBe("blocked_preflight");
    expect(secretOccurrence.reason).toContain(
      'MCP server "github": Auth header "Authorization" references the env var AGENTLATHE_SECRET_SCHEDULER_TEST_UNSET',
    );
    expect((await reload(inactive.id)).consecutiveFailures).toBe(1);

    const noKey = await makeSchedule((await makeAgent("no key agent")).id);
    const key = process.env.PROVIDER_API_KEY;
    delete process.env.PROVIDER_API_KEY;
    try {
      await runTick();
    } finally {
      process.env.PROVIDER_API_KEY = key;
    }
    expect((await occurrencesOf(noKey.id))[0]).toMatchObject({
      status: "blocked_preflight",
      reason: "PROVIDER_API_KEY is not set.",
    });
    expect(providerCalls).toHaveLength(0);
  });

  it("marks a running occurrence whose heartbeat went stale as interrupted", async () => {
    const agent = await makeAgent("stale agent");
    const schedule = await makeSchedule(agent.id, {
      nextRunAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const { sql } = drizzleOrm;
    await dbModule.db.insert(dbModule.scheduleOccurrences).values([
      {
        scheduleId: schedule.id,
        nominalAt: new Date("2026-01-01T00:00:00Z"),
        status: "running",
        heartbeatAt: sql`now() - interval '5 minutes'`,
      },
      {
        scheduleId: schedule.id,
        nominalAt: new Date("2026-01-02T00:00:00Z"),
        status: "running",
        heartbeatAt: sql`now()`,
      },
    ]);

    await runTick();

    const byNominal = Object.fromEntries(
      (await occurrencesOf(schedule.id)).map((row) => [
        row.nominalAt.toISOString().slice(0, 10),
        row.status,
      ]),
    );
    expect(byNominal).toEqual({
      "2026-01-01": "interrupted",
      "2026-01-02": "running",
    });
  });

  it("pauses the schedule after five consecutive failures, with the reason", async () => {
    handleCompletion = rejected;
    const agent = await makeAgent("failing agent");
    const schedule = await makeSchedule(agent.id, { consecutiveFailures: 4 });

    await runTick();

    const [occurrence] = await occurrencesOf(schedule.id);
    expect(occurrence.status).toBe("failed");
    expect(occurrence.reason).toEqual(expect.any(String));
    expect(occurrence.runId).toEqual(expect.any(String));
    expect(await reload(schedule.id)).toMatchObject({
      consecutiveFailures: 5,
      isActive: false,
      pausedReason: "Paused after 5 consecutive failures.",
    });
  });

  it("a run aborted by a shutdown ends interrupted and does not count as a failure", async () => {
    handleCompletion = completion("too late", 5000);
    const agent = await makeAgent("aborted agent");
    const schedule = await makeSchedule(agent.id, { consecutiveFailures: 1 });
    const abort = new AbortController();

    const executions = await engine.tick(abort.signal);
    await vi.waitFor(() => expect(providerCalls).toHaveLength(1));
    abort.abort();
    await Promise.all(executions.map((execution) => execution.done));

    const [occurrence] = await occurrencesOf(schedule.id);
    expect(occurrence.status).toBe("interrupted");
    expect((await reload(schedule.id)).consecutiveFailures).toBe(1);
  });
});
