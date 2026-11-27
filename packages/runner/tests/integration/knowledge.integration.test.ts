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

const IMAGES = ["pgvector/pgvector:0.8.6-pg16-trixie", "postgres:16"];
const DIMS = 16;

function vectorOf(text: string): number[] {
  const vector = Array.from({ length: DIMS }, () => 0);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean))
    vector[
      [...word].reduce((sum, c) => sum * 31 + c.charCodeAt(0), 7) % DIMS
    ] += 1;
  return vector;
}

const PASSAGES = [
  "Gifts over $250 must be politely declined.",
  "Gifts under $250 are logged in the gifts register.",
  "Expense reports are due within 30 days of the trip.",
  "Economy class for flights under six hours.",
  "Report a lost laptop within four hours.",
  "Bereavement leave is up to five paid days.",
  "Customer data leaks go to the privacy team within 24 hours.",
];

let provider: Server;
let containers: StartedPostgreSqlContainer[] = [];
let dbModule: typeof import("@agentlathe/db");
let knowledge: typeof import("../../src/knowledge");
const ids: Record<string, string> = {};

async function connectTo(container: StartedPostgreSqlContainer) {
  await dbModule.closePool();
  process.env.DATABASE_URL = container.getConnectionUri();
  knowledge.__resetPgvectorCache();
}

async function seed(url: string) {
  const pool = new Pool({ connectionString: url });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
    const insert = async (sql: string, values: unknown[]) =>
      (await pool.query(sql, values)).rows[0]?.id as string;
    const collection = (name: string, description: string) =>
      insert(
        "insert into knowledge_collections (id, name, description) values ($1, $2, $3) returning id",
        [ids[name], name, description],
      );
    const document = (
      id: string,
      collectionId: string,
      filename: string,
      text: string,
      status = "ready",
    ) =>
      insert(
        `insert into knowledge_documents (id, collection_id, filename, media_type, size, text, chars, status, embedding_model)
         values ($1, $2, $3, 'text/markdown', 1, $4, $5, $6, 'test/embed') returning id`,
        [id, collectionId, filename, text, text.length, status],
      );
    const chunk = (
      documentId: string,
      position: number,
      content: string,
      model = "test/embed",
      embedding = vectorOf(content),
    ) =>
      pool.query(
        "insert into knowledge_chunks (document_id, position, page, content, embedding, embedding_model) values ($1, $2, $3, $4, $5, $6)",
        [documentId, position, position + 1, content, embedding, model],
      );

    await collection("Policies", "Company HR policies.");
    await collection("Other", "Unrelated.");
    await collection("Handbook", "Read whole.");
    await collection("Huge", "Too big to read whole.");
    await document(
      ids.policiesDoc,
      ids.Policies,
      "policies.md",
      PASSAGES.join("\n"),
    );
    await document(ids.otherDoc, ids.Other, "other.md", "Gifts gifts gifts.");
    await document(
      ids.handbookDoc,
      ids.Handbook,
      "handbook.md",
      "Be kind.\fAlways.",
    );
    await document(ids.hugeDoc, ids.Huge, "huge.md", "x".repeat(200_000));
    for (const [position, content] of PASSAGES.entries())
      await chunk(ids.policiesDoc, position, content);
    await chunk(
      ids.policiesDoc,
      100,
      "Gifts over $250 stale vector.",
      "old/embed",
    );
    await chunk(
      ids.policiesDoc,
      101,
      "Gifts wrong size.",
      "test/embed",
      [1, 2, 3],
    );
    await chunk(ids.otherDoc, 0, "Gifts gifts gifts.");
    await document(
      ids.partialDoc,
      ids.Policies,
      "partial.md",
      "Gifts over $250 half written.",
      "processing",
    );
    await chunk(ids.partialDoc, 0, "Gifts over $250 half written.");

    await pool.query(
      "insert into agents (id, name, slug, model) values ($1, 'Reader', 'reader', 'test/model')",
      [ids.agent],
    );
    for (const [name, mode] of [
      ["Policies", "search"],
      ["Handbook", "always"],
      ["Huge", "always"],
    ])
      await pool.query(
        "insert into agent_knowledge (agent_id, collection_id, mode) values ($1, $2, $3)",
        [ids.agent, ids[name], mode],
      );
  } finally {
    await pool.end();
  }
}

describe("knowledge search (requires Docker)", () => {
  beforeAll(async () => {
    provider = createServer((req, res) => {
      let body = "";
      req.on("data", (part) => {
        body += part;
      });
      req.on("end", () => {
        const { model, input } = JSON.parse(body) as {
          model: string;
          input: string[];
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            model,
            data: input.map((text, index) => ({
              object: "embedding",
              index,
              embedding: vectorOf(text),
            })),
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, resolve));
    process.env.PROVIDER_BASE_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    process.env.PROVIDER_API_KEY = "test-key";
    process.env.EMBEDDING_MODEL = "test/embed";
    for (const key of [
      "Policies",
      "Other",
      "Handbook",
      "Huge",
      "policiesDoc",
      "otherDoc",
      "handbookDoc",
      "hugeDoc",
      "partialDoc",
      "agent",
    ])
      ids[key] = crypto.randomUUID();

    containers = await Promise.all(
      IMAGES.map((image) => new PostgreSqlContainer(image).start()),
    );
    await Promise.all(containers.map((c) => seed(c.getConnectionUri())));
    process.env.DATABASE_URL = containers[0].getConnectionUri();
    dbModule = await import("@agentlathe/db");
    knowledge = await import("../../src/knowledge");
  }, 120000);

  afterAll(async () => {
    await dbModule?.closePool();
    await Promise.all(containers.map((c) => c.stop()));
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  });

  it("returns the same five closest passages with and without pgvector, from the agent's collections and the current model only", async () => {
    const results = [];
    const probe = new Pool({
      connectionString: containers[0].getConnectionUri(),
    });
    const { rows } = await probe
      .query("select 1 from pg_extension where extname = 'vector'")
      .finally(() => probe.end());
    expect(rows).toHaveLength(1);
    for (const container of containers) {
      await connectTo(container);
      results.push(
        await knowledge.searchKnowledge([ids.Policies], PASSAGES[0]),
      );
    }
    const [withVector, plain] = results;

    expect(withVector).toEqual(plain);
    expect(withVector).toHaveLength(5);
    expect(withVector[0]).toEqual({
      collection: "Policies",
      document: "policies.md",
      page: 1,
      text: "Gifts over $250 must be politely declined.",
    });
    const texts = withVector.map((passage) => passage.text);
    expect(texts).not.toContain("Gifts over $250 stale vector.");
    expect(texts).not.toContain("Gifts wrong size.");
    expect(texts).not.toContain("Gifts gifts gifts.");
    expect(texts).not.toContain("Gifts over $250 half written.");
  });

  it("searches nothing without collections", async () => {
    await connectTo(containers[1]);
    await expect(knowledge.searchKnowledge([], "gifts")).resolves.toEqual([]);
  });

  it("reads small collections whole and searches the ones that do not fit in a quarter of the context", async () => {
    await connectTo(containers[1]);
    const view = await knowledge.loadKnowledge(ids.agent, 100_000);

    expect(view.always.map((c) => c.name)).toEqual(["Handbook"]);
    expect(view.always[0].documents).toEqual([
      { filename: "handbook.md", text: "Be kind.\fAlways." },
    ]);
    expect(view.search.map((c) => [c.name, c.mode])).toEqual([
      ["Huge", "always"],
      ["Policies", "search"],
    ]);
    expect(view.warnings).toEqual([
      {
        code: "knowledge_too_large",
        message: expect.stringContaining(
          'Searched the knowledge collection "Huge" instead of reading it whole',
        ),
      },
    ]);

    const roomy = await knowledge.loadKnowledge(ids.agent, 1_000_000);
    expect(roomy.always.map((c) => c.name)).toEqual(["Handbook", "Huge"]);
    expect(roomy.warnings).toEqual([]);
  });
});
