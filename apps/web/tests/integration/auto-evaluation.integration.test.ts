import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
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

const evaluationsSpy = vi.hoisted(() => ({
  evaluateRun: vi.fn(),
  hasActiveCriteria: vi.fn(),
}));

vi.mock("../../lib/evaluations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/evaluations")>();
  evaluationsSpy.evaluateRun.mockImplementation(actual.evaluateRun);
  evaluationsSpy.hasActiveCriteria.mockImplementation(actual.hasActiveCriteria);
  return { ...actual, ...evaluationsSpy };
});

const migrationsFolder = fileURLToPath(
  new URL("../../../../packages/db/drizzle", import.meta.url),
);

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const PASSING = "Did the assistant answer politely?";
const FAILING = "Did the assistant cite a source?";

type DecisionsRequest = {
  questions: Record<string, { instructions: string }>;
};
type DecisionsHandler = (
  request: DecisionsRequest,
  res: ServerResponse,
) => void;

let container: StartedPostgreSqlContainer;
let server: Server;
let dbModule: typeof import("@agentlathe/db");
let chatRoute: typeof import("../../app/api/agents/[id]/chat/route");
let v1Route: typeof import("../../app/v1/chat/completions/route");
let mcpRoute: typeof import("../../app/mcp/agents/[id]/route");
let recentRoute: typeof import("../../app/api/agents/[id]/criteria/evaluate-recent/route");
let decisionsRequests: DecisionsRequest[] = [];
let handleDecisions: DecisionsHandler;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function answering(res: ServerResponse, request: DecisionsRequest) {
  json(res, 200, {
    model: "typesafe/jev-1.13-20260917",
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [
        id,
        { type: "noul", noul: question.instructions === FAILING ? 0.02 : 0.98 },
      ]),
    ),
  });
}

const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const completionBase = { id: "gen-test", created: 1, model: "test/model" };

function answerCompletion(body: { stream?: boolean }, res: ServerResponse) {
  if (!body.stream) {
    json(res, 200, {
      ...completionBase,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "resolved" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    return;
  }
  const chunk = { ...completionBase, object: "chat.completion.chunk" };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    sse({
      ...chunk,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "resolved" },
          finish_reason: null,
        },
      ],
    }),
  );
  res.write(
    sse({
      ...chunk,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
  res.end("data: [DONE]\n\n");
}

function route(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "GET" && req.url?.endsWith("/models")) {
    json(res, 200, { data: [] });
    return;
  }
  let raw = "";
  req.on("data", (part) => {
    raw += part;
  });
  req.on("end", () => {
    const body = JSON.parse(raw);
    if (req.url?.endsWith("/alpha/decisions")) {
      decisionsRequests.push(body);
      handleDecisions(body, res);
      return;
    }
    answerCompletion(body, res);
  });
}

function postJson(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const withId = (id: string) => ({ params: Promise.resolve({ id }) });

async function seedAgent(
  name: string,
  overrides: { autoEvaluate?: boolean; recordTraffic?: boolean } = {},
) {
  const [agent] = await dbModule.db
    .insert(dbModule.agents)
    .values({
      name,
      slug: dbModule.agentSlug(name),
      model: "test/model",
      recordTraffic: true,
      ...overrides,
    })
    .returning();
  return agent;
}

async function seedCriteria(agentId: string, { active = true } = {}) {
  await dbModule.db.insert(dbModule.agentCriteria).values([
    { agentId, question: PASSING, isActive: active },
    { agentId, question: FAILING, isActive: active },
  ]);
}

async function runsOf(agentId: string) {
  return dbModule.db
    .select()
    .from(dbModule.agentRuns)
    .where(eq(dbModule.agentRuns.agentId, agentId));
}

async function transcriptsOf(agentId: string) {
  return dbModule.db
    .select({ runId: dbModule.runTranscripts.runId })
    .from(dbModule.runTranscripts)
    .innerJoin(
      dbModule.agentRuns,
      eq(dbModule.agentRuns.id, dbModule.runTranscripts.runId),
    )
    .where(eq(dbModule.agentRuns.agentId, agentId));
}

async function evaluationsOf(agentId: string) {
  return dbModule.db
    .select({ evaluation: dbModule.runEvaluations })
    .from(dbModule.runEvaluations)
    .innerJoin(
      dbModule.agentRuns,
      eq(dbModule.agentRuns.id, dbModule.runEvaluations.runId),
    )
    .where(eq(dbModule.agentRuns.agentId, agentId))
    .then((rows) => rows.map((row) => row.evaluation));
}

async function expectEvaluated(agentId: string) {
  await vi.waitFor(
    async () => {
      const [run] = await runsOf(agentId);
      expect(run).toBeDefined();
      const evaluations = await evaluationsOf(agentId);
      expect(evaluations.map((e) => e.status).sort()).toEqual(["fail", "pass"]);
      expect(evaluations.every((e) => e.runId === run.id)).toBe(true);
    },
    { timeout: 5000, interval: 50 },
  );
}

function callChat(agentId: string) {
  return chatRoute.POST(
    postJson(`http://localhost/api/agents/${agentId}/chat`, {
      messages: [
        { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ],
    }),
    withId(agentId),
  );
}

function callV1(slug: string, stream = false) {
  return v1Route.POST(
    postJson("http://localhost/v1/chat/completions", {
      model: slug,
      messages: [{ role: "user", content: "hi" }],
      stream,
    }),
  );
}

function callMcp(agent: { id: string; slug: string }) {
  return mcpRoute.POST(
    postJson(`http://localhost/mcp/agents/${agent.id}`, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: dbModule.agentAskToolName(agent.slug),
        arguments: { message: "hi" },
      },
    }),
    withId(agent.id),
  );
}

function evaluateRecent(agentId: string, body?: unknown, signal?: AbortSignal) {
  return recentRoute.POST(
    new Request(
      `http://localhost/api/agents/${agentId}/criteria/evaluate-recent`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      },
    ),
    withId(agentId),
  );
}

describe("automatic evaluation of recorded runs (requires Docker)", () => {
  beforeAll(async () => {
    server = createServer(route);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    process.env.PROVIDER_BASE_URL = `http://127.0.0.1:${port}/api/v1`;
    process.env.PROVIDER_API_KEY = "test-key";

    container = await new PostgreSqlContainer("postgres:16").start();
    process.env.DATABASE_URL = container.getConnectionUri();

    dbModule = await import("@agentlathe/db");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(drizzle(dbModule.getPool()), { migrationsFolder });

    chatRoute = await import("../../app/api/agents/[id]/chat/route");
    v1Route = await import("../../app/v1/chat/completions/route");
    mcpRoute = await import("../../app/mcp/agents/[id]/route");
    recentRoute = await import(
      "../../app/api/agents/[id]/criteria/evaluate-recent/route"
    );

    await dbModule.setSettings({
      trackDashboardRuns: true,
      trackV1Runs: true,
      trackMcpRuns: true,
    });
  }, 60000);

  afterAll(async () => {
    await dbModule.closePool();
    await container.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(async () => {
    await dbModule.db.delete(dbModule.agents);
    decisionsRequests = [];
    evaluationsSpy.evaluateRun.mockClear();
    evaluationsSpy.hasActiveCriteria.mockClear();
    handleDecisions = (request, res) => answering(res, request);
  });

  describe("each transport evaluates its run once the transcript is stored", () => {
    it("the Playground chat", async () => {
      const agent = await seedAgent("auto dashboard", { recordTraffic: false });
      await seedCriteria(agent.id);

      const res = await callChat(agent.id);
      expect(res.status).toBe(200);
      await res.text();

      await expectEvaluated(agent.id);
    });

    it("/v1 without streaming", async () => {
      const agent = await seedAgent("auto v1");
      await seedCriteria(agent.id);

      const res = await callV1(agent.slug);
      expect(res.status).toBe(200);

      await expectEvaluated(agent.id);
    });

    it("/v1 streaming", async () => {
      const agent = await seedAgent("auto v1 stream");
      await seedCriteria(agent.id);

      const res = await callV1(agent.slug, true);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("[DONE]");

      await expectEvaluated(agent.id);
    });

    it("MCP", async () => {
      const agent = await seedAgent("auto mcp");
      await seedCriteria(agent.id);

      const res = await callMcp(agent);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("resolved");

      await expectEvaluated(agent.id);
    });
  });

  describe("gates", () => {
    it("auto_evaluate off: the run is recorded, never judged", async () => {
      const agent = await seedAgent("auto off", { autoEvaluate: false });
      await seedCriteria(agent.id);

      expect((await callV1(agent.slug)).status).toBe(200);

      expect(await runsOf(agent.id)).toHaveLength(1);
      expect(await transcriptsOf(agent.id)).toHaveLength(1);
      expect(evaluationsSpy.hasActiveCriteria).not.toHaveBeenCalled();
      expect(evaluationsSpy.evaluateRun).not.toHaveBeenCalled();
    });

    it("no active criteria: one criteria query, the run and its transcript are never loaded", async () => {
      const agent = await seedAgent("auto inactive criteria");
      await seedCriteria(agent.id, { active: false });

      expect((await callV1(agent.slug)).status).toBe(200);

      await vi.waitFor(() =>
        expect(evaluationsSpy.hasActiveCriteria).toHaveBeenCalledWith(agent.id),
      );
      const [checked] = evaluationsSpy.hasActiveCriteria.mock.results;
      expect(await checked.value).toBe(false);
      await new Promise((resolve) => setImmediate(resolve));
      expect(evaluationsSpy.evaluateRun).not.toHaveBeenCalled();
      expect(decisionsRequests).toEqual([]);
    });

    it("/v1 with record_traffic off stores no transcript and evaluates nothing", async () => {
      const agent = await seedAgent("auto no traffic", {
        recordTraffic: false,
      });
      await seedCriteria(agent.id);

      expect((await callV1(agent.slug)).status).toBe(200);

      expect(await runsOf(agent.id)).toHaveLength(1);
      expect(await transcriptsOf(agent.id)).toEqual([]);
      expect(evaluationsSpy.hasActiveCriteria).not.toHaveBeenCalled();
      expect(evaluationsSpy.evaluateRun).not.toHaveBeenCalled();
    });
  });

  describe("a failing judge never touches the transport", () => {
    it("a 500 from the Decisions API leaves the response and the run as they were", async () => {
      handleDecisions = (_request, res) =>
        json(res, 500, { error: { message: "judge exploded" } });
      const agent = await seedAgent("judge 500");
      await seedCriteria(agent.id);

      const res = await callV1(agent.slug);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.choices[0].message.content).toBe("resolved");
      const [run] = await runsOf(agent.id);
      expect(run).toMatchObject({ status: "ok", error: null });
      await vi.waitFor(
        async () => {
          const evaluations = await evaluationsOf(agent.id);
          expect(evaluations).toHaveLength(2);
          expect(evaluations.every((e) => e.status === "error")).toBe(true);
        },
        { timeout: 5000, interval: 50 },
      );
    });

    it("a judge that never answers does not hold the response", async () => {
      const held: ServerResponse[] = [];
      handleDecisions = (_request, res) => {
        held.push(res);
      };
      const agent = await seedAgent("judge hangs");
      await seedCriteria(agent.id);

      const res = await callMcp(agent);

      expect(res.status).toBe(200);
      expect(await res.text()).toContain("resolved");
      const [run] = await runsOf(agent.id);
      expect(run).toMatchObject({ status: "ok", error: null });
      await vi.waitFor(() => expect(held).toHaveLength(1));
      expect(await evaluationsOf(agent.id)).toEqual([]);

      json(held[0], 500, { error: { message: "too late" } });
      await vi.waitFor(
        async () => expect(await evaluationsOf(agent.id)).toHaveLength(2),
        { timeout: 5000, interval: 50 },
      );
    });
  });

  describe("POST /api/agents/[id]/criteria/evaluate-recent", () => {
    async function seedRuns(agentId: string) {
      const minute = 60_000;
      const now = Date.now();
      const runs = await dbModule.db
        .insert(dbModule.agentRuns)
        .values(
          [0, 1, 2, 3].map((age) => ({
            agentId,
            source: "dashboard" as const,
            durationMs: 10,
            createdAt: new Date(now - age * minute),
          })),
        )
        .returning();
      const byAge = [...runs].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      );
      const [newest, second, untranscribed, oldest] = byAge;
      await dbModule.db.insert(dbModule.runTranscripts).values(
        [newest, second, oldest].map((run) => ({
          runId: run.id,
          input: [{ role: "user", content: "hi" }],
          output: [{ role: "assistant", content: "hello" }],
        })),
      );
      return { newest, second, untranscribed, oldest };
    }

    async function seedTranscribedRuns(agentId: string, count: number) {
      const runs = await dbModule.db
        .insert(dbModule.agentRuns)
        .values(
          Array.from({ length: count }, () => ({
            agentId,
            source: "dashboard" as const,
            durationMs: 10,
          })),
        )
        .returning();
      await dbModule.db.insert(dbModule.runTranscripts).values(
        runs.map((run) => ({
          runId: run.id,
          input: [{ role: "user", content: "hi" }],
          output: [{ role: "assistant", content: "hello" }],
        })),
      );
      return runs;
    }

    async function evaluatedRunIds(agentId: string) {
      return new Set((await evaluationsOf(agentId)).map((e) => e.runId));
    }

    it("judges the most recent runs with a transcript and summarizes, regardless of auto_evaluate", async () => {
      const agent = await seedAgent("recent", { autoEvaluate: false });
      await seedCriteria(agent.id);
      const runs = await seedRuns(agent.id);

      const res = await evaluateRecent(agent.id);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        runs: 3,
        pass: 3,
        fail: 3,
        needsReview: 0,
        notApplicable: 0,
        skipped: 0,
        error: 0,
        notJudged: 0,
        stoppedEarly: null,
      });
      expect(await evaluatedRunIds(agent.id)).toEqual(
        new Set([runs.newest.id, runs.second.id, runs.oldest.id]),
      );
    });

    it("respects the limit, newest first", async () => {
      const agent = await seedAgent("recent limit");
      await seedCriteria(agent.id);
      const runs = await seedRuns(agent.id);

      const res = await evaluateRecent(agent.id, { limit: 2 });

      expect(await res.json()).toMatchObject({ runs: 2, pass: 2, fail: 2 });
      expect(await evaluatedRunIds(agent.id)).toEqual(
        new Set([runs.newest.id, runs.second.id]),
      );
    });

    it("counts a failing judge as errors and runs not judged", async () => {
      handleDecisions = (_request, res) =>
        json(res, 500, { error: { message: "judge exploded" } });
      const agent = await seedAgent("recent judge down");
      await seedCriteria(agent.id);
      await seedRuns(agent.id);

      const res = await evaluateRecent(agent.id);

      expect(await res.json()).toMatchObject({
        runs: 3,
        pass: 0,
        fail: 0,
        error: 6,
        notJudged: 3,
        stoppedEarly: null,
      });
    });

    it("returns zeros without calling the judge when no criterion is active", async () => {
      const agent = await seedAgent("recent no criteria");
      await seedCriteria(agent.id, { active: false });
      await seedRuns(agent.id);

      const res = await evaluateRecent(agent.id);

      expect(await res.json()).toEqual({
        runs: 0,
        pass: 0,
        fail: 0,
        needsReview: 0,
        notApplicable: 0,
        skipped: 0,
        error: 0,
        notJudged: 0,
        stoppedEarly: null,
      });
      expect(decisionsRequests).toEqual([]);
    });

    it("a failed judge call counts as errors even where an earlier verdict survives", async () => {
      const agent = await seedAgent("recent stale verdicts");
      await seedCriteria(agent.id);
      const [run] = await seedTranscribedRuns(agent.id, 1);
      expect(await (await evaluateRecent(agent.id)).json()).toMatchObject({
        pass: 1,
        fail: 1,
      });
      handleDecisions = (_request, res) =>
        json(res, 500, { error: { message: "judge exploded" } });

      const res = await evaluateRecent(agent.id);

      expect(await res.json()).toEqual({
        runs: 1,
        pass: 0,
        fail: 0,
        needsReview: 0,
        notApplicable: 0,
        skipped: 0,
        error: 2,
        notJudged: 1,
        stoppedEarly: null,
      });
      const stored = await evaluationsOf(agent.id);
      expect(stored.map((e) => e.status).sort()).toEqual(["fail", "pass"]);
      expect(stored.every((e) => e.runId === run.id)).toBe(true);
    });

    it("stops calling a judge that failed three times in a row", async () => {
      handleDecisions = (_request, res) =>
        json(res, 500, { error: { message: "judge exploded" } });
      const agent = await seedAgent("recent judge failing");
      await seedCriteria(agent.id);
      await seedTranscribedRuns(agent.id, 8);

      const res = await evaluateRecent(agent.id);

      expect(await res.json()).toMatchObject({
        runs: 8,
        error: 12,
        notJudged: 8,
        stoppedEarly: "judge_failing",
      });
      expect(decisionsRequests).toHaveLength(6);
    });

    it("stops starting runs once the client disconnects", async () => {
      const abort = new AbortController();
      handleDecisions = (request, res) => {
        abort.abort();
        answering(res, request);
      };
      const agent = await seedAgent("recent aborted");
      await seedCriteria(agent.id);
      await seedTranscribedRuns(agent.id, 8);

      const res = await evaluateRecent(agent.id, {}, abort.signal);

      expect(await res.json()).toMatchObject({
        runs: 8,
        pass: 4,
        fail: 4,
        notJudged: 4,
        stoppedEarly: "aborted",
      });
      expect(decisionsRequests).toHaveLength(4);
    });

    it("rejects an unknown agent, a bad id and an out-of-range limit", async () => {
      expect((await evaluateRecent(NIL_UUID)).status).toBe(404);
      expect((await evaluateRecent("not-a-uuid")).status).toBe(400);
      const agent = await seedAgent("recent bad limit");
      expect((await evaluateRecent(agent.id, { limit: 201 })).status).toBe(400);
      expect((await evaluateRecent(agent.id, { limit: 0 })).status).toBe(400);
    });
  });
});
