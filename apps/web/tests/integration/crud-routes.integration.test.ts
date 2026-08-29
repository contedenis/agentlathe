import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

let container: StartedPostgreSqlContainer;
let dbModule: typeof import("@agentlathe/db");
let agentsRoute: typeof import("../../app/api/agents/route");
let agentRoute: typeof import("../../app/api/agents/[id]/route");
let toolsRoute: typeof import("../../app/api/tools/route");
let toolRoute: typeof import("../../app/api/tools/[id]/route");
let skillsRoute: typeof import("../../app/api/skills/route");
let skillRoute: typeof import("../../app/api/skills/[id]/route");
let mcpServersRoute: typeof import("../../app/api/mcp-servers/route");
let mcpServerRoute: typeof import("../../app/api/mcp-servers/[id]/route");
let settingsRoute: typeof import("../../app/api/settings/route");
let fixDraftsRoute: typeof import("../../app/api/runs/[id]/fix-drafts/route");
let fixDraftRoute: typeof import("../../app/api/runs/[id]/fix-drafts/[draftId]/route");

function jsonRequest(url: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function withParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function createTool(name: string) {
  const res = await toolsRoute.POST(
    jsonRequest("http://test/api/tools", "POST", {
      name,
      description: "a tool",
      endpoint: "https://example.com/tool",
      inputSchema: {},
    }),
  );
  return res.json();
}

async function createAgent(name: string) {
  const res = await agentsRoute.POST(
    jsonRequest("http://test/api/agents", "POST", {
      name,
      model: "test/model",
    }),
  );
  return res.json();
}

describe("CRUD routes (requires Docker)", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").start();
    process.env.DATABASE_URL = container.getConnectionUri();

    dbModule = await import("@agentlathe/db");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(drizzle(dbModule.getPool()), { migrationsFolder });

    agentsRoute = await import("../../app/api/agents/route");
    agentRoute = await import("../../app/api/agents/[id]/route");
    toolsRoute = await import("../../app/api/tools/route");
    toolRoute = await import("../../app/api/tools/[id]/route");
    skillsRoute = await import("../../app/api/skills/route");
    skillRoute = await import("../../app/api/skills/[id]/route");
    mcpServersRoute = await import("../../app/api/mcp-servers/route");
    mcpServerRoute = await import("../../app/api/mcp-servers/[id]/route");
    settingsRoute = await import("../../app/api/settings/route");
    fixDraftsRoute = await import("../../app/api/runs/[id]/fix-drafts/route");
    fixDraftRoute = await import(
      "../../app/api/runs/[id]/fix-drafts/[draftId]/route"
    );
  }, 60000);

  afterAll(async () => {
    await dbModule.closePool();
    await container.stop();
  });

  describe("agents", () => {
    it("creates an agent with relations and returns 201", async () => {
      const tool = await createTool("relation tool");
      const subAgent = await createAgent("relation sub agent");

      const res = await agentsRoute.POST(
        jsonRequest("http://test/api/agents", "POST", {
          name: "relation agent",
          model: "test/model",
          toolIds: [tool.id],
          subAgentIds: [subAgent.id],
        }),
      );
      expect(res.status).toBe(201);
      const created = await res.json();
      expect(created.name).toBe("relation agent");
      expect(created.slug).toBe("relation-agent");

      const toolRows = await dbModule.db
        .select()
        .from(dbModule.agentTools)
        .where(eq(dbModule.agentTools.agentId, created.id));
      expect(toolRows).toHaveLength(1);
      expect(toolRows[0].toolId).toBe(tool.id);

      const subAgentRows = await dbModule.db
        .select()
        .from(dbModule.agentSubAgents)
        .where(eq(dbModule.agentSubAgents.parentId, created.id));
      expect(subAgentRows).toHaveLength(1);
      expect(subAgentRows[0].childId).toBe(subAgent.id);
    });

    it("derives the slug from a display name and keeps it editable by PATCH", async () => {
      const res = await agentsRoute.POST(
        jsonRequest("http://test/api/agents", "POST", {
          name: "Créditos Support Bot",
          model: "test/model",
        }),
      );
      expect(res.status).toBe(201);
      const created = await res.json();

      expect(created.slug).toBe("creditos-support-bot");
      expect(created.slug).not.toBe(created.name);
      // POST derives the slug without the schema, so it must still satisfy PATCH's pattern.
      expect(created.slug).toMatch(dbModule.AGENT_SLUG_PATTERN);

      const patched = await agentRoute.PATCH(
        jsonRequest(`http://test/api/agents/${created.id}`, "PATCH", {
          slug: created.slug,
        }),
        withParams(created.id),
      );
      expect(patched.status).toBe(200);
    });

    it("persists the per-tool approval flag on MCP selections", async () => {
      const [server] = await dbModule.db
        .insert(dbModule.mcpServers)
        .values({ name: "approval server", serverUrl: "http://mcp.example" })
        .returning();

      const res = await agentsRoute.POST(
        jsonRequest("http://test/api/agents", "POST", {
          name: "mcp approval agent",
          model: "test/model",
          mcpTools: [
            {
              serverId: server.id,
              toolName: "deploy",
              needsApproval: true,
            },
            { serverId: server.id, toolName: "read" },
          ],
        }),
      );
      expect(res.status).toBe(201);
      const created = await res.json();

      const rows = await dbModule.db
        .select()
        .from(dbModule.agentMcpTools)
        .where(eq(dbModule.agentMcpTools.agentId, created.id));
      expect(
        rows
          .map((row) => ({
            toolName: row.toolName,
            needsApproval: row.needsApproval,
          }))
          .sort((a, b) => a.toolName.localeCompare(b.toolName)),
      ).toEqual([
        { toolName: "deploy", needsApproval: true },
        { toolName: "read", needsApproval: false },
      ]);
    });

    it("GET [id] returns the detail with skills, tools, mcp tools and sub-agents", async () => {
      const tool = await createTool("detail tool");
      const subAgent = await createAgent("detail sub agent");

      const created = await createAgent("detail agent placeholder");
      const res = await agentRoute.PATCH(
        jsonRequest(`http://test/api/agents/${created.id}`, "PATCH", {
          toolIds: [tool.id],
          subAgentIds: [subAgent.id],
        }),
        withParams(created.id),
      );
      expect(res.status).toBe(200);

      const detailRes = await agentRoute.GET(
        new Request(`http://test/api/agents/${created.id}`),
        withParams(created.id),
      );
      expect(detailRes.status).toBe(200);
      const detail = await detailRes.json();
      expect(detail.tools).toEqual([
        { id: tool.id, name: tool.name, isActive: tool.isActive },
      ]);
      expect(detail.subAgents).toEqual([
        { id: subAgent.id, name: subAgent.name, isActive: subAgent.isActive },
      ]);
      expect(detail.mcpTools).toEqual([]);
    });

    it("PATCH replaces relations and updates fields", async () => {
      const toolA = await createTool("swap tool a");
      const toolB = await createTool("swap tool b");
      const agent = await createAgent("swap agent");

      const firstPatch = await agentRoute.PATCH(
        jsonRequest(`http://test/api/agents/${agent.id}`, "PATCH", {
          toolIds: [toolA.id],
        }),
        withParams(agent.id),
      );
      expect(firstPatch.status).toBe(200);

      const secondPatch = await agentRoute.PATCH(
        jsonRequest(`http://test/api/agents/${agent.id}`, "PATCH", {
          name: "swap agent renamed",
          toolIds: [toolB.id],
        }),
        withParams(agent.id),
      );
      expect(secondPatch.status).toBe(200);
      const updated = await secondPatch.json();
      expect(updated.name).toBe("swap agent renamed");

      const toolRows = await dbModule.db
        .select()
        .from(dbModule.agentTools)
        .where(eq(dbModule.agentTools.agentId, agent.id));
      expect(toolRows.map((row) => row.toolId)).toEqual([toolB.id]);
    });

    it("PATCH with subAgentIds containing the agent's own id returns 400", async () => {
      const agent = await createAgent("self reference agent");

      const res = await agentRoute.PATCH(
        jsonRequest(`http://test/api/agents/${agent.id}`, "PATCH", {
          subAgentIds: [agent.id],
        }),
        withParams(agent.id),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("An agent cannot be its own sub-agent.");
    });

    it("DELETE returns 204 and cascades join rows", async () => {
      const tool = await createTool("cascade tool");
      const agent = await createAgent("cascade agent");
      await agentRoute.PATCH(
        jsonRequest(`http://test/api/agents/${agent.id}`, "PATCH", {
          toolIds: [tool.id],
        }),
        withParams(agent.id),
      );

      const res = await agentRoute.DELETE(
        new Request(`http://test/api/agents/${agent.id}`, {
          method: "DELETE",
        }),
        withParams(agent.id),
      );
      expect(res.status).toBe(204);

      const toolRows = await dbModule.db
        .select()
        .from(dbModule.agentTools)
        .where(eq(dbModule.agentTools.agentId, agent.id));
      expect(toolRows).toEqual([]);
    });

    it("POST with a nonexistent toolId maps the FK violation to a 400", async () => {
      const res = await agentsRoute.POST(
        jsonRequest("http://test/api/agents", "POST", {
          name: "bad tool ref agent",
          model: "test/model",
          toolIds: [NIL_UUID],
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Referenced resource does not exist.");
    });

    it("POST with a duplicate name maps the unique violation to a 400", async () => {
      await createAgent("dup name agent");

      const res = await agentsRoute.POST(
        jsonRequest("http://test/api/agents", "POST", {
          name: "dup name agent",
          model: "test/model",
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("An agent with this name already exists.");
    });

    it("GET/PATCH/DELETE with a non-uuid id return 400", async () => {
      const getRes = await agentRoute.GET(
        new Request("http://test/api/agents/not-a-uuid"),
        withParams("not-a-uuid"),
      );
      expect(getRes.status).toBe(400);

      const patchRes = await agentRoute.PATCH(
        jsonRequest("http://test/api/agents/not-a-uuid", "PATCH", {
          name: "irrelevant",
        }),
        withParams("not-a-uuid"),
      );
      expect(patchRes.status).toBe(400);

      const deleteRes = await agentRoute.DELETE(
        new Request("http://test/api/agents/not-a-uuid", {
          method: "DELETE",
        }),
        withParams("not-a-uuid"),
      );
      expect(deleteRes.status).toBe(400);
    });

    it("GET/PATCH/DELETE with a valid unknown uuid return 404", async () => {
      const getRes = await agentRoute.GET(
        new Request(`http://test/api/agents/${NIL_UUID}`),
        withParams(NIL_UUID),
      );
      expect(getRes.status).toBe(404);

      const patchRes = await agentRoute.PATCH(
        jsonRequest(`http://test/api/agents/${NIL_UUID}`, "PATCH", {
          name: "irrelevant",
        }),
        withParams(NIL_UUID),
      );
      expect(patchRes.status).toBe(404);

      const deleteRes = await agentRoute.DELETE(
        new Request(`http://test/api/agents/${NIL_UUID}`, {
          method: "DELETE",
        }),
        withParams(NIL_UUID),
      );
      expect(deleteRes.status).toBe(404);
    });
  });

  describe("tools", () => {
    it("rejects an inputSchema that is not a valid JSON Schema", async () => {
      const res = await toolsRoute.POST(
        jsonRequest("http://test/api/tools", "POST", {
          name: "broken schema tool",
          description: "a tool",
          endpoint: "https://example.com/tool",
          inputSchema: { type: "not-a-type" },
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(JSON.stringify(body)).toContain("valid JSON Schema");
    });

    it("supports the full CRUD happy path", async () => {
      const createRes = await toolsRoute.POST(
        jsonRequest("http://test/api/tools", "POST", {
          name: "crud tool",
          description: "does things",
          endpoint: "https://example.com/crud-tool",
          inputSchema: { type: "object" },
        }),
      );
      expect(createRes.status).toBe(201);
      const created = await createRes.json();

      const listRes = await toolsRoute.GET();
      const list = await listRes.json();
      expect(list.map((row: { id: string }) => row.id)).toContain(created.id);

      const patchRes = await toolRoute.PATCH(
        jsonRequest(`http://test/api/tools/${created.id}`, "PATCH", {
          description: "does more things",
        }),
        withParams(created.id),
      );
      expect(patchRes.status).toBe(200);
      const patched = await patchRes.json();
      expect(patched.description).toBe("does more things");

      const deleteRes = await toolRoute.DELETE(
        new Request(`http://test/api/tools/${created.id}`, {
          method: "DELETE",
        }),
        withParams(created.id),
      );
      expect(deleteRes.status).toBe(204);
    });

    it("POST with an invalid endpoint URL returns 400", async () => {
      const res = await toolsRoute.POST(
        jsonRequest("http://test/api/tools", "POST", {
          name: "bad endpoint tool",
          description: "does things",
          endpoint: "not-a-url",
          inputSchema: {},
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe("skills", () => {
    it("supports the full CRUD happy path", async () => {
      const createRes = await skillsRoute.POST(
        jsonRequest("http://test/api/skills", "POST", {
          name: "crud skill",
          description: "does things",
          content: "some skill content",
        }),
      );
      expect(createRes.status).toBe(201);
      const created = await createRes.json();

      const listRes = await skillsRoute.GET();
      const list = await listRes.json();
      expect(list.map((row: { id: string }) => row.id)).toContain(created.id);

      const patchRes = await skillRoute.PATCH(
        jsonRequest(`http://test/api/skills/${created.id}`, "PATCH", {
          description: "does more things",
        }),
        withParams(created.id),
      );
      expect(patchRes.status).toBe(200);
      const patched = await patchRes.json();
      expect(patched.description).toBe("does more things");

      const deleteRes = await skillRoute.DELETE(
        new Request(`http://test/api/skills/${created.id}`, {
          method: "DELETE",
        }),
        withParams(created.id),
      );
      expect(deleteRes.status).toBe(204);
    });

    it("POST with a missing required field returns 400", async () => {
      const res = await skillsRoute.POST(
        jsonRequest("http://test/api/skills", "POST", {
          name: "incomplete skill",
          description: "missing content",
        }),
      );
      expect(res.status).toBe(400);
    });

    it("GET/PATCH/DELETE with a non-uuid id return 400", async () => {
      const getRes = await skillRoute.GET(
        new Request("http://test/api/skills/not-a-uuid"),
        withParams("not-a-uuid"),
      );
      expect(getRes.status).toBe(400);

      const patchRes = await skillRoute.PATCH(
        jsonRequest("http://test/api/skills/not-a-uuid", "PATCH", {
          name: "irrelevant",
        }),
        withParams("not-a-uuid"),
      );
      expect(patchRes.status).toBe(400);

      const deleteRes = await skillRoute.DELETE(
        new Request("http://test/api/skills/not-a-uuid", {
          method: "DELETE",
        }),
        withParams("not-a-uuid"),
      );
      expect(deleteRes.status).toBe(400);
    });

    it("GET/PATCH/DELETE with a valid unknown uuid return 404", async () => {
      const getRes = await skillRoute.GET(
        new Request(`http://test/api/skills/${NIL_UUID}`),
        withParams(NIL_UUID),
      );
      expect(getRes.status).toBe(404);

      const patchRes = await skillRoute.PATCH(
        jsonRequest(`http://test/api/skills/${NIL_UUID}`, "PATCH", {
          name: "irrelevant",
        }),
        withParams(NIL_UUID),
      );
      expect(patchRes.status).toBe(404);

      const deleteRes = await skillRoute.DELETE(
        new Request(`http://test/api/skills/${NIL_UUID}`, {
          method: "DELETE",
        }),
        withParams(NIL_UUID),
      );
      expect(deleteRes.status).toBe(404);
    });
  });

  describe("mcp-servers", () => {
    it("POST with an invalid serverUrl returns 400", async () => {
      const res = await mcpServersRoute.POST(
        jsonRequest("http://test/api/mcp-servers", "POST", {
          name: "bad url server",
          serverUrl: "not-a-url",
        }),
      );
      expect(res.status).toBe(400);
    });

    it("redacts authConfig on GET list and GET [id]", async () => {
      const createRes = await mcpServersRoute.POST(
        jsonRequest("http://test/api/mcp-servers", "POST", {
          name: "secret server",
          serverUrl: "https://example.com/mcp",
          authConfig: { headers: { Authorization: "Bearer super-secret" } },
        }),
      );
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      expect(created.authConfig).toBeUndefined();
      expect(created.hasAuth).toBe(true);

      const listRes = await mcpServersRoute.GET();
      const list = await listRes.json();
      const listed = list.find((row: { id: string }) => row.id === created.id);
      expect(listed.authConfig).toBeUndefined();
      expect(listed.hasAuth).toBe(true);

      const detailRes = await mcpServerRoute.GET(
        new Request(`http://test/api/mcp-servers/${created.id}`),
        withParams(created.id),
      );
      const detail = await detailRes.json();
      expect(detail.authConfig).toBeUndefined();
      expect(detail.hasAuth).toBe(true);
    });

    it("POST rejects an authConfig without a headers object", async () => {
      const res = await mcpServersRoute.POST(
        jsonRequest("http://test/api/mcp-servers", "POST", {
          name: "malshaped auth server",
          serverUrl: "https://example.com/mcp",
          authConfig: { Authorization: "Bearer super-secret" },
        }),
      );
      expect(res.status).toBe(400);
    });

    it("POST [id]/tools rejects a malformed serverUrl override", async () => {
      const [server] = await dbModule.db
        .insert(dbModule.mcpServers)
        .values({
          name: "bad override server",
          serverUrl: "https://stale.example/mcp",
        })
        .returning();
      const toolsRoute = await import(
        "../../app/api/mcp-servers/[id]/tools/route"
      );

      const res = await toolsRoute.POST(
        jsonRequest(`http://test/api/mcp-servers/${server.id}/tools`, "POST", {
          serverUrl: "not-a-url",
        }),
        withParams(server.id),
      );
      expect(res.status).toBe(400);
    });

    it("POST [id]/tools connects to the overridden serverUrl instead of the stored one", async () => {
      const [server] = await dbModule.db
        .insert(dbModule.mcpServers)
        .values({
          name: "override server",
          serverUrl: "https://stored-mcp-host.invalid/mcp",
        })
        .returning();
      const toolsRoute = await import(
        "../../app/api/mcp-servers/[id]/tools/route"
      );

      const overrideUrl = "https://override-mcp-host.invalid/mcp";
      const res = await toolsRoute.POST(
        jsonRequest(`http://test/api/mcp-servers/${server.id}/tools`, "POST", {
          serverUrl: overrideUrl,
        }),
        withParams(server.id),
      );
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toContain("override-mcp-host.invalid");
      expect(body.error).not.toContain("stored-mcp-host.invalid");
    }, 15000);

    it("POST [id]/tools without a body discovers via the stored serverUrl and auth", async () => {
      vi.stubEnv("AGENTLATHE_SECRET_CRUD_MCP", "Bearer resolved-token");
      const seen: {
        rpcMethod: string;
        auth: string | undefined;
        static: string | undefined;
      }[] = [];
      const stub = createServer((req, res) => {
        if (req.method === "DELETE") {
          res.writeHead(200).end();
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          seen.push({
            rpcMethod: message.method,
            auth: req.headers.authorization,
            static: req.headers["x-static"] as string | undefined,
          });
          if (message.id === undefined) {
            res.writeHead(202).end();
            return;
          }
          const result =
            message.method === "initialize"
              ? {
                  protocolVersion: message.params.protocolVersion,
                  capabilities: { tools: {} },
                  serverInfo: { name: "stub", version: "1.0.0" },
                }
              : {
                  tools: [
                    {
                      name: "echo",
                      description: "Echoes the message back.",
                      inputSchema: { type: "object" },
                    },
                  ],
                };
          res
            .writeHead(200, {
              "content-type": "application/json",
              "mcp-session-id": "stub-session",
            })
            .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        });
      });
      await new Promise<void>((resolve) => {
        stub.listen(0, "127.0.0.1", resolve);
      });

      try {
        const [server] = await dbModule.db
          .insert(dbModule.mcpServers)
          .values({
            name: "stored url server",
            serverUrl: `http://127.0.0.1:${(stub.address() as AddressInfo).port}/mcp`,
            authConfig: {
              headers: {
                Authorization: "AGENTLATHE_SECRET_CRUD_MCP",
                "x-static": "literal-value",
              },
            },
          })
          .returning();
        const toolsRoute = await import(
          "../../app/api/mcp-servers/[id]/tools/route"
        );

        const res = await toolsRoute.POST(
          jsonRequest(`http://test/api/mcp-servers/${server.id}/tools`, "POST"),
          withParams(server.id),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual([
          "echo",
        ]);
        expect(seen.map((r) => r.rpcMethod)).toContain("tools/list");
        expect(seen.every((r) => r.auth === "Bearer resolved-token")).toBe(
          true,
        );
        expect(seen.every((r) => r.static === "literal-value")).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        stub.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          stub.close((err) => (err ? reject(err) : resolve()));
        });
      }
    }, 15000);

    it("POST [id]/tools fails before connecting when a referenced env var is unset", async () => {
      const [server] = await dbModule.db
        .insert(dbModule.mcpServers)
        .values({
          name: "unset ref server",
          serverUrl: "https://never-contacted.invalid/mcp",
          authConfig: {
            headers: { Authorization: "AGENTLATHE_SECRET_CRUD_UNSET" },
          },
        })
        .returning();
      const toolsRoute = await import(
        "../../app/api/mcp-servers/[id]/tools/route"
      );

      const res = await toolsRoute.POST(
        jsonRequest(`http://test/api/mcp-servers/${server.id}/tools`, "POST"),
        withParams(server.id),
      );
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toContain("AGENTLATHE_SECRET_CRUD_UNSET");
      expect(body.error).toContain("is not set");
    });

    it("keeps env references visible through redaction as authRefs", async () => {
      const createRes = await mcpServersRoute.POST(
        jsonRequest("http://test/api/mcp-servers", "POST", {
          name: "ref redaction server",
          serverUrl: "https://example.com/mcp",
          authConfig: {
            headers: {
              Authorization: "AGENTLATHE_SECRET_REDACTION_PAT",
              "x-literal": "Bearer super-secret",
            },
          },
        }),
      );
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      expect(created.authConfig).toBeUndefined();
      expect(created.hasAuth).toBe(true);
      expect(created.authRefs).toEqual({
        Authorization: "AGENTLATHE_SECRET_REDACTION_PAT",
      });

      const detailRes = await mcpServerRoute.GET(
        new Request(`http://test/api/mcp-servers/${created.id}`),
        withParams(created.id),
      );
      const detail = await detailRes.json();
      expect(detail.authConfig).toBeUndefined();
      expect(detail.authRefs).toEqual({
        Authorization: "AGENTLATHE_SECRET_REDACTION_PAT",
      });
      expect(JSON.stringify(detail)).not.toContain("super-secret");
    });

    it("POST rejects a header value in the AGENTLATHE_ namespace outside AGENTLATHE_SECRET_", async () => {
      const res = await mcpServersRoute.POST(
        jsonRequest("http://test/api/mcp-servers", "POST", {
          name: "typo ref server",
          serverUrl: "https://example.com/mcp",
          authConfig: {
            headers: { Authorization: "AGENTLATHE_SECRETS_TYPO" },
          },
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe("settings", () => {
    it("GET returns the defaults", async () => {
      const res = await settingsRoute.GET();
      const body = await res.json();
      expect(body).toEqual({
        trackDashboardRuns: true,
        trackV1Runs: false,
        trackMcpRuns: false,
        agentRunTtlDays: 90,
        transcriptTtlDays: 14,
      });
    });

    it("PATCH persists a single flag", async () => {
      const res = await settingsRoute.PATCH(
        jsonRequest("http://test/api/settings", "PATCH", {
          trackV1Runs: true,
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.trackV1Runs).toBe(true);

      const getRes = await settingsRoute.GET();
      const getBody = await getRes.json();
      expect(getBody.trackV1Runs).toBe(true);
    });

    it("PATCH with an empty body returns 400", async () => {
      const res = await settingsRoute.PATCH(
        jsonRequest("http://test/api/settings", "PATCH", {}),
      );
      expect(res.status).toBe(400);
    });

    it("PATCH with agentRunTtlDays above the max returns 400", async () => {
      const res = await settingsRoute.PATCH(
        jsonRequest("http://test/api/settings", "PATCH", {
          agentRunTtlDays: dbModule.MAX_AGENT_RUN_TTL_DAYS + 1,
        }),
      );
      expect(res.status).toBe(400);
    });

    it("PATCH persists transcriptTtlDays", async () => {
      const res = await settingsRoute.PATCH(
        jsonRequest("http://test/api/settings", "PATCH", {
          transcriptTtlDays: 30,
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.transcriptTtlDays).toBe(30);

      const getRes = await settingsRoute.GET();
      const getBody = await getRes.json();
      expect(getBody.transcriptTtlDays).toBe(30);
    });

    it("PATCH with transcriptTtlDays above the max returns 400", async () => {
      const res = await settingsRoute.PATCH(
        jsonRequest("http://test/api/settings", "PATCH", {
          transcriptTtlDays: dbModule.MAX_AGENT_RUN_TTL_DAYS + 1,
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe("fix-drafts", () => {
    async function createRun(agentName: string) {
      const agent = await createAgent(agentName);
      const [run] = await dbModule.db
        .insert(dbModule.agentRuns)
        .values({ agentId: agent.id, source: "dashboard", durationMs: 5 })
        .returning();
      return run;
    }

    function draftBody(overrides: Record<string, unknown> = {}) {
      return {
        messageId: "msg-1",
        anchor: { type: "turn" },
        category: "prompt",
        rationale: "The tone is off",
        ...overrides,
      };
    }

    async function createDraft(runId: string, overrides = {}) {
      const res = await fixDraftsRoute.POST(
        jsonRequest(
          `http://test/api/runs/${runId}/fix-drafts`,
          "POST",
          draftBody(overrides),
        ),
        withParams(runId),
      );
      return { res, draft: await res.json() };
    }

    it("POST anchors a draft to a tool call and returns 201", async () => {
      const run = await createRun("fix draft agent");
      const { res, draft } = await createDraft(run.id, {
        anchor: { type: "tool_call", toolCallId: "call-9" },
        proposedValue: "Ask for the city first.",
      });

      expect(res.status).toBe(201);
      expect(draft).toMatchObject({
        messageId: "msg-1",
        anchor: { type: "tool_call", toolCallId: "call-9" },
        category: "prompt",
        proposedValue: "Ask for the city first.",
        status: "open",
      });

      const rows = await dbModule.db
        .select()
        .from(dbModule.fixDrafts)
        .where(eq(dbModule.fixDrafts.runId, run.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(draft.id);
    });

    it("POST defaults proposedValue to null when omitted", async () => {
      const run = await createRun("fix draft default agent");
      const { draft } = await createDraft(run.id);

      expect(draft.proposedValue).toBeNull();
    });

    it("POST with a non-uuid run id returns 400", async () => {
      const res = await fixDraftsRoute.POST(
        jsonRequest(
          "http://test/api/runs/nope/fix-drafts",
          "POST",
          draftBody(),
        ),
        withParams("nope"),
      );
      expect(res.status).toBe(400);
    });

    it("POST with a valid unknown run uuid returns 404", async () => {
      const res = await fixDraftsRoute.POST(
        jsonRequest(
          `http://test/api/runs/${NIL_UUID}/fix-drafts`,
          "POST",
          draftBody(),
        ),
        withParams(NIL_UUID),
      );
      expect(res.status).toBe(404);
    });

    it("POST with an unknown category, a bad anchor or an empty rationale returns 400", async () => {
      const run = await createRun("fix draft validation agent");

      for (const overrides of [
        { category: "not_a_category" },
        { anchor: { type: "selection" } },
        { anchor: { type: "tool_call" } },
        { rationale: "" },
      ]) {
        const { res } = await createDraft(run.id, overrides);
        expect(res.status).toBe(400);
      }
    });

    it("PATCH moves a draft to dismissed and back to open", async () => {
      const run = await createRun("fix draft status agent");
      const { draft } = await createDraft(run.id);

      const dismissRes = await fixDraftRoute.PATCH(
        jsonRequest(
          `http://test/api/runs/${run.id}/fix-drafts/${draft.id}`,
          "PATCH",
          { status: "dismissed" },
        ),
        { params: Promise.resolve({ id: run.id, draftId: draft.id }) },
      );
      expect(dismissRes.status).toBe(200);
      expect((await dismissRes.json()).status).toBe("dismissed");

      const reopenRes = await fixDraftRoute.PATCH(
        jsonRequest(
          `http://test/api/runs/${run.id}/fix-drafts/${draft.id}`,
          "PATCH",
          { status: "open" },
        ),
        { params: Promise.resolve({ id: run.id, draftId: draft.id }) },
      );
      expect((await reopenRes.json()).status).toBe("open");
    });

    it("PATCH edits content fields and leaves the status alone", async () => {
      const run = await createRun("fix draft edit agent");
      const { draft } = await createDraft(run.id);

      const res = await fixDraftRoute.PATCH(
        jsonRequest(
          `http://test/api/runs/${run.id}/fix-drafts/${draft.id}`,
          "PATCH",
          {
            category: "model",
            rationale: "Edited rationale",
            proposedValue: "switch to a cheaper model",
          },
        ),
        { params: Promise.resolve({ id: run.id, draftId: draft.id }) },
      );
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated.category).toBe("model");
      expect(updated.rationale).toBe("Edited rationale");
      expect(updated.proposedValue).toBe("switch to a cheaper model");
      expect(updated.status).toBe(draft.status);
    });

    it("PATCH with an empty body returns 400", async () => {
      const run = await createRun("fix draft empty patch agent");
      const { draft } = await createDraft(run.id);

      const res = await fixDraftRoute.PATCH(
        jsonRequest(
          `http://test/api/runs/${run.id}/fix-drafts/${draft.id}`,
          "PATCH",
          {},
        ),
        { params: Promise.resolve({ id: run.id, draftId: draft.id }) },
      );
      expect(res.status).toBe(400);
    });

    it("PATCH with a status outside the enum returns 400", async () => {
      const run = await createRun("fix draft bad status agent");
      const { draft } = await createDraft(run.id);

      const res = await fixDraftRoute.PATCH(
        jsonRequest(
          `http://test/api/runs/${run.id}/fix-drafts/${draft.id}`,
          "PATCH",
          { status: "archived" },
        ),
        { params: Promise.resolve({ id: run.id, draftId: draft.id }) },
      );
      expect(res.status).toBe(400);
    });

    it("PATCH with a non-uuid run id or draft id returns 400", async () => {
      const run = await createRun("fix draft uuid agent");
      const { draft } = await createDraft(run.id);

      for (const params of [
        { id: "nope", draftId: draft.id },
        { id: run.id, draftId: "nope" },
      ]) {
        const res = await fixDraftRoute.PATCH(
          jsonRequest("http://test/api/runs/x/fix-drafts/y", "PATCH", {
            status: "dismissed",
          }),
          { params: Promise.resolve(params) },
        );
        expect(res.status).toBe(400);
      }
    });

    it("PATCH with a valid unknown draft uuid returns 404", async () => {
      const run = await createRun("fix draft missing agent");

      const res = await fixDraftRoute.PATCH(
        jsonRequest(
          `http://test/api/runs/${run.id}/fix-drafts/${NIL_UUID}`,
          "PATCH",
          { status: "dismissed" },
        ),
        { params: Promise.resolve({ id: run.id, draftId: NIL_UUID }) },
      );
      expect(res.status).toBe(404);
    });

    it("PATCH cannot reach a draft that belongs to another run", async () => {
      const [ownerRun, otherRun] = await Promise.all([
        createRun("fix draft owner agent"),
        createRun("fix draft intruder agent"),
      ]);
      const { draft } = await createDraft(ownerRun.id);

      const res = await fixDraftRoute.PATCH(
        jsonRequest(
          `http://test/api/runs/${otherRun.id}/fix-drafts/${draft.id}`,
          "PATCH",
          { status: "dismissed" },
        ),
        { params: Promise.resolve({ id: otherRun.id, draftId: draft.id }) },
      );
      expect(res.status).toBe(404);

      const [row] = await dbModule.db
        .select()
        .from(dbModule.fixDrafts)
        .where(eq(dbModule.fixDrafts.id, draft.id));
      expect(row.status).toBe("open");
    });
  });
});
