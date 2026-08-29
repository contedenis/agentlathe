import { describe, expect, it } from "vitest";
import { POST } from "./route";

const agentId = "00000000-0000-0000-0000-000000000000";

function chatRequest(body: unknown) {
  return new Request(`http://localhost/api/agents/${agentId}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/agents/[id]/chat — message validation", () => {
  it("rejects messages that are not valid UI messages, with a JSON 400", async () => {
    const res = await POST(chatRequest({ messages: [{ role: "user" }] }), {
      params: Promise.resolve({ id: agentId }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });
});
