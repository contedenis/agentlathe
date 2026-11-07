import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentSlug } from "../../src/naming";
import * as schema from "../../src/schema";

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

const IMAGES = [
  { image: "pgvector/pgvector:0.8.6-pg16-trixie", vector: true },
  { image: "postgres:16", vector: false },
];

describe.each(IMAGES)(
  "knowledge schema on $image (requires Docker)",
  ({ image, vector }) => {
    let container: StartedPostgreSqlContainer;
    let pool: Pool;
    let db: ReturnType<typeof drizzle<typeof schema>>;

    beforeAll(async () => {
      container = await new PostgreSqlContainer(image).start();
      pool = new Pool({ connectionString: container.getConnectionUri() });
      db = drizzle(pool, { schema });
      await migrate(drizzle(pool), { migrationsFolder });
    }, 120000);

    afterAll(async () => {
      await pool.end();
      await container.stop();
    });

    async function collectionWithChunk(name: string) {
      const [collection] = await db
        .insert(schema.knowledgeCollections)
        .values({ name })
        .returning();
      const [document] = await db
        .insert(schema.knowledgeDocuments)
        .values({
          collectionId: collection.id,
          filename: "notes.md",
          mediaType: "text/markdown",
          size: 8,
        })
        .returning();
      await db
        .insert(schema.knowledgeFiles)
        .values({ documentId: document.id, bytes: Buffer.from("# Notes\n") });
      await db.insert(schema.knowledgeChunks).values({
        documentId: document.id,
        position: 0,
        page: 1,
        content: "# Notes",
        embedding: [0.5, -0.25, 1],
        embeddingModel: "test/embed",
      });
      return { collection, document };
    }

    it(`${vector ? "installs" : "skips"} the vector extension`, async () => {
      const { rows } = await pool.query(
        "select 1 from pg_extension where extname = 'vector'",
      );
      expect(rows.length).toBe(vector ? 1 : 0);
    });

    it.runIf(vector)(
      "migrates without the extension when the owner cannot create it",
      async () => {
        await pool.query("create role app login password 'app' nosuperuser");
        await pool.query("create database appdb owner app");
        const url = new URL(container.getConnectionUri());
        url.username = "app";
        url.password = "app";
        url.pathname = "/appdb";
        const appPool = new Pool({ connectionString: url.toString() });
        try {
          await migrate(drizzle(appPool), { migrationsFolder });
          const { rows } = await appPool.query(
            "select 1 from pg_extension where extname = 'vector'",
          );
          expect(rows.length).toBe(0);
          const tables = await appPool.query(
            "select 1 from information_schema.tables where table_name = 'knowledge_chunks'",
          );
          expect(tables.rows.length).toBe(1);
        } finally {
          await appPool.end();
        }
      },
    );

    it("stores the original bytes and the embedding as given", async () => {
      const original = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
      const [collection] = await db
        .insert(schema.knowledgeCollections)
        .values({ name: "Round trip" })
        .returning();
      const [document] = await db
        .insert(schema.knowledgeDocuments)
        .values({
          collectionId: collection.id,
          filename: "a.pdf",
          mediaType: "application/pdf",
          size: original.length,
        })
        .returning();
      await db
        .insert(schema.knowledgeFiles)
        .values({ documentId: document.id, bytes: original });
      await db.insert(schema.knowledgeChunks).values({
        documentId: document.id,
        position: 0,
        content: "x",
        embedding: [0.125, -2, 3.5],
        embeddingModel: "test/embed",
      });

      const [stored] = await db
        .select()
        .from(schema.knowledgeDocuments)
        .where(eq(schema.knowledgeDocuments.id, document.id));
      const [file] = await db
        .select()
        .from(schema.knowledgeFiles)
        .where(eq(schema.knowledgeFiles.documentId, document.id));
      expect(Buffer.compare(file.bytes, original)).toBe(0);
      expect(stored.status).toBe("pending");
      expect(stored.attempts).toBe(0);
      const [chunk] = await db
        .select()
        .from(schema.knowledgeChunks)
        .where(eq(schema.knowledgeChunks.documentId, document.id));
      expect(chunk.embedding).toEqual([0.125, -2, 3.5]);
    });

    it("deleting a collection deletes its documents, files, chunks and agent links", async () => {
      const { collection, document } = await collectionWithChunk("Doomed");
      const [agent] = await db
        .insert(schema.agents)
        .values({
          name: "Knowledge reader",
          slug: agentSlug("Knowledge reader"),
          model: "test/model",
        })
        .returning();
      await db
        .insert(schema.agentKnowledge)
        .values({ agentId: agent.id, collectionId: collection.id });

      await db
        .delete(schema.knowledgeCollections)
        .where(eq(schema.knowledgeCollections.id, collection.id));

      const [[files], [documents], [chunks], [links]] = await Promise.all([
        db
          .select({ n: count() })
          .from(schema.knowledgeFiles)
          .where(eq(schema.knowledgeFiles.documentId, document.id)),
        db
          .select({ n: count() })
          .from(schema.knowledgeDocuments)
          .where(eq(schema.knowledgeDocuments.id, document.id)),
        db
          .select({ n: count() })
          .from(schema.knowledgeChunks)
          .where(eq(schema.knowledgeChunks.documentId, document.id)),
        db
          .select({ n: count() })
          .from(schema.agentKnowledge)
          .where(eq(schema.agentKnowledge.agentId, agent.id)),
      ]);
      expect([files.n, documents.n, chunks.n, links.n]).toEqual([0, 0, 0, 0]);
    });

    it("deleting an agent removes its links and keeps the collection", async () => {
      const { collection } = await collectionWithChunk("Kept");
      const [agent] = await db
        .insert(schema.agents)
        .values({
          name: "Short-lived",
          slug: agentSlug("Short-lived"),
          model: "test/model",
        })
        .returning();
      await db.insert(schema.agentKnowledge).values({
        agentId: agent.id,
        collectionId: collection.id,
        mode: "always",
      });

      await db.delete(schema.agents).where(eq(schema.agents.id, agent.id));

      const [links] = await db
        .select({ n: count() })
        .from(schema.agentKnowledge)
        .where(eq(schema.agentKnowledge.collectionId, collection.id));
      const [kept] = await db
        .select({ n: count() })
        .from(schema.knowledgeCollections)
        .where(eq(schema.knowledgeCollections.id, collection.id));
      expect([links.n, kept.n]).toEqual([0, 1]);
    });

    it("rejects an unknown mode, status or media type, and accepts a knowledge call", async () => {
      const { collection, document } = await collectionWithChunk("Checks");
      const [agent] = await db
        .insert(schema.agents)
        .values({
          name: "Checker",
          slug: agentSlug("Checker"),
          model: "test/model",
        })
        .returning();

      await expect(
        db.insert(schema.agentKnowledge).values({
          agentId: agent.id,
          collectionId: collection.id,
          mode: "skim",
        }),
      ).rejects.toThrow();
      await expect(
        db
          .update(schema.knowledgeDocuments)
          .set({ status: "done" })
          .where(eq(schema.knowledgeDocuments.id, document.id)),
      ).rejects.toThrow();
      await expect(
        db.insert(schema.knowledgeDocuments).values({
          collectionId: collection.id,
          filename: "a.csv",
          mediaType: "text/csv",
          size: 3,
        }),
      ).rejects.toThrow();

      const [run] = await db
        .insert(schema.agentRuns)
        .values({ agentId: agent.id, source: "dashboard", durationMs: 1 })
        .returning();
      await expect(
        db.insert(schema.agentRunCalls).values({
          runId: run.id,
          kind: "knowledge",
          name: "search_knowledge",
        }),
      ).resolves.toBeDefined();
    });

    it("rejects a second collection with the same name", async () => {
      await db.insert(schema.knowledgeCollections).values({ name: "Unique" });
      await expect(
        db.insert(schema.knowledgeCollections).values({ name: "Unique" }),
      ).rejects.toThrow();
    });
  },
);
