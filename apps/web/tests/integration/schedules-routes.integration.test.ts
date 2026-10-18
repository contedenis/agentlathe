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

let container: StartedPostgreSqlContainer;
let provider: Server;
let dbModule: typeof import("@agentlathe/db");
let drizzleOrm: typeof import("drizzle-orm");
let collection: typeof import("../../app/api/schedules/route");
let item: typeof import("../../app/api/schedules/[id]/route");
let run: typeof import("../../app/api/schedules/[id]/run/route");
let occurrences: typeof import("../../app/api/schedules/[id]/occurrences/route");
let after: typeof import("next/server").after;
let agentId: string;

const jsonRequest = (method: string, body?: unknown) =>
  new Request("http://localhost/api/schedules", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const daily = () => ({
  agentId,
  name: "Morning digest",
  frequency: "daily",
  timeOfDay: "09:00",
  timezone: "Europe/Madrid",
  input: "Summarize {{date}}.",
});

async function create(body: Record<string, unknown> = daily()) {
  const res = await collection.POST(jsonRequest("POST", body));
  return { res, body: await res.json() };
}

describe("schedule routes (requires Docker)", () => {
  beforeAll(async () => {
    provider = createServer((req, res) => {
      if (req.method === "GET" && req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "gen",
            object: "chat.completion",
            created: 1,
            model: "test/model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Done." },
                finish_reason: "stop",
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, resolve));
    process.env.PROVIDER_BASE_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    process.env.PROVIDER_API_KEY = "test-key";

    container = await new PostgreSqlContainer("postgres:16").start();
    process.env.DATABASE_URL = container.getConnectionUri();

    dbModule = await import("@agentlathe/db");
    drizzleOrm = await import("drizzle-orm");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(drizzle(dbModule.getPool()), { migrationsFolder });

    collection = await import("../../app/api/schedules/route");
    item = await import("../../app/api/schedules/[id]/route");
    run = await import("../../app/api/schedules/[id]/run/route");
    occurrences = await import(
      "../../app/api/schedules/[id]/occurrences/route"
    );
    ({ after } = await import("next/server"));
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
    vi.mocked(after).mockClear();
    await dbModule.db.delete(dbModule.agents);
    const [agent] = await dbModule.db
      .insert(dbModule.agents)
      .values({
        name: "digest agent",
        slug: dbModule.agentSlug("digest agent"),
        model: "test/model",
      })
      .returning();
    agentId = agent.id;
  });

  it("creates a schedule with its next run computed in its time zone", async () => {
    const { res, body } = await create();

    expect(res.status).toBe(201);
    expect(body).toMatchObject({
      frequency: "daily",
      weekday: null,
      startDate: null,
      isActive: true,
    });
    const next = new Date(body.nextRunAt);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Madrid",
        timeStyle: "short",
      }).format(next),
    ).toBe("09:00");

    const list = await (await collection.GET()).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      agentName: "digest agent",
      lastOccurrence: null,
    });
  });

  it("rejects triggers the presets cannot express, and unknown agents", async () => {
    const cases: [Record<string, unknown>, RegExp | string][] = [
      [
        { ...daily(), frequency: "weekly" },
        "A weekly schedule needs a weekday.",
      ],
      [
        { ...daily(), frequency: "monthly" },
        "A monthly schedule needs a start date.",
      ],
      [{ ...daily(), frequency: "every_minute" }, "Invalid body."],
      [{ ...daily(), timeOfDay: "9:00" }, "Invalid body."],
      [{ ...daily(), timeOfDay: "24:00" }, "Invalid body."],
      [{ ...daily(), timezone: "Mars/Olympus" }, "Invalid body."],
      [
        { ...daily(), agentId: "00000000-0000-4000-8000-000000000000" },
        "Referenced resource does not exist.",
      ],
    ];
    for (const [payload, error] of cases) {
      const { res, body } = await create(payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
      expect(body.error).toBe(error);
    }
  });

  it("keeps only the fields its preset uses", async () => {
    const { body } = await create({
      ...daily(),
      weekday: 2,
      startDate: "2026-11-30",
    });
    expect(body).toMatchObject({ weekday: null, startDate: null });
  });

  it("recomputes the next run when the trigger changes, and clears it when deactivated", async () => {
    const { body: created } = await create();

    const changed = await (
      await item.PATCH(
        jsonRequest("PATCH", { frequency: "weekly", weekday: 0 }),
        params(created.id),
      )
    ).json();
    expect(new Date(changed.nextRunAt).getUTCDay()).toBe(0);

    const renamed = await (
      await item.PATCH(
        jsonRequest("PATCH", { name: "Sunday digest" }),
        params(created.id),
      )
    ).json();
    expect(renamed.nextRunAt).toBe(changed.nextRunAt);

    const off = await (
      await item.PATCH(
        jsonRequest("PATCH", { isActive: false }),
        params(created.id),
      )
    ).json();
    expect(off.nextRunAt).toBeNull();

    const badPatch = await item.PATCH(
      jsonRequest("PATCH", { frequency: "monthly" }),
      params(created.id),
    );
    expect(badPatch.status).toBe(400);
  });

  it("reactivating a paused schedule clears the pause and the failure count", async () => {
    const { body: created } = await create();
    const { eq } = drizzleOrm;
    await dbModule.db
      .update(dbModule.schedules)
      .set({
        isActive: false,
        nextRunAt: null,
        consecutiveFailures: 5,
        pausedReason: "Paused after 5 consecutive failures.",
      })
      .where(eq(dbModule.schedules.id, created.id));

    const res = await item.PATCH(
      jsonRequest("PATCH", { isActive: true }),
      params(created.id),
    );

    expect(await res.json()).toMatchObject({
      isActive: true,
      consecutiveFailures: 0,
      pausedReason: null,
      nextRunAt: expect.any(String),
    });
  });

  it("runs now: starts at once, refuses a second while it runs, and records the occurrence", async () => {
    const { body: created } = await create();

    const first = await run.POST(jsonRequest("POST"), params(created.id));
    expect(first.status).toBe(202);
    const busy = await run.POST(jsonRequest("POST"), params(created.id));
    expect(busy.status).toBe(409);

    await vi.mocked(after).mock.calls[0][0];
    const history = await (
      await occurrences.GET(jsonRequest("GET"), params(created.id))
    ).json();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      status: "succeeded",
      runId: expect.any(String),
    });

    const { eq } = drizzleOrm;
    const [recorded] = await dbModule.db
      .select()
      .from(dbModule.agentRuns)
      .where(eq(dbModule.agentRuns.id, history[0].runId));
    expect(recorded).toMatchObject({
      source: "schedule",
      scheduleId: created.id,
    });
    const [schedule] = await dbModule.db
      .select()
      .from(dbModule.schedules)
      .where(eq(dbModule.schedules.id, created.id));
    expect(schedule.nextRunAt?.toISOString()).toBe(created.nextRunAt);
  });

  it("run now on an inactive agent is blocked with the reason and leaves a blocked occurrence", async () => {
    const { body: created } = await create();
    const { eq } = drizzleOrm;
    await dbModule.db
      .update(dbModule.agents)
      .set({ isActive: false })
      .where(eq(dbModule.agents.id, agentId));

    const res = await run.POST(jsonRequest("POST"), params(created.id));

    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("The agent is inactive.");
    const history = await (
      await occurrences.GET(jsonRequest("GET"), params(created.id))
    ).json();
    expect(history[0].status).toBe("blocked_preflight");
  });

  it("deleting a schedule keeps its runs", async () => {
    const { body: created } = await create();
    await run.POST(jsonRequest("POST"), params(created.id));
    await vi.mocked(after).mock.calls[0][0];

    const res = await item.DELETE(jsonRequest("DELETE"), params(created.id));
    expect(res.status).toBe(204);

    const runs = await dbModule.db.select().from(dbModule.agentRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0].scheduleId).toBeNull();
    expect(
      (await item.GET(jsonRequest("GET"), params(created.id))).status,
    ).toBe(404);
  });
});
