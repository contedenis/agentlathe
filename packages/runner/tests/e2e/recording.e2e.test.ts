import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsFolder = fileURLToPath(
  new URL("../../../db/drizzle", import.meta.url),
);

function requireOpenRouterKey(): void {
  if (process.env.PROVIDER_API_KEY) return;
  const envFile = fileURLToPath(
    new URL("../../../../apps/web/.env.local", import.meta.url),
  );
  if (existsSync(envFile)) {
    const match = readFileSync(envFile, "utf8").match(
      /^PROVIDER_API_KEY=(.+)$/m,
    );
    if (match) {
      process.env.PROVIDER_API_KEY = match[1].trim().replace(/^"|"$/g, "");
      return;
    }
  }
  throw new Error(
    "PROVIDER_API_KEY is required for the e2e suite: export it or set it in apps/web/.env.local",
  );
}

const MODEL = process.env.E2E_MODEL || "~deepseek/deepseek-v4-flash-latest";

let container: StartedPostgreSqlContainer;
let toolServer: Server;
let toolHits: string[] = [];
let db: typeof import("@agentlathe/db");
let runner: typeof import("@agentlathe/runner");

beforeAll(async () => {
  requireOpenRouterKey();

  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  process.env.DATABASE_URL = container.getConnectionUri();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(drizzle(pool), { migrationsFolder });
  await pool.end();

  toolServer = createServer((req, res) => {
    toolHits.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ number: 7 }));
  });
  await new Promise<void>((resolve) => toolServer.listen(0, resolve));
  const port = (toolServer.address() as AddressInfo).port;
  const endpoint = (path: string) => `http://127.0.0.1:${port}${path}`;

  db = await import("@agentlathe/db");
  runner = await import("@agentlathe/runner");

  await db.setSettings({ trackV1Runs: true });

  const [agentRow] = await db.db
    .insert(db.agents)
    .values({
      name: "E2E Recorder",
      slug: "e2e-recorder",
      model: MODEL,
      systemPrompt:
        "You are a test agent. When asked for the number, you MUST call the get_number tool and answer with its result. When asked to clean the workspace, you MUST call the dangerous_cleanup tool.",
      maxSteps: 4,
      isActive: true,
      recordTraffic: true,
    })
    .returning({ id: db.agents.id });

  const toolRows = await db.db
    .insert(db.tools)
    .values([
      {
        name: "get_number",
        description: "Returns the current number.",
        endpoint: endpoint("/number"),
        inputSchema: { type: "object", properties: {} },
        needsApproval: false,
      },
      {
        name: "dangerous_cleanup",
        description: "Deletes the whole workspace. Destructive.",
        endpoint: endpoint("/cleanup"),
        inputSchema: { type: "object", properties: {} },
        needsApproval: true,
      },
    ])
    .returning({ id: db.tools.id });

  await db.db.insert(db.agentTools).values(
    toolRows.map((tool) => ({
      agentId: agentRow.id,
      toolId: tool.id,
    })),
  );
});

afterAll(async () => {
  await db?.closePool();
  await new Promise<void>((resolve) => {
    toolServer?.close(() => resolve());
  });
  await container?.stop();
});

async function runRecorded(prompt: string) {
  const agent = await runner.loadActiveAgent("E2E Recorder");
  if (!agent) throw new Error("seeded agent not found");

  const {
    agent: runtime,
    cleanup,
    stats,
  } = await runner.buildAgentRuntime(agent, {
    buildApproval: runner.buildHeadlessToolApproval,
  });
  const recorder = runner.createRunRecorder({ agent, source: "v1" });
  try {
    const result = await runtime.generate({ prompt });
    const runId = await recorder.record({ stats: stats() });
    await recorder.attachTranscript(
      [{ role: "user", content: prompt }],
      result.steps.flatMap((step) => step.response.messages),
    );
    return { runId, text: result.text };
  } finally {
    await cleanup();
  }
}

async function callRowsOf(runId: string) {
  const { eq } = await import("drizzle-orm");
  return db.db
    .select()
    .from(db.agentRunCalls)
    .where(eq(db.agentRunCalls.runId, runId));
}

describe("recording end to end: real model, real tools, real database", () => {
  it("an executed tool call lands as an ok row with duration, tokens and transcript", async () => {
    toolHits = [];
    const { runId, text } = await runRecorded(
      "What is the number right now? Use your tool.",
    );

    expect(runId).not.toBeNull();
    expect(text.length).toBeGreaterThan(0);
    expect(toolHits).toContain("/number");

    const { eq } = await import("drizzle-orm");
    const [run] = await db.db
      .select()
      .from(db.agentRuns)
      .where(eq(db.agentRuns.id, runId as string));
    expect(run).toMatchObject({ source: "v1", status: "ok", model: MODEL });
    expect(run.durationMs).toBeGreaterThan(0);
    expect(run.inputTokens).toBeGreaterThan(0);

    const calls = await callRowsOf(runId as string);
    const executed = calls.find((call) => call.name === "get_number");
    expect(executed).toMatchObject({ kind: "tool", status: "ok" });
    expect(executed?.durationMs).toBeGreaterThanOrEqual(0);

    const [transcript] = await db.db
      .select()
      .from(db.runTranscripts)
      .where(eq(db.runTranscripts.runId, runId as string));
    expect(transcript).toBeDefined();
  });

  it("a headless denial lands as a denied row and the tool endpoint is never hit", async () => {
    toolHits = [];
    const { runId } = await runRecorded(
      "Clean the workspace now. Call the dangerous_cleanup tool.",
    );

    expect(runId).not.toBeNull();
    expect(toolHits).not.toContain("/cleanup");

    const calls = await callRowsOf(runId as string);
    const denied = calls.find((call) => call.name === "dangerous_cleanup");
    expect(denied).toMatchObject({ kind: "tool", status: "denied" });
  });
});
