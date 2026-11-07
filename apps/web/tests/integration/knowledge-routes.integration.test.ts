import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ after: vi.fn() }));

const migrationsFolder = fileURLToPath(
  new URL("../../../../packages/db/drizzle", import.meta.url),
);

let container: StartedPostgreSqlContainer;
let dbModule: typeof import("@agentlathe/db");
let collectionsRoute: typeof import("../../app/api/knowledge/collections/route");
let collectionRoute: typeof import("../../app/api/knowledge/collections/[id]/route");
let uploadRoute: typeof import("../../app/api/knowledge/collections/[id]/documents/route");
let documentRoute: typeof import("../../app/api/knowledge/documents/[id]/route");
let fileRoute: typeof import("../../app/api/knowledge/documents/[id]/file/route");
let retryRoute: typeof import("../../app/api/knowledge/documents/[id]/retry/route");
let agentsRoute: typeof import("../../app/api/agents/route");
let agentRoute: typeof import("../../app/api/agents/[id]/route");

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function jsonRequest(method: string, body?: unknown) {
  return new Request("http://test/api", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createCollection(name: string) {
  const res = await collectionsRoute.POST(
    jsonRequest("POST", { name, description: `About ${name}.` }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; name: string };
}

async function upload(collectionId: string, name: string, content: string) {
  const form = new FormData();
  form.set("file", new File([content], name));
  const res = await uploadRoute.POST(
    new Request("http://test/api", { method: "POST", body: form }),
    params(collectionId),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

describe("knowledge routes (requires Docker)", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(
      "pgvector/pgvector:0.8.6-pg16-trixie",
    ).start();
    process.env.DATABASE_URL = container.getConnectionUri();
    dbModule = await import("@agentlathe/db");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(drizzle(dbModule.getPool()), { migrationsFolder });
    collectionsRoute = await import(
      "../../app/api/knowledge/collections/route"
    );
    collectionRoute = await import(
      "../../app/api/knowledge/collections/[id]/route"
    );
    uploadRoute = await import(
      "../../app/api/knowledge/collections/[id]/documents/route"
    );
    documentRoute = await import(
      "../../app/api/knowledge/documents/[id]/route"
    );
    fileRoute = await import(
      "../../app/api/knowledge/documents/[id]/file/route"
    );
    retryRoute = await import(
      "../../app/api/knowledge/documents/[id]/retry/route"
    );
    agentsRoute = await import("../../app/api/agents/route");
    agentRoute = await import("../../app/api/agents/[id]/route");
  }, 60000);

  afterAll(async () => {
    await dbModule.closePool();
    await container.stop();
  });

  it("creates, renames, lists and deletes a collection, refusing a duplicate name", async () => {
    const collection = await createCollection("Policies");
    const duplicate = await collectionsRoute.POST(
      jsonRequest("POST", { name: "Policies", description: "" }),
    );
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual({
      error: "A collection with this name already exists.",
    });

    const renamed = await collectionRoute.PATCH(
      jsonRequest("PATCH", { name: "HR policies" }),
      params(collection.id),
    );
    expect(await renamed.json()).toMatchObject({ name: "HR policies" });
    await upload(collection.id, "gifts.md", "Decline gifts over $250.");

    const list = (await (await collectionsRoute.GET()).json()) as {
      name: string;
      documents: number;
      waiting: number;
    }[];
    expect(list.find((row) => row.name === "HR policies")).toMatchObject({
      documents: 1,
      waiting: 1,
    });

    expect(
      (
        await collectionRoute.DELETE(
          jsonRequest("DELETE"),
          params(collection.id),
        )
      ).status,
    ).toBe(204);
    expect(
      (await collectionRoute.GET(jsonRequest("GET"), params(collection.id)))
        .status,
    ).toBe(404);
  });

  it("downloads the original as it was uploaded, and deletes a document", async () => {
    const collection = await createCollection("Downloads");
    const content = "# Título\n\nÑandú.";
    const document = await upload(collection.id, "notes ñ.md", content);

    const res = await fileRoute.GET(jsonRequest("GET"), params(document.id));
    expect(res.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(res.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''notes%20%C3%B1.md",
    );
    expect(await res.text()).toBe(content);

    expect(
      (await documentRoute.DELETE(jsonRequest("DELETE"), params(document.id)))
        .status,
    ).toBe(204);
    expect(
      (await fileRoute.GET(jsonRequest("GET"), params(document.id))).status,
    ).toBe(404);
  });

  it("counts only the extracted text of a collection toward reading it whole", async () => {
    const collection = await createCollection("Counted");
    const [first] = [
      await upload(collection.id, "a.md", "First."),
      await upload(collection.id, "b.md", "Second."),
    ];
    await dbModule.db
      .update(dbModule.knowledgeDocuments)
      .set({ text: "First.", chars: 6, status: "ready" })
      .where(eq(dbModule.knowledgeDocuments.id, first.id));

    const { listCollectionOptions } = await import(
      "../../lib/queries-knowledge"
    );
    const options = await listCollectionOptions();
    expect(options.find((option) => option.id === collection.id)?.chars).toBe(
      6,
    );
  });

  it("retries only a document that failed, from scratch", async () => {
    const collection = await createCollection("Retries");
    const document = await upload(collection.id, "notes.md", "Text.");
    expect(
      (await retryRoute.POST(jsonRequest("POST"), params(document.id))).status,
    ).toBe(409);
    expect(
      (await retryRoute.POST(jsonRequest("POST"), params(crypto.randomUUID())))
        .status,
    ).toBe(404);

    await dbModule.db
      .update(dbModule.knowledgeDocuments)
      .set({ status: "failed", attempts: 3, error: "quota exceeded" })
      .where(eq(dbModule.knowledgeDocuments.id, document.id));
    const res = await retryRoute.POST(jsonRequest("POST"), params(document.id));
    expect(res.status).toBe(200);
    const [row] = await dbModule.db
      .select({
        status: dbModule.knowledgeDocuments.status,
        attempts: dbModule.knowledgeDocuments.attempts,
        error: dbModule.knowledgeDocuments.error,
      })
      .from(dbModule.knowledgeDocuments)
      .where(eq(dbModule.knowledgeDocuments.id, document.id));
    expect(row).toEqual({ status: "pending", attempts: 0, error: null });
  });

  it("attaches collections to an agent with their mode and replaces them on edit", async () => {
    const [policies, handbook] = await Promise.all([
      createCollection("Agent policies"),
      createCollection("Agent handbook"),
    ]);
    const created = await agentsRoute.POST(
      jsonRequest("POST", {
        name: "Reader",
        model: "test/model",
        knowledge: [
          { collectionId: policies.id, mode: "search" },
          { collectionId: handbook.id, mode: "always" },
        ],
      }),
    );
    expect(created.status).toBe(201);
    const agent = (await created.json()) as { id: string };
    const links = () =>
      dbModule.db
        .select({
          collectionId: dbModule.agentKnowledge.collectionId,
          mode: dbModule.agentKnowledge.mode,
        })
        .from(dbModule.agentKnowledge)
        .where(eq(dbModule.agentKnowledge.agentId, agent.id));
    expect(await links()).toHaveLength(2);

    await agentRoute.PATCH(
      jsonRequest("PATCH", {
        knowledge: [{ collectionId: handbook.id, mode: "search" }],
      }),
      params(agent.id),
    );
    expect(await links()).toEqual([
      { collectionId: handbook.id, mode: "search" },
    ]);

    await agentRoute.PATCH(
      jsonRequest("PATCH", { systemPrompt: "Be brief." }),
      params(agent.id),
    );
    expect(await links()).toEqual([
      { collectionId: handbook.id, mode: "search" },
    ]);

    const twice = await agentRoute.PATCH(
      jsonRequest("PATCH", {
        knowledge: [
          { collectionId: handbook.id, mode: "search" },
          { collectionId: handbook.id, mode: "always" },
        ],
      }),
      params(agent.id),
    );
    expect(twice.status).toBe(400);
    const missing = await agentRoute.PATCH(
      jsonRequest("PATCH", {
        knowledge: [{ collectionId: crypto.randomUUID(), mode: "search" }],
      }),
      params(agent.id),
    );
    expect(missing.status).toBe(400);
    expect(await links()).toEqual([
      { collectionId: handbook.id, mode: "search" },
    ]);
  });

  it("creates a collection without a description", async () => {
    const res = await collectionsRoute.POST(
      jsonRequest("POST", { name: "Bare" }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: "Bare", description: "" });
  });
});
