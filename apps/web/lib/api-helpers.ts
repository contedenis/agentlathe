import type { ZodType } from "zod";

export { isUuid } from "@agentlathe/db";

export async function parseBody<T>(
  req: Request,
  schema: ZodType<T>,
): Promise<{ data: T } | { error: Response }> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return {
      error: Response.json({ error: "Invalid JSON body." }, { status: 400 }),
    };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    return {
      error: Response.json(
        { error: "Invalid body.", issues: result.error.issues },
        { status: 400 },
      ),
    };
  }
  return { data: result.data };
}

function hostOf(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

// Both callers test one specific URL: "fetch failed" alone cannot say which.
export function mcpConnectionErrorResponse(
  serverUrl: string,
  err: unknown,
): Response {
  const message = err instanceof Error ? err.message : "Unknown error";
  return Response.json(
    {
      error: `Could not connect to MCP server at ${hostOf(serverUrl)}: ${message}`,
    },
    { status: 502 },
  );
}

const UNIQUE_VIOLATION_MESSAGES: Record<string, string> = {
  agents_name_unique: "An agent with this name already exists.",
  agents_slug_unique: "An agent with this slug already exists.",
};

const SELF_REFERENCE_CHECK_CONSTRAINT = "agent_sub_agents_parent_child_check";

export function dbErrorResponse(err: unknown): Response {
  // drizzle wraps failures in DrizzleQueryError: the Postgres code is on .cause.
  const wrapper = err as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  } | null;
  const code = wrapper?.code ?? wrapper?.cause?.code;
  const constraint = wrapper?.constraint ?? wrapper?.cause?.constraint;
  if (code === "23503") {
    return Response.json(
      { error: "Referenced resource does not exist." },
      { status: 400 },
    );
  }
  if (code === "23514") {
    if (constraint === SELF_REFERENCE_CHECK_CONSTRAINT) {
      return Response.json(
        { error: "Invalid relation: a resource cannot reference itself." },
        { status: 400 },
      );
    }
    return Response.json({ error: "Invalid value." }, { status: 400 });
  }
  if (code === "23505") {
    const message =
      (constraint && UNIQUE_VIOLATION_MESSAGES[constraint]) ??
      "Duplicate relation.";
    return Response.json({ error: message }, { status: 400 });
  }
  console.error(err);
  return Response.json({ error: "Internal server error." }, { status: 500 });
}
