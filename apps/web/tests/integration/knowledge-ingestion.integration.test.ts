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
import { makePdf } from "../pdf-fixture";

vi.mock("next/server", () => ({ after: vi.fn() }));

const migrationsFolder = fileURLToPath(
  new URL("../../../../packages/db/drizzle", import.meta.url),
);

let container: StartedPostgreSqlContainer;
let provider: Server;
let dbModule: typeof import("@agentlathe/db");
let engine: typeof import("../../lib/knowledge/engine");
let upload: typeof import("../../app/api/knowledge/collections/[id]/documents/route");
let after: typeof import("next/server").after;
let collectionId: string;
let embeddingRequests: { model: string; input: string[] }[];
let failEmbeddings: boolean;
let holdEmbeddings: Promise<void> | null;

function vectorOf(text: string): number[] {
  const vector = Array.from({ length: 8 }, () => 0);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean))
    vector[[...word].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 8] += 1;
  return vector;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function uploadRequest(
  name: string,
  content: BlobPart,
  headers: Record<string, string> = {},
) {
  const form = new FormData();
  form.set("file", new File([content], name));
  return new Request("http://localhost/api", {
    method: "POST",
    body: form,
    headers,
  });
}

async function uploaded(name: string, content: BlobPart) {
  const res = await upload.POST(
    uploadRequest(name, content),
    params(collectionId),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; status: string };
}

async function documentRow(id: string) {
  const { eq } = await import("drizzle-orm");
  const [row] = await dbModule.db
    .select({
      status: dbModule.knowledgeDocuments.status,
      error: dbModule.knowledgeDocuments.error,
      attempts: dbModule.knowledgeDocuments.attempts,
      text: dbModule.knowledgeDocuments.text,
      pages: dbModule.knowledgeDocuments.pages,
      chars: dbModule.knowledgeDocuments.chars,
      embeddingModel: dbModule.knowledgeDocuments.embeddingModel,
      claimedAt: dbModule.knowledgeDocuments.claimedAt,
    })
    .from(dbModule.knowledgeDocuments)
    .where(eq(dbModule.knowledgeDocuments.id, id));
  return row;
}

async function chunksOf(id: string) {
  const { asc, eq } = await import("drizzle-orm");
  return dbModule.db
    .select()
    .from(dbModule.knowledgeChunks)
    .where(eq(dbModule.knowledgeChunks.documentId, id))
    .orderBy(asc(dbModule.knowledgeChunks.position));
}

async function setDocument(
  id: string,
  values: Partial<typeof dbModule.knowledgeDocuments.$inferInsert>,
) {
  const { eq } = await import("drizzle-orm");
  await dbModule.db
    .update(dbModule.knowledgeDocuments)
    .set(values)
    .where(eq(dbModule.knowledgeDocuments.id, id));
}

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60 * 1000);

describe("knowledge ingestion (requires Docker)", () => {
  beforeAll(async () => {
    provider = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", async () => {
        const request = JSON.parse(body) as { model: string; input: string[] };
        embeddingRequests.push(request);
        await holdEmbeddings;
        if (failEmbeddings) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "quota exceeded" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            model: request.model,
            data: request.input.map((text, index) => ({
              object: "embedding",
              index,
              embedding: vectorOf(text),
            })),
            usage: { prompt_tokens: 10, total_tokens: 10 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, resolve));
    process.env.PROVIDER_BASE_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    process.env.PROVIDER_API_KEY = "test-key";
    process.env.EMBEDDING_MODEL = "test/embed";

    container = await new PostgreSqlContainer(
      "pgvector/pgvector:0.8.6-pg16-trixie",
    ).start();
    process.env.DATABASE_URL = container.getConnectionUri();
    dbModule = await import("@agentlathe/db");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(drizzle(dbModule.getPool()), { migrationsFolder });
    engine = await import("../../lib/knowledge/engine");
    upload = await import(
      "../../app/api/knowledge/collections/[id]/documents/route"
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
    embeddingRequests = [];
    failEmbeddings = false;
    holdEmbeddings = null;
    process.env.EMBEDDING_MODEL = "test/embed";
    await dbModule.db.delete(dbModule.knowledgeCollections);
    const [collection] = await dbModule.db
      .insert(dbModule.knowledgeCollections)
      .values({ name: "Policies" })
      .returning();
    collectionId = collection.id;
  });

  it("stores an upload as pending, processes it in the background and keeps the text", async () => {
    const text = `# Travel\n\n${"Economy class for flights under six hours. ".repeat(40)}`;
    const document = await uploaded("travel.md", text);
    expect(document.status).toBe("pending");
    expect(vi.mocked(after)).toHaveBeenCalledOnce();

    await engine.processKnowledge();

    const row = await documentRow(document.id);
    expect(row).toMatchObject({
      status: "ready",
      error: null,
      attempts: 1,
      text,
      pages: null,
      chars: text.length,
      embeddingModel: "test/embed",
      claimedAt: null,
    });
    const chunks = await chunksOf(document.id);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.position)).toEqual(
      chunks.map((_, i) => i),
    );
    expect(chunks[0].embedding).toEqual(vectorOf(chunks[0].content));
    expect(chunks.every((chunk) => chunk.embeddingModel === "test/embed")).toBe(
      true,
    );
    expect(embeddingRequests.map((request) => request.model)).toEqual([
      "test/embed",
    ]);
  });

  it("extracts a PDF page by page and records where each chunk starts", async () => {
    const document = await uploaded(
      "handbook.pdf",
      makePdf([
        "Gifts over $250 must be politely declined and logged in the register.",
        "Expense reports are due within thirty days of the end of the trip.",
      ]),
    );
    await engine.processKnowledge();

    expect(await documentRow(document.id)).toMatchObject({
      status: "ready",
      pages: 2,
    });
    const [chunk] = await chunksOf(document.id);
    expect(chunk.page).toBe(1);
    expect(chunk.content).toContain("Gifts over $250");
    expect(chunk.content).toContain("thirty days");
  });

  it("rejects what it cannot ingest before storing anything", async () => {
    const cases: [Request, string, number][] = [
      [uploadRequest("data.csv", "a,b"), collectionId, 415],
      [uploadRequest("fake.pdf", "hello"), collectionId, 415],
      [uploadRequest("empty.txt", ""), collectionId, 400],
      [uploadRequest("notes.md", "x"), crypto.randomUUID(), 404],
      [uploadRequest("notes.md", "x"), "not-a-uuid", 400],
      [
        uploadRequest("notes.md", "x", {
          "content-length": String(25 * 1024 * 1024),
        }),
        collectionId,
        413,
      ],
      [
        new Request("http://localhost/api", { method: "POST", body: "{}" }),
        collectionId,
        400,
      ],
    ];
    for (const [request, id, status] of cases)
      expect((await upload.POST(request, params(id))).status).toBe(status);

    const rows = await dbModule.db.select().from(dbModule.knowledgeDocuments);
    expect(rows).toEqual([]);
    expect(vi.mocked(after)).not.toHaveBeenCalled();
  });

  it("fails a PDF without text on the first attempt and never calls the provider", async () => {
    const document = await uploaded("scan.pdf", makePdf(["", ""]));
    await engine.processKnowledge();

    expect(await documentRow(document.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "No text found. Is it a scanned PDF?",
    });
    expect(embeddingRequests).toEqual([]);
  });

  it("retries a provider failure after a pause and gives up after three attempts", async () => {
    failEmbeddings = true;
    const document = await uploaded(
      "notes.md",
      "Refunds over $500 go to billing.",
    );

    await engine.processKnowledge();
    let row = await documentRow(document.id);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.error).toContain("quota exceeded");

    await engine.processKnowledge();
    expect((await documentRow(document.id)).attempts).toBe(1);

    for (const attempt of [2, 3]) {
      await setDocument(document.id, { claimedAt: minutesAgo(3) });
      await engine.processKnowledge();
      row = await documentRow(document.id);
      expect(row.attempts).toBe(attempt);
    }
    expect(row.status).toBe("failed");
    expect(row.error).toContain("quota exceeded");
    expect(await chunksOf(document.id)).toEqual([]);
  });

  it("processes a document once when two workers race for it", async () => {
    const document = await uploaded(
      "notes.md",
      "Refunds over $500 go to billing.",
    );
    await Promise.all([engine.processKnowledge(), engine.processKnowledge()]);

    expect((await documentRow(document.id)).status).toBe("ready");
    expect(embeddingRequests).toHaveLength(1);
    expect(await chunksOf(document.id)).toHaveLength(1);
  });

  it("takes over a document whose worker stopped, and fails it after three stops", async () => {
    const [resumed, exhausted] = await Promise.all([
      uploaded("resumed.md", "Gifts over $250 are declined."),
      uploaded("exhausted.md", "Expense reports are due in 30 days."),
    ]);
    await setDocument(resumed.id, {
      status: "processing",
      attempts: 1,
      claimedAt: minutesAgo(11),
    });
    await setDocument(exhausted.id, {
      status: "processing",
      attempts: 3,
      claimedAt: minutesAgo(11),
    });
    const fresh = await uploaded("fresh.md", "Report lost laptops in 4 hours.");
    await setDocument(fresh.id, {
      status: "processing",
      attempts: 1,
      claimedAt: minutesAgo(1),
    });

    await engine.processKnowledge();

    expect(await documentRow(resumed.id)).toMatchObject({
      status: "ready",
      attempts: 2,
    });
    expect(await documentRow(exhausted.id)).toMatchObject({
      status: "failed",
      error: "Processing stopped before finishing 3 times.",
    });
    expect((await documentRow(fresh.id)).status).toBe("processing");
  });

  it("re-embeds a ready document when the model changes, without extracting it again", async () => {
    const document = await uploaded(
      "notes.md",
      "Refunds over $500 go to billing.",
    );
    process.env.EMBEDDING_MODEL = "old/embed";
    await engine.processKnowledge();
    expect((await documentRow(document.id)).embeddingModel).toBe("old/embed");

    const { eq } = await import("drizzle-orm");
    await dbModule.db
      .delete(dbModule.knowledgeFiles)
      .where(eq(dbModule.knowledgeFiles.documentId, document.id));
    process.env.EMBEDDING_MODEL = "test/embed";
    await engine.processKnowledge();

    expect(await documentRow(document.id)).toMatchObject({
      status: "ready",
      embeddingModel: "test/embed",
      attempts: 1,
    });
    const chunks = await chunksOf(document.id);
    expect(chunks.map((chunk) => chunk.embeddingModel)).toEqual(["test/embed"]);
  });

  it("writes nothing for a document deleted while it was being embedded", async () => {
    let release = () => {};
    holdEmbeddings = new Promise<void>((resolve) => {
      release = resolve;
    });
    const document = await uploaded(
      "notes.md",
      "Refunds over $500 go to billing.",
    );
    const processing = engine.processKnowledge();
    await vi.waitFor(() => expect(embeddingRequests).toHaveLength(1));

    const { eq } = await import("drizzle-orm");
    await dbModule.db
      .delete(dbModule.knowledgeDocuments)
      .where(eq(dbModule.knowledgeDocuments.id, document.id));
    release();
    await processing;

    expect(await documentRow(document.id)).toBeUndefined();
    expect(await chunksOf(document.id)).toEqual([]);
  });

  it("a worker whose claim was taken over writes nothing", async () => {
    let release = () => {};
    holdEmbeddings = new Promise<void>((resolve) => {
      release = resolve;
    });
    const document = await uploaded(
      "notes.md",
      "Gifts over $250 are declined.",
    );
    const processing = engine.processKnowledge();
    await vi.waitFor(() => expect(embeddingRequests).toHaveLength(1));

    const otherClaim = crypto.randomUUID();
    await setDocument(document.id, { claimId: otherClaim, attempts: 2 });
    release();
    await processing;

    expect(await documentRow(document.id)).toMatchObject({
      status: "processing",
      attempts: 2,
    });
    expect(await chunksOf(document.id)).toEqual([]);
  });

  it("keeps the extension of a filename that is too long", async () => {
    const res = await upload.POST(
      uploadRequest(`${"ñ".repeat(300)}.md`, "# Long"),
      params(collectionId),
    );
    expect(res.status).toBe(201);
    const { filename } = (await res.json()) as { filename: string };
    expect([...filename]).toHaveLength(255);
    expect(filename.endsWith("ñ.md")).toBe(true);
  });

  it("gives back the documents it holds when the process stops, without spending an attempt or claiming more", async () => {
    let release = () => {};
    holdEmbeddings = new Promise<void>((resolve) => {
      release = resolve;
    });
    const document = await uploaded(
      "notes.md",
      "Gifts over $250 are declined.",
    );
    const processing = engine.processKnowledge();
    await vi.waitFor(() => expect(embeddingRequests).toHaveLength(1));

    await engine.stopKnowledgeProcessing();
    holdEmbeddings = null;
    release();
    await processing;
    await engine.processKnowledge();
    expect(await documentRow(document.id)).toMatchObject({
      status: "pending",
      attempts: 0,
      claimedAt: null,
    });
    expect(embeddingRequests).toHaveLength(1);
  });
});
