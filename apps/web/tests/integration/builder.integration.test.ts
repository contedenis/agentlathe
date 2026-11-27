import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ after: vi.fn() }));

const migrationsFolder = fileURLToPath(
  new URL("../../../../packages/db/drizzle", import.meta.url),
);

let container: StartedPostgreSqlContainer;
let dbModule: typeof import("@agentlathe/db");
let review: typeof import("../../lib/builder/review");
let agentContext: typeof import("../../lib/builder/agent-context");
let chatRoute: typeof import("../../app/api/builder/chat/route");

async function makeAgent(name: string) {
  const [agent] = await dbModule.db
    .insert(dbModule.agents)
    .values({ name, slug: dbModule.agentSlug(name), model: "test/model" })
    .returning();
  return agent;
}

async function makeRun(
  agentId: string,
  overrides: Partial<typeof dbModule.agentRuns.$inferInsert> = {},
) {
  const [run] = await dbModule.db
    .insert(dbModule.agentRuns)
    .values({ agentId, source: "dashboard", durationMs: 5, ...overrides })
    .returning();
  return run;
}

async function makeDraft(runId: string, rationale: string, status = "open") {
  const [draft] = await dbModule.db
    .insert(dbModule.fixDrafts)
    .values({
      runId,
      messageId: "msg-1",
      anchor: { type: "turn" },
      category: "prompt",
      rationale,
      status,
    })
    .returning();
  return draft;
}

const chat = (body: unknown) =>
  chatRoute.POST(
    new Request("http://test/api/builder/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const userMessage = {
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "hello" }],
};

describe("agent builder (requires Docker)", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(
      "pgvector/pgvector:0.8.6-pg16-trixie",
    ).start();
    process.env.DATABASE_URL = container.getConnectionUri();

    dbModule = await import("@agentlathe/db");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(drizzle(dbModule.getPool()), { migrationsFolder });

    review = await import("../../lib/builder/review");
    agentContext = await import("../../lib/builder/agent-context");
    chatRoute = await import("../../app/api/builder/chat/route");
  }, 60000);

  afterAll(async () => {
    await dbModule.closePool();
    await container.stop();
  });

  it("gathers an agent's open notes, verdicts to fix and failed runs, and nothing of another agent", async () => {
    const [agent, other] = await Promise.all([
      makeAgent("review subject"),
      makeAgent("review bystander"),
    ]);
    const [noted, dismissed, failed, judged, reviewedOk, otherRun] =
      await Promise.all([
        makeRun(agent.id),
        makeRun(agent.id),
        makeRun(agent.id, { status: "error", error: "provider down" }),
        makeRun(agent.id),
        makeRun(agent.id),
        makeRun(other.id, { status: "error", error: "not mine" }),
      ]);
    const [openNote] = await Promise.all([
      makeDraft(noted.id, "Promised a refund."),
      makeDraft(dismissed.id, "Ignore me.", "dismissed"),
      makeDraft(otherRun.id, "Another agent's note."),
    ]);
    const [active, edited, inactive] = await dbModule.db
      .insert(dbModule.agentCriteria)
      .values([
        { agentId: agent.id, question: "Stayed polite?" },
        { agentId: agent.id, question: "New wording?" },
        { agentId: agent.id, question: "Retired?", isActive: false },
      ])
      .returning();
    await dbModule.db.insert(dbModule.runEvaluations).values([
      {
        runId: judged.id,
        criterionId: active.id,
        questionSnapshot: "Stayed polite?",
        status: "fail",
      },
      {
        runId: reviewedOk.id,
        criterionId: active.id,
        questionSnapshot: "Stayed polite?",
        status: "fail",
        reviewedVerdict: "pass",
      },
      {
        runId: noted.id,
        criterionId: active.id,
        questionSnapshot: "Stayed polite?",
        status: "needs_review",
      },
      {
        runId: judged.id,
        criterionId: edited.id,
        questionSnapshot: "Old wording?",
        status: "fail",
      },
      {
        runId: judged.id,
        criterionId: inactive.id,
        questionSnapshot: "Retired?",
        status: "fail",
      },
    ]);

    const result = await review.loadAgentReview(agent.id);

    expect(result.notes).toEqual([
      {
        id: openNote.id,
        runId: noted.id,
        category: "prompt",
        rationale: "Promised a refund.",
        proposedValue: null,
      },
    ]);
    expect(
      result.verdicts
        .map((verdict) => [verdict.runId, verdict.question, verdict.verdict])
        .sort(),
    ).toEqual(
      [
        [judged.id, "Stayed polite?", "fail"],
        [noted.id, "Stayed polite?", "needs_review"],
      ].sort(),
    );
    expect(result.failedRuns).toEqual([
      { runId: failed.id, error: "provider down" },
    ]);
  });

  it("renders a run of the agent as text, and refuses a run of another agent or without a transcript", async () => {
    const [agent, other] = await Promise.all([
      makeAgent("transcript subject"),
      makeAgent("transcript bystander"),
    ]);
    const [run, bare, foreign] = await Promise.all([
      makeRun(agent.id),
      makeRun(agent.id),
      makeRun(other.id),
    ]);
    const transcript = {
      input: [{ role: "user", content: "Where is my order?" }],
      output: [{ role: "assistant", content: "It ships tomorrow." }],
    };
    await dbModule.db.insert(dbModule.runTranscripts).values([
      { runId: run.id, ...transcript },
      { runId: foreign.id, ...transcript },
    ]);

    const text = await review.loadRunTranscript(agent.id, run.id);

    expect(text).toContain("USER: Where is my order?");
    expect(text).toContain("ASSISTANT: It ships tomorrow.");
    for (const runId of [bare.id, foreign.id, randomUUID()])
      await expect(review.loadRunTranscript(agent.id, runId)).rejects.toThrow(
        "no stored transcript",
      );
    await expect(
      review.loadRunTranscript(agent.id, "not-a-run"),
    ).rejects.toThrow("runId must be a run id");
  });

  it("describes the agent being improved without nulls the model would copy", async () => {
    const agent = await makeAgent("context subject");

    const context = await agentContext.loadAgentContext(agent.id);

    expect(context).toMatchObject({
      id: agent.id,
      name: "context subject",
      slug: "context-subject",
      description: "",
      systemPrompt: "",
      skillIds: [],
      mcpTools: [],
      memory: { type: "none" },
      schedules: [],
      criteria: [],
    });
    await expect(
      agentContext.loadAgentContext(randomUUID()),
    ).resolves.toBeNull();
  });

  it("refuses to chat without a builder model, and for an agent that does not exist", async () => {
    const off = await chat({ messages: [userMessage] });
    expect(off.status).toBe(409);
    expect(await off.json()).toEqual({
      error: "Choose a builder model in Settings first.",
    });

    await dbModule.setSettings({ builderModel: "vendor/model" });
    const missing = await chat({
      messages: [userMessage],
      agentId: randomUUID(),
    });
    expect(missing.status).toBe(404);

    const invalid = await chat({ messages: [userMessage], agentId: "nope" });
    expect(invalid.status).toBe(400);
  });
});
