import { describe, expect, it, vi } from "vitest";

const generate = vi.fn(async (_call: unknown) => ({ steps: [] }));
const stream = vi.fn(async (_call: unknown) => ({ fullStream: null }));
const recorder = {
  record: vi.fn(async () => "run-1"),
  attachTranscript: vi.fn(async () => {}),
  runId: () => "run-1",
};

vi.mock("@/lib/run-recorder", () => ({ createRecorder: () => recorder }));
vi.mock("@agentlathe/runner", () => ({
  loadActiveAgent: async () => ({ id: "agent-1", slug: "agent" }),
  openAIMessagesToModelMessages: (messages: unknown) => messages,
  buildHeadlessToolApproval: () => undefined,
  runTimeout: () => ({ totalMs: 1000 }),
  buildAgentRuntime: async () => ({
    agent: { generate, stream },
    cleanup: async () => {},
    stats: () => ({}),
  }),
  toOpenAIChatCompletion: () => {
    throw new Error("serializer bug");
  },
  toOpenAIChatCompletionStream: vi.fn(() => new Response("")),
}));

import { POST } from "./route";

describe("POST /v1/chat/completions — a run is recorded at most once", () => {
  it("a serialization failure after a recorded run answers 500 without recording it again", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const res = await POST(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );

    expect(res.status).toBe(500);
    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(recorder.record).toHaveBeenCalledWith({ stats: {} });
    expect(recorder.attachTranscript).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});

describe("POST /v1/chat/completions — the run timeout", () => {
  const post = (streamed: boolean) =>
    POST(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          stream: streamed,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );

  it("goes on the generate call", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    generate.mockClear();

    await post(false);

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: { totalMs: 1000 } }),
    );
    consoleError.mockRestore();
  });

  it("goes on the stream call", async () => {
    await post(true);

    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: { totalMs: 1000 } }),
    );
  });
});
