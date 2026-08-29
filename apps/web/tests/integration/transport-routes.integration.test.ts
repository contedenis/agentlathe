import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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

type Agent = { id: string; name: string; slug: string };

let container: StartedPostgreSqlContainer;
let provider: Server;
let dbModule: typeof import("@agentlathe/db");
let chatCompletionsRoute: typeof import("../../app/v1/chat/completions/route");
let modelsRoute: typeof import("../../app/v1/models/route");
let mcpRoute: typeof import("../../app/mcp/agents/[id]/route");
let playgroundChatRoute: typeof import("../../app/api/agents/[id]/chat/route");
let activeAgent: Agent;
let inactiveAgent: Agent;
// name and slug differ, the way they do for any agent named for humans.
let displayNameAgent: Agent;
// nameCollider.name is exactly slugOwner.slug: the ambiguous lookup.
let slugOwner: Agent;
let nameCollider: Agent;

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function callMcp(id: string, body: unknown) {
  return mcpRoute.POST(jsonRequest("http://localhost/mcp/agents/x", body), {
    params: Promise.resolve({ id }),
  });
}

function callPlaygroundChat(id: string, body: unknown) {
  return playgroundChatRoute.POST(
    jsonRequest("http://localhost/api/agents/x/chat", body),
    { params: Promise.resolve({ id }) },
  );
}

describe("transport routes (requires Docker)", () => {
  beforeAll(async () => {
    // Answers every completion with the same text: a 200 with it proves the string resolved.
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
            id: "gen-test",
            object: "chat.completion",
            created: 1,
            model: "test/model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "resolved" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, resolve));
    const port = (provider.address() as AddressInfo).port;
    process.env.PROVIDER_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.PROVIDER_API_KEY = "test-key";

    container = await new PostgreSqlContainer("postgres:16").start();
    process.env.DATABASE_URL = container.getConnectionUri();

    dbModule = await import("@agentlathe/db");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(drizzle(dbModule.getPool()), { migrationsFolder });

    chatCompletionsRoute = await import("../../app/v1/chat/completions/route");
    modelsRoute = await import("../../app/v1/models/route");
    mcpRoute = await import("../../app/mcp/agents/[id]/route");
    playgroundChatRoute = await import("../../app/api/agents/[id]/chat/route");

    const [active] = await dbModule.db
      .insert(dbModule.agents)
      .values({
        name: "transport-active-agent",
        slug: dbModule.agentSlug("transport-active-agent"),
        model: "test/model",
      })
      .returning();
    activeAgent = active;

    const [inactive] = await dbModule.db
      .insert(dbModule.agents)
      .values({
        name: "transport-inactive-agent",
        slug: dbModule.agentSlug("transport-inactive-agent"),
        model: "test/model",
        isActive: false,
      })
      .returning();
    inactiveAgent = inactive;

    const [display] = await dbModule.db
      .insert(dbModule.agents)
      .values({
        name: "Transport Support Bot",
        slug: dbModule.agentSlug("Transport Support Bot"),
        model: "test/model",
      })
      .returning();
    displayNameAgent = display;

    const [owner] = await dbModule.db
      .insert(dbModule.agents)
      .values({
        name: "Transport Alias Owner",
        slug: "transport-alias",
        model: "test/model",
      })
      .returning();
    slugOwner = owner;

    const [collider] = await dbModule.db
      .insert(dbModule.agents)
      .values({
        name: "transport-alias",
        slug: "transport-alias-collider",
        model: "test/model",
      })
      .returning();
    nameCollider = collider;
  }, 60000);

  afterAll(async () => {
    await dbModule.closePool();
    await container.stop();
    await new Promise<void>((resolve, reject) =>
      provider.close((err) => (err ? reject(err) : resolve())),
    );
  });

  describe("POST /v1/chat/completions", () => {
    it("rejects a body that is not JSON", async () => {
      const res = await chatCompletionsRoute.POST(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          body: "not json",
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: {
          message: "Invalid JSON in request body.",
          type: "invalid_request_error",
        },
      });
    });

    it("rejects a request missing the model field", async () => {
      const res = await chatCompletionsRoute.POST(
        jsonRequest("http://localhost/v1/chat/completions", {
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.type).toBe("invalid_request_error");
    });

    it("rejects a request with an empty messages array", async () => {
      const res = await chatCompletionsRoute.POST(
        jsonRequest("http://localhost/v1/chat/completions", {
          model: activeAgent.name,
          messages: [],
        }),
      );
      expect(res.status).toBe(400);
    });

    it("returns 404 with a not-found message for an unknown model name", async () => {
      const res = await chatCompletionsRoute.POST(
        jsonRequest("http://localhost/v1/chat/completions", {
          model: "does-not-exist",
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.message).toBe("Model 'does-not-exist' not found");
    });

    it("returns 404 when the model name resolves to an inactive agent", async () => {
      const res = await chatCompletionsRoute.POST(
        jsonRequest("http://localhost/v1/chat/completions", {
          model: inactiveAgent.name,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.message).toBe(
        `Model '${inactiveAgent.name}' not found`,
      );
    });
  });

  describe("GET /v1/models", () => {
    it("lists the active agent and excludes the inactive one", async () => {
      const res = await modelsRoute.GET();
      expect(res.status).toBe(200);
      const json = await res.json();
      const ids = (json.data as Array<{ id: string }>).map((row) => row.id);
      expect(ids).toContain(activeAgent.slug);
      expect(ids).not.toContain(inactiveAgent.slug);
    });

    it("advertises the slug as the model id, never the display name", async () => {
      expect(displayNameAgent.slug).toBe("transport-support-bot");
      expect(displayNameAgent.slug).not.toBe(displayNameAgent.name);

      const json = await (await modelsRoute.GET()).json();
      const ids = (json.data as Array<{ id: string }>).map((row) => row.id);

      expect(ids).toContain(displayNameAgent.slug);
      expect(ids).not.toContain(displayNameAgent.name);
    });
  });

  describe("public agent identity across transports", () => {
    async function ask(model: string) {
      return chatCompletionsRoute.POST(
        jsonRequest("http://localhost/v1/chat/completions", {
          model,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
    }

    it("/v1/chat/completions accepts the slug that /v1/models advertised", async () => {
      const res = await ask(displayNameAgent.slug);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.choices[0].message.content).toBe("resolved");
      expect(json.model).toBe(displayNameAgent.slug);
    });

    it("/v1/chat/completions also accepts the display name", async () => {
      const res = await ask(displayNameAgent.name);
      expect(res.status).toBe(200);
      expect((await res.json()).choices[0].message.content).toBe("resolved");
    });

    it("the MCP endpoint resolves the agent by slug", async () => {
      const res = await callMcp(displayNameAgent.slug, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.result.tools[0].name).toBe(
        dbModule.agentAskToolName(displayNameAgent.slug),
      );
    });

    // loadActiveAgent looks the string up as slug and as name at once, and prefers the slug.
    it("prefers the slug owner when another agent's name is that same string", async () => {
      expect(nameCollider.name).toBe(slugOwner.slug);

      const res = await callMcp(slugOwner.slug, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {} },
      });
      const json = await res.json();
      expect(json.result.serverInfo.name).toBe(`agentlathe/${slugOwner.name}`);
      expect(json.result.serverInfo.name).not.toBe(
        `agentlathe/${nameCollider.name}`,
      );
    });

    it("still reaches the name collider through its own slug", async () => {
      const res = await callMcp(nameCollider.slug, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {} },
      });
      const json = await res.json();
      expect(json.result.serverInfo.name).toBe(
        `agentlathe/${nameCollider.name}`,
      );
    });

    // The slug wins before isActive is checked: deactivating a slug owner takes that string
    // from an active agent holding it as a name. Pinned: it is the public contract.
    it("resolves nothing when an inactive slug owner shadows an active name", async () => {
      const [shadowed] = await dbModule.db
        .insert(dbModule.agents)
        .values({
          name: "Transport Shadowed Owner",
          slug: "transport-shadowed",
          model: "test/model",
          isActive: false,
        })
        .returning();
      const [shadowing] = await dbModule.db
        .insert(dbModule.agents)
        .values({
          name: "transport-shadowed",
          slug: "transport-shadowing",
          model: "test/model",
        })
        .returning();
      expect(shadowed.slug).toBe(shadowing.name);

      const res = await callMcp(shadowed.slug, {
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
      });
      expect(res.status).toBe(404);

      const direct = await callMcp(shadowing.slug, {
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
      });
      expect(direct.status).toBe(200);
    });
  });

  describe("POST /mcp/agents/[id]", () => {
    it("resolves the agent by url-encoded name", async () => {
      const res = await callMcp(encodeURIComponent(activeAgent.name), {
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
      });
      expect(res.status).toBe(200);
    });

    it("returns 404 for an unknown name", async () => {
      const res = await callMcp("no-such-agent", {
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 for an unknown uuid", async () => {
      const res = await callMcp(crypto.randomUUID(), {
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 for an inactive agent", async () => {
      const res = await callMcp(inactiveAgent.id, {
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
      });
      expect(res.status).toBe(404);
    });

    it("returns a JSON-RPC parse error for a malformed body", async () => {
      const res = await mcpRoute.POST(
        new Request("http://localhost/mcp/agents/x", {
          method: "POST",
          body: "not json",
        }),
        { params: Promise.resolve({ id: activeAgent.id }) },
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe(-32700);
    });

    it("negotiates the requested protocol version on initialize", async () => {
      const res = await callMcp(activeAgent.id, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("mcp-session-id")).toBeTruthy();
      const json = await res.json();
      expect(json.result.protocolVersion).toBe("2025-06-18");
      expect(json.result.serverInfo.name).toBe(
        `agentlathe/${activeAgent.name}`,
      );
    });

    it("falls back to the default protocol version for an unsupported request", async () => {
      const res = await callMcp(activeAgent.id, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "1999-01-01", capabilities: {} },
      });
      const json = await res.json();
      expect(json.result.protocolVersion).toBe("2025-11-25");
    });

    it("lists exactly one tool named after the agent", async () => {
      const res = await callMcp(activeAgent.id, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      const json = await res.json();
      expect(json.result.tools).toHaveLength(1);
      expect(json.result.tools[0].name).toBe(
        dbModule.agentAskToolName(activeAgent.slug),
      );
    });

    it("responds to ping with an empty result", async () => {
      const res = await callMcp(activeAgent.id, {
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
      });
      const json = await res.json();
      expect(json.result).toEqual({});
    });

    it("returns method not found for an unknown method", async () => {
      const res = await callMcp(activeAgent.id, {
        jsonrpc: "2.0",
        id: 1,
        method: "does/not-exist",
      });
      const json = await res.json();
      expect(json.error.code).toBe(-32601);
    });

    it("returns invalid params for a tools/call with the wrong tool name", async () => {
      const res = await callMcp(activeAgent.id, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "wrong_tool", arguments: { message: "hi" } },
      });
      const json = await res.json();
      expect(json.error.code).toBe(-32602);
    });

    it("returns invalid params for a tools/call missing the message argument", async () => {
      const res = await callMcp(activeAgent.id, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: dbModule.agentAskToolName(activeAgent.slug),
          arguments: {},
        },
      });
      const json = await res.json();
      expect(json.error.code).toBe(-32602);
    });

    it("returns 202 for a notification", async () => {
      const res = await callMcp(activeAgent.id, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      expect(res.status).toBe(202);
    });

    it("returns an invalid request error for a null body", async () => {
      const res = await callMcp(activeAgent.id, null);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe(-32600);
      expect(json.id).toBeNull();
    });

    it("returns an invalid request error for a batch, which no supported protocol has", async () => {
      const res = await callMcp(activeAgent.id, [
        { jsonrpc: "2.0", id: 1, method: "ping" },
      ]);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe(-32600);
    });

    it("returns an invalid request error for a body that is not an object", async () => {
      const res = await callMcp(activeAgent.id, "ping");
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe(-32600);
    });
  });

  describe("POST /api/agents/[id]/chat", () => {
    it("rejects a non-uuid id", async () => {
      const res = await callPlaygroundChat("not-a-uuid", { messages: [] });
      expect(res.status).toBe(400);
    });

    it("returns 404 for an unknown uuid", async () => {
      // Messages are validated before the lookup, so this needs a valid one to reach it.
      const res = await callPlaygroundChat(crypto.randomUUID(), {
        messages: [
          { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
        ],
      });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("Agent not found or inactive.");
    });

    it("rejects a body missing messages", async () => {
      const res = await callPlaygroundChat(activeAgent.id, {});
      expect(res.status).toBe(400);
    });
  });
});
