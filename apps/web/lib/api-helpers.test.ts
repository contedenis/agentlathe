import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { dbErrorResponse, parseBody } from "./api-helpers";

const schema = z.object({ name: z.string().min(1) });

function request(body: string) {
  return new Request("http://test/api/thing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseBody", () => {
  it("returns the parsed data for a valid body", async () => {
    const result = await parseBody(request('{"name":"ok"}'), schema);

    expect(result).toEqual({ data: { name: "ok" } });
  });

  it("answers 400 when the body is not JSON at all", async () => {
    const result = await parseBody(request("not json"), schema);

    if (!("error" in result)) throw new Error("expected an error response");
    expect(result.error.status).toBe(400);
    expect(await result.error.json()).toEqual({ error: "Invalid JSON body." });
  });

  it("answers 400 with the zod issues when the body fails the schema", async () => {
    const result = await parseBody(request('{"name":""}'), schema);

    if (!("error" in result)) throw new Error("expected an error response");
    expect(result.error.status).toBe(400);
    const body = await result.error.json();
    expect(body.error).toBe("Invalid body.");
    expect(body.issues).toHaveLength(1);
  });
});

describe("dbErrorResponse — the Postgres code decides the status", () => {
  it("maps a foreign key violation to 400", async () => {
    const res = dbErrorResponse({ code: "23503" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Referenced resource does not exist.",
    });
  });

  it("maps the sub-agent self-reference check violation to a self-reference message", async () => {
    const res = dbErrorResponse({
      code: "23514",
      constraint: "agent_sub_agents_parent_child_check",
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "Invalid relation: a resource cannot reference itself.",
    );
  });

  it("maps any other check violation to a generic invalid value message", async () => {
    const res = dbErrorResponse({
      code: "23514",
      constraint: "agent_runs_source_check",
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid value.");
  });

  it("maps a duplicate agent name to a message naming the field", async () => {
    const res = dbErrorResponse({
      code: "23505",
      constraint: "agents_name_unique",
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "An agent with this name already exists.",
    );
  });

  it("maps a duplicate agent slug to a message naming the field", async () => {
    const res = dbErrorResponse({
      code: "23505",
      constraint: "agents_slug_unique",
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "An agent with this slug already exists.",
    );
  });

  it("maps a unique violation on any other constraint to 400", async () => {
    const res = dbErrorResponse({ code: "23505" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Duplicate relation.");
  });

  it("reads the code off .cause when drizzle wrapped the failure", async () => {
    const res = dbErrorResponse({ cause: { code: "23505" } });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Duplicate relation.");
  });

  it("falls back to 500 and logs for an unrecognized failure", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("connection reset");

    const res = dbErrorResponse(err);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error." });
    expect(logged).toHaveBeenCalledWith(err);
  });

  it("does not leak a Postgres code that is not one it handles", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = dbErrorResponse({ code: "42P01" });

    expect(res.status).toBe(500);
  });

  it("survives a null error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(dbErrorResponse(null).status).toBe(500);
  });
});
