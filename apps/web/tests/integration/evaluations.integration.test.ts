import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
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

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const DATED_MODEL = "typesafe/jev-1.13-20260917";

type DecisionQuestion = {
  type: string;
  instructions: string;
  criteria?: { true: string; false: string };
};
type DecisionRequest = {
  url: string;
  authorization: string | undefined;
  body: {
    model: string;
    state: string;
    questions: Record<string, DecisionQuestion>;
  };
};
type DecisionReply = { status: number; body: unknown };

let container: StartedPostgreSqlContainer;
let decisions: Server;
let judgeOrigin: string;
let requests: DecisionRequest[] = [];
let reply: (request: DecisionRequest) => DecisionReply;

let dbModule: typeof import("@agentlathe/db");
let criteriaRoute: typeof import("../../app/api/agents/[id]/criteria/route");
let criterionRoute: typeof import("../../app/api/agents/[id]/criteria/[criterionId]/route");
let evaluateRoute: typeof import("../../app/api/runs/[id]/evaluate/route");
let previewRoute: typeof import("../../app/api/runs/[id]/evaluate/preview/route");
let evaluationRoute: typeof import("../../app/api/runs/[id]/evaluations/[evaluationId]/route");
let settingsRoute: typeof import("../../app/api/settings/route");

function answering(byInstructions: Record<string, number>) {
  return (request: DecisionRequest): DecisionReply => ({
    status: 200,
    body: {
      model: DATED_MODEL,
      answers: Object.fromEntries(
        Object.entries(request.body.questions).map(([id, question]) => [
          id,
          { type: "noul", noul: byInstructions[question.instructions] ?? 0.5 },
        ]),
      ),
      usage: { input_tokens: 468, output_tokens: 63, cost: 0.000019656 },
      id: "gen-dec-1791829365-w29hDFEVOiVv5oQxM16Z",
      provider: "TypeSafe",
    },
  });
}

function jsonRequest(url: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const withId = (id: string) => ({ params: Promise.resolve({ id }) });

const transcript = {
  input: [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "I was charged twice for order 4417" }],
    },
  ],
  output: [
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-search_orders",
          toolCallId: "c1",
          state: "output-available",
          input: { orderId: "4417" },
          output: { charges: [49.9, 49.9] },
        },
        {
          type: "tool-notify",
          toolCallId: "c2",
          state: "output-error",
          input: {},
          errorText: "HTTP 500: down",
        },
        { type: "text", text: "I refunded both charges." },
      ],
    },
  ],
};

const pausedTranscript = {
  input: transcript.input,
  output: [
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-issue_refund",
          toolCallId: "c1",
          state: "approval-requested",
          input: { orderId: "4417" },
          approval: { id: "ap1" },
        },
      ],
    },
  ],
};

async function seedAgent(name: string) {
  const [agent] = await dbModule.db
    .insert(dbModule.agents)
    .values({ name, slug: dbModule.agentSlug(name), model: "test/model" })
    .returning();
  return agent;
}

async function seedRun(
  agentId: string,
  stored: { input: unknown; output: unknown } | null = transcript,
) {
  const [run] = await dbModule.db
    .insert(dbModule.agentRuns)
    .values({ agentId, source: "dashboard", durationMs: 10 })
    .returning();
  if (stored)
    await dbModule.db
      .insert(dbModule.runTranscripts)
      .values({ runId: run.id, ...stored });
  return run;
}

async function seedFixDraft(runId: string) {
  const [draft] = await dbModule.db
    .insert(dbModule.fixDrafts)
    .values({
      runId,
      messageId: "a1",
      anchor: { type: "turn" },
      category: "prompt",
      rationale: "It promised a refund.",
    })
    .returning();
  return draft;
}

async function createCriterion(agentId: string, body: unknown) {
  return criteriaRoute.POST(
    jsonRequest(`http://test/api/agents/${agentId}/criteria`, "POST", body),
    withId(agentId),
  );
}

async function criterion(agentId: string, body: Record<string, unknown>) {
  const res = await createCriterion(agentId, body);
  expect(res.status).toBe(201);
  return res.json();
}

function patchCriterion(agentId: string, criterionId: string, body: unknown) {
  return criterionRoute.PATCH(
    jsonRequest(
      `http://test/api/agents/${agentId}/criteria/${criterionId}`,
      "PATCH",
      body,
    ),
    { params: Promise.resolve({ id: agentId, criterionId }) },
  );
}

function evaluate(runId: string, body: unknown = {}) {
  return evaluateRoute.POST(
    jsonRequest(`http://test/api/runs/${runId}/evaluate`, "POST", body),
    withId(runId),
  );
}

function preview(runId: string, body: unknown) {
  return previewRoute.POST(
    jsonRequest(`http://test/api/runs/${runId}/evaluate/preview`, "POST", body),
    withId(runId),
  );
}

function review(runId: string, evaluationId: string, body: unknown) {
  return evaluationRoute.PATCH(
    jsonRequest(
      `http://test/api/runs/${runId}/evaluations/${evaluationId}`,
      "PATCH",
      body,
    ),
    { params: Promise.resolve({ id: runId, evaluationId }) },
  );
}

async function storedEvaluations(runId: string) {
  return dbModule.db
    .select()
    .from(dbModule.runEvaluations)
    .where(eq(dbModule.runEvaluations.runId, runId));
}

describe("evaluators: criteria, the judge client and manual evaluation (requires Docker)", () => {
  beforeAll(async () => {
    decisions = createServer((req, res) => {
      let body = "";
      req.on("data", (part) => {
        body += part;
      });
      req.on("end", () => {
        const request: DecisionRequest = {
          url: req.url ?? "",
          authorization: req.headers.authorization,
          body: JSON.parse(body),
        };
        requests.push(request);
        const { status, body: payload } = reply(request);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(
          typeof payload === "string" ? payload : JSON.stringify(payload),
        );
      });
    });
    await new Promise<void>((resolve) => decisions.listen(0, resolve));
    const port = (decisions.address() as AddressInfo).port;
    judgeOrigin = `http://127.0.0.1:${port}`;
    process.env.PROVIDER_BASE_URL = `${judgeOrigin}/api/v1`;
    process.env.PROVIDER_API_KEY = "test-key";

    container = await new PostgreSqlContainer("postgres:16").start();
    process.env.DATABASE_URL = container.getConnectionUri();

    dbModule = await import("@agentlathe/db");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(drizzle(dbModule.getPool()), { migrationsFolder });

    criteriaRoute = await import("../../app/api/agents/[id]/criteria/route");
    criterionRoute = await import(
      "../../app/api/agents/[id]/criteria/[criterionId]/route"
    );
    evaluateRoute = await import("../../app/api/runs/[id]/evaluate/route");
    previewRoute = await import(
      "../../app/api/runs/[id]/evaluate/preview/route"
    );
    evaluationRoute = await import(
      "../../app/api/runs/[id]/evaluations/[evaluationId]/route"
    );
    settingsRoute = await import("../../app/api/settings/route");
  }, 60000);

  afterAll(async () => {
    await dbModule.closePool();
    await container.stop();
    await new Promise<void>((resolve, reject) =>
      decisions.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(async () => {
    await dbModule.db.delete(dbModule.agents);
    requests = [];
    reply = answering({});
  });

  describe("criteria CRUD", () => {
    it("creates a criterion with the default thresholds, trimming text and nulling empty descriptions", async () => {
      const agent = await seedAgent("crud agent");

      const created = await criterion(agent.id, {
        question: "  Did the assistant avoid promising a refund?  ",
        passDescription: "No refund is promised.",
        failDescription: "",
      });

      expect(created).toMatchObject({
        agentId: agent.id,
        question: "Did the assistant avoid promising a refund?",
        passDescription: "No refund is promised.",
        failDescription: null,
        appliesWhen: null,
        failBelow: 0.2,
        passAbove: 0.8,
        isActive: true,
        sourceFixDraftId: null,
      });

      const list = await criteriaRoute.GET(
        jsonRequest(`http://test/api/agents/${agent.id}/criteria`, "GET"),
        withId(agent.id),
      );
      expect(list.status).toBe(200);
      expect((await list.json()).map((row: { id: string }) => row.id)).toEqual([
        created.id,
      ]);
    });

    it("rejects an empty question, out-of-range thresholds and failBelow above passAbove", async () => {
      const agent = await seedAgent("validation agent");

      for (const body of [
        { question: "   " },
        { question: "ok?", failBelow: -0.1 },
        { question: "ok?", passAbove: 1.5 },
        { question: "ok?", failBelow: 0.9, passAbove: 0.5 },
        { question: "ok?", passAbove: 0.1 },
        { question: "x".repeat(1001) },
        { question: "ok?", failBelow: 1e-50 },
      ]) {
        const res = await createCriterion(agent.id, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
    });

    it("answers 404 for an unknown agent and 400 for a malformed id", async () => {
      expect(
        (await createCriterion(NIL_UUID, { question: "ok?" })).status,
      ).toBe(404);
      expect((await createCriterion("nope", { question: "ok?" })).status).toBe(
        400,
      );
      const list = await criteriaRoute.GET(
        jsonRequest(`http://test/api/agents/${NIL_UUID}/criteria`, "GET"),
        withId(NIL_UUID),
      );
      expect(list.status).toBe(404);
    });

    it("PATCH deactivates, validates the merged thresholds and stays inside its agent", async () => {
      const agent = await seedAgent("patch agent");
      const other = await seedAgent("patch other agent");
      const created = await criterion(agent.id, { question: "ok?" });

      const deactivated = await patchCriterion(agent.id, created.id, {
        isActive: false,
      });
      expect(deactivated.status).toBe(200);
      expect(await deactivated.json()).toMatchObject({
        isActive: false,
        question: "ok?",
      });

      expect(
        (await patchCriterion(agent.id, created.id, { failBelow: 0.9 })).status,
      ).toBe(400);
      const tightened = await patchCriterion(agent.id, created.id, {
        failBelow: 0.9,
        passAbove: 0.95,
      });
      expect(tightened.status).toBe(200);
      expect(await tightened.json()).toMatchObject({
        failBelow: 0.9,
        passAbove: 0.95,
      });

      expect((await patchCriterion(agent.id, created.id, {})).status).toBe(400);
      expect(
        (await patchCriterion(other.id, created.id, { isActive: true })).status,
      ).toBe(404);
    });

    it("accepts a source fix draft from the same agent and rejects one from another agent", async () => {
      const agent = await seedAgent("draft agent");
      const other = await seedAgent("draft other agent");
      const ownDraft = await seedFixDraft((await seedRun(agent.id)).id);
      const foreignDraft = await seedFixDraft((await seedRun(other.id)).id);

      const created = await criterion(agent.id, {
        question: "Did it avoid promising a refund?",
        failDescription: ownDraft.rationale,
        sourceFixDraftId: ownDraft.id,
      });
      expect(created.sourceFixDraftId).toBe(ownDraft.id);

      const rejected = await createCriterion(agent.id, {
        question: "Did it avoid promising a refund?",
        sourceFixDraftId: foreignDraft.id,
      });
      expect(rejected.status).toBe(400);
    });

    it("DELETE removes the criterion and cascades its evaluations", async () => {
      const agent = await seedAgent("delete agent");
      const run = await seedRun(agent.id);
      const created = await criterion(agent.id, { question: "ok?" });
      await evaluate(run.id);
      expect(await storedEvaluations(run.id)).toHaveLength(1);

      const params = {
        params: Promise.resolve({ id: agent.id, criterionId: created.id }),
      };
      const deleted = await criterionRoute.DELETE(
        jsonRequest("http://test", "DELETE"),
        params,
      );
      expect(deleted.status).toBe(204);
      expect(await storedEvaluations(run.id)).toHaveLength(0);

      const again = await criterionRoute.DELETE(
        jsonRequest("http://test", "DELETE"),
        { params: Promise.resolve({ id: agent.id, criterionId: created.id }) },
      );
      expect(again.status).toBe(404);
    });
  });

  describe("POST /api/runs/[id]/evaluate", () => {
    it("asks the judge once with every active criterion plus its applicability question, and stores the verdicts", async () => {
      const agent = await seedAgent("happy agent");
      const run = await seedRun(agent.id);
      const refund = await criterion(agent.id, {
        question: "Did the assistant avoid promising a refund?",
        passDescription: "No refund is promised.",
        failDescription: "A refund is promised without confirmation.",
      });
      const honest = await criterion(agent.id, {
        question: "Did the assistant tell the user about the failed tool?",
        appliesWhen: "Did any tool fail?",
      });
      await criterion(agent.id, { question: "Inactive?", isActive: false });
      reply = answering({
        "Did the assistant avoid promising a refund?": 0.03,
        "Did the assistant tell the user about the failed tool?": 0.95,
        "Did any tool fail?": 0.99,
      });

      const res = await evaluate(run.id);

      expect(res.status).toBe(200);
      expect(requests).toHaveLength(1);
      const [sent] = requests;
      expect(sent.url).toBe("/api/alpha/decisions");
      expect(sent.authorization).toBe("Bearer test-key");
      expect(sent.body.model).toBe("typesafe/jev-1.13");
      const questions = Object.values(sent.body.questions);
      expect(questions).toHaveLength(3);
      expect(questions.every((question) => question.type === "noul")).toBe(
        true,
      );
      expect(questions).toContainEqual({
        type: "noul",
        instructions: "Did the assistant avoid promising a refund?",
        criteria: {
          true: "No refund is promised.",
          false: "A refund is promised without confirmation.",
        },
      });
      expect(questions).toContainEqual({
        type: "noul",
        instructions: "Did any tool fail?",
      });
      expect(questions.map((question) => question.instructions)).not.toContain(
        "Inactive?",
      );
      expect(typeof sent.body.state).toBe("string");
      expect(sent.body.state).toContain(
        "USER: I was charged twice for order 4417",
      );
      expect(sent.body.state).toContain(
        'TOOL CALL search_orders({"orderId":"4417"}) -> {"charges":[49.9,49.9]}',
      );
      expect(sent.body.state).toContain(
        "TOOL CALL notify({}) -> ERROR: HTTP 500: down",
      );
      expect(sent.body.state).toContain("ASSISTANT: I refunded both charges.");

      const body = await res.json();
      expect(body.evaluations).toHaveLength(2);
      const rows = await storedEvaluations(run.id);
      const byCriterion = Object.fromEntries(
        rows.map((row) => [row.criterionId, row]),
      );
      expect(byCriterion[refund.id]).toMatchObject({
        status: "fail",
        questionSnapshot: "Did the assistant avoid promising a refund?",
        pApplies: null,
        skipReason: null,
        error: null,
        judgeModel: DATED_MODEL,
        reviewedVerdict: null,
      });
      expect(byCriterion[refund.id].pPass).toBeCloseTo(0.03);
      expect(byCriterion[honest.id]).toMatchObject({
        status: "pass",
        judgeModel: DATED_MODEL,
      });
      expect(byCriterion[honest.id].pApplies).toBeCloseTo(0.99);
    });

    it("an applicability below failBelow yields not_applicable", async () => {
      const agent = await seedAgent("na agent");
      const run = await seedRun(agent.id);
      await criterion(agent.id, {
        question: "Did it explain the refund policy?",
        appliesWhen: "Did the user ask about refunds?",
      });
      reply = answering({
        "Did it explain the refund policy?": 0.02,
        "Did the user ask about refunds?": 0.05,
      });

      await evaluate(run.id);

      const [row] = await storedEvaluations(run.id);
      expect(row.status).toBe("not_applicable");
    });

    it("the band between the thresholds yields needs_review, for the verdict and for applicability", async () => {
      const agent = await seedAgent("review agent");
      const run = await seedRun(agent.id);
      const unsure = await criterion(agent.id, { question: "Unsure?" });
      const unsureScope = await criterion(agent.id, {
        question: "Clear?",
        appliesWhen: "Maybe applies?",
      });
      reply = answering({
        "Unsure?": 0.5,
        "Clear?": 0.99,
        "Maybe applies?": 0.5,
      });

      await evaluate(run.id);

      const rows = await storedEvaluations(run.id);
      expect(rows.find((row) => row.criterionId === unsure.id)?.status).toBe(
        "needs_review",
      );
      expect(
        rows.find((row) => row.criterionId === unsureScope.id)?.status,
      ).toBe("needs_review");
    });

    it("max_tokens_exceeded stores skipped/too_long rows", async () => {
      const agent = await seedAgent("long agent");
      const run = await seedRun(agent.id);
      await criterion(agent.id, { question: "ok?" });
      reply = () => ({
        status: 400,
        body: {
          error: {
            message:
              'HTTP 400: {"detail":{"error_type":"max_tokens_exceeded"}}',
            code: 400,
          },
        },
      });

      await evaluate(run.id);

      const [row] = await storedEvaluations(run.id);
      expect(row).toMatchObject({
        status: "skipped",
        skipReason: "too_long",
        pPass: null,
        error: null,
      });
    });

    it("a repeated too_long keeps the human review, the only verdict such a run can have", async () => {
      const agent = await seedAgent("long review agent");
      const run = await seedRun(agent.id);
      await criterion(agent.id, { question: "ok?" });
      reply = () => ({
        status: 400,
        body: {
          error: {
            message:
              'HTTP 400: {"detail":{"error_type":"max_tokens_exceeded"}}',
            code: 400,
          },
        },
      });
      await evaluate(run.id);
      const [first] = await storedEvaluations(run.id);
      await review(run.id, first.id, { reviewedVerdict: "fail" });

      const res = await evaluate(run.id);

      expect((await res.json()).notJudged).toMatchObject({
        status: "skipped",
        skipReason: "too_long",
      });
      const [row] = await storedEvaluations(run.id);
      expect(row).toMatchObject({
        status: "skipped",
        skipReason: "too_long",
        reviewedVerdict: "fail",
      });
    });

    it("a provider without the Decisions API stores error rows that say so", async () => {
      const agent = await seedAgent("404 agent");
      const run = await seedRun(agent.id);
      await criterion(agent.id, { question: "ok?" });
      await criterion(agent.id, { question: "also ok?" });
      reply = () => ({ status: 404, body: "Not Found" });

      const res = await evaluate(run.id);

      expect(res.status).toBe(200);
      const rows = await storedEvaluations(run.id);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.status).toBe("error");
        expect(row.error).toBe(
          "the configured provider does not serve the Decisions API; set JUDGE_URL and JUDGE_API_KEY to a Jev endpoint",
        );
      }
    });

    it("JUDGE_URL and JUDGE_API_KEY send the judge call to another endpoint with its own key", async () => {
      const agent = await seedAgent("own judge agent");
      const run = await seedRun(agent.id);
      await criterion(agent.id, { question: "ok?" });
      reply = answering({ "ok?": 0.95 });
      process.env.JUDGE_URL = `${judgeOrigin}/v1/systemone`;
      process.env.JUDGE_API_KEY = "judge-key";
      try {
        await evaluate(run.id);
      } finally {
        delete process.env.JUDGE_URL;
        delete process.env.JUDGE_API_KEY;
      }

      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe("/v1/systemone");
      expect(requests[0].authorization).toBe("Bearer judge-key");
      const [row] = await storedEvaluations(run.id);
      expect(row.status).toBe("pass");
    });

    it("a rejected key and an unknown judge model are errors with an actionable message", async () => {
      const agent = await seedAgent("401 agent");
      const run = await seedRun(agent.id);
      await criterion(agent.id, { question: "ok?" });

      reply = () => ({
        status: 401,
        body: {
          error: { message: "Missing Authentication header", code: 401 },
        },
      });
      await evaluate(run.id);
      let [row] = await storedEvaluations(run.id);
      expect(row.status).toBe("error");
      expect(row.error).toContain("Missing Authentication header");
      expect(row.error).toContain("PROVIDER_API_KEY");

      reply = () => ({
        status: 400,
        body: {
          error: {
            message: "Model typesafe/jev-9.99 does not exist",
            code: 400,
          },
        },
      });
      await evaluate(run.id);
      [row] = await storedEvaluations(run.id);
      expect(row.status).toBe("error");
      expect(row.error).toContain("Model typesafe/jev-9.99 does not exist");
    });

    it("a run paused on a pending approval is skipped without calling the judge", async () => {
      const agent = await seedAgent("paused agent");
      const run = await seedRun(agent.id, pausedTranscript);
      await criterion(agent.id, { question: "ok?" });

      await evaluate(run.id);

      expect(requests).toHaveLength(0);
      const [row] = await storedEvaluations(run.id);
      expect(row).toMatchObject({
        status: "skipped",
        skipReason: "awaiting_approval",
        judgeModel: null,
      });
    });

    it("a run without a transcript writes nothing and says why", async () => {
      const agent = await seedAgent("bare agent");
      const run = await seedRun(agent.id, null);
      await criterion(agent.id, { question: "ok?" });

      const res = await evaluate(run.id);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ skipped: "no_transcript" });
      expect(requests).toHaveLength(0);
      expect(await storedEvaluations(run.id)).toHaveLength(0);
    });

    it("a judge failure leaves a judged, reviewed verdict untouched and still reports the failure", async () => {
      const agent = await seedAgent("keep agent");
      const run = await seedRun(agent.id);
      await criterion(agent.id, { question: "ok?" });
      reply = answering({ "ok?": 0.5 });
      await evaluate(run.id);
      const [judged] = await storedEvaluations(run.id);
      await review(run.id, judged.id, { reviewedVerdict: "pass" });
      const [reviewed] = await storedEvaluations(run.id);

      reply = () => ({
        status: 429,
        body: { error: { message: "Rate limit exceeded", code: 429 } },
      });
      const res = await evaluate(run.id);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.notJudged).toMatchObject({ status: "error" });
      expect(body.notJudged.error).toContain("HTTP 429: Rate limit exceeded");
      expect(body.evaluations).toHaveLength(1);
      expect(body.evaluations[0]).toMatchObject({
        status: "needs_review",
        reviewedVerdict: "pass",
      });
      expect(await storedEvaluations(run.id)).toEqual([reviewed]);
    });

    it("re-judging the same question replaces the verdict and keeps the human review", async () => {
      const agent = await seedAgent("again agent");
      const run = await seedRun(agent.id);
      await criterion(agent.id, { question: "ok?" });
      reply = answering({ "ok?": 0.5 });
      await evaluate(run.id);
      const [first] = await storedEvaluations(run.id);
      expect(first.status).toBe("needs_review");

      const reviewed = await review(run.id, first.id, {
        reviewedVerdict: "fail",
      });
      expect(reviewed.status).toBe(200);
      expect((await reviewed.json()).reviewedVerdict).toBe("fail");

      reply = answering({ "ok?": 0.97 });
      await evaluate(run.id);

      const rows = await storedEvaluations(run.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: first.id,
        status: "pass",
        reviewedVerdict: "fail",
      });
    });

    it("a judgement under an edited question clears the human review", async () => {
      const agent = await seedAgent("edited agent");
      const run = await seedRun(agent.id);
      const created = await criterion(agent.id, { question: "ok?" });
      reply = answering({ "ok?": 0.5 });
      await evaluate(run.id);
      const [first] = await storedEvaluations(run.id);
      await review(run.id, first.id, { reviewedVerdict: "fail" });

      expect(
        (await patchCriterion(agent.id, created.id, { question: "better?" }))
          .status,
      ).toBe(200);
      reply = answering({ "better?": 0.97 });
      await evaluate(run.id);

      const rows = await storedEvaluations(run.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: first.id,
        questionSnapshot: "better?",
        status: "pass",
        reviewedVerdict: null,
      });
    });

    it("a failed call under an edited question keeps the judged row and its review", async () => {
      const agent = await seedAgent("edited failing agent");
      const run = await seedRun(agent.id);
      const created = await criterion(agent.id, { question: "ok?" });
      reply = answering({ "ok?": 0.5 });
      await evaluate(run.id);
      const [first] = await storedEvaluations(run.id);
      await review(run.id, first.id, { reviewedVerdict: "pass" });
      const [reviewed] = await storedEvaluations(run.id);

      await patchCriterion(agent.id, created.id, { question: "better?" });
      reply = () => ({
        status: 429,
        body: { error: { message: "Rate limit exceeded", code: 429 } },
      });
      await evaluate(run.id);

      expect(await storedEvaluations(run.id)).toEqual([reviewed]);
    });

    it("evaluates only the given criteria, and refuses criteria of another agent", async () => {
      const agent = await seedAgent("subset agent");
      const other = await seedAgent("subset other agent");
      const run = await seedRun(agent.id);
      const picked = await criterion(agent.id, { question: "picked?" });
      await criterion(agent.id, { question: "left out?" });
      const foreign = await criterion(other.id, { question: "foreign?" });

      const res = await evaluate(run.id, { criterionIds: [picked.id] });
      expect(res.status).toBe(200);
      expect(Object.keys(requests[0].body.questions)).toHaveLength(1);
      const rows = await storedEvaluations(run.id);
      expect(rows.map((row) => row.criterionId)).toEqual([picked.id]);

      const refused = await evaluate(run.id, {
        criterionIds: [picked.id, foreign.id],
      });
      expect(refused.status).toBe(400);
    });

    it("refuses foreign criteria before looking at the transcript, and accepts an empty body", async () => {
      const agent = await seedAgent("order agent");
      const other = await seedAgent("order other agent");
      const bare = await seedRun(agent.id, null);
      const foreign = await criterion(other.id, { question: "foreign?" });

      expect(
        (await evaluate(bare.id, { criterionIds: [foreign.id] })).status,
      ).toBe(400);

      const run = await seedRun(agent.id);
      await criterion(agent.id, { question: "ok?" });
      const res = await evaluateRoute.POST(
        new Request(`http://test/api/runs/${run.id}/evaluate`, {
          method: "POST",
        }),
        withId(run.id),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).evaluations).toHaveLength(1);
    });

    it("answers 404 for an unknown run and 400 for a malformed id", async () => {
      expect((await evaluate(NIL_UUID)).status).toBe(404);
      expect((await evaluate("nope")).status).toBe(400);
    });
  });

  describe("POST /api/runs/[id]/evaluate/preview", () => {
    it("judges an unsaved criterion against the run and writes nothing", async () => {
      const agent = await seedAgent("preview agent");
      const run = await seedRun(agent.id);
      reply = answering({
        "Did it avoid promising a refund?\nA no means: A refund is promised.": 0.04,
        "Did a refund come up?": 0.97,
      });

      const res = await preview(run.id, {
        question: "Did it avoid promising a refund?",
        failDescription: "A refund is promised.",
        appliesWhen: "Did a refund come up?",
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        status: "fail",
        skipReason: null,
        error: null,
        judgeModel: DATED_MODEL,
      });
      expect(body.pPass).toBeCloseTo(0.04);
      expect(body.pApplies).toBeCloseTo(0.97);
      expect(Object.values(requests[0].body.questions)).toContainEqual({
        type: "noul",
        instructions:
          "Did it avoid promising a refund?\nA no means: A refund is promised.",
      });
      expect(await storedEvaluations(run.id)).toHaveLength(0);
    });

    it("validates the draft and the run", async () => {
      const agent = await seedAgent("preview validation agent");
      const run = await seedRun(agent.id);
      expect((await preview(run.id, { question: "" })).status).toBe(400);
      expect((await preview(NIL_UUID, { question: "ok?" })).status).toBe(404);
    });
  });

  describe("PATCH /api/runs/[id]/evaluations/[evaluationId]", () => {
    it("sets and clears the reviewed verdict, scoped to its run", async () => {
      const agent = await seedAgent("review patch agent");
      const run = await seedRun(agent.id);
      const otherRun = await seedRun(agent.id);
      await criterion(agent.id, { question: "ok?" });
      await evaluate(run.id);
      const [row] = await storedEvaluations(run.id);

      const passed = await review(run.id, row.id, { reviewedVerdict: "pass" });
      expect((await passed.json()).reviewedVerdict).toBe("pass");
      const cleared = await review(run.id, row.id, { reviewedVerdict: null });
      expect((await cleared.json()).reviewedVerdict).toBeNull();

      expect(
        (await review(run.id, row.id, { reviewedVerdict: "maybe" })).status,
      ).toBe(400);
      expect(
        (await review(otherRun.id, row.id, { reviewedVerdict: "pass" })).status,
      ).toBe(404);
    });
  });

  describe("settings.judgeModel", () => {
    it("round-trips through /api/settings and is the model the judge is asked for", async () => {
      const initial = await (await settingsRoute.GET()).json();
      expect(initial.judgeModel).toBe("typesafe/jev-1.13");

      const patched = await settingsRoute.PATCH(
        jsonRequest("http://test/api/settings", "PATCH", {
          judgeModel: "typesafe/jev-2.0",
        }),
      );
      expect(patched.status).toBe(200);
      expect((await patched.json()).judgeModel).toBe("typesafe/jev-2.0");
      expect((await (await settingsRoute.GET()).json()).judgeModel).toBe(
        "typesafe/jev-2.0",
      );

      const agent = await seedAgent("settings agent");
      const run = await seedRun(agent.id);
      await criterion(agent.id, { question: "ok?" });
      await evaluate(run.id);
      expect(requests[0].body.model).toBe("typesafe/jev-2.0");

      expect(
        (
          await settingsRoute.PATCH(
            jsonRequest("http://test/api/settings", "PATCH", {
              judgeModel: "  ",
            }),
          )
        ).status,
      ).toBe(400);
      await settingsRoute.PATCH(
        jsonRequest("http://test/api/settings", "PATCH", {
          judgeModel: "typesafe/jev-1.13",
        }),
      );
    });
  });
});
